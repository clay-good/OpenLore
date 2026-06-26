/**
 * Change significance briefing handler (change: add-change-significance-briefing).
 * Composes git diff + churn + landmark labels + select_tests over a known fixture:
 * a stable hub surfaces top as surprising-change, the briefing is a ranked
 * conclusion (not a diff), truncation carries a receipt that never drops a higher
 * tier for a lower one, the surprise label is withheld on shallow history, tests-to-
 * run are wired, and the briefing core is deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));

vi.mock('../../drift/git-diff.js', () => ({
  getChangedFiles: vi.fn(),
  // Default: any explicit ref resolves; individual tests override to force a fallback.
  refExists: vi.fn(async () => true),
}));

// Keep volatilityLevel real; stub only the git-history miner.
vi.mock('../../provenance/change-coupling.js', async (importActual) => {
  const actual = await importActual<typeof import('../../provenance/change-coupling.js')>();
  return { ...actual, analyzeChangeCoupling: vi.fn() };
});

// Keep seedsFromFiles real; stub only the test-selection handler.
vi.mock('./test-impact.js', async (importActual) => {
  const actual = await importActual<typeof import('./test-impact.js')>();
  return {
    ...actual,
    handleSelectTests: vi.fn(async () => ({
      selectedTests: [{ test: 'testCore', file: 'src/core.test.ts', viaPath: [], confidence: 'high' }],
    })),
  };
});

vi.mock('./confidence-boundary.js', () => ({
  computeStaleness: vi.fn(async () => undefined),
  assembleBoundary: vi.fn(() => ({})),
}));

import { handleBriefingSince } from './briefing-since.js';
import { readCachedContext } from './utils.js';
import { getChangedFiles, refExists } from '../../drift/git-diff.js';
import { analyzeChangeCoupling } from '../../provenance/change-coupling.js';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id,
    filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'typescript', startIndex: 0, endIndex: 100, fanIn: 0, fanOut: 0,
    ...over,
  };
}
function graph(nodes: FunctionNode[], over: Partial<SerializedCallGraph> = {}): SerializedCallGraph {
  return {
    nodes, edges: [] as CallEdge[], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    ...over,
  };
}

// Fixture: a stable chokepoint hub (high fan-in funnel) and a volatile god-hub among
// trivial leaves, all in changed files. coreHub has low churn → surprising;
// orchHub has high churn → hub-change.
const coreHub = node({ id: 'src/core.ts::coreHub', fanIn: 9, fanOut: 2, communityLabel: 'core' });
const orchHub = node({ id: 'src/orch.ts::orchHub', fanIn: 6, fanOut: 30, communityLabel: 'orch' });
const leafA = node({ id: 'src/core.ts::leafA', fanIn: 0 });
const leafB = node({ id: 'src/util.ts::leafB', fanIn: 1 });
const testNode = node({ id: 'src/core.test.ts::testCore', isTest: true, fanOut: 1 });

const NODES = [coreHub, orchHub, leafA, leafB, testNode];
const FIXTURE = () => graph(NODES, { hubFunctions: [coreHub, orchHub] });

interface BriefingResult {
  baseRef: string;
  baseRefFallback?: { requested: string; resolved: string };
  scope: string;
  changedFiles: number;
  changedSymbols: number;
  tierCounts: Record<string, number>;
  briefing: Array<{ name: string; tier: string; labels: string[]; community?: string; evidence: { fanIn: number; priorChurn: number } }>;
  truncation: { bounded: boolean; returned: number; omitted: number; lowestTierReached: string | null; omittedByTier?: Record<string, number> };
  regions: Array<{ community: string; count: number }>;
  testsToRun: { count: number; files: string[] };
  surprisingChange: { available: boolean; historyCommitsScanned: number };
  note?: string;
  caveats: string[];
}

const mockedReadCtx = vi.mocked(readCachedContext);
const mockedDiff = vi.mocked(getChangedFiles);
const mockedCoupling = vi.mocked(analyzeChangeCoupling);
const mockedRefExists = vi.mocked(refExists);

function diffFiles(paths: string[], resolvedBase = 'mainsha') {
  return {
    resolvedBase,
    files: paths.map(p => ({ path: p, status: 'modified' as const, additions: 1, deletions: 0, isTest: /\.test\./.test(p), isConfig: false, isGenerated: false, extension: '.ts' })),
    hasUnstagedChanges: false,
    currentBranch: 'feature',
  };
}
function coupling(churn: Record<string, number>, commitsScanned: number) {
  return {
    churn: new Map(Object.entries(churn)),
    coupling: new Map(),
    stats: { commitsScanned, bulkCommitsFiltered: 0, filesTracked: Object.keys(churn).length },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedReadCtx.mockResolvedValue({ callGraph: FIXTURE() } as unknown as Awaited<ReturnType<typeof readCachedContext>>);
  mockedRefExists.mockResolvedValue(true); // explicit refs resolve unless a test overrides
});

describe('handleBriefingSince', () => {
  it('returns a ranked conclusion: a stable hub tops as surprising-change, with evidence and tests', async () => {
    mockedDiff.mockResolvedValue(diffFiles(['src/core.ts', 'src/orch.ts', 'src/util.ts']));
    // coreHub file low churn (1), orchHub file high churn (20); ≥2 commits of history.
    mockedCoupling.mockResolvedValue(coupling({ 'src/core.ts': 1, 'src/orch.ts': 20 }, 40));

    const r = (await handleBriefingSince({ directory: '/repo' })) as BriefingResult;

    expect(r.briefing[0].name).toBe('coreHub');
    expect(r.briefing[0].tier).toBe('surprising-change');
    expect(r.briefing[0].evidence).toMatchObject({ fanIn: 9, priorChurn: 1 });
    expect(r.briefing[0].community).toBe('core');
    // orchHub is a volatile god-hub → hub-change
    const orch = r.briefing.find(b => b.name === 'orchHub');
    expect(orch?.tier).toBe('hub-change');
    expect(r.tierCounts['surprising-change']).toBe(1);
    expect(r.tierCounts['hub-change']).toBe(1);
    expect(r.tierCounts['ordinary-change']).toBe(2);
    // tests-to-run wired from select_tests
    expect(r.testsToRun.count).toBe(1);
    expect(r.testsToRun.files).toContain('src/core.test.ts');
    // grouped by region
    expect(r.regions.some(g => g.community === 'core')).toBe(true);
    // baseRef cursor echoed (resolved)
    expect(r.baseRef).toBe('mainsha');
  });

  it('withholds surprising-change on shallow history (single commit) and discloses it', async () => {
    mockedDiff.mockResolvedValue(diffFiles(['src/core.ts']));
    mockedCoupling.mockResolvedValue(coupling({ 'src/core.ts': 1 }, 1)); // only 1 commit scanned

    const r = (await handleBriefingSince({ directory: '/repo' })) as BriefingResult;

    const core = r.briefing.find(b => b.name === 'coreHub')!;
    expect(core.tier).not.toBe('surprising-change');
    expect(r.surprisingChange.available).toBe(false);
    expect(r.surprisingChange.historyCommitsScanned).toBe(1);
    expect(r.caveats.some(c => /shallow/i.test(c))).toBe(true);
  });

  it('bounds the briefing with a receipt that retains higher tiers and reports omissions', async () => {
    mockedDiff.mockResolvedValue(diffFiles(['src/core.ts', 'src/orch.ts', 'src/util.ts']));
    mockedCoupling.mockResolvedValue(coupling({ 'src/core.ts': 1, 'src/orch.ts': 20 }, 40));

    const r = (await handleBriefingSince({ directory: '/repo', maxResults: 1 })) as BriefingResult;

    // only the top (surprising-change) is returned; the rest are omitted with a receipt
    expect(r.briefing).toHaveLength(1);
    expect(r.briefing[0].tier).toBe('surprising-change');
    expect(r.truncation.bounded).toBe(true);
    expect(r.truncation.omitted).toBe(3);
    expect(r.truncation.lowestTierReached).toBe('surprising-change');
    // the omitted are all lower tiers — surprising-change is never dropped
    expect(r.truncation.omittedByTier?.['surprising-change']).toBeUndefined();
    expect((r.truncation.omittedByTier?.['hub-change'] ?? 0) + (r.truncation.omittedByTier?.['ordinary-change'] ?? 0)).toBe(3);
  });

  it('reports "nothing changed" honestly when no production symbol changed', async () => {
    mockedDiff.mockResolvedValue(diffFiles(['src/core.test.ts'])); // only a test file
    mockedCoupling.mockResolvedValue(coupling({}, 10));

    const r = (await handleBriefingSince({ directory: '/repo' })) as BriefingResult;
    expect(r.changedSymbols).toBe(0);
    expect(r.briefing).toHaveLength(0);
    expect(r.note).toMatch(/nothing changed|NOT/i);
  });

  it('is deterministic — byte-identical briefing core for a fixed ref pair', async () => {
    mockedDiff.mockResolvedValue(diffFiles(['src/core.ts', 'src/orch.ts', 'src/util.ts']));
    mockedCoupling.mockResolvedValue(coupling({ 'src/core.ts': 1, 'src/orch.ts': 20 }, 40));

    const a = (await handleBriefingSince({ directory: '/repo' })) as BriefingResult;
    const b = (await handleBriefingSince({ directory: '/repo' })) as BriefingResult;
    const core = (x: BriefingResult) => JSON.stringify({ briefing: x.briefing, tierCounts: x.tierCounts, truncation: x.truncation, regions: x.regions });
    expect(core(a)).toBe(core(b));
  });

  it('discloses a SILENT base-ref fallback when an explicit ref cannot be resolved', async () => {
    mockedRefExists.mockResolvedValue(false); // git can't resolve the requested ref
    mockedDiff.mockResolvedValue(diffFiles(['src/core.ts'], 'main')); // resolveBaseRef fell back to main
    mockedCoupling.mockResolvedValue(coupling({ 'src/core.ts': 1 }, 40));

    const r = (await handleBriefingSince({ directory: '/repo', baseRef: 'totally-bogus-ref' })) as BriefingResult;
    expect(r.baseRefFallback).toEqual({ requested: 'totally-bogus-ref', resolved: 'main' });
    expect(r.caveats[0]).toMatch(/could not be resolved.*briefed against "main"/i);
  });

  it('does NOT report a fallback when the explicit ref resolves', async () => {
    mockedRefExists.mockResolvedValue(true);
    mockedDiff.mockResolvedValue(diffFiles(['src/core.ts'], 'abc123'));
    mockedCoupling.mockResolvedValue(coupling({ 'src/core.ts': 1 }, 40));

    const r = (await handleBriefingSince({ directory: '/repo', baseRef: 'abc123' })) as BriefingResult;
    expect(r.baseRefFallback).toBeUndefined();
    // 'auto' base never triggers a resolve-check at all
    mockedRefExists.mockClear();
    await handleBriefingSince({ directory: '/repo' });
    expect(mockedRefExists).not.toHaveBeenCalled();
  });

  it('discloses the rename/exact-path churn limitation only when surprising-change is live', async () => {
    // Live surprise: a low-churn hub with sufficient history → caveat present
    mockedDiff.mockResolvedValue(diffFiles(['src/core.ts']));
    mockedCoupling.mockResolvedValue(coupling({ 'src/core.ts': 1 }, 40));
    const live = (await handleBriefingSince({ directory: '/repo' })) as BriefingResult;
    expect(live.tierCounts['surprising-change']).toBeGreaterThan(0);
    expect(live.caveats.some(c => /does not follow renames/i.test(c))).toBe(true);

    // No surprise (only a volatile hub) → the rename caveat is suppressed as noise
    mockedDiff.mockResolvedValue(diffFiles(['src/orch.ts']));
    mockedCoupling.mockResolvedValue(coupling({ 'src/orch.ts': 50 }, 40));
    const quiet = (await handleBriefingSince({ directory: '/repo' })) as BriefingResult;
    expect(quiet.tierCounts['surprising-change']).toBe(0);
    expect(quiet.caveats.some(c => /does not follow renames/i.test(c))).toBe(false);
  });
});
