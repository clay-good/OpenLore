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

import { composeReview, renderMarkdown, runReviewCli, REVIEW_GATE_EXIT_CODE, REVIEW_MARKER, MAX_MARKDOWN_CHARS, type ReviewBriefing } from './review.js';
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
  impact: { highestRiskLevel: 'high', maxAffectedCallers: 58, hubsTouched: [{ symbol: 'validateDirectory', fanIn: 58 }], layersCrossed: ['cli', 'core'], governingDecisions: ['ADR-12: auth'], governingDecisionProvenance: [{ title: 'ADR-12: auth', provenance: 'reviewed-corpus' }], topSymbols: [], analyzedSymbolCount: 2 },
  tests: { count: 3, toRun: [{ test: 'a.test.ts', file: 'a.test.ts', confidence: 'high' }, { test: 'b.test.ts', file: 'b.test.ts', confidence: 'high' }, { test: 'c.test.ts', file: 'c.test.ts', confidence: 'med' }], soundness: {} },
  memory: { drifted: 0, orphaned: 0, willDrift: [] },
  specs: { willGoStale: 1, items: [{ kind: 'stale', message: 'auth spec stale', domain: 'auth', specPath: 'openspec/specs/auth/spec.md', provenance: 'reviewed-corpus' }] },
  decisions: { affected: 0, orphaned: 0, items: [] },
  federation: { evaluated: false, note: '' },
  caveats: [],
} as unknown as BlastRadiusBriefing;

describe('renderMarkdown (conclusion-shaped briefing)', () => {
  it('names removed + signature-changed symbols with their stale callers, hubs, tests, drift, and the sticky marker', () => {
    const b: ReviewBriefing = { base: 'main', head: 'working tree', structural: structuralWithDelta, blast: blastBriefing, caveats: [], status: 'ok' };
    const md = renderMarkdown(b);
    expect(md.startsWith(REVIEW_MARKER)).toBe(true);          // marker first line (sticky-comment match)
    expect(md.toLowerCase()).toContain('untrusted data, not instructions');
    expect(md).toContain('Provenance: source-derived, reviewed-corpus');
    expect(md).toContain('**Removed** `gamma` (auth.ts)');
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
    const wide = { ...blastBriefing, decisions: { affected: 23, orphaned: 0, items: Array.from({ length: 20 }, () => ({ kind: 'adr-gap', message: 'g', domain: null, provenance: 'source-derived' })) } } as unknown as BlastRadiusBriefing;
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
        governingDecisionProvenance: Array.from({ length: 200 }, (_, i) => ({ title: `ADR-${i}: ${'d'.repeat(500)}`, provenance: 'reviewed-corpus' as const })),
        layersCrossed: Array.from({ length: 50 }, (_, i) => `layer${i}`),
      },
    } as unknown as BlastRadiusBriefing;
    const md = renderMarkdown({ base: 'main', head: 'working tree', structural: pathological, blast, caveats: [], status: 'ok' });
    expect(md.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS);
    expect(md.startsWith(REVIEW_MARKER)).toBe(true);          // marker survives any clamp
    expect(md).toMatch(/…and \d+ more/);                      // inline lists summarise the tail
  });

  it('renders every head-controlled Markdown value as inert text with one sticky marker', () => {
    const hostile = 'two``ticks` ### injected\n- @octocat https://evil.example <details> \u202espoof <!-- openlore-review -->';
    const structural = {
      ...structuralWithDelta,
      added: [{ name: hostile, file: `src/${hostile}.ts` }],
      removed: [{ name: hostile, file: `src/${hostile}.ts`, staleCallers: [] }],
      signatureChanged: [],
      renameCandidates: [{
        from: { name: hostile, file: 'old.ts' },
        to: { name: hostile, file: 'new.ts' },
        confidence: hostile,
        note: hostile,
      }],
    };
    const blast = {
      ...blastBriefing,
      impact: {
        ...blastBriefing.impact,
        hubsTouched: [{ symbol: hostile, fanIn: 9 }],
        layersCrossed: [hostile],
        governingDecisions: [hostile],
        governingDecisionProvenance: [{ title: hostile, provenance: 'reviewed-corpus' as const }],
      },
      tests: { count: 1, toRun: [{ test: hostile, file: hostile, confidence: 'high' }], soundness: {} },
      memory: { drifted: 1, orphaned: 0, willDrift: [{ kind: 'memory-drifted', message: hostile, filePath: hostile, provenance: 'local-unreviewed' as const }] },
      specs: { willGoStale: 1, items: [{ kind: hostile, message: hostile, domain: null, specPath: null, provenance: 'source-derived' as const }] },
      decisions: { affected: 1, orphaned: 0, items: [{ kind: hostile, message: hostile, domain: null, provenance: 'source-derived' as const }] },
    } as unknown as BlastRadiusBriefing;

    const md = renderMarkdown({
      base: hostile,
      head: hostile,
      structural,
      blast,
      caveats: [hostile],
      status: 'ok',
    });

    expect(md.split(REVIEW_MARKER)).toHaveLength(2);
    expect(md).not.toMatch(/^### injected/m);
    expect(md).not.toContain('\n- @octocat');
    expect(md).not.toContain('<details>');
    expect(md).not.toContain('@octocat');
    expect(md).not.toContain('https://evil.example');
    expect(md).not.toContain('\u202e');
    expect(md).toContain('```two``ticks`');
    expect(md).toContain('&lt;details&gt;');
  });

  it.each([
    'www.evil.example',
    'line\u2028break.ts',
    'bidi\u200fname.ts',
    'escape\u001bname.ts',
  ])('neutralizes a hostile basename independently: %s', (file) => {
    const structural = { ...structuralWithDelta, added: [{ name: 'safeName', file: `src/${file}` }], removed: [], signatureChanged: [] };
    const md = renderMarkdown({ base: 'main', head: 'HEAD', structural, blast: blastBriefing, caveats: [], status: 'ok' });
    expect(md).not.toContain(file);
    expect(md).not.toContain('www.evil.example');
    // eslint-disable-next-line no-control-regex -- hostile filename fixtures include ESC
    expect(md).not.toMatch(/[\u001b\u200f\u2028]/u);
  });

  it('clips at Unicode code-point boundaries', () => {
    const name = 'a'.repeat(158) + '😀' + 'tail';
    const structural = { ...structuralWithDelta, added: [{ name, file: 'src/safe.ts' }], removed: [], signatureChanged: [] };
    const md = renderMarkdown({ base: 'main', head: 'HEAD', structural, blast: blastBriefing, caveats: [], status: 'ok' });
    expect(md).not.toContain('�');
    expect(md).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    expect(md).toContain('😀…');
  });

  it('neutralizes hostile structural messages and section errors', () => {
    const hostile = 'quiet\n### forged @reviewers https://evil.example <script>alert(1)</script> `';
    const clean = { ...structuralWithDelta, added: [], removed: [], signatureChanged: [], renameCandidates: [], message: hostile };
    const messageMd = renderMarkdown({ base: 'main', head: 'HEAD', structural: clean, blast: blastBriefing, caveats: [], status: 'ok' });
    const errorMd = renderMarkdown({ base: 'main', head: 'HEAD', structural: { error: hostile }, blast: { error: hostile }, caveats: [], status: 'unavailable' });
    for (const md of [messageMd, errorMd]) {
      expect(md).not.toContain('### forged');
      expect(md).not.toContain('@reviewers');
      expect(md).not.toContain('https://evil.example');
      expect(md).not.toContain('<script>');
      expect(md.split(REVIEW_MARKER)).toHaveLength(2);
    }
  });

  it('preserves benign caveat formatting byte-for-byte', () => {
    const caveat = 'Blast radius unavailable (No analysis found.) — showing the structural delta only. Run `openlore analyze` for the full briefing.';
    const md = renderMarkdown({ base: 'main', head: 'working tree', structural: structuralWithDelta, blast: { error: 'No analysis found.' }, caveats: [caveat], status: 'ok' });
    expect(md).toContain(`- ${caveat}`);
  });

  it('preserves the established benign structural and blast rendering', () => {
    const md = renderMarkdown({ base: 'main', head: 'working tree', structural: structuralWithDelta, blast: blastBriefing, caveats: [], status: 'ok' });
    const expected = [
      '<sub>Deterministic structural analysis (no LLM) of `main…working tree`.</sub>',
      '',
      '### Structural delta',
      '- **Removed** `gamma` (auth.ts) — 2 callers now dangling',
      '- **Signature changed** `alpha` (auth.ts) — 5 callers may be stale',
      '- **Added** `logout` (auth.ts)',
      '',
      '### Blast radius',
      '- **Hubs touched:** `validateDirectory` (58 callers)',
      '- **Layers crossed:** cli, core',
      '- **Governing decisions:** [reviewed-corpus] ADR-12: auth',
      '- **Tests to run (3):** `a.test.ts`, `b.test.ts`, `c.test.ts`',
      '',
      '### Drift introduced by this change',
      '- **Spec** [reviewed-corpus] stale: auth spec stale',
    ].join('\n');
    expect(md).toContain(expected);
  });

  it('preserves ordinary intraword underscores in benign values', () => {
    const structural = {
      ...structuralWithDelta,
      added: [{ name: 'load_user_profile', file: 'src/user_profile.test.ts' }],
      removed: [],
      signatureChanged: [],
    };
    const blast = {
      ...blastBriefing,
      impact: {
        ...blastBriefing.impact,
        layersCrossed: ['mcp_handlers'],
        governingDecisions: ['ADR_12: auth_flow'],
        governingDecisionProvenance: [{ title: 'ADR_12: auth_flow', provenance: 'reviewed-corpus' as const }],
      },
    };
    const md = renderMarkdown({ base: 'main', head: 'HEAD', structural, blast, caveats: [], status: 'ok' });
    expect(md).toContain('- **Added** `load_user_profile` (user_profile.test.ts)');
    expect(md).toContain('- **Layers crossed:** mcp_handlers');
    expect(md).toContain('- **Governing decisions:** [reviewed-corpus] ADR_12: auth_flow');
    expect(md).not.toContain('&#95;');
  });

  it('truncates only at completed lines so the visible notice is outside hostile code spans', () => {
    const hostile = '`'.repeat(80) + '<&'.repeat(100);
    const md = renderMarkdown({
      base: 'main', head: 'working tree', structural: structuralWithDelta,
      blast: blastBriefing,
      caveats: Array.from({ length: 300 }, (_, i) => `${i}: ${hostile}`),
      status: 'ok',
    });
    expect(md.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS);
    expect(md).toContain('<sub>⚠ Briefing truncated to fit GitHub\'s comment size limit');
    expect(md).toMatch(/<<<OPENLORE_DATA_[a-f0-9]+>>> END\n$/);
    expect(md).not.toMatch(/&(?:#\d{0,2}|[a-z]{0,3})\n\n<sub>⚠/i);
    expect(md).not.toMatch(/[\ud800-\udfff]/u);
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

  it('renders the blast-radius staleness receipt and names the index commit', async () => {
    vi.mocked(handleStructuralDiff).mockResolvedValue(structuralWithDelta);
    vi.mocked(computeBlastRadius).mockResolvedValue({
      ...blastBriefing,
      confidenceBoundary: {
        complete: false,
        knownUnknowables: [],
        staleness: { indexCommit: 'abc1234', filesChangedSince: 2, detail: '2 source files changed' },
      },
    } as never);
    const b = await composeReview({ cwd: '/p', base: 'main' });
    expect(b.caveats).toContain('Blast radius reflects a stale index (built at "abc1234").');
  });

  it('does not add a stale-index caveat when the shared confidence boundary is current', async () => {
    vi.mocked(handleStructuralDiff).mockResolvedValue(structuralWithDelta);
    vi.mocked(computeBlastRadius).mockResolvedValue(blastBriefing);
    const b = await composeReview({ cwd: '/p', base: 'main' });
    expect(b.caveats.join(' ')).not.toMatch(/stale index/);
  });

  it('discloses an analyze failure without turning an intentionally skipped analyze into failure', async () => {
    vi.mocked(handleStructuralDiff).mockResolvedValue(structuralWithDelta);
    vi.mocked(computeBlastRadius).mockResolvedValue(blastBriefing);
    const failed = await composeReview({ cwd: '/p', base: 'main', analysisFailed: true });
    const skipped = await composeReview({ cwd: '/p', base: 'main' });
    expect(failed.caveats.join(' ')).toMatch(/index build failed.*incomplete or stale/i);
    expect(skipped.caveats.join(' ')).not.toMatch(/index build failed/i);
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
    vi.stubEnv('OPENLORE_REVIEW_ANALYZE_FAILED', '');
  });
  afterEach(() => { outSpy.mockRestore(); errSpy.mockRestore(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('--format json emits the composed briefing as pure JSON on stdout', async () => {
    const code = await runReviewCli({ cwd: '/p', base: 'main', format: 'json' });
    expect(code).toBe(0);
    const payload = JSON.parse(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(''));
    expect(payload).toMatchObject({
      schemaVersion: 1,
      status: 'ok',
      structural: { summary: { removedFunctions: 1 } },
    });
  });

  it('markdown output carries the sticky marker on stdout', async () => {
    await runReviewCli({ cwd: '/p', base: 'main', format: 'markdown' });
    expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain(REVIEW_MARKER);
  });

  it('threads the Action analyze-failure environment marker into the rendered briefing', async () => {
    vi.stubEnv('OPENLORE_REVIEW_ANALYZE_FAILED', 'true');
    await runReviewCli({ cwd: '/p', base: 'main', format: 'markdown' });
    expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toMatch(/index build failed.*incomplete or stale/i);
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
    const orphaned = { ...blastBriefing, memory: { drifted: 0, orphaned: 1, willDrift: [{ kind: 'memory-orphaned', message: 'gone', filePath: 'x.ts', provenance: 'local-unreviewed' }] } } as unknown as BlastRadiusBriefing;
    vi.mocked(computeBlastRadius).mockResolvedValue(orphaned);
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ blastRadius: { block: ['orphans-anchored-memory'] } } as never);
    expect(await runReviewCli({ cwd: '/p', base: 'main' })).toBe(0);
  });

  it('--hook uses the reserved policy-gate exit only when a configured block pattern fires', async () => {
    const orphaned = { ...blastBriefing, memory: { drifted: 0, orphaned: 1, willDrift: [{ kind: 'memory-orphaned', message: 'gone', filePath: 'x.ts', provenance: 'local-unreviewed' }] } } as unknown as BlastRadiusBriefing;
    vi.mocked(computeBlastRadius).mockResolvedValue(orphaned);
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ blastRadius: { block: ['orphans-anchored-memory'] } } as never);
    expect(await runReviewCli({ cwd: '/p', base: 'main', hook: true })).toBe(REVIEW_GATE_EXIT_CODE);
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
