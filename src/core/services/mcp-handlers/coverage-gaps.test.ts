/**
 * Structural Test-Coverage Gap Report (change: add-test-coverage-gap-report).
 * Inverts test-selection reachability over a known fixture: the untested hub ranks
 * top, untested leaves sink, the tested hub is absent; the report claims only the
 * sound direction ("no reaching test"), excludes test/generated/vendored, keeps
 * untested-not-dead distinct from also-dead, scopes to a diff, and is deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));

vi.mock('../../drift/git-diff.js', () => ({
  getChangedFiles: vi.fn(async () => ({ files: [] })),
}));

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../../constants.js';
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
  coverageGaps: Array<{
    name: string; file: string; fanIn: number; signals: Array<{ label: string }>;
    alsoFlaggedDead?: true;
    deadReason?: 'no-callers' | 'dead-via-unreachable-callers';
    deadLabelWithheld?: { reason: string; site: { file: string; line: number; kind: string } };
  }>;
  composition?: {
    returned: { live: number; deadFlagged: number; boundaryWithheld?: number };
    omittedRemainder?: { live: number; deadFlagged: number; boundaryWithheld?: number };
    total: { live: number; deadFlagged: number; boundaryWithheld?: number };
  };
  omitted?: number;
  note?: string;
  confidenceBoundary?: Record<string, unknown>;
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
/** Point the mocked context at the shared fixture graph. */
function setFixture(): void {
  vi.mocked(readCachedContext).mockResolvedValue({ callGraph: FIXTURE() } as never);
  vi.mocked(getChangedFiles).mockResolvedValue({ files: [] } as never);
}

describe('handleReportCoverageGaps', () => {
  beforeEach(() => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: FIXTURE() } as never);
    vi.mocked(getChangedFiles).mockResolvedValue({ files: [] } as never);
  });

  it('ranks live gaps above dead-flagged ones, sinks the leaves, and omits the tested hub', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    const names = r.coverageGaps.map(g => g.name);

    expect(names).not.toContain('testedHub'); // reached by a test → not a gap
    // `untestedHub` is load-bearing BUT reached only from candidate-dead leaves, so
    // its own reachability is undecidable. The live gap leads instead
    // (change: demote-dead-flagged-coverage-gaps) — certainty before significance.
    expect(names[0]).toBe('main');
    // Within the dead-flagged tier the old comparator still holds: the hub outranks
    // the leaves.
    expect(names.indexOf('untestedHub')).toBeLessThan(names.indexOf('leaf1'));
    expect(names.indexOf('leaf1')).toBeGreaterThan(names.indexOf('untestedHub'));
    expect(names.indexOf('leaf2')).toBeGreaterThan(names.indexOf('untestedHub'));
    // the untested hub carries its earned significance labels (evidence, not a score)
    const hub = r.coverageGaps.find(g => g.name === 'untestedHub')!;
    expect(hub.signals.map(s => s.label)).toEqual(expect.arrayContaining(['hub', 'chokepoint']));
    expect(r.reachableFromTest).toBe(1); // only testedHub
  });

  it('partitions the analyzed set: gapCount + reachableFromTest == analyzedSymbols', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    // universe (5: testedHub, untestedHub, leaf1, leaf2, main) splits exactly into
    // gaps (4) and test-reachable (1) — a complement with no overlap or omission.
    expect(r.analyzedSymbols).toBe(5);
    expect(r.gapCount).toBe(4);
    expect(r.reachableFromTest).toBe(1);
    expect(r.gapCount + r.reachableFromTest).toBe(r.analyzedSymbols);
    expect(r.confidenceBoundary).toBeDefined(); // always returned (negative-conclusion trust signal)
  });

  it('caps at maxResults but keeps gapCount the FULL count and reports omitted', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p', maxResults: 2 }) as GapResult;
    expect(r.coverageGaps).toHaveLength(2);   // list truncated
    expect(r.gapCount).toBe(4);               // ...but the count is the full set, not the page
    expect(r.omitted).toBe(2);                // and the omission is disclosed, never silent
    // maxResults floors at 1 (0/negative clamp), never returns an empty page on a non-empty set
    const z = await handleReportCoverageGaps({ directory: '/p', maxResults: 0 }) as GapResult;
    expect(z.coverageGaps.length).toBeGreaterThanOrEqual(1);
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

  it('scopes to a diff: only changed untested symbols are reported, with scoped denominators', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p', changedSymbols: ['untestedHub'] }) as GapResult;
    expect(r.scope).toBe('diff');
    expect(r.coverageGaps.map(g => g.name)).toEqual(['untestedHub']);
    // counts range over the IN-SCOPE set (1 symbol), never the whole repo's universe —
    // "1 gap of 1 analyzed", not "1 gap of <all symbols> analyzed".
    expect(r.analyzedSymbols).toBe(1);
    expect(r.reachableFromTest).toBe(0);
    expect(r.note).toBeUndefined(); // it DID match — no "nothing matched" disclosure
  });

  it('discloses when a diff scope resolves to nothing (never a reassuring "0 gaps")', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p', changedSymbols: ['noSuchSymbol'] }) as GapResult;
    expect(r.scope).toBe('diff');
    expect(r.gapCount).toBe(0);
    expect(r.analyzedSymbols).toBe(0);
    expect(r.note).toMatch(/nothing matched/i);
    expect(r.note).not.toMatch(/no coverage gaps$/i); // explicitly NOT the reassuring phrasing
  });

  it('discloses when a region (filePattern) matches nothing', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p', filePattern: 'no/such/dir' }) as GapResult;
    expect(r.scope).toBe('region');
    expect(r.gapCount).toBe(0);
    expect(r.note).toMatch(/matched no in-scope production symbol/i);
  });

  it('echoes filePattern even when layered on a diff scope (so the extra filter is visible)', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p', changedSymbols: ['untestedHub'], filePattern: 'src/a.ts' }) as GapResult & { filePattern?: string };
    expect(r.scope).toBe('diff');
    expect(r.filePattern).toBe('src/a.ts');
    expect(r.coverageGaps.map(g => g.name)).toEqual(['untestedHub']);
  });

  it('directResolvedOnly: a node reachable from a test ONLY via a synthesized edge becomes a gap in strict mode', async () => {
    // test → dispatcher (real) → handler (synthesized). Non-strict: handler reached
    // (not a gap). Strict: synthesized edge dropped, handler unreached → a gap.
    const dispatcher = node({ id: 'src/d.ts::dispatcher', fanIn: 1, fanOut: 1 });
    const handler = node({ id: 'src/d.ts::handler', fanIn: 1 });
    const t = node({ id: 'src/d.test.ts::t', isTest: true, fanOut: 1 });
    const synthEdge: CallEdge = { callerId: 'src/d.ts::dispatcher', calleeId: 'src/d.ts::handler', calleeName: 'handler', confidence: 'synthesized', kind: 'calls' };
    const g = graph([dispatcher, handler, t], [edge('src/d.test.ts::t', 'src/d.ts::dispatcher'), synthEdge]);

    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: g } as never);
    const lax = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    expect(lax.coverageGaps.map(x => x.name)).not.toContain('handler'); // reached via synthesized → not a gap

    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: g } as never);
    const strict = await handleReportCoverageGaps({ directory: '/p', directResolvedOnly: true }) as GapResult;
    const strictHandler = strict.coverageGaps.find(x => x.name === 'handler');
    expect(strictHandler).toBeDefined(); // synthesized dropped → a gap
    // Parity: the dead set is computed on the SAME strict basis, so a node unreachable
    // without the synthesized edge is BOTH a gap and also-dead (no strict/non-strict split).
    expect(strictHandler!.alsoFlaggedDead).toBe(true);
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

  // ==========================================================================
  // Reachability-aware ranking, typed dead reason, page composition
  // (change: demote-dead-flagged-coverage-gaps)
  // ==========================================================================

  it('ranks a dead-flagged hub below a live unlabelled gap', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    const names = r.coverageGaps.map(g => g.name);
    const hub = r.coverageGaps.find(g => g.name === 'untestedHub')!;
    const live = r.coverageGaps.find(g => g.name === 'main')!;

    // `untestedHub` carries hub+chokepoint and fanIn 5; `main` carries neither and
    // has fanIn 0. Under the old comparator the hub led. It no longer does.
    expect(hub.signals.map(s => s.label)).toEqual(expect.arrayContaining(['hub', 'chokepoint']));
    expect(hub.alsoFlaggedDead).toBe(true);
    expect(live.alsoFlaggedDead).toBeUndefined();
    expect(names.indexOf('main')).toBeLessThan(names.indexOf('untestedHub'));

    // Every live gap precedes every dead-flagged one — a partition, not a nudge.
    const lastLive = Math.max(...r.coverageGaps.map((g, i) => (g.alsoFlaggedDead ? -1 : i)));
    const firstDead = r.coverageGaps.findIndex(g => g.alsoFlaggedDead);
    expect(lastLive).toBeLessThan(firstDead);
  });

  it('types the dead flag: fan-in zero is no-callers, fan-in above zero is undecidable reachability', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    const leaf = r.coverageGaps.find(g => g.name === 'leaf1')!;
    const hub = r.coverageGaps.find(g => g.name === 'untestedHub')!;
    const live = r.coverageGaps.find(g => g.name === 'main')!;

    expect(leaf.fanIn).toBe(0);
    expect(leaf.deadReason).toBe('no-callers');
    // 5 resolved callers, still unreachable from a liveness root — the signature of
    // an inbound edge static analysis cannot see (the pi-outpost WebSocket case).
    expect(hub.fanIn).toBeGreaterThan(0);
    expect(hub.deadReason).toBe('dead-via-unreachable-callers');
    // The boolean keeps its exact prior meaning; the reason is additive.
    expect(hub.alsoFlaggedDead).toBe(true);
    expect(live.deadReason).toBeUndefined();
  });

  it('emits the undecidable-reachability caveat only when that reason is on the page', async () => {
    const withReason = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    expect(withReason.soundness.caveats.join(' ')).toMatch(/dead-via-unreachable-callers/);

    // A graph whose only gap has no callers at all: no such reason, so no caveat.
    vi.mocked(readCachedContext).mockResolvedValueOnce({
      callGraph: graph(
        [node({ id: 'src/z.ts::lonely', fanIn: 0 }), node({ id: 'src/z.test.ts::t', isTest: true })],
        [],
      ),
    } as never);
    const without = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    expect(without.coverageGaps.map(g => g.deadReason)).not.toContain('dead-via-unreachable-callers');
    expect(without.soundness.caveats.join(' ')).not.toMatch(/dead-via-unreachable-callers/);
  });

  it('reports page composition that sums to the whole gap set', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    const c = r.composition!;
    expect(c.returned.live + c.returned.deadFlagged).toBe(r.coverageGaps.length);
    expect(c.total.live + c.total.deadFlagged).toBe(r.gapCount);
    expect(c.total.live).toBe(1);              // only `main` is live-and-untested
    expect(c.omittedRemainder).toBeUndefined(); // nothing truncated here
  });

  it('truncation never returns a dead-flagged gap ahead of a live one, and discloses the remainder split', async () => {
    const r = await handleReportCoverageGaps({ directory: '/p', maxResults: 1 }) as GapResult;
    expect(r.coverageGaps).toHaveLength(1);
    expect(r.coverageGaps[0].alsoFlaggedDead).toBeUndefined(); // the live gap survives truncation
    expect(r.composition!.returned).toEqual({ live: 1, deadFlagged: 0 });
    expect(r.composition!.omittedRemainder).toEqual({ live: 0, deadFlagged: 3 });
    expect(
      r.composition!.omittedRemainder!.live + r.composition!.omittedRemainder!.deadFlagged,
    ).toBe(r.omitted);
  });

  it('keeps ranking stable across repeated runs', async () => {
    const first = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: FIXTURE() } as never);
    const second = await handleReportCoverageGaps({ directory: '/p' }) as GapResult;
    expect(second.coverageGaps.map(g => g.name)).toEqual(first.coverageGaps.map(g => g.name));
  });

  it('errors cleanly when no analysis is cached', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce(null as never);
    const r = await handleReportCoverageGaps({ directory: '/p' }) as { error: string };
    expect(r.error).toMatch(/analyze_codebase/i);
  });
});

// ---------------------------------------------------------------------------
// Dynamic-boundary withholding (change: disclose-dynamic-boundary-regions)
// ---------------------------------------------------------------------------

describe('the also-dead label is withheld behind a dynamic boundary', () => {
  let root: string;

  async function writeSites(entries: Array<{ filePath: string; language: string; kind: string; line: number }>) {
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'dynamic-boundary.json'), JSON.stringify({
      version: 1, totalSites: entries.length, totalFiles: entries.length, byKind: [], byLanguage: [],
      files: entries.map(e => ({
        filePath: e.filePath, language: e.language,
        sites: [{ line: e.line, kind: e.kind, refusal: 'no-static-target', evidence: 'o[n]()', moduleLevel: true }],
      })),
    }));
  }

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'openlore-gaps-dyn-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('withholds also-dead, names the site, and STILL reports the symbol as a gap', async () => {
    setFixture();
    await writeSites([{ filePath: 'src/a.ts', language: 'typescript', kind: 'computed-member', line: 12 }]);
    const r = await handleReportCoverageGaps({ directory: root }) as GapResult;

    const withheld = r.coverageGaps.filter(g => g.deadLabelWithheld);
    expect(withheld.length).toBeGreaterThan(0);
    for (const g of withheld) {
      expect(g.alsoFlaggedDead).toBeUndefined();
      expect(g.deadReason).toBeUndefined();
      expect(g.deadLabelWithheld).toEqual({
        reason: 'dynamic-boundary',
        site: { file: 'src/a.ts', line: 12, kind: 'computed-member' },
      });
    }
    // One-directional: withholding a label never removes the gap, never implies the symbol is
    // tested or reached, AND never promotes it into the live bucket or the live ranking tier —
    // an undecided symbol is strictly less decided than a plain dead-flagged one.
    const clean = await mkdtemp(join(tmpdir(), 'openlore-gaps-clean-'));
    try {
      setFixture();
      const baseline = await handleReportCoverageGaps({ directory: clean }) as GapResult;
      expect(r.gapCount).toBe(baseline.gapCount);
      expect(r.reachableFromTest).toBe(baseline.reachableFromTest);
      // The live count must NOT grow: the withheld symbols came out of the dead bucket, and they
      // land in their own, never in `live`.
      expect(r.composition!.total.live).toBe(baseline.composition!.total.live);
      expect(r.composition!.total.boundaryWithheld).toBe(withheld.length);
      expect(r.composition!.total.live + r.composition!.total.deadFlagged
        + (r.composition!.total.boundaryWithheld ?? 0)).toBe(r.gapCount);
      // …and they must not have jumped the ranking: every live gap still precedes every withheld one.
      const names = r.coverageGaps.map(g => g.name);
      const lastLive = Math.max(...r.coverageGaps
        .map((g, i) => (!g.alsoFlaggedDead && !g.deadLabelWithheld ? i : -1)));
      const firstWithheld = names.findIndex((_, i) => !!r.coverageGaps[i].deadLabelWithheld);
      if (lastLive >= 0 && firstWithheld >= 0) expect(firstWithheld).toBeGreaterThan(lastLive);
    } finally {
      await rm(clean, { recursive: true, force: true });
    }
  });

  it('a site in a file that cannot name the symbol leaves also-dead intact', async () => {
    setFixture();
    await writeSites([{ filePath: 'src/unrelated.ts', language: 'typescript', kind: 'computed-member', line: 1 }]);
    const r = await handleReportCoverageGaps({ directory: root }) as GapResult;
    expect(r.coverageGaps.some(g => g.alsoFlaggedDead)).toBe(true);
    expect(r.coverageGaps.every(g => !g.deadLabelWithheld)).toBe(true);
  });

  it('a kind that cannot hide a caller does not withhold the label', async () => {
    setFixture();
    await writeSites([{ filePath: 'src/a.ts', language: 'typescript', kind: 'code-eval', line: 4 }]);
    const r = await handleReportCoverageGaps({ directory: root }) as GapResult;
    expect(r.coverageGaps.every(g => !g.deadLabelWithheld)).toBe(true);
  });
});
