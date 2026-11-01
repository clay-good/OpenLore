/**
 * A handler that serves a DECLARED operation is a liveness root
 * (change: add-contract-node-projection).
 *
 * A route handler is invoked by whoever calls the endpoint — inside this repository or outside
 * it — so a specification that declares the operation is evidence of an external caller, not of
 * dead code. The contract operation node itself is a declaration and must never be ranked as
 * code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
}));
vi.mock('./parse-health-boundary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./parse-health-boundary.js')>();
  return { ...actual, loadParseHealthReport: vi.fn(async () => null) };
});
vi.mock('../../drift/git-diff.js', () => ({ getChangedFiles: vi.fn(async () => ({ files: [] })) }));
vi.mock('../../analyzer/entry-point-adapters.js', () => ({ collectExternalWiring: vi.fn() }));

import { handleFindDeadCode } from './reachability.js';
import { readCachedContext } from './utils.js';
import { collectExternalWiring } from '../../analyzer/entry-point-adapters.js';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id, filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 100, fanIn: 0, fanOut: 0, ...over,
  };
}

const OPERATION = node({
  id: 'openapi.yaml::GET /v1/orders/{id}', name: 'GET /v1/orders/{id}',
  filePath: 'openapi.yaml', language: 'OpenAPI',
});
const implementsEdge: CallEdge = {
  callerId: 'src/handlers.ts::getOrder', calleeId: OPERATION.id,
  calleeName: OPERATION.name, confidence: 'import', kind: 'implements_endpoint',
};

function graph(edges: CallEdge[]): SerializedCallGraph {
  return {
    nodes: [
      node({ id: 'src/handlers.ts::getOrder', fanOut: 1 }),
      node({ id: 'src/handlers.ts::render', fanIn: 1 }),
      node({ id: 'src/unused.ts::orphan' }),
      OPERATION,
    ],
    edges: [
      { callerId: 'src/handlers.ts::getOrder', calleeId: 'src/handlers.ts::render', calleeName: 'render', confidence: 'import', kind: 'calls' },
      ...edges,
    ],
    classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: 4, totalEdges: 1 + edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
}

type DeadResult = { candidateDead: Array<{ name: string }> };

describe('find_dead_code with a declared operation', () => {
  beforeEach(() => {
    vi.mocked(collectExternalWiring).mockResolvedValue({ wired: [], boundaries: [], boundariesOmitted: 0 });
  });

  it('keeps the handler and what it calls live, and never ranks the operation itself', async () => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph([implementsEdge]) } as never);
    const result = await handleFindDeadCode({ directory: '/repo' }) as DeadResult;
    const names = result.candidateDead.map(d => d.name);
    expect(names).toContain('orphan');
    expect(names).not.toContain('getOrder');
    expect(names).not.toContain('render');
    expect(names).not.toContain('GET /v1/orders/{id}');
  });

  it('reports the same handler as dead when no specification declares its operation', async () => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph([]) } as never);
    const result = await handleFindDeadCode({ directory: '/repo' }) as DeadResult;
    expect(result.candidateDead.map(d => d.name)).toContain('getOrder');
  });
});
