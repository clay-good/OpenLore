/**
 * add-pr-review-surface — `openlore review` composes structural_diff + blast_radius
 * into a deterministic Markdown PR briefing:
 *   - renderMarkdown: conclusion-shaped (names removed/changed symbols, stale callers,
 *     hubs, tests, drift), capped (no wall-of-text), and carries the sticky marker.
 *   - composeReview: degrades honestly (blast error → structural-only + caveat; both
 *     error → status "unavailable"); flags an explicit --head and a base-ref fallback.
 *   - runReviewCli: --format json emits the composed briefing as pure JSON on stdout;
 *     advisory by default — gating (exit 1) only in --hook mode with a configured pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../core/services/mcp-handlers/blast-radius.js', () => ({ computeBlastRadius: vi.fn() }));
vi.mock('../../core/services/mcp-handlers/structural-diff.js', () => ({ handleStructuralDiff: vi.fn() }));
vi.mock('../../core/services/config-manager.js', () => ({ readOpenLoreConfig: vi.fn() }));
vi.mock('node:fs/promises', () => ({ writeFile: vi.fn() }));

import { writeFile } from 'node:fs/promises';

import { composeReview, renderMarkdown, runReviewCli, REVIEW_MARKER, MAX_MARKDOWN_CHARS, type ReviewBriefing } from './review.js';
import { computeBlastRadius } from '../../core/services/mcp-handlers/blast-radius.js';
import { handleStructuralDiff } from '../../core/services/mcp-handlers/structural-diff.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import type { BlastRadiusBriefing } from '../../core/services/mcp-handlers/blast-radius.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────
const structuralWithDelta = {
  base: 'main', head: 'working tree',
  changedFiles: [{ path: 'src/auth.ts', status: 'modified' }],
  summary: { addedFunctions: 1, removedFunctions: 1, signatureChanges: 1, addedEdges: 0, removedEdges: 2, staleCallers: 7, renameCandidates: 0 },
  added: [{ name: 'logout', file: 'src/auth.ts' }],
  removed: [{ name: 'gamma', file: 'src/auth.ts', staleCallers: [{ file: 'a.ts', name: 'x' }, { file: 'b.ts', name: 'y' }] }],
  signatureChanged: [{ name: 'alpha', file: 'src/auth.ts', before: 'alpha()', after: 'alpha(x)', staleCallers: Array.from({ length: 5 }, (_, i) => ({ file: `c${i}.ts`, name: 'k' })) }],
  renameCandidates: [],
};

const blastBriefing = {
  baseRef: 'main', resolvedBaseRef: 'main',
  headline: 'h', posture: 'advisory',
  changed: { files: 1, symbols: 2, symbolNames: [] },
  impact: { highestRiskLevel: 'high', maxAffectedCallers: 58, hubsTouched: [{ symbol: 'validateDirectory', fanIn: 58 }], layersCrossed: ['cli', 'core'], governingDecisions: ['ADR-12: auth'], topSymbols: [], analyzedSymbolCount: 2 },
  tests: { count: 3, toRun: [{ test: 'a.test.ts', file: 'a.test.ts', confidence: 'high' }, { test: 'b.test.ts', file: 'b.test.ts', confidence: 'high' }, { test: 'c.test.ts', file: 'c.test.ts', confidence: 'med' }], soundness: {} },
  memory: { drifted: 0, orphaned: 0, willDrift: [] },
  specs: { willGoStale: 1, items: [{ kind: 'stale', message: 'auth spec stale', domain: 'auth', specPath: 'openspec/specs/auth/spec.md' }] },
  decisions: { affected: 0, orphaned: 0, items: [] },
  federation: { evaluated: false, note: '' },
  caveats: [],
} as unknown as BlastRadiusBriefing;

describe('renderMarkdown (conclusion-shaped briefing)', () => {
  it('names removed + signature-changed symbols with their stale callers, hubs, tests, drift, and the sticky marker', () => {
    const b: ReviewBriefing = { base: 'main', head: 'working tree', structural: structuralWithDelta, blast: blastBriefing, caveats: [], status: 'ok' };
    const md = renderMarkdown(b);
    expect(md.startsWith(REVIEW_MARKER)).toBe(true);          // marker first line (sticky-comment match)
    expect(md).toContain('**Removed** `gamma`');
    expect(md).toContain('2 callers now dangling');
    expect(md).toContain('**Signature changed** `alpha`');
    expect(md).toContain('5 callers may be stale');
    expect(md).toContain('validateDirectory');               // hub
    expect(md).toContain('Tests to run (3)');
    expect(md).toContain('ADR-12: auth');                    // governing decision
    expect(md).toContain('auth spec stale');                 // drift
    expect(md).toContain('Advisory');                        // advisory footer
  });

  it('caps a wide drift list to a briefing, not a wall of text', () => {
    const wide = { ...blastBriefing, decisions: { affected: 23, orphaned: 0, items: Array.from({ length: 20 }, () => ({ kind: 'adr-gap', message: 'g', domain: null })) } } as unknown as BlastRadiusBriefing;
    const md = renderMarkdown({ base: 'main', head: 'working tree', structural: structuralWithDelta, blast: wide, caveats: [], status: 'ok' });
    const decisionLines = md.split('\n').filter(l => l.includes('**Decision**')).length;
    expect(decisionLines).toBeLessThanOrEqual(5);
    expect(md).toMatch(/and 18 more decision issue/);        // 23 affected − 5 shown
  });

  it('discloses a missing index instead of an empty briefing', () => {
    const md = renderMarkdown({ base: 'main', head: 'working tree', structural: structuralWithDelta, blast: { error: 'No analysis found.' }, caveats: ['Blast radius unavailable (No analysis found.) — showing the structural delta only. Run `openlore analyze` for the full briefing.'], status: 'ok' });
    expect(md).toContain('Blast radius unavailable');
    expect(md).toContain('openlore analyze');
    expect(md).toContain('**Removed** `gamma`');             // structural delta still shown
  });

  it('always fits in a GitHub comment (≤65536 chars) even with pathological names + many hubs', () => {
    // A 50k-char symbol name + 200 hubs + 200 long governing decisions would, unbounded,
    // blow past GitHub's 65536-char comment limit and 422 the Action's post step.
    const longName = 'x'.repeat(50_000);
    const pathological = {
      ...structuralWithDelta,
      removed: [{ name: longName, file: `${longName}.ts`, staleCallers: [] }],
      signatureChanged: [{ name: longName + 'B', file: 'a.ts', before: 'a', after: 'b', staleCallers: [] }],
    };
    const blast = {
      ...blastBriefing,
      impact: {
        ...blastBriefing.impact,
        hubsTouched: Array.from({ length: 200 }, (_, i) => ({ symbol: `${longName}_hub${i}`, fanIn: i })),
        governingDecisions: Array.from({ length: 200 }, (_, i) => `ADR-${i}: ${'d'.repeat(500)}`),
        layersCrossed: Array.from({ length: 50 }, (_, i) => `layer${i}`),
      },
    } as unknown as BlastRadiusBriefing;
    const md = renderMarkdown({ base: 'main', head: 'working tree', structural: pathological, blast, caveats: [], status: 'ok' });
    expect(md.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS);
    expect(md.startsWith(REVIEW_MARKER)).toBe(true);          // marker survives any clamp
    expect(md).toMatch(/…and \d+ more/);                      // inline lists summarise the tail
  });
});

describe('composeReview (honest degradation + caveats)', () => {
  beforeEach(() => { vi.mocked(readOpenLoreConfig).mockResolvedValue(null as never); });
  afterEach(() => vi.clearAllMocks());

  it('blast error → status "ok" (structural present) with a disclosure caveat', async () => {
    vi.mocked(handleStructuralDiff).mockResolvedValue(structuralWithDelta);
    vi.mocked(computeBlastRadius).mockResolvedValue({ error: 'No analysis found.' });
    const b = await composeReview({ cwd: '/p', base: 'main' });
    expect(b.status).toBe('ok');
    expect(b.caveats.join(' ')).toMatch(/Blast radius unavailable/);
  });

  it('both analyses error → status "unavailable"', async () => {
    vi.mocked(handleStructuralDiff).mockResolvedValue({ error: 'Not a git repository.' } as never);
    vi.mocked(computeBlastRadius).mockResolvedValue({ error: 'Not a git repository.' });
    const b = await composeReview({ cwd: '/p' });
    expect(b.status).toBe('unavailable');
  });

  it('an explicit --head adds a caveat that blast radius uses the working tree', async () => {
    vi.mocked(handleStructuralDiff).mockResolvedValue(structuralWithDelta);
    vi.mocked(computeBlastRadius).mockResolvedValue(blastBriefing);
    const b = await composeReview({ cwd: '/p', base: 'main', head: 'feature-sha' });
    expect(b.caveats.join(' ')).toMatch(/Blast radius is computed against the working tree/);
  });

  it('surfaces a silent base-ref fallback as a caveat', async () => {
    vi.mocked(handleStructuralDiff).mockResolvedValue(structuralWithDelta);
    vi.mocked(computeBlastRadius).mockResolvedValue({ ...blastBriefing, baseRef: 'bogus', resolvedBaseRef: 'main' } as never);
    const b = await composeReview({ cwd: '/p', base: 'bogus' });
    expect(b.caveats.join(' ')).toMatch(/did not resolve.*diffed against "main"/);
  });

  it('discloses a base-ref fallback even when blast is unavailable (derived from the structural resolved base)', async () => {
    // A shallow CI checkout with no index is exactly the case the spec scenario targets:
    // blast errors, but the typo'd base must still be disclosed via structural.base.
    vi.mocked(handleStructuralDiff).mockResolvedValue({ ...structuralWithDelta, base: 'main' });
    vi.mocked(computeBlastRadius).mockResolvedValue({ error: 'No analysis found.' });
    const b = await composeReview({ cwd: '/p', base: 'bogus' });
    expect(b.caveats.join(' ')).toMatch(/Base ref "bogus" did not resolve.*diffed against "main"/);
  });
});

describe('runReviewCli (output + advisory posture)', () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(readOpenLoreConfig).mockResolvedValue(null as never);
    vi.mocked(handleStructuralDiff).mockResolvedValue(structuralWithDelta);
    vi.mocked(computeBlastRadius).mockResolvedValue(blastBriefing);
  });
  afterEach(() => { outSpy.mockRestore(); errSpy.mockRestore(); vi.clearAllMocks(); });

  it('--format json emits the composed briefing as pure JSON on stdout', async () => {
    const code = await runReviewCli({ cwd: '/p', base: 'main', format: 'json' });
    expect(code).toBe(0);
    const payload = JSON.parse(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(''));
    expect(payload).toMatchObject({ status: 'ok', structural: { summary: { removedFunctions: 1 } } });
  });

  it('markdown output carries the sticky marker on stdout', async () => {
    await runReviewCli({ cwd: '/p', base: 'main', format: 'markdown' });
    expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain(REVIEW_MARKER);
  });

  it('--out to an unwritable path never throws — warns on stderr and falls back to stdout', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));
    const code = await runReviewCli({ cwd: '/p', base: 'main', format: 'markdown', out: '/nope/x.md' });
    expect(code).toBe(0); // advisory: a write failure is not a gate
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toMatch(/Could not write .*writing to stdout instead/);
    expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain(REVIEW_MARKER); // briefing not lost
  });

  it('--out success writes its confirmation to stderr, keeping stdout empty', async () => {
    vi.mocked(writeFile).mockResolvedValueOnce(undefined);
    await runReviewCli({ cwd: '/p', base: 'main', format: 'markdown', out: '/tmp/x.md' });
    expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toBe(''); // stdout stays clean
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toMatch(/Wrote review briefing/);
  });

  it('advisory by default (exit 0) even with a block pattern configured but no --hook', async () => {
    const orphaned = { ...blastBriefing, memory: { drifted: 0, orphaned: 1, willDrift: [{ kind: 'memory-orphaned', message: 'gone', filePath: 'x.ts' }] } } as unknown as BlastRadiusBriefing;
    vi.mocked(computeBlastRadius).mockResolvedValue(orphaned);
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ blastRadius: { block: ['orphans-anchored-memory'] } } as never);
    expect(await runReviewCli({ cwd: '/p', base: 'main' })).toBe(0);
  });

  it('--hook gates (exit 1) only when a configured block pattern fires', async () => {
    const orphaned = { ...blastBriefing, memory: { drifted: 0, orphaned: 1, willDrift: [{ kind: 'memory-orphaned', message: 'gone', filePath: 'x.ts' }] } } as unknown as BlastRadiusBriefing;
    vi.mocked(computeBlastRadius).mockResolvedValue(orphaned);
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ blastRadius: { block: ['orphans-anchored-memory'] } } as never);
    expect(await runReviewCli({ cwd: '/p', base: 'main', hook: true })).toBe(1);
  });

  it('--hook stays advisory (exit 0) when no pattern is configured', async () => {
    expect(await runReviewCli({ cwd: '/p', base: 'main', hook: true })).toBe(0);
  });
});

// ============================================================================
// The headline is the line a PR reviewer acts on
// ============================================================================

describe('headline (the bolded first line of the PR comment)', () => {
  const cleanStructural = {
    ...structuralWithDelta,
    summary: { addedFunctions: 0, removedFunctions: 0, signatureChanges: 0, addedEdges: 0, removedEdges: 0, staleCallers: 0, renameCandidates: 0 },
    added: [], removed: [], signatureChanged: [],
  };
  const line = (b: ReviewBriefing): string =>
    renderMarkdown(b).split('\n').find(l => l.includes('This change') || l.includes('No structural') || l.includes('could not')) ?? '';

  it('phrases an uncomputed test set as a clause, not a bare fragment', () => {
    // It read "This change tests to run could not be computed." — a broken sentence
    // at the top of a public PR comment.
    const blast = { ...blastBriefing, tests: { count: 0, toRun: [], soundness: undefined, unavailable: 'tested_by missing' } } as unknown as BlastRadiusBriefing;
    const md = line({ base: 'main', head: 'working tree', structural: structuralWithDelta, blast, caveats: [], status: 'ok' });
    expect(md).toContain('This change');
    expect(md).toMatch(/test set that could not be computed/);
    expect(md).not.toMatch(/This change tests to run/);
  });

  it('does NOT claim an all-clear when the blast radius never ran', () => {
    // Empty `parts` with a failed blast radius means "half the analysis is missing",
    // not "nothing changed" — and the headline is what gets acted on.
    const md = line({
      base: 'main', head: 'working tree',
      structural: cleanStructural,
      blast: { error: 'no index' } as unknown as BlastRadiusBriefing,
      caveats: ['Blast radius unavailable (no index)'], status: 'ok',
    });
    expect(md).not.toMatch(/^No structural changes detected\./);
    expect(md).toMatch(/blast radius could not be computed/i);
  });

  it('still says the clean thing when both halves ran and found nothing', () => {
    const blast = { ...blastBriefing, impact: { ...blastBriefing.impact, hubsTouched: [] }, tests: { count: 0, toRun: [], soundness: {} } } as unknown as BlastRadiusBriefing;
    const md = line({ base: 'main', head: 'working tree', structural: cleanStructural, blast, caveats: [], status: 'ok' });
    expect(md).toContain('No structural changes detected.');
  });
});
