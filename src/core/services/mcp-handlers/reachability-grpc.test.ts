/**
 * find_dead_code and gRPC registrations (change: add-contract-graph-projection).
 *
 * A method bound to an RPC is a liveness root. A registration that could NOT be bound leaves its
 * implementation unrooted, so the result must say so; and a disclosure that leaves every binding
 * intact (an unresolved `google.protobuf.Timestamp`) must not raise the "bindings were NOT made"
 * alarm. Drives the real handler over an llm-context fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../../constants.js';
import { handleFindDeadCode } from './reachability.js';
import type { FunctionNode, CallEdge } from '../../analyzer/call-graph.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-grpc-dead-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const node = (id: string, name: string, extra: Partial<FunctionNode> = {}): FunctionNode => ({
  id, name, filePath: id.split('::')[0], isAsync: false, language: 'Go', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0, ...extra,
});
const none = { items: [], total: 0 };
const disclosure = (over: Record<string, unknown>) => ({
  unmatchedOperations: none, unmatchedRoutes: none, unresolvedBindings: none, unreadSpecifications: none,
  unboundClientCalls: none, ambiguousAddresses: none, unresolvedGeneratedBindings: none,
  unresolvedRegistrations: none, unboundRpcs: none, skippedCandidates: none, ...over,
});

async function write(nodes: FunctionNode[], edges: CallEdge[], contracts: Record<string, unknown>): Promise<void> {
  const callGraph = { nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 }, contracts };
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }), 'utf-8');
}

const RPC = node('orders.proto::/orders.v1.OrderService/GetOrder', '/orders.v1.OrderService/GetOrder', { language: 'Protobuf' });

describe('find_dead_code with gRPC registrations', () => {
  it('a bound implementation is not dead, and an after-the-fact note raises no alarm', async () => {
    const impl = node('srv/main.go::orderServer.GetOrder', 'GetOrder', { className: 'orderServer' });
    await write([impl, RPC], [{ callerId: impl.id, calleeId: RPC.id, calleeName: RPC.name, confidence: 'import', kind: 'implements_endpoint', synthesizedBy: 'grpc-registration' }],
      disclosure({ notes: ['1 protobuf type reference(s) resolve to no type projected from the files read'] }));
    const r = await handleFindDeadCode({ directory: root }) as { candidateDead: Array<{ name: string }>; contractRootsNotAssessed?: unknown };
    expect(r.candidateDead.map(c => c.name)).not.toContain('GetOrder');
    expect(r.contractRootsNotAssessed).toBeUndefined();
  });

  it('an unbound registration is named beside the candidate it leaves unrooted', async () => {
    const impl = node('srv/main.go::orderServer.GetOrder', 'GetOrder', { className: 'orderServer' });
    await write([impl, RPC], [], disclosure({
      unresolvedRegistrations: { items: [{ file: 'srv/main.go', line: 12, service: 'orders.v1.OrderService', reason: 'not-literal', detail: 'the implementation is `srv`' }], total: 1 },
    }));
    const r = await handleFindDeadCode({ directory: root }) as { contractRootsNotAssessed?: { unresolvedRegistrations: number; unresolvedRegistrationItems: Array<{ reason: string }> } };
    expect(r.contractRootsNotAssessed?.unresolvedRegistrations).toBe(1);
    expect(r.contractRootsNotAssessed?.unresolvedRegistrationItems.map(i => i.reason)).toEqual(['not-literal']);
  });
});
