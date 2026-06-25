import { describe, it, expect } from 'vitest';
import {
  computeFootprint,
  classifyHazard,
  ambientFanInThreshold,
  type Footprint,
  type WriteMode,
} from './change-footprint.js';
import { buildAdjacency, bfs } from './graph.js';
import type { FunctionNode, CallEdge, SerializedCallGraph } from '../../analyzer/call-graph.js';
import type { FileChangeCoupling } from '../../provenance/change-coupling.js';

// ---- fixture builders (mirrors landmark-signals.test.ts) ----

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  const [filePath, rest] = over.id.split('::');
  return {
    name: rest ?? over.id,
    filePath: filePath ?? 'x.ts',
    isAsync: false,
    language: 'typescript',
    startIndex: 0,
    endIndex: 1,
    fanIn: 0,
    fanOut: 0,
    ...over,
  };
}

function edge(callerId: string, calleeId: string, confidence: CallEdge['confidence'] = 'import'): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1] ?? calleeId, confidence, kind: 'calls' };
}

function graph(nodes: FunctionNode[], edges: CallEdge[] = []): SerializedCallGraph {
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

/** A four-symbol chain: entry → main → {greet → emit, emit}. */
function chainGraph(): SerializedCallGraph {
  const nodes = [
    node({ id: 'a.ts::entry', fanIn: 0 }),
    node({ id: 'a.ts::main', fanIn: 1 }),
    node({ id: 'a.ts::greet', fanIn: 1 }),
    node({ id: 'a.ts::emit', fanIn: 2 }),
  ];
  const edges = [
    edge('a.ts::entry', 'a.ts::main'),
    edge('a.ts::main', 'a.ts::greet'),
    edge('a.ts::main', 'a.ts::emit'),
    edge('a.ts::greet', 'a.ts::emit'),
  ];
  return graph(nodes, edges);
}

/** Build a minimal Footprint literal for classifier-only tests. */
function fp(
  taskId: string,
  writes: Array<{ id: string; mode?: WriteMode; file?: string }>,
  over: Partial<Footprint> = {},
): Footprint {
  return {
    taskId,
    writeSet: writes.map(w => ({
      id: w.id,
      name: w.id.split('::')[1] ?? w.id,
      filePath: w.file ?? w.id.split('::')[0] ?? 'x.ts',
      writeMode: w.mode ?? 'modify',
    })),
    readSet: [],
    ambientReadDeps: [],
    affectedSet: [],
    couplingNeighbors: [],
    unresolvedSeeds: [],
    advisory: true,
    disclosure: 'd',
    ...over,
  };
}

// ---- footprint computation ----

describe('computeFootprint — three regions', () => {
  it('expands a single symbol seed into write / read / affected regions', () => {
    const g = chainGraph();
    const f = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::main'] });

    expect(f.writeSet.map(w => w.id)).toEqual(['a.ts::main']);
    // read-set == forward call closure of the write-set
    expect(f.readSet).toEqual(['a.ts::greet', 'a.ts::emit'].sort());
    // affected-set == backward reachability (== blast radius) of the write-set
    expect(f.affectedSet).toEqual(['a.ts::entry']);
  });

  it('the affected-set equals an independent backward blast-radius computation', () => {
    const g = chainGraph();
    const f = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::main'] });
    const { backward } = buildAdjacency(g);
    const blast = [...bfs(['a.ts::main'], backward, 2).keys()]
      .filter(id => id !== 'a.ts::main')
      .sort();
    expect(f.affectedSet).toEqual(blast);
  });

  it('resolves a file seed to every symbol in the file (enclosing scope)', () => {
    const g = chainGraph();
    const f = computeFootprint(g, { id: 't1', seedFiles: ['a.ts'] });
    expect(f.writeSet.map(w => w.id).sort()).toEqual(
      ['a.ts::entry', 'a.ts::main', 'a.ts::greet', 'a.ts::emit'].sort(),
    );
  });

  it('the write-set is declared (advisory), not inferred, and carries the disclosure', () => {
    const g = chainGraph();
    const f = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::main'] });
    expect(f.advisory).toBe(true);
    expect(f.disclosure).toMatch(/declared\/advisory/);
    // declared only — no heuristic prediction of extra edit targets
    expect(f.writeSet.map(w => w.id)).toEqual(['a.ts::main']);
    expect(f.writeSet[0].writeMode).toBe('modify');
  });

  it('carries a caller-declared append writeMode without inferring it', () => {
    const g = chainGraph();
    const f = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::main'], writeMode: 'append' });
    expect(f.writeSet[0].writeMode).toBe('append');
  });

  it('an unresolved seed yields an empty footprint with an explicit note (no fabricated region)', () => {
    const g = chainGraph();
    const f = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::doesNotExist'] });
    expect(f.writeSet).toEqual([]);
    expect(f.readSet).toEqual([]);
    expect(f.affectedSet).toEqual([]);
    expect(f.unresolvedSeeds).toEqual(['a.ts::doesNotExist']);
  });

  it('is byte-identical across re-evaluations of a fixed state (determinism)', () => {
    const g = chainGraph();
    const a = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::main'] });
    const b = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::main'] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('merges seedFiles and seedSymbols and de-duplicates an overlapping seed', () => {
    const g = chainGraph();
    // the file seed pulls in every symbol; the symbol seed names one already in it.
    const f = computeFootprint(g, { id: 't1', seedFiles: ['a.ts'], seedSymbols: ['a.ts::main'] });
    const ids = f.writeSet.map(w => w.id);
    expect(ids.sort()).toEqual(['a.ts::entry', 'a.ts::main', 'a.ts::greet', 'a.ts::emit'].sort());
    // 'a.ts::main' came from both seeds but appears exactly once (Set-deduped write-set).
    expect(ids.filter(id => id === 'a.ts::main')).toHaveLength(1);
  });

  it('partial resolution: a real footprint is still computed and the bad seed is noted', () => {
    const g = chainGraph();
    const f = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::main', 'a.ts::ghost'] });
    // the good seed produces a full footprint...
    expect(f.writeSet.map(w => w.id)).toEqual(['a.ts::main']);
    expect(f.readSet).toEqual(['a.ts::greet', 'a.ts::emit'].sort());
    expect(f.affectedSet).toEqual(['a.ts::entry']);
    // ...AND the unresolved seed is still disclosed (not the empty-footprint short-circuit).
    expect(f.unresolvedSeeds).toEqual(['a.ts::ghost']);
  });

  it('widens the write-set via the caller-injected extraSeedIds seam (proposal-2 semantic search)', () => {
    const g = chainGraph();
    // The core never searches; the caller resolves `intent` to candidate ids and injects them here.
    const f = computeFootprint(
      g,
      { id: 't1', seedSymbols: ['a.ts::main'], intent: 'greeting path' },
      { extraSeedIds: ['a.ts::greet'] },
    );
    expect(f.writeSet.map(w => w.id).sort()).toEqual(['a.ts::greet', 'a.ts::main'].sort());
    // a symbol promoted into the write-set is no longer counted as "read".
    expect(f.readSet).not.toContain('a.ts::greet');
    expect(f.readSet).toEqual(['a.ts::emit']);
  });

  it('an unresolved extraSeedId is disclosed under unresolvedSeeds', () => {
    const g = chainGraph();
    const f = computeFootprint(
      g,
      { id: 't1', seedSymbols: ['a.ts::main'] },
      { extraSeedIds: ['a.ts::ghostCandidate'] },
    );
    expect(f.writeSet.map(w => w.id)).toEqual(['a.ts::main']);
    expect(f.unresolvedSeeds).toEqual(['a.ts::ghostCandidate']);
  });

  it('readMaxDistance bounds the forward read closure', () => {
    // linear chain n1 → n2 → n3 → n4, all import edges (cost 1 each).
    const g = graph(
      [node({ id: 'c.ts::n1' }), node({ id: 'c.ts::n2' }), node({ id: 'c.ts::n3' }), node({ id: 'c.ts::n4' })],
      [edge('c.ts::n1', 'c.ts::n2'), edge('c.ts::n2', 'c.ts::n3'), edge('c.ts::n3', 'c.ts::n4')],
    );
    const tight = computeFootprint(g, { id: 't1', seedSymbols: ['c.ts::n1'] }, { readMaxDistance: 2 });
    expect(tight.readSet).toEqual(['c.ts::n2', 'c.ts::n3']); // n4 is at distance 3, excluded
    const wide = computeFootprint(g, { id: 't1', seedSymbols: ['c.ts::n1'] }, { readMaxDistance: 6 });
    expect(wide.readSet).toEqual(['c.ts::n2', 'c.ts::n3', 'c.ts::n4']);
  });

  it('affectedMaxDepth bounds the backward affected closure', () => {
    // linear chain n1 → n2 → n3 → n4; affected(n4) walks backward through callers.
    const g = graph(
      [node({ id: 'c.ts::n1' }), node({ id: 'c.ts::n2' }), node({ id: 'c.ts::n3' }), node({ id: 'c.ts::n4' })],
      [edge('c.ts::n1', 'c.ts::n2'), edge('c.ts::n2', 'c.ts::n3'), edge('c.ts::n3', 'c.ts::n4')],
    );
    const shallow = computeFootprint(g, { id: 't1', seedSymbols: ['c.ts::n4'] }, { affectedMaxDepth: 1 });
    expect(shallow.affectedSet).toEqual(['c.ts::n3']); // only the direct caller
    const deep = computeFootprint(g, { id: 't1', seedSymbols: ['c.ts::n4'] }, { affectedMaxDepth: 3 });
    expect(deep.affectedSet).toEqual(['c.ts::n1', 'c.ts::n2', 'c.ts::n3'].sort());
  });
});

describe('computeFootprint — coupling neighbors', () => {
  it('surfaces a co-changing file as a separate advisory annotation, not in the static regions', () => {
    const g = chainGraph();
    const couplingLookup = (files: string[]): FileChangeCoupling[] =>
      files.includes('a.ts')
        ? [{ filePath: 'a.ts', churn: 10, coupledWith: [{ file: 'docs/guide.md', support: 4, confidence: 0.6 }] }]
        : [];
    const f = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::main'] }, { couplingLookup });
    expect(f.couplingNeighbors).toEqual(['docs/guide.md']);
    // never merged into static regions
    expect(f.readSet).not.toContain('docs/guide.md');
    expect(f.affectedSet).not.toContain('docs/guide.md');
  });

  it('excludes the write-set own files from coupling neighbors', () => {
    const g = chainGraph();
    const couplingLookup = (): FileChangeCoupling[] => [
      { filePath: 'a.ts', churn: 10, coupledWith: [{ file: 'a.ts', support: 5, confidence: 0.9 }] },
    ];
    const f = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::main'] }, { couplingLookup });
    expect(f.couplingNeighbors).toEqual([]);
  });
});

// ---- ambient symbol exclusion ----

describe('ambientFanInThreshold', () => {
  it('returns the fan-in value at the configured percentile', () => {
    const g = graph([
      node({ id: 'x.ts::a', fanIn: 0 }),
      node({ id: 'x.ts::b', fanIn: 1 }),
      node({ id: 'x.ts::c', fanIn: 2 }),
      node({ id: 'x.ts::hub', fanIn: 100 }),
    ]);
    // p99 of [0,1,2,100] → index ceil(0.99*3)=3 → value 100; only fanIn>100 would be ambient.
    expect(ambientFanInThreshold(g, { ambientFanInPercentile: 0.99 })).toBe(100);
    // p50 → index ceil(0.5*3)=2 → value 2; symbols with fanIn>2 (the hub) are ambient.
    expect(ambientFanInThreshold(g, { ambientFanInPercentile: 0.5 })).toBe(2);
  });
});

describe('computeFootprint — ambient exclusion', () => {
  function ambientGraph(): SerializedCallGraph {
    // main → helper (normal), main → logger (ambient, high fan-in)
    const nodes = [
      node({ id: 'a.ts::main', fanIn: 1 }),
      node({ id: 'a.ts::helper', fanIn: 1 }),
      node({ id: 'log.ts::logger', fanIn: 100 }),
    ];
    const edges = [edge('a.ts::main', 'a.ts::helper'), edge('a.ts::main', 'log.ts::logger')];
    return graph(nodes, edges);
  }

  it('excludes an ambient symbol from the read-set and discloses it under ambientReadDeps', () => {
    const g = ambientGraph();
    const f = computeFootprint(g, { id: 't1', seedSymbols: ['a.ts::main'] }, { ambientFanInThreshold: 50 });
    expect(f.readSet).toEqual(['a.ts::helper']);
    expect(f.ambientReadDeps).toEqual(['log.ts::logger']);
  });
});

// ---- pairwise hazard classification ----

describe('classifyHazard', () => {
  it('WAW: a shared written symbol with a modify side', () => {
    const a = fp('A', [{ id: 's.ts::shared' }]);
    const b = fp('B', [{ id: 's.ts::shared' }]);
    expect(classifyHazard(a, b)).toEqual({ kind: 'WAW', witnesses: ['s.ts::shared'] });
  });

  it('shared-append: concurrent appends to a registration symbol are NOT WAW', () => {
    const a = fp('A', [{ id: 'reg.ts::TOOL_DEFINITIONS', mode: 'append' }]);
    const b = fp('B', [{ id: 'reg.ts::TOOL_DEFINITIONS', mode: 'append' }]);
    expect(classifyHazard(a, b)).toEqual({
      kind: 'shared-append',
      witnesses: ['reg.ts::TOOL_DEFINITIONS'],
    });
  });

  it('shared-append downgrades to WAW if either side declares modify', () => {
    const a = fp('A', [{ id: 'reg.ts::TOOL_DEFINITIONS', mode: 'append' }]);
    const b = fp('B', [{ id: 'reg.ts::TOOL_DEFINITIONS', mode: 'modify' }]);
    expect(classifyHazard(a, b).kind).toBe('WAW');
  });

  it('RAW: one task writes a symbol the other reads, with direction B after A', () => {
    const a = fp('A', [{ id: 'm.ts::producer' }]);
    const b = fp('B', [{ id: 'm.ts::consumer' }], { readSet: ['m.ts::producer'] });
    expect(classifyHazard(a, b)).toEqual({
      kind: 'RAW',
      witnesses: ['m.ts::producer'],
      direction: 'B after A',
    });
  });

  it('RAW: records bidirectional when each writes what the other reads', () => {
    const a = fp('A', [{ id: 'm.ts::x' }], { readSet: ['m.ts::y'] });
    const b = fp('B', [{ id: 'm.ts::y' }], { readSet: ['m.ts::x'] });
    const v = classifyHazard(a, b);
    expect(v.kind).toBe('RAW');
    expect(v.direction).toBe('bidirectional');
    expect(v.witnesses).toEqual(['m.ts::x', 'm.ts::y']);
  });

  it('RAW outranks shared-append when both apply', () => {
    // both append the registry, AND B reads what A writes elsewhere
    const a = fp('A', [{ id: 'reg.ts::REG', mode: 'append' }, { id: 'p.ts::prod' }]);
    const b = fp('B', [{ id: 'reg.ts::REG', mode: 'append' }], { readSet: ['p.ts::prod'] });
    expect(classifyHazard(a, b).kind).toBe('RAW');
  });

  it('WAW outranks RAW: a true write-write conflict is never downgraded to ordering', () => {
    // A and B both modify `shared` (WAW), AND B writes `x` that A reads (would be RAW alone).
    // The strongest hazard must win — scheduling these as a mere ordering dependency would
    // let a real conflict run concurrently.
    const a = fp('A', [{ id: 's.ts::shared' }], { readSet: ['s.ts::x'] });
    const b = fp('B', [{ id: 's.ts::shared' }, { id: 's.ts::x' }]);
    const v = classifyHazard(a, b);
    expect(v.kind).toBe('WAW');
    expect(v.witnesses).toEqual(['s.ts::shared']);
  });

  it('WAR: same file, disjoint symbols is low-risk, not WAW', () => {
    const a = fp('A', [{ id: 'shared.ts::alpha' }]);
    const b = fp('B', [{ id: 'shared.ts::beta' }]);
    expect(classifyHazard(a, b)).toEqual({ kind: 'WAR', witnesses: ['shared.ts'] });
  });

  it('WAR: a read-only overlap is low-risk', () => {
    const a = fp('A', [{ id: 'a.ts::one' }], { readSet: ['lib.ts::util'] });
    const b = fp('B', [{ id: 'b.ts::two' }], { readSet: ['lib.ts::util'] });
    expect(classifyHazard(a, b)).toEqual({ kind: 'WAR', witnesses: ['lib.ts::util'] });
  });

  it('soft-coupling: co-change with no static relation is advisory only', () => {
    const a = fp('A', [{ id: 'a.ts::one', file: 'a.ts' }], { couplingNeighbors: ['b.ts'] });
    const b = fp('B', [{ id: 'b.ts::two', file: 'b.ts' }]);
    expect(classifyHazard(a, b)).toEqual({ kind: 'soft-coupling', witnesses: ['b.ts'] });
  });

  it('none: fully disjoint footprints', () => {
    const a = fp('A', [{ id: 'a.ts::one', file: 'a.ts' }], { readSet: ['a.ts::dep'] });
    const b = fp('B', [{ id: 'b.ts::two', file: 'b.ts' }], { readSet: ['b.ts::dep'] });
    expect(classifyHazard(a, b)).toEqual({ kind: 'none', witnesses: [] });
  });

  // ---- ambient interaction with RAW ----

  it('a shared ambient read dependency does NOT create a RAW edge (tasks stay independent)', () => {
    const a = fp('A', [{ id: 'a.ts::one', file: 'a.ts' }], { ambientReadDeps: ['log.ts::logger'] });
    const b = fp('B', [{ id: 'b.ts::two', file: 'b.ts' }], { ambientReadDeps: ['log.ts::logger'] });
    expect(classifyHazard(a, b).kind).toBe('none');
  });

  it('writing an ambient symbol the other reads STILL creates a RAW hazard', () => {
    const a = fp('A', [{ id: 'log.ts::logger', file: 'log.ts' }]);
    const b = fp('B', [{ id: 'b.ts::two', file: 'b.ts' }], { ambientReadDeps: ['log.ts::logger'] });
    expect(classifyHazard(a, b)).toEqual({
      kind: 'RAW',
      witnesses: ['log.ts::logger'],
      direction: 'B after A',
    });
  });

  it('is deterministic and symmetric in classification kind', () => {
    const a = fp('A', [{ id: 'm.ts::producer' }]);
    const b = fp('B', [{ id: 'm.ts::consumer' }], { readSet: ['m.ts::producer'] });
    expect(classifyHazard(a, b).kind).toBe(classifyHazard(b, a).kind);
  });
});
