/**
 * Tests for graph.ts pure utility functions:
 * buildAdjacency, bfs, computeRiskScore, recommendStrategy, nodeToSummary
 * Plus error-path tests for the async handlers.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';

// handleGetFileDependencies reads dependency-graph.json through the shared, stamp-keyed
// artifact cache. Mock that one function rather than the filesystem: the handler's
// contract is "given this graph (or none), produce this answer", and mocking the reader
// keeps the test independent of how the cache reads and validates bytes.
vi.mock('./artifact-cache.js', () => ({
  readDependencyGraphCached: vi.fn(async () => null),
}));

// Static mocks for handler tests
vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (dir: string) => dir),
  readCachedContext: vi.fn(async () => null),
  loadMappingIndex: vi.fn(async () => null),
  specsForFile: vi.fn(() => []),
  functionsForDomain: vi.fn(() => []),
  isCacheFresh: vi.fn(async () => false),
  notReadyResult: (error: string, reason: string) => ({ error, notReady: true, reason, remedy: 'openlore analyze' }),
}));

import {
  buildAdjacency,
  bfs,
  buildWeightedAdjacency,
  bfsFromDB,
  weightedBfs,
  computeRiskScore,
  recommendStrategy,
  nodeToSummary,
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleGetGodFunctions,
  handleGetFileDependencies,
  handleTraceExecutionPath,
} from './graph.js';
import { readCachedContext } from './utils.js';
import type { FunctionNode, SerializedCallGraph, CallEdge, EdgeConfidence } from '../../analyzer/call-graph.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

function makeNode(overrides: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: overrides.id.split('::')[1] ?? overrides.id,
    filePath: overrides.id.split('::')[0] ?? 'test.ts',
    isAsync: false,
    language: 'typescript',
    startIndex: 0,
    endIndex: 100,
    fanIn: 0,
    fanOut: 0,
    ...overrides,
  };
}

function makeEdge(callerId: string, calleeId: string): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1] ?? calleeId, confidence: 'name_only' };
}

function makeGraph(nodes: FunctionNode[], edges: CallEdge[]): SerializedCallGraph {
  return {
    nodes,
    edges,
    classes: [],
    inheritanceEdges: [],
    hubFunctions: [],
    entryPoints: [],
    layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
}

// ============================================================================
// CHA override / virtual-dispatch edges in the adjacency builders
// (spec: add-type-hierarchy-resolved-dispatch)
// ============================================================================

describe('CHA edges in adjacency builders', () => {
  const overrideEdge = (from: string, to: string): CallEdge =>
    ({ callerId: from, calleeId: to, calleeName: to.split('::')[1] ?? to, confidence: 'synthesized', kind: 'overrides', synthesizedBy: 'override' });
  const chaCallEdge = (from: string, to: string): CallEdge =>
    ({ callerId: from, calleeId: to, calleeName: to.split('::')[1] ?? to, confidence: 'synthesized', kind: 'calls', callType: 'method', synthesizedBy: 'cha-declared-type' });

  it('materialized override edges propagate in both directions (replacing the cross-product)', () => {
    const base = makeNode({ id: 'a.ts::Base.m', className: 'Base' });
    const derived = makeNode({ id: 'a.ts::Derived.m', className: 'Derived' });
    const cg = makeGraph([base, derived], [overrideEdge(base.id, derived.id)]);
    const { forward, backward } = buildAdjacency(cg);
    expect(forward.get(base.id)!.has(derived.id)).toBe(true);   // base → override
    expect(backward.get(derived.id)!.has(base.id)).toBe(true);  // override ← base
  });

  it('strict mode (directResolvedOnly) excludes override and CHA virtual-dispatch edges', () => {
    const base = makeNode({ id: 'a.ts::Base.m', className: 'Base' });
    const derived = makeNode({ id: 'a.ts::Derived.m', className: 'Derived' });
    const caller = makeNode({ id: 'a.ts::caller' });
    const impl = makeNode({ id: 'a.ts::Impl.area', className: 'Impl' });
    const cg = makeGraph(
      [base, derived, caller, impl],
      [overrideEdge(base.id, derived.id), chaCallEdge(caller.id, impl.id)],
    );
    const { forward } = buildAdjacency(cg, { directResolvedOnly: true });
    expect(forward.get(base.id)!.has(derived.id)).toBe(false);
    expect(forward.get(caller.id)!.has(impl.id)).toBe(false);
  });

  it('override edges do not contribute to call distance (excluded from weighted adjacency)', () => {
    const base = makeNode({ id: 'a.ts::Base.m', className: 'Base' });
    const derived = makeNode({ id: 'a.ts::Derived.m', className: 'Derived' });
    const cg = makeGraph([base, derived], [overrideEdge(base.id, derived.id)]);
    const { forward } = buildWeightedAdjacency(cg);
    // kind 'overrides' is not a call hop — no weighted edge.
    expect(forward.get(base.id) ?? []).toHaveLength(0);
  });

  it('CHA virtual-dispatch (calls-kind) edges DO appear in weighted adjacency', () => {
    const caller = makeNode({ id: 'a.ts::caller' });
    const impl = makeNode({ id: 'a.ts::Impl.area', className: 'Impl' });
    const cg = makeGraph([caller, impl], [chaCallEdge(caller.id, impl.id)]);
    const { forward } = buildWeightedAdjacency(cg);
    expect((forward.get(caller.id) ?? []).some(e => e.to === impl.id)).toBe(true);
  });

  // The DB-backed lazy path (bfsFromDB) must traverse the SAME materialized override
  // edges as the in-memory buildAdjacency — so analyze_impact/get_subgraph agree with
  // find_dead_code — and directResolvedOnly must exclude them in this path too.
  // (spec: add-type-hierarchy-resolved-dispatch — ProvenanceAwareReachability)
  it('bfsFromDB traverses override edges by default and excludes them in strict mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ol-bfsdb-'));
    const store = EdgeStore.open(join(dir, 'call-graph.db'));
    try {
      store.insertEdges([overrideEdge('a.ts::Animal.speak', 'a.ts::Dog.speak')]);
      const reached = bfsFromDB(['a.ts::Animal.speak'], 'forward', 3, store);
      expect(reached.has('a.ts::Dog.speak')).toBe(true);
      const strict = bfsFromDB(['a.ts::Animal.speak'], 'forward', 3, store, { directResolvedOnly: true });
      expect(strict.has('a.ts::Dog.speak')).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// buildAdjacency
// ============================================================================

describe('buildAdjacency', () => {
  it('should build forward and backward adjacency maps', () => {
    const a = makeNode({ id: 'a.ts::foo' });
    const b = makeNode({ id: 'b.ts::bar' });
    const c = makeNode({ id: 'c.ts::baz' });
    const cg = makeGraph([a, b, c], [makeEdge(a.id, b.id), makeEdge(a.id, c.id)]);

    const { forward, backward, nodeMap } = buildAdjacency(cg);

    // Forward: a → {b, c}
    expect(forward.get(a.id)!.has(b.id)).toBe(true);
    expect(forward.get(a.id)!.has(c.id)).toBe(true);
    expect(forward.get(b.id)!.size).toBe(0);

    // Backward: b ← {a}, c ← {a}
    expect(backward.get(b.id)!.has(a.id)).toBe(true);
    expect(backward.get(c.id)!.has(a.id)).toBe(true);
    expect(backward.get(a.id)!.size).toBe(0);

    // nodeMap
    expect(nodeMap.get(a.id)).toBe(a);
    expect(nodeMap.size).toBe(3);
  });

  it('should handle empty graph', () => {
    const cg = makeGraph([], []);
    const { forward, backward, nodeMap } = buildAdjacency(cg);

    expect(forward.size).toBe(0);
    expect(backward.size).toBe(0);
    expect(nodeMap.size).toBe(0);
  });

  it('should skip edges with empty calleeId', () => {
    const a = makeNode({ id: 'a.ts::foo' });
    const cg = makeGraph([a], [{ callerId: a.id, calleeId: '', calleeName: 'external', confidence: 'name_only' }]);

    const { forward } = buildAdjacency(cg);
    expect(forward.get(a.id)!.size).toBe(0);
  });

  it('should handle diamond dependency graph', () => {
    const a = makeNode({ id: 'a.ts::a' });
    const b = makeNode({ id: 'b.ts::b' });
    const c = makeNode({ id: 'c.ts::c' });
    const d = makeNode({ id: 'd.ts::d' });
    // a → b, a → c, b → d, c → d
    const cg = makeGraph([a, b, c, d], [
      makeEdge(a.id, b.id), makeEdge(a.id, c.id),
      makeEdge(b.id, d.id), makeEdge(c.id, d.id),
    ]);

    const { backward } = buildAdjacency(cg);
    // d has two callers: b and c
    expect(backward.get(d.id)!.size).toBe(2);
    expect(backward.get(d.id)!.has(b.id)).toBe(true);
    expect(backward.get(d.id)!.has(c.id)).toBe(true);
  });
});

// ============================================================================
// bfs
// ============================================================================

describe('bfs', () => {
  it('should traverse to specified depth', () => {
    // Linear chain: a → b → c → d
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['d'])],
      ['d', new Set()],
    ]);

    const visited = bfs(['a'], adj, 2);
    expect(visited.get('a')).toBe(0);
    expect(visited.get('b')).toBe(1);
    expect(visited.get('c')).toBe(2);
    expect(visited.has('d')).toBe(false); // depth 3, beyond limit
  });

  it('should handle multiple seeds', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['c'])],
      ['b', new Set(['c'])],
      ['c', new Set(['d'])],
      ['d', new Set()],
    ]);

    const visited = bfs(['a', 'b'], adj, 1);
    expect(visited.get('a')).toBe(0);
    expect(visited.get('b')).toBe(0);
    expect(visited.get('c')).toBe(1);
    expect(visited.has('d')).toBe(false);
  });

  it('should handle cycles without infinite loop', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])], // cycle back
    ]);

    const visited = bfs(['a'], adj, 10);
    expect(visited.size).toBe(3);
    expect(visited.get('a')).toBe(0);
    expect(visited.get('b')).toBe(1);
    expect(visited.get('c')).toBe(2);
  });

  it('should return only seeds at depth 0', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set()],
    ]);

    const visited = bfs(['a'], adj, 0);
    expect(visited.size).toBe(1);
    expect(visited.get('a')).toBe(0);
  });

  it('should handle disconnected nodes', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set()],
      ['b', new Set()],
    ]);

    const visited = bfs(['a'], adj, 5);
    expect(visited.size).toBe(1);
    expect(visited.has('b')).toBe(false);
  });
});

// ============================================================================
// computeRiskScore
// ============================================================================

describe('computeRiskScore', () => {
  it('should return 0 for a node with no connections and no hub status', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 0, fanOut: 0 });
    expect(computeRiskScore(node, 0, false)).toBe(0);
  });

  it('should weight fan-in by 4', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 5, fanOut: 0 });
    // 5 * 4 = 20
    expect(computeRiskScore(node, 0, false)).toBe(20);
  });

  it('should weight fan-out by 2', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 0, fanOut: 5 });
    // 5 * 2 = 10
    expect(computeRiskScore(node, 0, false)).toBe(10);
  });

  it('should add hub bonus of 20', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 0, fanOut: 0 });
    expect(computeRiskScore(node, 0, true)).toBe(20);
  });

  it('should weight blast radius by 1.5', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 0, fanOut: 0 });
    // 10 * 1.5 = 15
    expect(computeRiskScore(node, 10, false)).toBe(15);
  });

  it('should combine all factors', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 3, fanOut: 4 });
    // 3*4 + 4*2 + 20 + 5*1.5 = 12 + 8 + 20 + 7.5 = 47.5 → 48
    expect(computeRiskScore(node, 5, true)).toBe(48);
  });

  it('should cap at 100', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 50, fanOut: 50 });
    // 50*4 + 50*2 + 20 + 100*1.5 = 200 + 100 + 20 + 150 = 470 → capped at 100
    expect(computeRiskScore(node, 100, true)).toBe(100);
  });
});

// ============================================================================
// recommendStrategy
// ============================================================================

describe('recommendStrategy', () => {
  it('should recommend "refactor freely" for low risk (<= 20)', () => {
    const result = recommendStrategy(10, 1, 1, false);
    expect(result.approach).toBe('refactor freely');
  });

  it('should recommend "refactor with tests" for medium risk (21-45)', () => {
    const result = recommendStrategy(30, 3, 3, false);
    expect(result.approach).toBe('refactor with tests');
  });

  it('should recommend "split responsibility" for high-risk hub with high fan-out', () => {
    // riskScore > 45, isHub = true, fanOut > REFACTOR_SRP_FAN_OUT_THRESHOLD (5)
    const result = recommendStrategy(80, 10, 10, true);
    expect(result.approach).toBe('split responsibility (SRP)');
  });

  it('should recommend "introduce façade" for hub without extreme fan-out', () => {
    // riskScore > 45, isHub = true, fanOut <= REFACTOR_SRP_FAN_OUT_THRESHOLD (5)
    const result = recommendStrategy(60, 10, 3, true);
    expect(result.approach).toBe('introduce façade');
  });

  it('should recommend "decompose fan-out" for non-hub with high fan-out', () => {
    // riskScore > 45, isHub = false, fanOut > GOD_FUNCTION_FAN_OUT_THRESHOLD (8)
    const result = recommendStrategy(50, 2, 12, false);
    expect(result.approach).toBe('decompose fan-out');
  });

  it('should fall back to "incremental extraction" for high risk non-hub, low fan-out', () => {
    // riskScore > 45, isHub = false, fanOut <= 8
    const result = recommendStrategy(50, 10, 3, false);
    expect(result.approach).toBe('incremental extraction');
  });

  it('should always include a rationale', () => {
    for (const [risk, fanIn, fanOut, isHub] of [
      [5, 0, 0, false], [30, 3, 3, false], [80, 10, 10, true],
      [60, 10, 3, true], [50, 2, 12, false], [50, 10, 3, false],
    ] as [number, number, number, boolean][]) {
      const result = recommendStrategy(risk, fanIn, fanOut, isHub);
      expect(result.rationale.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// nodeToSummary
// ============================================================================

describe('nodeToSummary', () => {
  it('should extract name, file, className, and depth from a node', () => {
    const node = makeNode({ id: 'src/auth.ts::AuthService.login', name: 'login', className: 'AuthService' });
    const summary = nodeToSummary(node);
    expect(summary.name).toBe('login');
    expect(summary.file).toBe('src/auth.ts');
    expect(summary.className).toBe('AuthService');
    expect(summary.depth).toBe(0);
  });

  it('should handle node without className', () => {
    const node = makeNode({ id: 'utils.ts::helper', name: 'helper' });
    const summary = nodeToSummary(node);
    expect(summary.className).toBeNull();
  });

  it('should return empty defaults for undefined node', () => {
    const summary = nodeToSummary(undefined);
    expect(summary.name).toBe('');
    expect(summary.file).toBe('');
    expect(summary.className).toBeNull();
    expect(summary.depth).toBe(0);
  });
});

// ============================================================================
// Handler error paths (readCachedContext returns null → error object)
// ============================================================================

describe('handler error paths — no cached context', () => {
  it('handleGetCallGraph returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetCallGraph('/tmp/proj') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetSubgraph returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetSubgraph('/tmp/proj', 'doFoo') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleAnalyzeImpact returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleAnalyzeImpact('/tmp/proj', 'doFoo') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetLowRiskRefactorCandidates returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetLowRiskRefactorCandidates('/tmp/proj') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetLeafFunctions returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetLeafFunctions('/tmp/proj') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetCriticalHubs returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetCriticalHubs('/tmp/proj') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetGodFunctions returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetGodFunctions('/tmp/proj') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetFileDependencies returns error when no dependency graph file', async () => {
    // readCachedContext not involved here; it reads a JSON file directly
    const result = await handleGetFileDependencies('/tmp/proj', 'src/foo.ts') as { error: string };
    expect(result.error).toContain('No dependency graph found');
  });

  it('handleTraceExecutionPath returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleTraceExecutionPath('/tmp/proj', 'foo', 'bar') as { error: string };
    expect(result.error).toContain('No analysis found');
  });
});

// ============================================================================
// handleTraceExecutionPath — path finding logic
// ============================================================================

describe('handleTraceExecutionPath', () => {
  it('finds the shortest direct path between two functions', async () => {
    const nodes = [
      makeNode({ id: 'a.ts::processOrder', fanOut: 1 }),
      makeNode({ id: 'b.ts::applyDiscounts', fanOut: 1 }),
      makeNode({ id: 'c.ts::chargeCard', fanOut: 0 }),
    ];
    const edges = [
      { ...makeEdge('a.ts::processOrder', 'b.ts::applyDiscounts'), line: 12 },
      { ...makeEdge('a.ts::processOrder', 'b.ts::applyDiscounts'), line: 18 },
      { ...makeEdge('b.ts::applyDiscounts', 'c.ts::chargeCard'), line: 27 },
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, edges) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'processOrder', 'chargeCard') as {
      pathsFound: number;
      shortestPath: string;
      paths: Array<{ hops: number; chain: string; steps: Array<{ callsNext?: Array<{ file: string; line: number }> }> }>;
    };

    expect(result.pathsFound).toBe(1);
    expect(result.paths[0].hops).toBe(2);
    expect(result.paths[0].chain).toBe('processOrder → applyDiscounts → chargeCard');
    expect(result.paths[0].steps[0].callsNext).toEqual([
      expect.objectContaining({ file: 'a.ts', line: 12 }),
      expect.objectContaining({ file: 'a.ts', line: 18 }),
    ]);
    expect(result.paths[0].steps[1].callsNext).toEqual([
      expect.objectContaining({ file: 'b.ts', line: 27 }),
    ]);
    expect(result.paths[0].steps[2].callsNext).toBeUndefined();
  });

  it('bounds parallel call-site evidence and reports truncation', async () => {
    const nodes = [makeNode({ id: 'a.ts::A' }), makeNode({ id: 'b.ts::B' })];
    const edges = Array.from({ length: 12 }, (_, index) => ({ ...makeEdge('a.ts::A', 'b.ts::B'), line: index + 1 }));
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, edges) } as never);
    const result = await handleTraceExecutionPath('/tmp/proj', 'A', 'B') as {
      paths: Array<{ steps: Array<{ callsNext?: unknown[]; callsNextReceipt?: Record<string, number> }> }>;
    };
    expect(result.paths[0].steps[0].callsNext).toHaveLength(8);
    expect(result.paths[0].steps[0].callsNextReceipt).toMatchObject({ returned: 8, totalAtLeast: 9, omittedAtLeast: 1, limit: 8, truncated: true });
  });

  it('selects the same deduplicated receipt under adversarial edge order', async () => {
    const nodes = [makeNode({ id: 'a.ts::A' }), makeNode({ id: 'b.ts::B' })];
    const duplicates = Array.from({ length: 20 }, () => ({ ...makeEdge('a.ts::A', 'b.ts::B'), line: 1 }));
    const distinct = Array.from({ length: 11 }, (_, index) => ({ ...makeEdge('a.ts::A', 'b.ts::B'), line: index + 2 }));
    const run = async (edges: CallEdge[]) => {
      vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: makeGraph(nodes, edges) } as never);
      const result = await handleTraceExecutionPath('/tmp/proj', 'A', 'B') as {
        paths: Array<{ steps: Array<{ callsNext?: Array<{ line: number }>; callsNextReceipt?: Record<string, number | boolean> }> }>;
      };
      return result.paths[0].steps[0];
    };
    const forward = await run([...duplicates, ...distinct]);
    const reversed = await run([...distinct, ...duplicates].reverse());
    expect(reversed).toEqual(forward);
    expect(forward.callsNext?.map(item => item.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(forward.callsNextReceipt).toMatchObject({ totalAtLeast: 9, returned: 8, omittedAtLeast: 1, truncated: true });
  });

  it('does not guess a call-site line when the edge has none', async () => {
    const nodes = [makeNode({ id: 'a.ts::A' }), makeNode({ id: 'b.ts::B' })];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, [makeEdge('a.ts::A', 'b.ts::B')]) } as never);
    const result = await handleTraceExecutionPath('/tmp/proj', 'A', 'B') as {
      paths: Array<{ steps: Array<{ callsNext?: unknown[] }> }>;
    };
    expect(result.paths[0].steps[0].callsNext).toBeUndefined();
  });

  it('returns multiple paths ordered by length (shortest first)', async () => {
    // A → B → D  (2 hops)
    // A → C → D  (2 hops)
    const nodes = [
      makeNode({ id: 'f.ts::A', fanOut: 2 }),
      makeNode({ id: 'f.ts::B', fanOut: 1 }),
      makeNode({ id: 'f.ts::C', fanOut: 1 }),
      makeNode({ id: 'f.ts::D', fanOut: 0 }),
    ];
    const edges = [
      makeEdge('f.ts::A', 'f.ts::B'),
      makeEdge('f.ts::A', 'f.ts::C'),
      makeEdge('f.ts::B', 'f.ts::D'),
      makeEdge('f.ts::C', 'f.ts::D'),
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, edges) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'A', 'D') as {
      pathsFound: number;
      paths: Array<{ hops: number }>;
    };

    expect(result.pathsFound).toBe(2);
    expect(result.paths.every(p => p.hops === 2)).toBe(true);
  });

  it('resolves the EXACT target (not a same-substring node) and discloses a synthesized hop in the boundary', async () => {
    // "area" must not also resolve "totalArea". Before the exact-match fix, the DFS
    // stopped at the same-substring `totalArea` (reached by a direct edge) and never
    // reached the literal `area` (reachable only across a synthesized dispatch edge),
    // reporting a misleadingly `complete: true` boundary for a path to a target it
    // never reached. Now it reaches `area` and the boundary discloses the synthesized hop.
    const nodes = [
      makeNode({ id: 'm.ts::main', fanOut: 1 }),
      makeNode({ id: 's.ts::totalArea', fanOut: 1 }),
      makeNode({ id: 's.ts::area', fanOut: 0 }),
    ];
    const synth = (from: string, to: string): CallEdge =>
      ({ callerId: from, calleeId: to, calleeName: to.split('::')[1] ?? to, confidence: 'synthesized', kind: 'calls', synthesizedBy: 'cha-name-only' });
    const edges = [
      makeEdge('m.ts::main', 's.ts::totalArea'),   // direct
      synth('s.ts::totalArea', 's.ts::area'),       // synthesized dispatch → the only way to area
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, edges) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'main', 'area') as {
      pathsFound: number;
      shortestPath: string;
      confidenceBoundary: { complete: boolean };
    };

    expect(result.pathsFound).toBe(1);
    expect(result.shortestPath).toBe('main → totalArea → area'); // reached the literal target
    expect(result.confidenceBoundary.complete).toBe(false);      // leaned on a synthesized edge — disclosed
  });

  it('returns pathsFound: 0 with a hint when no path exists', async () => {
    const nodes = [
      makeNode({ id: 'f.ts::isolated', fanOut: 0 }),
      makeNode({ id: 'f.ts::other', fanOut: 0 }),
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, []) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'isolated', 'other') as {
      pathsFound: number;
      hint: string;
    };

    expect(result.pathsFound).toBe(0);
    expect(result.hint).toBeDefined();
  });

  it('returns error when entry function is not found', async () => {
    const nodes = [makeNode({ id: 'f.ts::known', fanOut: 0 })];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, []) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'ghost', 'known') as { error: string };
    expect(result.error).toContain('"ghost"');
  });

  it('returns error when target function is not found', async () => {
    const nodes = [makeNode({ id: 'f.ts::known', fanOut: 0 })];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, []) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'known', 'ghost') as { error: string };
    expect(result.error).toContain('"ghost"');
  });

  it('respects maxDepth and does not return paths longer than the limit', async () => {
    // A → B → C → D (3 hops) — should be excluded when maxDepth=2
    const nodes = [
      makeNode({ id: 'f.ts::A', fanOut: 1 }),
      makeNode({ id: 'f.ts::B', fanOut: 1 }),
      makeNode({ id: 'f.ts::C', fanOut: 1 }),
      makeNode({ id: 'f.ts::D', fanOut: 0 }),
    ];
    const edges = [
      makeEdge('f.ts::A', 'f.ts::B'),
      makeEdge('f.ts::B', 'f.ts::C'),
      makeEdge('f.ts::C', 'f.ts::D'),
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, edges) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'A', 'D', 2) as { pathsFound: number };
    expect(result.pathsFound).toBe(0);
  });
});

// ============================================================================
// handleGetFileDependencies — direction branches
// ============================================================================

const DEP_GRAPH_FIXTURE = JSON.stringify({
  nodes: [
    { id: 'n1', file: { path: 'src/a.ts', absolutePath: '/proj/src/a.ts' } },
    { id: 'n2', file: { path: 'src/b.ts', absolutePath: '/proj/src/b.ts' } },
    { id: 'n3', file: { path: 'src/c.ts', absolutePath: '/proj/src/c.ts' } },
  ],
  edges: [
    { source: 'n1', target: 'n2', importedNames: ['foo'], isTypeOnly: false, weight: 1 },
    { source: 'n3', target: 'n1', importedNames: ['bar'], isTypeOnly: true,  weight: 1 },
  ],
});

describe('handleGetFileDependencies — direction branches', () => {
  afterEach(async () => {
    const { readDependencyGraphCached } = await import('./artifact-cache.js');
    vi.mocked(readDependencyGraphCached).mockResolvedValue(null);
  });

  async function mockDepGraph() {
    const { readDependencyGraphCached } = await import('./artifact-cache.js');
    vi.mocked(readDependencyGraphCached).mockResolvedValue(JSON.parse(DEP_GRAPH_FIXTURE) as never);
  }

  it('returns imports only when direction is "imports"', async () => {
    await mockDepGraph();
    const result = await handleGetFileDependencies('/proj', 'src/a.ts', 'imports') as {
      imports: unknown[]; importedBy: unknown; importsCount: number;
    };
    expect(result.imports).toHaveLength(1);
    expect(result.importedBy).toBeUndefined();
    expect(result.importsCount).toBe(1);
  });

  it('returns importedBy only when direction is "importedBy"', async () => {
    await mockDepGraph();
    const result = await handleGetFileDependencies('/proj', 'src/a.ts', 'importedBy') as {
      imports: unknown; importedBy: unknown[]; importedByCount: number;
    };
    expect(result.importedBy).toHaveLength(1);
    expect(result.imports).toBeUndefined();
    expect(result.importedByCount).toBe(1);
  });

  it('returns both imports and importedBy when direction is "both"', async () => {
    await mockDepGraph();
    const result = await handleGetFileDependencies('/proj', 'src/a.ts', 'both') as {
      imports: unknown[]; importedBy: unknown[];
    };
    expect(result.imports).toHaveLength(1);
    expect(result.importedBy).toHaveLength(1);
  });

  it('returns error when file not found in dependency graph', async () => {
    await mockDepGraph();
    const result = await handleGetFileDependencies('/proj', 'src/nonexistent.ts') as { error: string };
    expect(result.error).toContain('File not found in dependency graph');
  });

  it('returns the friendly error (not a TypeError) on a valid-but-partial graph artifact', async () => {
    // {} parses fine but has no nodes array — must not crash on graph.nodes.find().
    // A valid-but-partial artifact is rejected by the shared reader, which returns null.
    const { readDependencyGraphCached } = await import('./artifact-cache.js');
    vi.mocked(readDependencyGraphCached).mockResolvedValue(null);
    const result = await handleGetFileDependencies('/proj', 'src/a.ts') as { error: string };
    expect(result.error).toContain('No dependency graph found');
  });

  it('does not throw on a node missing its file field', async () => {
    const { readDependencyGraphCached } = await import('./artifact-cache.js');
    vi.mocked(readDependencyGraphCached).mockResolvedValue(({
      nodes: [{ id: 'n1' }, { id: 'n2', file: { path: 'src/b.ts', absolutePath: '/proj/src/b.ts' } }],
      edges: [],
    }) as never);
    const result = await handleGetFileDependencies('/proj', 'src/b.ts') as { imports: unknown[] };
    // resolves the well-formed node without throwing on the malformed sibling
    expect(Array.isArray(result.imports)).toBe(true);
  });
});

// ============================================================================
// EdgeStore fast paths — handleGetSubgraph + handleAnalyzeImpact
// ============================================================================

describe('handleGetSubgraph — edgeStore fast path', () => {
  let dir: string;
  let store: EdgeStore;

  // Graph: entry → middle → leaf (downstream chain)
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-subgraph-test-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([
      makeNode({ id: 'src/a.ts::entry',  fanOut: 1 }),
      makeNode({ id: 'src/b.ts::middle', fanOut: 1 }),
      makeNode({ id: 'src/c.ts::leaf',   fanOut: 0 }),
    ]);
    store.insertEdges([
      { ...makeEdge('src/a.ts::entry',  'src/b.ts::middle'), line: 11 },
      { ...makeEdge('src/b.ts::middle', 'src/c.ts::leaf'), line: 22 },
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds seed via searchNodes (indexed) and returns downstream subgraph', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'entry', 'downstream', 2) as Record<string, unknown>;

    const nodes = result.nodes as Array<{ name: string }>;
    expect(nodes.map(n => n.name)).toContain('entry');
    expect(nodes.map(n => n.name)).toContain('middle');
    expect(nodes.map(n => n.name)).toContain('leaf');
    expect((result.indexStaleness as { staleFiles: string[] }).staleFiles).toEqual([
      'src/a.ts', 'src/b.ts', 'src/c.ts',
    ]);
  });

  it('subgraph edges connect visited nodes correctly', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'entry', 'downstream', 2) as Record<string, unknown>;

    const edges = result.edges as Array<{ caller: string; callee: string }>;
    expect(edges.some(e => e.caller === 'entry' && e.callee === 'middle')).toBe(true);
    expect(edges.some(e => e.caller === 'middle' && e.callee === 'leaf')).toBe(true);
  });

  it('upstream direction returns callers only', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'leaf', 'upstream', 2) as Record<string, unknown>;

    const nodes = result.nodes as Array<{ name: string }>;
    const names = nodes.map(n => n.name);
    expect(names).toContain('leaf');
    expect(names).toContain('middle');
    expect(names).toContain('entry');
  });

  it('depth limit is respected', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'entry', 'downstream', 1) as Record<string, unknown>;

    const nodes = result.nodes as Array<{ name: string }>;
    const names = nodes.map(n => n.name);
    expect(names).toContain('entry');
    expect(names).toContain('middle');
    expect(names).not.toContain('leaf'); // depth 1 stops at middle
  });

  it('returns error when function name not found', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'nonexistent', 'downstream', 2) as { error: string };
    expect(result.error).toContain('nonexistent');
  });
});

describe('handleAnalyzeImpact — edgeStore fast path', () => {
  let dir: string;
  let store: EdgeStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-impact-test-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([
      makeNode({ id: 'src/a.ts::entry',  fanOut: 2 }),
      makeNode({ id: 'src/b.ts::middle', fanIn: 1, fanOut: 1 }),
      makeNode({ id: 'src/c.ts::leaf',   fanIn: 1, fanOut: 0 }),
    ]);
    store.insertEdges([
      { ...makeEdge('src/a.ts::entry',  'src/b.ts::middle'), line: 11 },
      { ...makeEdge('src/b.ts::middle', 'src/c.ts::leaf'), line: 22 },
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('computes downstream blast radius via lazy BFS', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'entry', 2) as Record<string, unknown>;

    const blast = result.blastRadius as { total: number; downstream: number; upstream: number };
    expect(blast.downstream).toBe(2); // middle + leaf
    expect(blast.upstream).toBe(0);   // nothing calls entry
    const chain = result.downstreamCriticalPath as Array<{ name: string; callSites?: Array<{ file: string; line: number }> }>;
    expect(chain.find(node => node.name === 'middle')?.callSites).toEqual([
      expect.objectContaining({ file: 'src/a.ts', line: 11 }),
    ]);
    expect(chain.find(node => node.name === 'leaf')?.callSites).toEqual([
      expect.objectContaining({ file: 'src/b.ts', line: 22 }),
    ]);
  });

  it('computes upstream chain for a leaf node', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'leaf', 2) as Record<string, unknown>;

    const blast = result.blastRadius as { total: number; upstream: number };
    expect(blast.upstream).toBe(2); // middle + entry call into leaf
    const chain = result.upstreamChain as Array<{ name: string; callSites?: Array<{ file: string; line: number }> }>;
    expect(chain.find(node => node.name === 'middle')?.callSites).toEqual([
      expect.objectContaining({ file: 'src/b.ts', line: 22 }),
    ]);
  });

  it('preserves call sites from every shortest-depth parent', async () => {
    store.insertNodes([makeNode({ id: 'src/b.ts::other', fanIn: 1, fanOut: 1 })]);
    store.insertEdges([
      { ...makeEdge('src/a.ts::entry', 'src/b.ts::other'), line: 12 },
      { ...makeEdge('src/b.ts::other', 'src/c.ts::leaf'), line: 22 },
    ]);
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'entry', 2) as Record<string, unknown>;
    const chain = result.downstreamCriticalPath as Array<{ name: string; callSites?: Array<{ file: string; line: number }> }>;
    expect(chain.find(node => node.name === 'leaf')?.callSites).toEqual([
      expect.objectContaining({ callerId: 'src/b.ts::middle', file: 'src/b.ts', line: 22 }),
      expect.objectContaining({ callerId: 'src/b.ts::other', file: 'src/b.ts', line: 22 }),
    ]);
    expect(chain.find(node => node.name === 'leaf')).toMatchObject({
      callSitesReceipt: { returned: 2, total: 2, omitted: 0, truncated: false },
    });
  });

  it('bounds call-site evidence across the entire impact response deterministically', async () => {
    const nodes = Array.from({ length: 140 }, (_, index) =>
      makeNode({ id: `src/generated-${String(index).padStart(3, '0')}.ts::target${index}` }));
    store.insertNodes(nodes);
    store.insertEdges(nodes.map((node, index) => ({
      ...makeEdge('src/a.ts::entry', node.id),
      line: index + 100,
    })));

    vi.mocked(readCachedContext).mockResolvedValue({ edgeStore: store } as never);
    const first = await handleAnalyzeImpact(dir, 'entry', 1) as Record<string, unknown>;
    const second = await handleAnalyzeImpact(dir, 'entry', 1) as Record<string, unknown>;
    const chain = first.downstreamCriticalPath as Array<{ callSites?: unknown[] }>;

    expect(chain.filter(node => node.callSites?.length).length).toBe(128);
    expect(first.callSiteEvidenceReceipt).toEqual({
      eligibleEntries: 141,
      returnedEntries: 128,
      omittedEntries: 13,
      limit: 128,
      truncated: true,
    });
    expect(second).toEqual(first);
  });

  it('returns riskLevel field', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'middle', 2) as Record<string, unknown>;
    expect(['low', 'medium', 'high', 'critical']).toContain(result.riskLevel);
  });

  // Ambiguity disclosure (change: harden-call-resolution-ambiguity): a site whose caller is
  // in the impact set means downstream is under-counted; the blast radius is a lower bound.
  it('surfaces unresolved-ambiguous call sites touching the impact set', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({
      edgeStore: store,
      callGraph: {
        ambiguousSites: [
          { callerId: 'src/a.ts::entry', calleeName: 'run', line: 3, strategy: 'name_only', candidateIds: ['x.ts::run', 'y.ts::run'], candidateCount: 2 },
        ],
      },
    } as never);
    const result = await handleAnalyzeImpact(dir, 'entry', 2) as {
      ambiguousCallSites?: { count: number; sample: Array<{ caller: string; callee: string; strategy: string; candidates: number }> };
    };
    expect(result.ambiguousCallSites?.count).toBe(1);
    expect(result.ambiguousCallSites?.sample[0]).toMatchObject({ caller: 'entry', callee: 'run', strategy: 'name_only', candidates: 2 });
  });

  it('omits the ambiguous block when no ambiguous site touches the impact set', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({
      edgeStore: store,
      callGraph: {
        ambiguousSites: [
          { callerId: 'unrelated.ts::other', calleeName: 'run', line: 3, strategy: 'name_only', candidateIds: ['x.ts::run', 'y.ts::run'], candidateCount: 2 },
        ],
      },
    } as never);
    const result = await handleAnalyzeImpact(dir, 'entry', 2) as { ambiguousCallSites?: unknown };
    expect(result.ambiguousCallSites).toBeUndefined();
  });

  // Regression: `symbol` is required by the MCP inputSchema, but dispatchTool enforces
  // nothing — a non-conformant caller reaching the handler with an undefined/blank
  // symbol must get a clean error, not an uncaught `undefined.toLowerCase()` crash.
  it('returns a clean error for a missing/blank symbol instead of crashing', async () => {
    vi.mocked(readCachedContext).mockResolvedValue({ edgeStore: store } as never);
    for (const bad of [undefined, '', '   ']) {
      const result = await handleAnalyzeImpact(dir, bad as unknown as string, 2) as { error: string };
      expect(result.error).toBe('symbol is required.');
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Value-level opt-in (spec: add-intraprocedural-cfg-dataflow-overlay).
// `entry(a, b)` calls used(a) on a's data-dependence line and unused(b) on b's;
// a value-level request targeting `a` must narrow downstream to `used` only, while
// the default (no flag) keeps the full function-granularity blast radius.
// ──────────────────────────────────────────────────────────────────────────────
describe('handleAnalyzeImpact — value-level opt-in', () => {
  let dir: string;
  let store: EdgeStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-valuelevel-test-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([
      makeNode({ id: 'src/a.ts::entry',  fanOut: 2 }),
      makeNode({ id: 'src/u.ts::used',   fanIn: 1 }),
      makeNode({ id: 'src/n.ts::unused', fanIn: 1 }),
    ]);
    // entry calls `used` at line 3 and `unused` at line 4.
    store.insertEdges([
      { callerId: 'src/a.ts::entry', calleeId: 'src/u.ts::used',   calleeName: 'used',   confidence: 'import', line: 3 },
      { callerId: 'src/a.ts::entry', calleeId: 'src/n.ts::unused', calleeName: 'unused', confidence: 'import', line: 4 },
    ]);
    // Overlay: param `a` is read at line 3 (used(a)); param `b` at line 4 (unused(b)).
    store.insertCfgs([{
      functionId: 'src/a.ts::entry',
      filePath: 'src/a.ts',
      cfg: {
        blocks: [{ id: 0, kind: 'entry' }, { id: 1, kind: 'exit' }, { id: 2, kind: 'normal' }],
        edges: [{ from: 0, to: 2, kind: 'normal' }, { from: 2, to: 1, kind: 'normal' }],
        params: ['a', 'b'],
        paramLine: 1,
        defUse: [
          { variable: 'a', defLine: 1, useLine: 3, precision: 'exact' },
          { variable: 'b', defLine: 1, useLine: 4, precision: 'exact' },
        ],
      },
    }]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('default impact (no flag) includes both callees', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'entry', 2) as Record<string, unknown>;
    const blast = result.blastRadius as { downstream: number };
    expect(blast.downstream).toBe(2);
    expect(result.valueLevel).toBeUndefined();
  });

  it('value-level on param `a` narrows downstream to the data-dependent callee', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'entry', 2, false, true, 'a') as Record<string, unknown>;
    const blast = result.blastRadius as { downstream: number };
    const downstream = result.downstreamCriticalPath as Array<{ name: string }>;
    expect(blast.downstream).toBe(1);
    expect(downstream.map(d => d.name)).toEqual(['used']);
    const vl = result.valueLevel as { applied: boolean; precision?: string };
    expect(vl.applied).toBe(true);
    // Cross-call dependence is labeled `may` (spec: DataFlowProvenanceLabeling) —
    // the value-level hop crosses the call boundary, which is conservative.
    expect(vl.precision).toContain('may');
  });

  it('falls back to function granularity when the function has no overlay', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    // `used` has no overlay row → value-level request must fall back, not error.
    const result = await handleAnalyzeImpact(dir, 'used', 2, false, true, 'x') as Record<string, unknown>;
    expect((result.valueLevel as { applied: boolean }).applied).toBe(false);
    expect(result.symbol).toBe('used');
  });

  it('falls back (not zero blast radius) when valueParam is not a real parameter', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    // `entry` has an overlay, but `zzz` is not one of its params/locals. The
    // narrowing must NOT silently report 0 callees — it must fall back to the
    // full function-granularity blast radius so a typo can't read as "safe".
    const result = await handleAnalyzeImpact(dir, 'entry', 2, false, true, 'zzz') as Record<string, unknown>;
    const vl = result.valueLevel as { applied: boolean; reason?: string };
    expect(vl.applied).toBe(false);
    expect(vl.reason).toContain('zzz');
    expect((result.blastRadius as { downstream: number }).downstream).toBe(2);
  });

  it('falls back (not throws) when the overlay store errors', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    // A corrupt/erroring overlay must never fail the tool — value-level is
    // strictly best-effort and degrades to the full function-granularity result.
    const spy = vi.spyOn(store, 'getCfg').mockImplementation(() => { throw new Error('boom'); });
    const result = await handleAnalyzeImpact(dir, 'entry', 2, false, true, 'a') as Record<string, unknown>;
    expect((result.valueLevel as { applied: boolean }).applied).toBe(false);
    expect((result.blastRadius as { downstream: number }).downstream).toBe(2);
    spy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// trace_execution_path value-level: first-hop narrowing to the data-dependent
// callee, and fail-soft fallback when the entry has no overlay. `entry(a,b)`
// calls used(a) on a's data-dependence line (3) and unused(b) on b's (4).
// ──────────────────────────────────────────────────────────────────────────────
describe('handleTraceExecutionPath — value-level opt-in', () => {
  let dir: string;
  let store: EdgeStore;
  let cg: SerializedCallGraph;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-trace-vl-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    const nodes = [
      makeNode({ id: 'a.ts::entry',  fanOut: 2 }),
      makeNode({ id: 'u.ts::used',   fanIn: 1 }),
      makeNode({ id: 'n.ts::unused', fanIn: 1 }),
    ];
    const edges: CallEdge[] = [
      { callerId: 'a.ts::entry', calleeId: 'u.ts::used',   calleeName: 'used',   confidence: 'import' as EdgeConfidence, line: 3 },
      { callerId: 'a.ts::entry', calleeId: 'n.ts::unused', calleeName: 'unused', confidence: 'import' as EdgeConfidence, line: 4 },
    ];
    store.insertNodes(nodes);
    store.insertEdges(edges);
    store.insertCfgs([{
      functionId: 'a.ts::entry', filePath: 'a.ts',
      cfg: {
        blocks: [{ id: 0, kind: 'entry' }, { id: 1, kind: 'exit' }, { id: 2, kind: 'normal' }],
        edges: [{ from: 0, to: 2, kind: 'normal' }, { from: 2, to: 1, kind: 'normal' }],
        params: ['a', 'b'], paramLine: 1,
        defUse: [
          { variable: 'a', defLine: 1, useLine: 3, precision: 'exact' },
          { variable: 'b', defLine: 1, useLine: 4, precision: 'exact' },
        ],
      },
    }]);
    cg = makeGraph(nodes, edges);
  });

  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('default trace (no flag) carries no valueLevel block', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: cg, edgeStore: store } as never);
    const r = await handleTraceExecutionPath(dir, 'entry', 'used', 5, 10) as Record<string, unknown>;
    expect((r as { pathsFound: number }).pathsFound).toBeGreaterThanOrEqual(1);
    expect(r.valueLevel).toBeUndefined();
  });

  it('value-level narrows the first hop to the data-dependent callee', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: cg, edgeStore: store } as never);
    // entry→used (call line 3) IS data-dependent on param `a` → reachable.
    const r1 = await handleTraceExecutionPath(dir, 'entry', 'used', 5, 10, false, true, 'a') as { pathsFound: number; valueLevel: { applied: boolean } };
    expect(r1.valueLevel.applied).toBe(true);
    expect(r1.pathsFound).toBeGreaterThanOrEqual(1);
    // entry→unused (call line 4) is NOT data-dependent on `a` → first hop excluded.
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: cg, edgeStore: store } as never);
    const r2 = await handleTraceExecutionPath(dir, 'entry', 'unused', 5, 10, false, true, 'a') as { pathsFound: number; valueLevel: { applied: boolean } };
    expect(r2.valueLevel.applied).toBe(true);
    expect(r2.pathsFound).toBe(0);
  });

  it('falls back (applied:false) when the entry function has no overlay', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: cg, edgeStore: store } as never);
    // `unused` has no overlay row → value-level cannot narrow → unrestricted DFS,
    // reported with applied:false (never a silent empty narrowing).
    const r = await handleTraceExecutionPath(dir, 'unused', 'used', 5, 10, false, true, 'x') as { valueLevel: { applied: boolean } };
    expect(r.valueLevel.applied).toBe(false);
  });

  it('does not let a synthesized data-dependent edge admit an unrelated strict edge', async () => {
    const target = makeNode({ id: 'p.ts::parallel', fanIn: 2 });
    const synthesized = { callerId: 'a.ts::entry', calleeId: target.id, calleeName: 'parallel', confidence: 'synthesized' as const, synthesizedBy: 'callback', line: 3 };
    const direct = { callerId: 'a.ts::entry', calleeId: target.id, calleeName: 'parallel', confidence: 'import' as const, line: 4 };
    store.insertNodes([target]);
    store.insertEdges([synthesized, direct]);
    cg = makeGraph([...cg.nodes, target], [...cg.edges, synthesized, direct]);
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: cg, edgeStore: store } as never);
    const result = await handleTraceExecutionPath(dir, 'entry', 'parallel', 5, 10, true, true, 'a') as { pathsFound: number };
    expect(result.pathsFound).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Symbol resolution — exact-name match is preferred over fuzzy FTS hits.
// searchNodes uses an fts5 trigram index, so a query like "auth" substring-matches
// "authenticate"/"authorize" too. A request for a symbol that DOES exist exactly
// must resolve to that single node (flat result), not an ambiguous { matches }.
// ──────────────────────────────────────────────────────────────────────────────
describe('symbol resolution — exact-match preference', () => {
  let dir: string;
  let store: EdgeStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-exact-match-test-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([
      makeNode({ id: 'src/auth.ts::auth',         fanIn: 3, fanOut: 1 }),
      makeNode({ id: 'src/auth.ts::authenticate', fanIn: 1, fanOut: 1 }),
      makeNode({ id: 'src/auth.ts::authorize',    fanIn: 1, fanOut: 0 }),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('analyze_impact returns the flat exact match (not { matches }) when the symbol exists exactly', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'auth', 2) as { symbol?: string; matches?: unknown[] };
    expect(result.matches).toBeUndefined();
    expect(result.symbol).toBe('auth');
  });

  it('analyze_impact still returns { matches } for an ambiguous query with no exact match', async () => {
    // "authent" substring-matches "authenticate" and "reauthenticate" but no node
    // is named exactly "authent", so the result stays a { matches } disambiguation list.
    store.insertNodes([makeNode({ id: 'src/auth.ts::reauthenticate', fanIn: 0, fanOut: 0 })]);
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'authent', 2) as { symbol?: string; matches?: Array<{ symbol: string }>; confidenceBoundary?: { complete: boolean } };
    expect(result.matches).toBeDefined();
    expect(result.matches!.length).toBeGreaterThan(1);
    expect(result.matches!.map(m => m.symbol)).toContain('authenticate');
    expect(result.matches!.map(m => m.symbol)).toContain('reauthenticate');
    // The boundary is attached to the multi-seed { matches } shape too, not just the flat one.
    expect(typeof result.confidenceBoundary?.complete).toBe('boolean');
  });

  it('get_subgraph resolves the exact symbol when fuzzy hits also exist', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'auth', 'downstream', 2) as { matches?: unknown[]; nodes?: Array<{ name: string }> };
    expect(result.matches).toBeUndefined();
    expect(result.nodes?.map(n => n.name)).toContain('auth');
  });
});

// ============================================================================
// Governing decisions as typed graph neighbors (spec-16)
// ============================================================================
describe('governing decisions — analyze_impact & get_subgraph', () => {
  let dir: string;
  let store: EdgeStore;

  // entry → middle → leaf, with a decision governing the seed's file (src/a.ts).
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-decisions-test-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([
      makeNode({ id: 'src/a.ts::entry',  fanOut: 1 }),
      makeNode({ id: 'src/b.ts::middle', fanIn: 1, fanOut: 1 }),
      makeNode({ id: 'src/c.ts::leaf',   fanIn: 1, fanOut: 0 }),
    ]);
    store.insertEdges([
      makeEdge('src/a.ts::entry',  'src/b.ts::middle'),
      makeEdge('src/b.ts::middle', 'src/c.ts::leaf'),
    ]);
    store.insertDecisions(
      [{
        id: 'decision::c6d1ad07', decisionId: 'c6d1ad07', kind: 'decision',
        title: 'North star is a deterministic substrate', status: 'verified',
        rationale: 'local-first plumbing', consequences: 'features must serve the agent case',
        affectedDomains: ['overview'], affectedFiles: ['src/a.ts'], confidence: 'high',
      }],
      [{ decisionNodeId: 'decision::c6d1ad07', filePath: 'src/a.ts', kind: 'affects' }],
    );
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('analyze_impact returns the governing decision as a typed neighbor (not a code node)', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'entry', 2) as {
      governingDecisions?: Array<{ nodeType: string; id: string; governs: string[]; provenance: string }>;
      upstreamChain: unknown[];
    };
    expect(result.governingDecisions).toBeDefined();
    expect(result.governingDecisions!).toHaveLength(1);
    expect(result.governingDecisions![0]).toMatchObject({
      nodeType: 'decision',
      id: 'c6d1ad07',
      governs: ['src/a.ts'],
      provenance: 'local-unreviewed',
    });
  });

  it('get_subgraph surfaces governing decisions for the subgraph files', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'entry', 'downstream', 2) as {
      governingDecisions?: Array<{ id: string }>;
      stats: { governingDecisions: number };
    };
    expect(result.stats.governingDecisions).toBe(1);
    expect(result.governingDecisions?.map(d => d.id)).toEqual(['c6d1ad07']);
  });

  it('omits the field entirely when no decision governs the touched files', async () => {
    store.clearAll();
    store.insertNodes([makeNode({ id: 'src/x.ts::solo', fanIn: 0, fanOut: 0 })]);
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'solo', 2) as { governingDecisions?: unknown };
    expect(result.governingDecisions).toBeUndefined();
  });
});

// ============================================================================
// Cross-domain impact: code ↔ infrastructure (spec-17)
// ============================================================================
describe('cross-domain impact — analyze_impact', () => {
  let dir: string;
  let store: EdgeStore;

  // handler → deploy (code) --references--> Bucket:logs (Pulumi infra)
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-xdomain-test-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([
      makeNode({ id: 'src/app.ts::handleProvisionRequest', fanOut: 1 }),
      makeNode({ id: 'src/app.ts::deployBucket', fanIn: 1, fanOut: 1 }),
      makeNode({ id: 'src/app.ts::Bucket:logs', language: 'Pulumi', fanIn: 1 }),
    ]);
    store.insertEdges([
      { callerId: 'src/app.ts::handleProvisionRequest', calleeId: 'src/app.ts::deployBucket', calleeName: 'deployBucket', confidence: 'import', kind: 'calls' },
      { callerId: 'src/app.ts::deployBucket', calleeId: 'src/app.ts::Bucket:logs', calleeName: 'Bucket:logs', confidence: 'import', kind: 'references' },
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the provisioned infra as a typed, ecosystem-tagged crossDomain neighbor', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'deployBucket', 2) as {
      crossDomain?: { reachesInfrastructure: boolean; ecosystems: string[]; infrastructure: Array<{ nodeType: string; name: string; ecosystem: string; direction: string }> };
      downstreamCriticalPath: Array<{ name: string }>;
      blastRadius: { infrastructure?: number };
    };
    expect(result.crossDomain?.reachesInfrastructure).toBe(true);
    expect(result.crossDomain?.ecosystems).toEqual(['Pulumi']);
    expect(result.crossDomain?.infrastructure).toEqual([
      { nodeType: 'infrastructure', name: 'Bucket:logs', file: 'src/app.ts', ecosystem: 'Pulumi', direction: 'downstream', depth: 1 },
    ]);
    expect(result.blastRadius.infrastructure).toBe(1);
    // Infra is kept OUT of the pure-code chain.
    expect(result.downstreamCriticalPath.map(n => n.name)).not.toContain('Bucket:logs');
  });

  it('reverse: a code function provisioning the resource shows up as its upstream (what code breaks if I change this resource)', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'Bucket:logs', 2) as {
      symbol?: string; language?: string;
      upstreamChain: Array<{ name: string }>;
      crossDomain?: unknown;
    };
    expect(result.symbol).toBe('Bucket:logs');
    expect(result.language).toBe('Pulumi');
    expect(result.upstreamChain.map(n => n.name)).toContain('deployBucket');
    // The resource's neighbors here are all code → no infra crossDomain bucket.
    expect(result.crossDomain).toBeUndefined();
  });

  it('omits crossDomain entirely for a pure-code impact', async () => {
    store.clearAll();
    store.insertNodes([
      makeNode({ id: 'src/a.ts::foo', fanOut: 1 }),
      makeNode({ id: 'src/b.ts::bar', fanIn: 1 }),
    ]);
    store.insertEdges([{ callerId: 'src/a.ts::foo', calleeId: 'src/b.ts::bar', calleeName: 'bar', confidence: 'import', kind: 'calls' }]);
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'foo', 2) as { crossDomain?: unknown; blastRadius: { infrastructure?: number } };
    expect(result.crossDomain).toBeUndefined();
    expect(result.blastRadius.infrastructure).toBeUndefined();
  });
});

// ============================================================================
// buildWeightedAdjacency + weightedBfs (call-distance scoping)
// ============================================================================

function edgeC(callerId: string, calleeId: string, confidence: EdgeConfidence): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1] ?? calleeId, confidence };
}

describe('buildWeightedAdjacency', () => {
  it('weights edges by call-distance and excludes external (Infinity) edges', () => {
    const a = makeNode({ id: 'a.ts::a' });
    const b = makeNode({ id: 'b.ts::b' });
    const ext = makeNode({ id: 'external::fetch', isExternal: true });
    const cg = makeGraph([a, b, ext], [
      edgeC(a.id, b.id, 'import'),       // cost 1
      edgeC(a.id, ext.id, 'external'),   // Infinity → omitted
    ]);

    const { forward, backward } = buildWeightedAdjacency(cg);
    expect(forward.get(a.id)).toEqual([{ to: b.id, cost: 1 }]);
    expect(backward.get(b.id)).toEqual([{ to: a.id, cost: 1 }]);
    // external edge omitted entirely
    expect(forward.get(a.id)!.some(e => e.to === ext.id)).toBe(false);
  });

  it('only includes call edges, not tested_by / other kinds', () => {
    const a = makeNode({ id: 'a.ts::a' });
    const t = makeNode({ id: 'a.test.ts::t' });
    const cg = makeGraph([a, t], [
      { callerId: a.id, calleeId: t.id, calleeName: 't', confidence: 'import', kind: 'tested_by' },
    ]);
    const { forward } = buildWeightedAdjacency(cg);
    expect(forward.get(a.id)).toBeUndefined();
  });
});

describe('weightedBfs', () => {
  it('accumulates minimal distance, hops, and a reconstructable predecessor chain', () => {
    // A →(import,1) B →(name_only,3) C
    const a = makeNode({ id: 'a.ts::a' });
    const b = makeNode({ id: 'b.ts::b' });
    const c = makeNode({ id: 'c.ts::c' });
    const cg = makeGraph([a, b, c], [
      edgeC(a.id, b.id, 'import'),
      edgeC(b.id, c.id, 'name_only'),
    ]);
    const { forward } = buildWeightedAdjacency(cg);

    const reach = weightedBfs([a.id], forward, 10);
    expect(reach.get(a.id)).toEqual({ distance: 0, hops: 0, predecessor: null });
    expect(reach.get(b.id)).toEqual({ distance: 1, hops: 1, predecessor: a.id });
    expect(reach.get(c.id)).toEqual({ distance: 4, hops: 2, predecessor: b.id });

    // Reconstruct the cheapest path C → B → A via predecessors.
    const path: string[] = [];
    for (let cur: string | null = c.id; cur; cur = reach.get(cur)!.predecessor) path.push(cur);
    expect(path).toEqual([c.id, b.id, a.id]);
  });

  it('prefers the strong longer path over a weak shorter one (cost, not hops)', () => {
    // A →(name_only,3) Z  (1 hop, distance 3)
    // A →(import,1) M →(import,1) Z  (2 hops, distance 2)  ← cheaper
    const a = makeNode({ id: 'a.ts::a' });
    const m = makeNode({ id: 'm.ts::m' });
    const z = makeNode({ id: 'z.ts::z' });
    const cg = makeGraph([a, m, z], [
      edgeC(a.id, z.id, 'name_only'),
      edgeC(a.id, m.id, 'import'),
      edgeC(m.id, z.id, 'import'),
    ]);
    const { forward } = buildWeightedAdjacency(cg);
    const reach = weightedBfs([a.id], forward, 10);
    expect(reach.get(z.id)).toEqual({ distance: 2, hops: 2, predecessor: m.id });
  });

  it('does not expand nodes beyond the distance budget', () => {
    // A →(name_only,3) B — budget 2 excludes B.
    const a = makeNode({ id: 'a.ts::a' });
    const b = makeNode({ id: 'b.ts::b' });
    const cg = makeGraph([a, b], [edgeC(a.id, b.id, 'name_only')]);
    const { forward } = buildWeightedAdjacency(cg);
    const reach = weightedBfs([a.id], forward, 2);
    expect(reach.has(b.id)).toBe(false);
    expect(reach.has(a.id)).toBe(true);
  });
});

// ============================================================================
// confidenceBoundary wiring — every graph conclusion handler attaches the field,
// reports a complete boundary on an all-direct answer, and an incomplete one that
// discloses the crossing when the traversal leaned on a synthesized edge.
// (spec: add-confidence-boundary-disclosure)
// ============================================================================

type Boundary = {
  complete: boolean;
  basis?: { directEdges: number; synthesizedEdges: number; synthesizedByRule?: Record<string, number> };
  knownUnknowable?: Array<{ kind: string; rule?: string }>;
};

function synthEdge(callerId: string, calleeId: string, rule = 'cha-name-only'): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1] ?? calleeId, confidence: 'synthesized', kind: 'calls', synthesizedBy: rule };
}

describe('confidenceBoundary wiring — handleGetSubgraph', () => {
  let dir: string;
  let store: EdgeStore;
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('reports complete with an all-direct basis (no fingerprint → staleness silent)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cb-subgraph-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([makeNode({ id: 'src/a.ts::entry', fanOut: 1 }), makeNode({ id: 'src/b.ts::leaf' })]);
    store.insertEdges([makeEdge('src/a.ts::entry', 'src/b.ts::leaf')]);
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);

    const b = (await handleGetSubgraph(dir, 'entry', 'downstream', 2) as { confidenceBoundary: Boundary }).confidenceBoundary;
    expect(b.complete).toBe(true);
    expect(b.basis!.directEdges).toBeGreaterThanOrEqual(1);
    expect(b.basis!.synthesizedEdges).toBe(0);
    expect(b.knownUnknowable).toBeUndefined();
  });

  it('reports incomplete and discloses the crossing when a subgraph edge is synthesized', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cb-subgraph-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([makeNode({ id: 'src/a.ts::entry', fanOut: 1 }), makeNode({ id: 'src/b.ts::leaf' })]);
    store.insertEdges([synthEdge('src/a.ts::entry', 'src/b.ts::leaf')]);
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);

    const b = (await handleGetSubgraph(dir, 'entry', 'downstream', 2) as { confidenceBoundary: Boundary }).confidenceBoundary;
    expect(b.complete).toBe(false);
    expect(b.basis!.synthesizedEdges).toBeGreaterThanOrEqual(1);
    expect(b.knownUnknowable![0].kind).toBe('synthesized-dispatch');
  });
});

describe('confidenceBoundary wiring — handleAnalyzeImpact', () => {
  let dir: string;
  let store: EdgeStore;
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('reports complete with an all-direct impact neighborhood', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cb-impact-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([makeNode({ id: 'src/a.ts::entry', fanOut: 1 }), makeNode({ id: 'src/b.ts::leaf', fanIn: 1 })]);
    store.insertEdges([makeEdge('src/a.ts::entry', 'src/b.ts::leaf')]);
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);

    const b = (await handleAnalyzeImpact(dir, 'entry', 2) as { confidenceBoundary: Boundary }).confidenceBoundary;
    expect(b.complete).toBe(true);
    expect(b.basis!.synthesizedEdges).toBe(0);
  });

  it('reports incomplete when an edge inside the impact set is synthesized', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cb-impact-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([makeNode({ id: 'src/a.ts::entry', fanOut: 1 }), makeNode({ id: 'src/b.ts::leaf', fanIn: 1 })]);
    store.insertEdges([synthEdge('src/a.ts::entry', 'src/b.ts::leaf', 'route-handler')]);
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);

    const b = (await handleAnalyzeImpact(dir, 'entry', 2) as { confidenceBoundary: Boundary }).confidenceBoundary;
    expect(b.complete).toBe(false);
    expect(b.basis!.synthesizedByRule).toMatchObject({ 'route-handler': expect.any(Number) });
    expect(b.knownUnknowable!.some(c => c.rule === 'route-handler')).toBe(true);
  });
});

describe('confidenceBoundary wiring — handleTraceExecutionPath', () => {
  it('reports complete on an all-direct path', async () => {
    const nodes = [makeNode({ id: 'a.ts::p', fanOut: 1 }), makeNode({ id: 'b.ts::q', fanOut: 1 }), makeNode({ id: 'c.ts::r' })];
    const edges = [makeEdge('a.ts::p', 'b.ts::q'), makeEdge('b.ts::q', 'c.ts::r')];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, edges) } as never);

    const b = (await handleTraceExecutionPath('/tmp/proj', 'p', 'r') as { confidenceBoundary: Boundary }).confidenceBoundary;
    expect(b.complete).toBe(true);
    expect(b.basis!.directEdges).toBeGreaterThanOrEqual(1);
  });

  it('reports incomplete when the returned path crosses a synthesized edge', async () => {
    const nodes = [makeNode({ id: 'a.ts::p', fanOut: 1 }), makeNode({ id: 'b.ts::q', fanOut: 1 }), makeNode({ id: 'c.ts::r' })];
    const edges = [makeEdge('a.ts::p', 'b.ts::q'), synthEdge('b.ts::q', 'c.ts::r', 'callback-registration')];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, edges) } as never);

    const b = (await handleTraceExecutionPath('/tmp/proj', 'p', 'r') as { confidenceBoundary: Boundary }).confidenceBoundary;
    expect(b.complete).toBe(false);
    expect(b.knownUnknowable!.some(c => c.rule === 'callback-registration')).toBe(true);
  });

  it('attaches a boundary even on the no-path result', async () => {
    const nodes = [makeNode({ id: 'f.ts::x' }), makeNode({ id: 'f.ts::y' })];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, []) } as never);

    const r = await handleTraceExecutionPath('/tmp/proj', 'x', 'y') as { pathsFound: number; confidenceBoundary: Boundary };
    expect(r.pathsFound).toBe(0);
    expect(r.confidenceBoundary.complete).toBe(true); // empty basis, current index
  });
});
