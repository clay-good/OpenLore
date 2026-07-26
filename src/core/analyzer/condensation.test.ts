/**
 * Golden equivalence suite for the precomputed traversal structure
 * (change: optimize-reachability-precompute).
 *
 * The change's whole contract is "same answers, only faster", so the oracle here
 * is the code it replaces: `buildAdjacency` + the per-call BFS shapes the handlers
 * used (`bfs`, `reachableFrom`, `reachAll`, and the sorted-neighbour parent walk
 * inside `select_tests`). Those oracles are re-implemented verbatim in this file
 * so the suite keeps testing the OLD behaviour even after the handlers migrate.
 *
 * Coverage is randomized over graph shapes that historically break traversal
 * rewrites: cycles (self-loops, 2-cycles, large SCCs), synthesized edges mixed
 * with direct ones on the SAME caller→callee pair, duplicate edges, external
 * callee ids absent from `cg.nodes`, and fully disconnected regions.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTraversalIndex,
  serializeTraversalIndex,
  deserializeTraversalIndex,
  TRAVERSAL_INDEX_VERSION,
  type TraversalIndex,
  type Direction,
  type TraversalFilter,
} from './condensation.js';
import type { CallEdge, FunctionNode, SerializedCallGraph } from './call-graph.js';

// ============================================================================
// ORACLES — the pre-migration implementations, frozen here on purpose.
// ============================================================================

function oracleAdjacency(cg: SerializedCallGraph, opts?: { directResolvedOnly?: boolean }) {
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const forward = new Map<string, Set<string>>();
  const backward = new Map<string, Set<string>>();
  for (const n of cg.nodes) {
    forward.set(n.id, new Set());
    backward.set(n.id, new Set());
  }
  for (const e of cg.edges) {
    if (!e.calleeId) continue;
    if (opts?.directResolvedOnly && e.confidence === 'synthesized') continue;
    if (!forward.has(e.calleeId)) forward.set(e.calleeId, new Set());
    if (!backward.has(e.calleeId)) backward.set(e.calleeId, new Set());
    forward.get(e.callerId)?.add(e.calleeId);
    backward.get(e.calleeId)?.add(e.callerId);
  }
  return { nodeMap, forward, backward };
}

/** graph.ts `bfs` — depth-bounded, CSR-order neighbours. */
function oracleBfs(seeds: string[], adjacency: Map<string, Set<string>>, maxDepth: number): Map<string, number> {
  const visited = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = seeds.map(id => ({ id, depth: 0 }));
  for (const id of seeds) visited.set(id, 0);
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    for (const nId of adjacency.get(id) ?? []) {
      if (!visited.has(nId)) {
        visited.set(nId, depth + 1);
        queue.push({ id: nId, depth: depth + 1 });
      }
    }
  }
  return visited;
}

/** reachability.ts `reachableFrom` — unbounded, with delete-mode exclusion. */
function oracleReach(seeds: string[], forward: Map<string, Set<string>>, excludeId?: string): Set<string> {
  const live = new Set<string>();
  const queue: string[] = [];
  for (const s of seeds) {
    if (s === excludeId || live.has(s)) continue;
    live.add(s); queue.push(s);
  }
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of forward.get(id) ?? []) {
      if (next === excludeId || live.has(next)) continue;
      live.add(next); queue.push(next);
    }
  }
  return live;
}

/** test-impact.ts's backward walk — sorted neighbours, with parent tracking. */
function oracleSortedBfs(seeds: string[], adjacency: Map<string, Set<string>>, maxDepth: number) {
  const depthOf = new Map<string, number>();
  const parent = new Map<string, string>();
  const queue: Array<{ id: string; depth: number }> = [];
  for (const s of seeds) { depthOf.set(s, 0); queue.push({ id: s, depth: 0 }); }
  while (queue.length) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    for (const caller of [...(adjacency.get(id) ?? [])].sort()) {
      if (!depthOf.has(caller)) {
        depthOf.set(caller, depth + 1);
        parent.set(caller, id);
        queue.push({ id: caller, depth: depth + 1 });
      }
    }
  }
  return { depthOf, parent };
}

// ============================================================================
// GRAPH GENERATION
// ============================================================================

function makeNode(id: string, over: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id,
    name: id.split('::')[1] ?? id,
    filePath: id.split('::')[0] ?? 'test.ts',
    isAsync: false,
    language: 'typescript',
    startIndex: 0,
    endIndex: 10,
    fanIn: 0,
    fanOut: 0,
    ...over,
  } as FunctionNode;
}

function makeGraph(nodes: FunctionNode[], edges: CallEdge[]): SerializedCallGraph {
  return {
    nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [],
    layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
  } as unknown as SerializedCallGraph;
}

function edge(from: string, to: string, synthesized = false): CallEdge {
  return {
    callerId: from,
    calleeId: to,
    calleeName: to.split('::')[1] ?? to,
    confidence: synthesized ? 'synthesized' : 'name_only',
    ...(synthesized ? { synthesizedBy: 'route-handler' } : {}),
  } as CallEdge;
}

/** Deterministic PRNG so a failure is always reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A randomized graph that deliberately contains every shape that breaks naive
 * traversal rewrites: back edges (cycles/SCCs), self-loops, duplicate pairs,
 * mixed direct+synthesized on one pair, callee ids missing from `nodes`
 * (external leaves), and isolated nodes.
 */
function randomGraph(seed: number, nodeCount = 40): SerializedCallGraph {
  const rnd = mulberry32(seed);
  const nodes = Array.from({ length: nodeCount }, (_, i) => makeNode(`f${i % 5}.ts::fn${i}`));
  const ids = nodes.map(n => n.id);
  const edges: CallEdge[] = [];
  const edgeCount = Math.floor(nodeCount * (1 + rnd() * 2));
  for (let k = 0; k < edgeCount; k++) {
    const a = ids[Math.floor(rnd() * ids.length)];
    const r = rnd();
    let b: string;
    if (r < 0.12) b = `external::lib${Math.floor(rnd() * 4)}`; // external leaf, not in nodes
    else b = ids[Math.floor(rnd() * ids.length)];             // may be `a` → self-loop
    const synthesized = rnd() < 0.3;
    edges.push(edge(a, b, synthesized));
    // Duplicate the pair with the opposite confidence sometimes — the exact case
    // where a naive pre-deduplicated CSR diverges from the per-call filtered Set.
    if (rnd() < 0.15) edges.push(edge(a, b, !synthesized));
  }
  // A guaranteed 4-cycle so at least one non-trivial SCC always exists.
  if (ids.length >= 4) {
    edges.push(edge(ids[0], ids[1]), edge(ids[1], ids[2]), edge(ids[2], ids[3]), edge(ids[3], ids[0]));
  }
  // A guaranteed edge whose caller is absent from `nodes` — it must contribute to
  // backward adjacency only (buildAdjacency's optional-chain drop on forward).
  edges.push(edge('ghost.ts::ghostCaller', ids[0] ?? 'x'));
  return makeGraph(nodes, edges);
}

const SEEDS = [1, 2, 3, 7, 11, 42, 1337, 99991];
const FILTERS: Array<TraversalFilter | undefined> = [undefined, { directResolvedOnly: true }];
const DIRECTIONS: Direction[] = ['forward', 'backward'];

function everyId(cg: SerializedCallGraph): string[] {
  const s = new Set<string>();
  for (const n of cg.nodes) s.add(n.id);
  for (const e of cg.edges) { s.add(e.callerId); if (e.calleeId) s.add(e.calleeId); }
  return [...s].sort();
}

// ============================================================================
// EQUIVALENCE
// ============================================================================

describe('traversal index — neighbour equivalence with buildAdjacency', () => {
  it.each(SEEDS)('seed %i: every node, both directions, both filters', seed => {
    const cg = randomGraph(seed);
    const ix = buildTraversalIndex(cg);
    for (const filter of FILTERS) {
      const adj = oracleAdjacency(cg, filter);
      for (const dir of DIRECTIONS) {
        const map = dir === 'forward' ? adj.forward : adj.backward;
        for (const id of everyId(cg)) {
          // Order matters: `trace_execution_path` enumerates the first N paths in
          // neighbour order, so a reordering is an observable payload change.
          expect(ix.neighborIds(id, dir, filter)).toEqual([...(map.get(id) ?? [])]);
        }
      }
    }
  });

  it('an id outside the graph has no neighbours (matches `adjacency.get(x) ?? []`)', () => {
    const ix = buildTraversalIndex(randomGraph(5));
    expect(ix.neighborIds('nope::nope', 'forward')).toEqual([]);
    expect(ix.hasNode('nope::nope')).toBe(false);
    expect(ix.indexOf('nope::nope')).toBe(-1);
  });
});

describe('traversal index — unbounded reach equivalence (reachAll / reachableFrom)', () => {
  it.each(SEEDS)('seed %i: reach from every single seed, both directions, both filters', seed => {
    const cg = randomGraph(seed);
    const ix = buildTraversalIndex(cg);
    const ids = everyId(cg);
    for (const filter of FILTERS) {
      const adj = oracleAdjacency(cg, filter);
      for (const dir of DIRECTIONS) {
        const map = dir === 'forward' ? adj.forward : adj.backward;
        for (const start of ids) {
          const expected = oracleReach([start], map);
          const got = ix.reachAll([start], dir, filter);
          expect([...got].sort()).toEqual([...expected].sort());
        }
      }
    }
  });

  it.each(SEEDS)('seed %i: multi-seed reach, and delete-mode exclusion', seed => {
    const cg = randomGraph(seed);
    const ix = buildTraversalIndex(cg);
    const ids = everyId(cg);
    const adj = oracleAdjacency(cg);
    const seeds = ids.filter((_, i) => i % 7 === 0);
    expect([...ix.reachAll(seeds, 'forward')].sort()).toEqual([...oracleReach(seeds, adj.forward)].sort());
    for (const excluded of ids.filter((_, i) => i % 5 === 0)) {
      expect([...ix.reachAll(seeds, 'forward', undefined, excluded)].sort())
        .toEqual([...oracleReach(seeds, adj.forward, excluded)].sort());
    }
  });

  it('a seed that is not in the graph is reached but expands to nothing', () => {
    const cg = randomGraph(3);
    const ix = buildTraversalIndex(cg);
    const adj = oracleAdjacency(cg);
    const seeds = ['not::in::graph', cg.nodes[0].id];
    expect([...ix.reachAll(seeds, 'forward')].sort()).toEqual([...oracleReach(seeds, adj.forward)].sort());
    expect(ix.reachAll(['not::in::graph'], 'forward').has('not::in::graph')).toBe(true);
  });
});

describe('traversal index — depth-bounded BFS equivalence', () => {
  it.each(SEEDS)('seed %i: bfsDepths matches graph.ts `bfs` at every depth', seed => {
    const cg = randomGraph(seed);
    const ix = buildTraversalIndex(cg);
    const ids = everyId(cg);
    for (const filter of FILTERS) {
      const adj = oracleAdjacency(cg, filter);
      for (const dir of DIRECTIONS) {
        const map = dir === 'forward' ? adj.forward : adj.backward;
        for (const maxDepth of [1, 2, 3, 12]) {
          const start = [ids[seed % ids.length]];
          const expected = oracleBfs(start, map, maxDepth);
          const got = ix.bfsDepths(start, dir, maxDepth, filter);
          expect([...got.entries()].sort()).toEqual([...expected.entries()].sort());
        }
      }
    }
  });

  it.each(SEEDS)('seed %i: sorted-neighbour BFS matches select_tests depth AND parent chains', seed => {
    const cg = randomGraph(seed);
    const ix = buildTraversalIndex(cg);
    const ids = everyId(cg);
    const adj = oracleAdjacency(cg);
    for (const maxDepth of [1, 3, 12]) {
      const start = [ids[(seed * 3) % ids.length], ids[(seed * 5) % ids.length]];
      const expected = oracleSortedBfs(start, adj.backward, maxDepth);
      const got = ix.bfsWithParents(start, 'backward', maxDepth, undefined, { sortNeighbors: true });
      expect([...got.depth.entries()].sort()).toEqual([...expected.depthOf.entries()].sort());
      // The parent chain drives `viaPath` in select_tests' payload — it must be
      // identical, not merely a valid alternative path.
      expect([...got.parent.entries()].sort()).toEqual([...expected.parent.entries()].sort());
    }
  });
});

// ============================================================================
// CONDENSATION PROPERTIES
// ============================================================================

describe('condensation', () => {
  it('collapses a cycle into one component and reaches every member from any member', () => {
    const nodes = ['a', 'b', 'c'].map(n => makeNode(`x.ts::${n}`));
    const cg = makeGraph(nodes, [
      edge('x.ts::a', 'x.ts::b'), edge('x.ts::b', 'x.ts::c'), edge('x.ts::c', 'x.ts::a'),
    ]);
    const ix = buildTraversalIndex(cg);
    expect(ix.componentCount).toBe(1);
    for (const n of nodes) {
      expect([...ix.reachAll([n.id], 'forward')].sort()).toEqual(nodes.map(m => m.id).sort());
    }
  });

  it('a self-loop is a single-member component and does not hang the walk', () => {
    const cg = makeGraph([makeNode('x.ts::a')], [edge('x.ts::a', 'x.ts::a')]);
    const ix = buildTraversalIndex(cg);
    expect(ix.componentCount).toBe(1);
    expect([...ix.reachAll(['x.ts::a'], 'forward')]).toEqual(['x.ts::a']);
  });

  it('disconnected regions stay disconnected', () => {
    const cg = makeGraph(
      ['a', 'b', 'c', 'd'].map(n => makeNode(`x.ts::${n}`)),
      [edge('x.ts::a', 'x.ts::b'), edge('x.ts::c', 'x.ts::d')],
    );
    const ix = buildTraversalIndex(cg);
    expect([...ix.reachAll(['x.ts::a'], 'forward')].sort()).toEqual(['x.ts::a', 'x.ts::b']);
    expect([...ix.reachAll(['x.ts::c'], 'forward')].sort()).toEqual(['x.ts::c', 'x.ts::d']);
  });

  it.each(SEEDS)('seed %i: components are numbered in reverse topological order', seed => {
    // The condensation walk reads `topoOrder` rather than re-deriving this, but the
    // invariant it rests on — Tarjan closes a component only after everything it
    // reaches — is pinned here so a future refactor cannot silently break it.
    const cg = randomGraph(seed);
    const ix = buildTraversalIndex(cg);
    for (const id of everyId(cg)) {
      const c = ix.componentOf(id);
      for (const n of ix.neighborIds(id, 'forward')) {
        const cn = ix.componentOf(n);
        if (cn !== c) expect(cn).toBeLessThan(c);
      }
    }
  });
});

// ============================================================================
// SERIALIZATION
// ============================================================================

describe('traversal index — persistence round-trip', () => {
  function sameAnswers(a: TraversalIndex, b: TraversalIndex, cg: SerializedCallGraph) {
    expect(b.nodeCount).toBe(a.nodeCount);
    expect(b.edgeCount).toBe(a.edgeCount);
    expect(b.componentCount).toBe(a.componentCount);
    for (const filter of FILTERS) {
      for (const dir of DIRECTIONS) {
        for (const id of everyId(cg)) {
          expect(b.neighborIds(id, dir, filter)).toEqual(a.neighborIds(id, dir, filter));
          expect([...b.reachAll([id], dir, filter)].sort())
            .toEqual([...a.reachAll([id], dir, filter)].sort());
        }
      }
    }
  }

  it.each(SEEDS)('seed %i: a rehydrated index answers identically to a freshly built one', seed => {
    const cg = randomGraph(seed);
    const built = buildTraversalIndex(cg);
    const loaded = deserializeTraversalIndex(serializeTraversalIndex(cg, 'digest-1'), 'digest-1');
    expect(loaded).not.toBeNull();
    sameAnswers(built, loaded!, cg);
  });

  it('a structure whose digest does not match the graph is refused, never traversed', () => {
    const raw = serializeTraversalIndex(randomGraph(1), 'digest-of-generation-A');
    expect(deserializeTraversalIndex(raw, 'digest-of-generation-B')).toBeNull();
    expect(deserializeTraversalIndex(raw, '')).toBeNull();
  });

  it('a wrong-version, foreign-endian, or corrupt artifact is refused', () => {
    const raw = serializeTraversalIndex(randomGraph(1), 'd');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(deserializeTraversalIndex(JSON.stringify({ ...parsed, version: TRAVERSAL_INDEX_VERSION + 1 }), 'd')).toBeNull();
    expect(deserializeTraversalIndex(JSON.stringify({ ...parsed, littleEndian: !parsed.littleEndian }), 'd')).toBeNull();
    expect(deserializeTraversalIndex(JSON.stringify({ ...parsed, nodeIds: [] }), 'd')).toBeNull();
    expect(deserializeTraversalIndex(JSON.stringify({ ...parsed, arrays: {} }), 'd')).toBeNull();
    expect(deserializeTraversalIndex('not json', 'd')).toBeNull();
    expect(deserializeTraversalIndex('null', 'd')).toBeNull();
    expect(deserializeTraversalIndex('[]', 'd')).toBeNull();

    // Truncated CSR: offsets no longer index the targets array.
    const arrays = { ...(parsed.arrays as Record<string, string>) };
    arrays.fwdTargets = Buffer.from(new Int32Array([1, 2]).buffer).toString('base64');
    expect(deserializeTraversalIndex(JSON.stringify({ ...parsed, arrays }), 'd')).toBeNull();

    // Duplicate node ids would make indexOf ambiguous.
    const dupIds = [...(parsed.nodeIds as string[])];
    if (dupIds.length > 1) {
      dupIds[1] = dupIds[0];
      expect(deserializeTraversalIndex(JSON.stringify({ ...parsed, nodeIds: dupIds }), 'd')).toBeNull();
    }
  });
});

describe('traversal index — degenerate inputs', () => {
  it('an empty graph builds, serializes, and answers empty', () => {
    const cg = makeGraph([], []);
    const ix = buildTraversalIndex(cg);
    expect(ix.nodeCount).toBe(0);
    expect(ix.componentCount).toBe(0);
    expect([...ix.reachAll([], 'forward')]).toEqual([]);
    const loaded = deserializeTraversalIndex(serializeTraversalIndex(cg, 'd'), 'd');
    expect(loaded?.nodeCount).toBe(0);
  });

  it('edges with no calleeId are skipped, exactly as buildAdjacency skips them', () => {
    const cg = makeGraph([makeNode('x.ts::a')], [
      { callerId: 'x.ts::a', calleeName: 'unresolved', confidence: 'name_only' } as CallEdge,
    ]);
    const ix = buildTraversalIndex(cg);
    expect(ix.neighborIds('x.ts::a', 'forward')).toEqual([]);
    expect(ix.edgeCount).toBe(0);
  });

  it('a deep chain does not overflow the stack (iterative Tarjan)', () => {
    const n = 20_000;
    const nodes = Array.from({ length: n }, (_, i) => makeNode(`x.ts::f${i}`));
    const edges = Array.from({ length: n - 1 }, (_, i) => edge(`x.ts::f${i}`, `x.ts::f${i + 1}`));
    const ix = buildTraversalIndex(makeGraph(nodes, edges));
    expect(ix.componentCount).toBe(n);
    expect(ix.reachAll(['x.ts::f0'], 'forward').size).toBe(n);
    expect(ix.reachAll([`x.ts::f${n - 1}`], 'backward').size).toBe(n);
  });
});
