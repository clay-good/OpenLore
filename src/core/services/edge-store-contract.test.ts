/**
 * Contract nodes and edges in the SERVING graph (change: add-contract-node-projection).
 *
 * The in-memory build keeps declarations out of the code metrics by construction; this is the
 * persisted copy of the same measurement, and every tool reads THIS one. So the same two
 * exclusions must hold here: a contract edge changes no function's degree, and a contract node is
 * never classified a hub or an entry point of the code. A subset rebuild must also keep contract
 * edges, because only a full analyze can re-project them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EdgeStore } from './edge-store.js';
import type { CallEdge, FunctionNode } from '../analyzer/call-graph.js';

function fn(id: string, over: Partial<FunctionNode> = {}): FunctionNode {
  const [filePath, name] = [id.slice(0, id.indexOf('::')), id.slice(id.indexOf('::') + 2)];
  return {
    id, name, filePath, isAsync: false, language: 'TypeScript',
    startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0, startLine: 1, endLine: 5, ...over,
  };
}

const OPERATION = fn('openapi.yaml::GET /v1/orders/{id}', { language: 'OpenAPI', name: 'GET /v1/orders/{id}' });
const HANDLER = fn('src/handlers.ts::getOrder');
const RENDER = fn('src/render.ts::render');

const callEdge: CallEdge = {
  callerId: HANDLER.id, calleeId: RENDER.id, calleeName: 'render', confidence: 'import', kind: 'calls',
};
const implementsEdge: CallEdge = {
  callerId: HANDLER.id, calleeId: OPERATION.id, calleeName: OPERATION.name,
  confidence: 'import', kind: 'implements_endpoint',
};

describe('EdgeStore with contract nodes', () => {
  let dir: string;
  let store: EdgeStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'edge-store-contract-'));
    store = EdgeStore.openForAnalyze(join(dir, 'call-graph.db'));
    store.insertNodes([HANDLER, RENDER, OPERATION]);
    store.insertEdges([callEdge, implementsEdge]);
    store.recomputeStructuralMetrics();
  });

  afterEach(async () => {
    store.close();
    for (let i = 0; i < 5; i++) {
      try { await rm(dir, { recursive: true, force: true }); break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
  });

  it('does not count a contract edge in the handler fan-out it serves', () => {
    const handler = store.getNode(HANDLER.id);
    // One real call to render; the implements_endpoint edge is not a call.
    expect(handler?.fanOut).toBe(1);
  });

  it('never classifies a contract node as an entry point of the code', () => {
    const entryPoints = store.getEntryPoints(100).map(n => n.id);
    expect(entryPoints).not.toContain(OPERATION.id);
    expect(entryPoints).toContain(HANDLER.id);
  });

  it('never classifies a contract node as a hub, however many handlers bind to it', () => {
    const handlers = Array.from({ length: 8 }, (_, i) => fn(`src/h${i}.ts::h${i}`));
    store.insertNodes(handlers);
    store.insertEdges(handlers.map(h => ({
      callerId: h.id, calleeId: OPERATION.id, calleeName: OPERATION.name,
      confidence: 'import' as const, kind: 'implements_endpoint' as const,
    })));
    store.recomputeStructuralMetrics();
    expect(store.getNode(OPERATION.id)?.fanIn).toBe(0);
    expect(store.getHubs(100).map(n => n.id)).not.toContain(OPERATION.id);
  });

  it('keeps a contract edge when a subset rebuild deletes the handler file edges', () => {
    store.deleteEdgesForFile('src/handlers.ts');
    expect(store.getCallers(OPERATION.id).map(e => e.callerId)).toEqual([HANDLER.id]);
    // The ordinary call edge from the same file IS removed, as before.
    expect(store.getCallees(HANDLER.id).map(e => e.calleeId)).not.toContain(RENDER.id);
  });

  it('round-trips both contract edge kinds', () => {
    store.insertEdges([{
      callerId: 'src/client.ts::load', calleeId: OPERATION.id, calleeName: OPERATION.name,
      confidence: 'import', kind: 'consumes_endpoint',
    }]);
    store.insertNodes([fn('src/client.ts::load')]);
    const bound = store.getCallers(OPERATION.id);
    expect(new Set(bound.map(e => e.kind))).toEqual(new Set(['implements_endpoint', 'consumes_endpoint']));
    expect(bound.map(e => e.callerId).sort()).toEqual(['src/client.ts::load', HANDLER.id]);
  });
});
