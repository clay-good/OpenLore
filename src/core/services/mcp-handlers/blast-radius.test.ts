/**
 * add-preflight-blast-radius-guard — the blast-radius briefing composes existing
 * deterministic analyses (impact, test selection, spec/memory/ADR drift) over a
 * diff into one conclusion-shaped briefing, and the hook's block logic fires only
 * on a configured high-risk pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));

vi.mock('../../drift/git-diff.js', () => ({
  getChangedFiles: vi.fn(async () => ({ files: [{ path: 'src/utils.ts' }], resolvedBase: 'HEAD' })),
  // The shared resolve-or-disclose helper (fix-cli-conclusion-honesty). Default: the ref
  // resolves as-is (no fallback); individual tests override to force a disclosed fallback.
  resolveBaseRefDisclosed: vi.fn(async (_d: string, requested: string) => ({
    requested,
    resolved: !requested || requested === 'auto' ? 'HEAD' : requested,
    fellBack: false,
  })),
}));

// Partial mock: stub handleAnalyzeImpact but keep buildAdjacency real (select_tests needs it).
vi.mock('./graph.js', async (importActual) => {
  const actual = await importActual<typeof import('./graph.js')>();
  return { ...actual, handleAnalyzeImpact: vi.fn() };
});

vi.mock('./analysis.js', () => ({
  handleCheckSpecDrift: vi.fn(),
}));

// Partial mock: stub handleSelectTests so a throwing test-selection can be driven;
// seedsFromFiles stays real (the briefing's changed-symbol seeding depends on it).
vi.mock('./test-impact.js', async (importActual) => {
  const actual = await importActual<typeof import('./test-impact.js')>();
  return { ...actual, handleSelectTests: vi.fn(actual.handleSelectTests) };
});

// Real staleness reads disk; stub ONLY computeStaleness so we can drive it
// deterministically, keeping every other confidence-boundary export (assembleBoundary,
// edgeBasisWithinSet, …) real — other reachable handlers depend on them. Default: index
// current (undefined) so the confidenceBoundary is omitted (existing assertions unaffected).
vi.mock('./confidence-boundary.js', async (importActual) => {
  const actual = await importActual<typeof import('./confidence-boundary.js')>();
  return { ...actual, computeStaleness: vi.fn(async () => undefined) };
});

import { computeBlastRadius, type BlastRadiusBriefing } from './blast-radius.js';
import { triggeredBlockPatterns } from '../../../cli/commands/blast-radius.js';
import { readCachedContext } from './utils.js';
import { handleAnalyzeImpact } from './graph.js';
import { handleCheckSpecDrift } from './analysis.js';
import { computeStaleness } from './confidence-boundary.js';
import { handleSelectTests } from './test-impact.js';
import { assertConclusionShape } from './tool-contract.js';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';
import type { DriftResult } from '../../../types/index.js';

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

// Fixture: a hub `validateDirectory` in the changed file, with a test reaching it.
const NODES = [
  node({ id: 'src/utils.ts::validateDirectory', fanIn: 58, fanOut: 1 }),
  node({ id: 'src/x.test.ts::testValidate', isTest: true, fanOut: 1 }),
];
const EDGES = [edge('src/x.test.ts::testValidate', 'src/utils.ts::validateDirectory')];

function driftResult(issues: DriftResult['issues']): DriftResult {
  return {
    timestamp: 't', baseRef: 'HEAD', totalChangedFiles: 1, specRelevantFiles: 1,
    issues,
    summary: { gaps: 0, stale: 0, uncovered: 0, orphanedSpecs: 0, adrGaps: 0, adrOrphaned: 0, memoryDrifted: 0, memoryOrphaned: 0, total: issues.length },
    hasDrift: issues.length > 0, duration: 1, mode: 'static',
  };
}

describe('computeBlastRadius', () => {
  beforeEach(() => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph(NODES, EDGES) } as never);
    vi.mocked(handleAnalyzeImpact).mockResolvedValue({
      symbol: 'validateDirectory', file: 'src/utils.ts',
      metrics: { fanIn: 58, fanOut: 1, isHub: true },
      blastRadius: { total: 60, upstream: 58, downstream: 2 },
      riskLevel: 'critical',
      crossDomain: { ecosystems: ['http'] },
      governingDecisions: [{ id: 'd1', title: 'Validate directories at the boundary', affectedDomains: ['mcp-handlers'] }],
    } as never);
    vi.mocked(handleCheckSpecDrift).mockResolvedValue(driftResult([
      { id: 'm1', kind: 'memory-orphaned', severity: 'warning', message: 'memory anchored to gone symbol', filePath: 'src/utils.ts', domain: null, specPath: null, suggestion: '' },
      { id: 's1', kind: 'stale', severity: 'warning', message: 'mcp-handlers spec describes removed behavior', filePath: 'src/utils.ts', domain: 'mcp-handlers', specPath: 'openspec/specs/mcp-handlers/spec.md', suggestion: '' },
      { id: 'a1', kind: 'adr-orphaned', severity: 'warning', message: 'ADR references a domain that no longer exists', filePath: 'src/utils.ts', domain: 'mcp-handlers', specPath: null, suggestion: '' },
    ]));
    // Default: index current. Composed handlers (select_tests) also call computeStaleness,
    // so use a persistent value (not Once) — a fresh default is set every beforeEach.
    vi.mocked(computeStaleness).mockResolvedValue(undefined);
  });

  it('briefs a hub change: callers, layers, tests, and anchored drift, as one conclusion', async () => {
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;

    // Changed set
    expect(b.changed.files).toBe(1);
    expect(b.changed.symbolNames).toContain('validateDirectory');

    // Impact — hub, layers, governing decision, highest risk
    expect(b.impact.highestRiskLevel).toBe('critical');
    expect(b.impact.maxAffectedCallers).toBe(58);
    expect(b.impact.hubsTouched).toEqual([{ symbol: 'validateDirectory', fanIn: 58 }]);
    expect(b.impact.layersCrossed).toEqual(expect.arrayContaining(['http', 'mcp-handlers']));
    expect(b.impact.governingDecisions).toContain('Validate directories at the boundary');

    // Tests to run (reached the change through select_tests)
    expect(b.tests.count).toBeGreaterThan(0);
    expect(b.tests.toRun.map(t => t.test)).toContain('testValidate');

    // Anchored memory / decision / spec drift, named
    expect(b.memory.orphaned).toBe(1);
    expect(b.memory.willDrift[0].kind).toBe('memory-orphaned');
    expect(b.specs.willGoStale).toBe(1);
    expect(b.decisions.affected).toBe(1);
    expect(b.decisions.orphaned).toBe(1); // uncapped count the block gate reads

    // Federation is honestly out of scope
    expect(b.federation.evaluated).toBe(false);

    // Conclusion-shaped + advisory
    expect(b.posture).toBe('advisory');
    expect(b.headline).toMatch(/hub/i);
    expect(() => assertConclusionShape('blast_radius', b)).not.toThrow();
  });

  it('reports an empty diff as nothing to brief (advisory, no risk)', async () => {
    const { getChangedFiles } = await import('../../drift/git-diff.js');
    vi.mocked(getChangedFiles).mockResolvedValueOnce({ files: [] } as never);
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.changed.files).toBe(0);
    expect(b.impact.highestRiskLevel).toBe('none');
    expect(b.headline).toMatch(/nothing to brief/i);
    expect(() => assertConclusionShape('blast_radius', b)).not.toThrow(); // empty-diff path is conclusion-shaped
  });

  it('degrades gracefully when spec/memory drift is unavailable', async () => {
    vi.mocked(handleCheckSpecDrift).mockResolvedValueOnce({ error: 'No specs found.' });
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.memory.orphaned).toBe(0);
    expect(b.specs.willGoStale).toBe(0);
    expect(b.caveats.join(' ')).toMatch(/drift could not be evaluated/i);
  });

  it('reports the resolved base ref (and caveats the fallback) when the requested ref does not resolve', async () => {
    // The shared helper falls back to main when the requested ref is bogus; the briefing
    // must report what git ACTUALLY diffed against (and disclose it), not the typo.
    const { getChangedFiles, resolveBaseRefDisclosed } = await import('../../drift/git-diff.js');
    vi.mocked(resolveBaseRefDisclosed).mockResolvedValueOnce({ requested: 'totally-bogus-ref', resolved: 'main', fellBack: true });
    vi.mocked(getChangedFiles).mockResolvedValueOnce({ files: [{ path: 'src/utils.ts' }], resolvedBase: 'main' } as never);
    const b = await computeBlastRadius({ directory: '/p', baseRef: 'totally-bogus-ref' }) as BlastRadiusBriefing;
    expect(b.baseRef).toBe('totally-bogus-ref');     // what the caller asked for
    expect(b.resolvedBaseRef).toBe('main');          // what git actually diffed
    expect(b.baseRefFallback).toEqual({ requested: 'totally-bogus-ref', resolved: 'main' });
    expect(b.caveats.join(' ')).toMatch(/Requested base ref "totally-bogus-ref" did not resolve.*diffed against "main"/i);
  });

  it('emits no fallback caveat when the requested ref resolves as-is', async () => {
    // Default fixture: getChangedFiles returns resolvedBase 'HEAD' for the default 'HEAD' request.
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.resolvedBaseRef).toBe('HEAD');
    expect(b.caveats.join(' ')).not.toMatch(/did not resolve/i);
  });

  it('discloses index staleness when the graph predates the working tree (finding #2)', async () => {
    // A risk headline computed over a stale graph must say so — the same boundary shape
    // certify-public-surface already emits.
    const marker = { indexCommit: 'abc1234', filesChangedSince: 42, detail: '42 source file(s) changed since abc1234.' };
    vi.mocked(computeStaleness).mockResolvedValue(marker);
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.confidenceBoundary?.staleness).toEqual(marker);
  });

  it('omits the confidence boundary when the index is current (no false staleness noise)', async () => {
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.confidenceBoundary).toBeUndefined();
  });

  it('errors clearly when no analysis exists', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce(null as never);
    const r = await computeBlastRadius({ directory: '/p' });
    expect(r).toEqual({ error: expect.stringMatching(/analyze_codebase/i) });
    expect(() => assertConclusionShape('blast_radius', r)).not.toThrow(); // {error} path is conclusion-shaped
  });

  it('resolves the analyze_impact match whose file matches the changed seed (name collision)', async () => {
    vi.mocked(handleAnalyzeImpact).mockResolvedValueOnce({ matches: [
      { symbol: 'validateDirectory', file: 'src/other.ts', metrics: { fanIn: 1, fanOut: 0, isHub: false }, blastRadius: { total: 1, upstream: 1, downstream: 0 }, riskLevel: 'low' },
      { symbol: 'validateDirectory', file: 'src/utils.ts', metrics: { fanIn: 58, fanOut: 1, isHub: true }, blastRadius: { total: 60, upstream: 58, downstream: 2 }, riskLevel: 'critical' },
    ] } as never);
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.impact.topSymbols[0].file).toBe('src/utils.ts');
    expect(b.impact.maxAffectedCallers).toBe(58);
  });

  it('skips a symbol whose impact is an error/null shape (no crash, none counted)', async () => {
    vi.mocked(handleAnalyzeImpact).mockResolvedValueOnce({ error: 'not found' } as never);
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.impact.topSymbols).toHaveLength(0);
    expect(b.impact.highestRiskLevel).toBe('none');
  });

  it('reports impact truncation (no silent truncation) when more symbols change than maxSymbols', async () => {
    const nodes = [
      node({ id: 'src/utils.ts::a', fanIn: 5 }),
      node({ id: 'src/utils.ts::b', fanIn: 3 }),
      node({ id: 'src/utils.ts::c', fanIn: 1 }),
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph(nodes, []) } as never);
    const b = await computeBlastRadius({ directory: '/p', maxSymbols: 1 }) as BlastRadiusBriefing;
    expect(b.impact.analyzedSymbolCount).toBe(1);
    expect(b.impact.truncated?.omitted).toBe(2);
    expect(b.caveats.join(' ')).toMatch(/lower-risk symbols were not individually analyzed/i);
  });

  it('clamps depth (≤6) and maxSymbols (≥1) to safe ranges', async () => {
    vi.mocked(handleAnalyzeImpact).mockClear();
    await computeBlastRadius({ directory: '/p', depth: 99, maxSymbols: 0 });
    const calls = vi.mocked(handleAnalyzeImpact).mock.calls;
    expect(calls.length).toBeGreaterThan(0);          // maxSymbols 0 clamped to ≥1
    expect(calls.every(c => c[2] === 6)).toBe(true);  // depth 99 clamped to 6
  });

  it('does not abort the briefing when impact analysis throws for a symbol (advisory — never block)', async () => {
    vi.mocked(handleAnalyzeImpact).mockRejectedValueOnce(new Error('boom'));
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.posture).toBe('advisory');
    expect(b.impact.topSymbols).toHaveLength(0);       // the throwing symbol contributes nothing
  });

  it('says tests could not be COMPUTED when select_tests throws, rather than reporting zero', async () => {
    // "0 tests to run" and "test selection failed" are different claims. Reported as a
    // bare 0 on a hub change, a pre-commit reader concludes nothing is impacted.
    vi.mocked(handleSelectTests).mockRejectedValueOnce(new Error('tested_by table missing'));
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.tests.count).toBe(0);
    expect(b.tests.unavailable).toMatch(/tested_by table missing/);
    expect(b.caveats.join(' ')).toMatch(/could not be computed/i);
    // The headline is the line acted on, so it must not silently drop the clause.
    expect(b.headline).toMatch(/tests to run could not be computed/i);
  });

  it('counts symbols actually ANALYZED, not merely attempted, and discloses failures', async () => {
    vi.mocked(handleAnalyzeImpact).mockRejectedValueOnce(new Error('boom'));
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.impact.analyzedSymbolCount).toBe(0);
    expect(b.caveats.join(' ')).toMatch(/Impact analysis failed for 1/);
  });

  it('degrades to drift-unavailable (caveat) when check_spec_drift throws (advisory — never block)', async () => {
    vi.mocked(handleCheckSpecDrift).mockRejectedValueOnce(new Error('git exploded'));
    const b = await computeBlastRadius({ directory: '/p' }) as BlastRadiusBriefing;
    expect(b.specs.willGoStale).toBe(0);
    expect(b.caveats.join(' ')).toMatch(/drift could not be evaluated.*git exploded/i);
  });
});

describe('triggeredBlockPatterns (opt-in blocking fires only on its pattern)', () => {
  const orphanBriefing = {
    memory: { orphaned: 1, drifted: 0, willDrift: [] },
    decisions: { affected: 1, orphaned: 1, items: [{ kind: 'adr-orphaned', message: 'x', domain: null }] },
  } as unknown as BlastRadiusBriefing;

  const cleanBriefing = {
    memory: { orphaned: 0, drifted: 2, willDrift: [] },
    decisions: { affected: 1, orphaned: 0, items: [{ kind: 'adr-gap', message: 'x', domain: null }] },
  } as unknown as BlastRadiusBriefing;

  it('fires when a configured pattern is triggered', () => {
    expect(triggeredBlockPatterns(orphanBriefing, ['orphans-anchored-memory'])).toEqual(['orphans-anchored-memory']);
    expect(triggeredBlockPatterns(orphanBriefing, ['orphans-anchored-decision'])).toEqual(['orphans-anchored-decision']);
  });

  it('stays advisory (no block) when the pattern is not triggered', () => {
    // A high-blast-radius but non-orphaning diff: memory only drifted, decision only adr-gap.
    expect(triggeredBlockPatterns(cleanBriefing, ['orphans-anchored-memory', 'orphans-anchored-decision'])).toEqual([]);
  });

  it('is advisory by default (no configured patterns → never blocks)', () => {
    expect(triggeredBlockPatterns(orphanBriefing, [])).toEqual([]);
  });

  it('blocks on the uncapped orphaned count even when the orphaned issue is past the items display cap', () => {
    // Regression: items is capped at 20 and may omit the adr-orphaned issue; the block
    // gate must read decisions.orphaned (uncapped), not scan the truncated items array.
    const cappedBriefing = {
      memory: { orphaned: 0, drifted: 0, willDrift: [] },
      decisions: { affected: 21, orphaned: 1, items: Array.from({ length: 20 }, () => ({ kind: 'adr-gap', message: 'g', domain: null })) },
    } as unknown as BlastRadiusBriefing;
    expect(cappedBriefing.decisions.items.some(i => i.kind === 'adr-orphaned')).toBe(false); // the old (buggy) check would miss it
    expect(triggeredBlockPatterns(cappedBriefing, ['orphans-anchored-decision'])).toEqual(['orphans-anchored-decision']);
  });
});
