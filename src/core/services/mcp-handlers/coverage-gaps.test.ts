/**
 * Structural Test-Coverage Gap Report (change: add-test-coverage-gap-report).
 * Inverts test-selection reachability over a known fixture: the untested hub ranks
 * top, untested leaves sink, the tested hub is absent; the report claims only the
 * sound direction ("no reaching test"), excludes test/generated/vendored, keeps
 * untested-not-dead distinct from also-dead, scopes to a diff, and is deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));

vi.mock('../../drift/git-diff.js', () => ({
  getChangedFiles: vi.fn(async () => ({ files: [] })),
}));

import { handleReportCoverageGaps } from './coverage-gaps.js';
import { readCachedContext } from './utils.js';
import { getChangedFiles } from '../../drift/git-diff.js';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';

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
function graph(nodes: FunctionNode[], edges: CallEdge[], over: Partial<SerializedCallGraph> = {}): SerializedCallGraph {
  return {
    nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
    ...over,
  };
}

interface GapResult {
  scope: string;
  changed?: string[];
  analyzedSymbols: number;
  reachableFromTest: number;
  gapCount: number;
  coverageGaps: Array<{ name: string; file: string; fanIn: number; signals: Array<{ label: string }>; alsoFlaggedDead?: true }>;
  omitted?: number;
  soundness: { posture: string; claim: string; caveats: string[] };
  coverage: { languages: string[]; testDetection: string };
}

// Fixture: a test reaches `testedHub`. `untestedHub` (a hub/chokepoint) is reached
// only from candidate-dead leaves; `leaf1`/`leaf2` are untested leaves; `main` is an
// untested entry point (a live root → untested-not-dead). Generated/vendored/.d.ts
// nodes are present but must be excluded.
const testedHub = node({ id: 'src/a.ts::testedHub', fanIn: 4 });
const untestedHub = node({ id: 'src/a.ts::untestedHub', fanIn: 5 });
const leaf1 = node({ id: 'src/a.ts::leaf1', fanIn: 0, fanOut: 1 });
const leaf2 = node({ id: 'src/a.ts::leaf2', fanIn: 0, fanOut: 1 });
const mainEntry = node({ id: 'src/entry.ts::main', name: 'main', fanIn: 0 });
const genFn = node({ id: 'src/x.generated.ts::genFn', fanIn: 0 });
const vendFn = node({ id: 'vendor/lib.ts::vendFn', fanIn: 0 });
const dtsFn = node({ id: 'src/types.d.ts::shim', fanIn: 0 });
const testA = node({ id: 'src/a.test.ts::testA', isTest: true, fanOut: 1 });

const NODES = [testedHub, untestedHub, leaf1, leaf2, mainEntry, genFn, vendFn, dtsFn, testA];
const EDGES = [
  edge('src/a.test.ts::testA', 'src/a.ts::testedHub'), // a test reaches testedHub
  edge('src/a.ts::leaf1', 'src/a.ts::untestedHub'),    // untestedHub reached only from dead leaves
  edge('src/a.ts::leaf2', 'src/a.ts::untestedHub'),
];
// hubFunctions drives the hub/chokepoint label; both hubs are listed.
const FIXTURE = () => graph(NODES, EDGES, { hubFunctions: [testedHub, untestedHub] });

describe('handleReportCoverageGaps', () => {
  beforeEach(() => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: FIXTURE() } as never);
    vi.mocked(getChangedFiles).mockResolvedValue({ files: [] } as never);
  });

  it('ranks the untested hub on top, sinks the leaves, and omits the tested hub', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    const names = r.coverageGaps.map(g => g.name);

    expect(names).not.toContain('testedHub'); // reached by a test → not a gap
    expect(names[0]).toBe('untestedHub');     // load-bearing (hub/chokepoint) floats up
    // the two untested leaves sink below the hub
    expect(names.indexOf('leaf1')).toBeGreaterThan(names.indexOf('untestedHub'));
    expect(names.indexOf('leaf2')).toBeGreaterThan(names.indexOf('untestedHub'));
    // the untested hub carries its earned significance labels (evidence, not a score)
    const hub = r.coverageGaps.find(g => g.name === 'untestedHub')!;
    expect(hub.signals.map(s => s.label)).toEqual(expect.arrayContaining(['hub', 'chokepoint']));
    expect(r.reachableFromTest).toBe(1); // only testedHub
  });

  it('claims only the sound direction — never reports a symbol as "tested"', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    expect(r.soundness.posture).toBe('gaps-only');
    expect(r.soundness.claim).toBe('no-reaching-test');
    const blob = JSON.stringify(r).toLowerCase();
    // the verdict never asserts coverage/testedness of any symbol
    expect(blob).not.toMatch(/"tested"\s*:/);
    expect(blob).not.toMatch(/"covered"\s*:/);
    expect(r.soundness.caveats.join(' ')).toMatch(/never claims a symbol is "tested"/i);
    expect(r.soundness.caveats.join(' ')).toMatch(/not that any test asserts its behavior/i);
  });

  it('excludes test / generated / vendored / .d.ts files from the untested surface', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    const names = r.coverageGaps.map(g => g.name);
    expect(names).not.toContain('testA');  // test file
    expect(names).not.toContain('genFn');  // .generated.
    expect(names).not.toContain('vendFn'); // vendor/
    expect(names).not.toContain('shim');   // .d.ts
  });

  it('reports an untested entry point, labeled untested-not-dead (not also-dead)', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    const main = r.coverageGaps.find(g => g.name === 'main');
    expect(main, 'untested entry point is still a real gap').toBeDefined();
    expect(main!.alsoFlaggedDead).toBeUndefined(); // a live root → untested, NOT dead
    // a genuinely unreachable leaf IS flagged also-dead, keeping the two distinct
    const leaf = r.coverageGaps.find(g => g.name === 'leaf1')!;
    expect(leaf.alsoFlaggedDead).toBe(true);
  });

  it('scopes to a diff: only changed untested symbols are reported', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p', changedSymbols: ['untestedHub'] }) as GapResult;
    expect(r.scope).toBe('diff');
    expect(r.coverageGaps.map(g => g.name)).toEqual(['untestedHub']);
  });

  it('reports testDetection "none" when the graph has no tests', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({
      callGraph: graph([node({ id: 'a.ts::foo' }), node({ id: 'a.ts::bar', fanIn: 1 })], [edge('a.ts::foo', 'a.ts::bar')]),
    } as never);
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    expect(r.coverage.testDetection).toBe('none');
    expect(r.soundness.caveats.join(' ')).toMatch(/no tests were detected/i);
  });

  it('partial test detection names ONLY languages with no detected test (not well-tested ones)', async () => {
    // TS has a test; Python has none. The caveat must name Python, never TypeScript.
    const tsProd = node({ id: 'src/a.ts::tsFn', fanIn: 1, language: 'typescript' });
    const tsTest = node({ id: 'src/a.test.ts::t', isTest: true, language: 'typescript', fanOut: 1 });
    const pyFn = node({ id: 'src/b.py::pyFn', language: 'python' });
    vi.mocked(readCachedContext).mockResolvedValueOnce({
      callGraph: graph([tsProd, tsTest, pyFn], [edge('src/a.test.ts::t', 'src/a.ts::tsFn')]),
    } as never);
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    expect(r.coverage.testDetection).toBe('partial');
    const partialCaveat = r.soundness.caveats.find(c => /no test files were detected/i.test(c))!;
    expect(partialCaveat).toMatch(/python/i);
    expect(partialCaveat).not.toMatch(/typescript/i);
  });

  it('is deterministic — byte-identical across two runs on the same state', async () => {
    const a = await handleReportCoverageGaps({ directory: '/p' });
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: FIXTURE() } as never);
    const b = await handleReportCoverageGaps({ directory: '/p' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('errors cleanly when no analysis is cached', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce(null as never);
    const r = await handleReportCoverageGaps({ directory: '/p' }) as { error: string };
    expect(r.error).toMatch(/analyze_codebase/i);
  });
});
