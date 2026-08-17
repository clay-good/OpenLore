/**
 * Spec-19 — Deterministic Test Impact Selection.
 * Backward reachability over a known test→code fixture: paths, over-approximation
 * posture, coverage honesty, and the tested_by harvest path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));

vi.mock('../../drift/git-diff.js', () => ({
  getChangedFiles: vi.fn(async () => ({ files: [] })),
}));

import { handleSelectTests, seedsFromSymbols, seedsFromFiles } from './test-impact.js';
import { handleReportCoverageGaps } from './coverage-gaps.js';
import { readCachedContext } from './utils.js';
import { getChangedFiles } from '../../drift/git-diff.js';
import { CallGraphBuilder, serializeCallGraph, type FunctionNode, type SerializedCallGraph, type CallEdge } from '../../analyzer/call-graph.js';

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id,
    filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'typescript', startIndex: 0, endIndex: 100, fanIn: 0, fanOut: 0,
    ...over,
  };
}
function edge(callerId: string, calleeId: string, kind: CallEdge['kind'] = 'calls', calleeName?: string): CallEdge {
  return { callerId, calleeId, calleeName: calleeName ?? calleeId.split('::')[1] ?? calleeId, confidence: 'import', kind };
}
function graph(nodes: FunctionNode[], edges: CallEdge[]): SerializedCallGraph {
  return { nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 } };
}

// Fixture: foo.test.ts::testFoo → foo → bar ; bar is tested_by bar.test.ts::testBar
const NODES = [
  node({ id: 'src/foo.ts::foo', fanOut: 1, fanIn: 1 }),
  node({ id: 'src/foo.ts::bar', fanIn: 1 }),
  node({ id: 'src/foo.test.ts::testFoo', isTest: true, fanOut: 1 }),
  node({ id: 'src/bar.test.ts::testBar', isTest: true, fanOut: 1 }),
];
const EDGES = [
  edge('src/foo.test.ts::testFoo', 'src/foo.ts::foo'),
  edge('src/foo.ts::foo', 'src/foo.ts::bar'),
  // tested_by points production → test (as the analyzer emits it)
  edge('src/foo.ts::bar', 'src/bar.test.ts::testBar', 'tested_by', 'testBar'),
];

describe('handleSelectTests', () => {
  beforeEach(() => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph(NODES, EDGES) } as never);
  });

  it('selects tests that transitively reach the changed symbol, with paths', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as {
      selectedTests: Array<{ test: string; file: string; viaPath: string[]; confidence: string }>;
      soundness: { posture: string; caveats: string[] };
      coverage: { languages: string[]; testDetection: string };
    };
    const names = r.selectedTests.map(t => t.test).sort();
    expect(names).toEqual(['testBar', 'testFoo']);

    // testFoo reaches bar through foo: [testFoo, foo, bar]
    const viaFoo = r.selectedTests.find(t => t.test === 'testFoo')!;
    expect(viaFoo.viaPath).toEqual(['testFoo', 'foo', 'bar']);
    // testBar is attached directly to bar by a tested_by edge — high confidence
    const viaBar = r.selectedTests.find(t => t.test === 'testBar')!;
    expect(viaBar.confidence).toBe('high');

    expect(r.coverage).toEqual({ languages: ['typescript'], testDetection: 'full' });
    expect(r.soundness.posture).toBe('over-approximate');
    expect(r.soundness.caveats.join(' ')).toMatch(/dynamic dispatch/i);
  });

  it('an upstream change still selects only the tests that reach it', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['foo'] }) as { selectedTests: Array<{ test: string }> };
    // testFoo calls foo directly; testBar tests bar (downstream of foo) — not reaching foo.
    expect(r.selectedTests.map(t => t.test)).toEqual(['testFoo']);
  });

  it('reports testDetection "none" and a caveat when the graph has no tests', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({
      callGraph: graph([node({ id: 'a.ts::foo' }), node({ id: 'a.ts::bar', fanIn: 1 })], [edge('a.ts::foo', 'a.ts::bar')]),
    } as never);
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as {
      selectedTests: unknown[]; coverage: { testDetection: string }; soundness: { caveats: string[] };
    };
    expect(r.selectedTests).toEqual([]);
    expect(r.coverage.testDetection).toBe('none');
    expect(r.soundness.caveats.join(' ')).toMatch(/no tests were detected/i);
  });

  it('reports full detection for a mixed-language graph with detected tests', async () => {
    const mixed = serializeCallGraph(await new CallGraphBuilder().build([
      { path: 'src/a.ts', content: 'export function tsFn() { return 1; }', language: 'TypeScript' },
      { path: 'src/a.test.ts', content: 'function testsTs() { tsFn(); }', language: 'TypeScript' },
      { path: 'lib/a.rb', content: 'def rbFn\n  1\nend\n', language: 'Ruby' },
      { path: 'spec/a_spec.rb', content: 'def testsRuby\n  rbFn\nend\n', language: 'Ruby' },
    ]));
    expect(mixed.nodes.some(n => n.filePath === 'spec/a_spec.rb' && n.isTest)).toBe(true);
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: mixed } as never);

    const selection = await handleSelectTests({
      directory: '/p',
      changedSymbols: ['tsFn', 'rbFn'],
    }) as { coverage: { testDetection: string } };
    const gaps = await handleReportCoverageGaps({ directory: '/p' }) as {
      coverage: { testDetection: string };
    };

    expect(selection.coverage.testDetection).toBe('full');
    expect(gaps.coverage.testDetection).toBe('full');
  });

  it('defaults to a working-tree diff vs HEAD when no args are given, and flags it', async () => {
    vi.mocked(getChangedFiles).mockResolvedValueOnce({ files: [{ path: 'src/foo.ts' }] } as never);
    const r = await handleSelectTests({ directory: '/p' }) as {
      selectedTests: Array<{ test: string }>; note?: string;
    };
    // src/foo.ts changed → seeds foo+bar → both tests reach the change.
    expect(r.selectedTests.map(t => t.test).sort()).toEqual(['testBar', 'testFoo']);
    expect(getChangedFiles).toHaveBeenCalledWith(expect.objectContaining({ baseRef: 'HEAD' }));
    expect(r.note).toMatch(/HEAD/);
  });

  it('flags the default in the empty-diff message when no args and no changes', async () => {
    vi.mocked(getChangedFiles).mockResolvedValueOnce({ files: [] } as never);
    const r = await handleSelectTests({ directory: '/p' }) as { selectedTests: unknown[]; message?: string; note?: string };
    expect(r.selectedTests).toEqual([]);
    expect(r.message).toMatch(/defaulted/);
    expect(r.note).toMatch(/HEAD/);
  });

  it('returns a message (not a false-empty) when symbols match no production function', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['doesNotExist'] }) as { selectedTests: unknown[]; message?: string };
    expect(r.selectedTests).toEqual([]);
    expect(r.message).toBeTruthy();
  });

  // Honesty: opting into federation but resolving no local seed must explain why no
  // cross-repo selection ran, not silently omit the federation surface.
  it('discloses a federationNote when federation is requested but no seed resolves', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['doesNotExist'], federation: true }) as { federationNote?: string };
    expect(r.federationNote).toMatch(/federation/i);
    const plain = await handleSelectTests({ directory: '/p', changedSymbols: ['doesNotExist'] }) as { federationNote?: string };
    expect(plain.federationNote).toBeUndefined();
  });

  it('errors cleanly when no analysis is cached', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce(null as never);
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as { error: string };
    expect(r.error).toMatch(/analyze_codebase/);
  });

  // confidenceBoundary wiring (spec: add-confidence-boundary-disclosure). The fixture
  // dir has no fingerprint artifact → staleness silent, so `complete` tracks the basis.
  it('attaches a complete confidenceBoundary on an all-direct selection', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as {
      confidenceBoundary: { complete: boolean; basis: { directEdges: number; synthesizedEdges: number } };
    };
    expect(r.confidenceBoundary.complete).toBe(true);
    expect(r.confidenceBoundary.basis.synthesizedEdges).toBe(0);
  });

  it('reports incomplete when a test reaches the change through a synthesized edge', async () => {
    const synthEdges: CallEdge[] = [
      { callerId: 'src/foo.test.ts::testFoo', calleeId: 'src/foo.ts::foo', calleeName: 'foo', confidence: 'synthesized', kind: 'calls', synthesizedBy: 'route-handler' },
      ...EDGES.slice(1),
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph(NODES, synthEdges) } as never);
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as {
      confidenceBoundary: { complete: boolean; knownUnknowable: Array<{ rule?: string }> };
    };
    expect(r.confidenceBoundary.complete).toBe(false);
    expect(r.confidenceBoundary.knownUnknowable.some(c => c.rule === 'route-handler')).toBe(true);
  });

  it('keys sibling fallback by seed identity when same-named functions collide', async () => {
    const nodes = [
      node({ id: 'src/covered.ts::render' }),
      node({ id: 'src/uncovered.ts::render' }),
      node({ id: 'src/uncovered.ts::helper' }),
      node({ id: 'test/covered.test.ts::testsCoveredRender', isTest: true }),
      node({ id: 'test/uncovered.test.ts::testsHelper', isTest: true }),
    ];
    const edges = [
      edge('test/covered.test.ts::testsCoveredRender', 'src/covered.ts::render'),
      edge('src/uncovered.ts::helper', 'test/uncovered.test.ts::testsHelper', 'tested_by', 'testsHelper'),
    ];
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, edges) } as never);
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['render'] }) as {
      selectedTests: Array<{ test: string; confidence: string; viaPath: string[] }>;
      soundness: { caveats: string[] };
    };

    expect(r.selectedTests).toContainEqual(expect.objectContaining({
      test: 'testsHelper',
      confidence: 'low',
      viaPath: ['testsHelper', '(same file as render)'],
    }));
    expect(r.soundness.caveats.join(' ')).toMatch(/sibling-file tests/i);
  });

  it('does not use sibling fallback for a genuinely covered seed', async () => {
    const nodes = [
      node({ id: 'src/subject.ts::subject' }),
      node({ id: 'src/subject.ts::helper' }),
      node({ id: 'test/direct.test.ts::testsSubject', isTest: true }),
      node({ id: 'test/sibling.test.ts::testsHelper', isTest: true }),
    ];
    const edges = [
      edge('test/direct.test.ts::testsSubject', 'src/subject.ts::subject'),
      edge('src/subject.ts::helper', 'test/sibling.test.ts::testsHelper', 'tested_by', 'testsHelper'),
    ];
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, edges) } as never);

    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['subject'] }) as {
      selectedTests: Array<{ test: string }>;
      soundness: { caveats: string[] };
    };

    expect(r.selectedTests.map(t => t.test)).toEqual(['testsSubject']);
    expect(r.soundness.caveats.join(' ')).not.toMatch(/sibling-file tests/i);
  });

  it('discloses a non-empty frontier at the depth cap and qualifies the empty result', async () => {
    const nodes = [
      node({ id: 'src/chain.ts::seed' }),
      node({ id: 'src/chain.ts::one' }),
      node({ id: 'src/chain.ts::two' }),
      node({ id: 'test/chain.test.ts::deepTest', isTest: true }),
    ];
    const edges = [
      edge('test/chain.test.ts::deepTest', 'src/chain.ts::two'),
      edge('src/chain.ts::two', 'src/chain.ts::one'),
      edge('src/chain.ts::one', 'src/chain.ts::seed'),
    ];
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, edges) } as never);

    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['seed'], maxDepth: 2 }) as {
      selectedTests: unknown[];
      truncatedAtDepth?: number;
      soundness: { caveats: string[] };
    };

    expect(r.selectedTests).toEqual([]);
    expect(r.truncatedAtDepth).toBe(2);
    expect(r.soundness.caveats.join(' ')).toMatch(/deeper tests may exist/i);
    expect(r.soundness.caveats.join(' ')).not.toMatch(/genuinely untested/i);

    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, edges) } as never);
    const gaps = await handleReportCoverageGaps({ directory: '/p', changedSymbols: ['seed'] }) as {
      reachableFromTest: number;
      coverageGaps: Array<{ name: string }>;
    };
    expect(gaps.reachableFromTest).toBe(1);
    expect(gaps.coverageGaps).not.toContainEqual(expect.objectContaining({ name: 'seed' }));
  });

  it('omits the truncation receipt when the walk exhausts before the cap', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'], maxDepth: 4 }) as {
      truncatedAtDepth?: number;
    };
    expect(r.truncatedAtDepth).toBeUndefined();
  });

  it('names substring-widened symbols while exact matches remain silent', async () => {
    const widened = await handleSelectTests({ directory: '/p', changedSymbols: ['ar'] }) as {
      soundness: { caveats: string[] };
    };
    expect(widened.soundness.caveats.join(' ')).toMatch(/substring fallback/i);
    expect(widened.soundness.caveats.join(' ')).toMatch(/bar \(src\/foo\.ts\)/);

    const exact = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as {
      soundness: { caveats: string[] };
    };
    expect(exact.soundness.caveats.join(' ')).not.toMatch(/substring fallback/i);
  });

  it('does not treat an exhausted cycle at the cap as truncation', async () => {
    const nodes = [
      node({ id: 'src/cycle.ts::seed' }),
      node({ id: 'src/cycle.ts::one' }),
      node({ id: 'src/cycle.ts::two' }),
    ];
    const edges = [
      edge('src/cycle.ts::one', 'src/cycle.ts::seed'),
      edge('src/cycle.ts::two', 'src/cycle.ts::one'),
      edge('src/cycle.ts::one', 'src/cycle.ts::two'),
    ];
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, edges) } as never);

    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['seed'], maxDepth: 2 }) as {
      truncatedAtDepth?: number;
    };
    expect(r.truncatedAtDepth).toBeUndefined();
  });

  it('recognizes every seed reached by one test despite multi-seed parent collisions', async () => {
    const nodes = [
      node({ id: 'src/a.ts::seedA' }),
      node({ id: 'src/b.ts::seedB' }),
      node({ id: 'src/shared.ts::shared' }),
      node({ id: 'src/a.ts::siblingA' }),
      node({ id: 'src/b.ts::siblingB' }),
      node({ id: 'test/shared.test.ts::testsBoth', isTest: true }),
      node({ id: 'test/a.test.ts::testsSiblingA', isTest: true }),
      node({ id: 'test/b.test.ts::testsSiblingB', isTest: true }),
    ];
    const edges = [
      edge('test/shared.test.ts::testsBoth', 'src/shared.ts::shared'),
      edge('src/shared.ts::shared', 'src/a.ts::seedA'),
      edge('src/shared.ts::shared', 'src/b.ts::seedB'),
      edge('src/a.ts::siblingA', 'test/a.test.ts::testsSiblingA', 'tested_by', 'testsSiblingA'),
      edge('src/b.ts::siblingB', 'test/b.test.ts::testsSiblingB', 'tested_by', 'testsSiblingB'),
    ];
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, edges) } as never);

    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['seedA', 'seedB'] }) as {
      selectedTests: Array<{ test: string }>;
      soundness: { caveats: string[] };
    };
    expect(r.selectedTests.map(t => t.test)).toEqual(['testsBoth']);
    expect(r.soundness.caveats.join(' ')).not.toMatch(/sibling-file tests/i);
  });

  it('does not count synthesized-only test coverage in direct-resolved-only mode', async () => {
    const nodes = [
      node({ id: 'src/strict.ts::seed' }),
      node({ id: 'src/strict.ts::sibling' }),
      node({ id: 'test/synth.test.ts::synthTest', isTest: true }),
      node({ id: 'test/sibling.test.ts::siblingTest', isTest: true }),
    ];
    const edges: CallEdge[] = [
      { callerId: 'test/synth.test.ts::synthTest', calleeId: 'src/strict.ts::seed', calleeName: 'seed', confidence: 'synthesized', kind: 'calls', synthesizedBy: 'callback-argument' },
      edge('src/strict.ts::sibling', 'test/sibling.test.ts::siblingTest', 'tested_by', 'siblingTest'),
    ];
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, edges) } as never);

    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['seed'], directResolvedOnly: true }) as {
      selectedTests: Array<{ test: string; confidence: string }>;
      soundness: { caveats: string[] };
    };
    expect(r.selectedTests).toContainEqual(expect.objectContaining({ test: 'siblingTest', confidence: 'low' }));
    expect(r.selectedTests.map(t => t.test)).not.toContain('synthTest');
    expect(r.soundness.caveats.join(' ')).toMatch(/sibling-file tests/i);
  });

  it('does not report strict-mode truncation across a synthesized-only frontier edge', async () => {
    const nodes = [
      node({ id: 'src/strict-cap.ts::seed' }),
      node({ id: 'src/strict-cap.ts::directCaller' }),
      node({ id: 'test/strict-cap.test.ts::synthTest', isTest: true }),
    ];
    const edges: CallEdge[] = [
      edge('src/strict-cap.ts::directCaller', 'src/strict-cap.ts::seed'),
      { callerId: 'test/strict-cap.test.ts::synthTest', calleeId: 'src/strict-cap.ts::directCaller', calleeName: 'directCaller', confidence: 'synthesized', kind: 'calls', synthesizedBy: 'callback-argument' },
    ];
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, edges) } as never);

    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['seed'], maxDepth: 1, directResolvedOnly: true }) as {
      truncatedAtDepth?: number;
    };
    expect(r.truncatedAtDepth).toBeUndefined();
  });

  it('recognizes a seed covered exclusively by tested_by identity', async () => {
    const nodes = [
      node({ id: 'src/imported.ts::seed' }),
      node({ id: 'src/imported.ts::sibling' }),
      node({ id: 'test/seed.test.ts::seedTest', isTest: true }),
      node({ id: 'test/sibling.test.ts::siblingTest', isTest: true }),
    ];
    const edges = [
      edge('src/imported.ts::seed', 'test/seed.test.ts::seedTest', 'tested_by', 'seedTest'),
      edge('src/imported.ts::sibling', 'test/sibling.test.ts::siblingTest', 'tested_by', 'siblingTest'),
    ];
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, edges) } as never);

    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['seed'] }) as {
      selectedTests: Array<{ test: string; confidence: string }>;
      soundness: { caveats: string[] };
    };
    expect(r.selectedTests).toEqual([expect.objectContaining({ test: 'seedTest', confidence: 'high' })]);
    expect(r.soundness.caveats.join(' ')).not.toMatch(/sibling-file tests/i);
  });

  it('rejects empty symbol names instead of widening to the whole graph', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['   '] }) as { error?: string };
    expect(r.error).toMatch(/non-empty symbol names/i);

    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(NODES, EDGES) } as never);
    const gaps = await handleReportCoverageGaps({ directory: '/p', changedSymbols: [''] }) as {
      analyzedSymbols: number;
      note?: string;
    };
    expect(gaps.analyzedSymbols).toBe(0);
    expect(gaps.note).toMatch(/nothing matched/i);
  });

  it('bounds substring-widening examples and points to the complete seed list', async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node({ id: `src/f${i}.ts::match${i}` }));
    vi.mocked(readCachedContext).mockResolvedValueOnce({ callGraph: graph(nodes, []) } as never);

    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['match'] }) as {
      seeds: Array<{ name: string }>;
      soundness: { caveats: string[] };
    };
    const widening = r.soundness.caveats.find(c => /substring fallback/i.test(c))!;
    expect(r.seeds).toHaveLength(12);
    expect(widening).toMatch(/12 symbol/);
    expect(widening).toMatch(/and 4 more listed in seeds/);
    expect(widening).not.toContain('match8 (');
  });

  it('attaches a confidenceBoundary on the no-seed (message) result', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['doesNotExist'] }) as {
      selectedTests: unknown[]; confidenceBoundary: { complete: boolean };
    };
    expect(r.selectedTests).toEqual([]);
    expect(typeof r.confidenceBoundary.complete).toBe('boolean');
  });
});

describe('seed resolution helpers', () => {
  const cg = graph(NODES, EDGES);
  it('seedsFromSymbols prefers exact names and excludes tests', () => {
    expect(seedsFromSymbols(cg, ['bar']).map(n => n.id)).toEqual(['src/foo.ts::bar']);
    expect(seedsFromSymbols(cg, ['testFoo'])).toEqual([]); // tests are never seeds
  });
  it('seedsFromFiles matches by tolerant path and excludes tests', () => {
    const seeds = seedsFromFiles(cg, ['src/foo.ts']).map(n => n.name).sort();
    expect(seeds).toEqual(['bar', 'foo']);
    expect(seedsFromFiles(cg, ['/abs/repo/src/foo.ts']).length).toBe(2); // absolute form
  });
});
