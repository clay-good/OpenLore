/**
 * working-set context briefing — intent extraction, the pure per-target projection
 * and budget core, and the read-only handler over a spec-store binding
 * (change: add-working-set-context-briefing).
 *
 * The "briefed" path (handleOrient against a real index) is exercised end-to-end
 * in the dogfood report, not here: CI checkouts carry no `.openlore/analysis`, so
 * the briefing's merge/budget/attribution core is factored into pure functions
 * (`briefTargetFromOrient`, `rankAndBudget`) that ARE tested deterministically
 * with synthetic orient-shaped inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleWorkingSetContext,
  extractIntent,
  briefTargetFromOrient,
  rankAndBudget,
  type OrientView,
  type WorkingSetItem,
} from './working-set.js';
import { assertConclusionShape } from './tool-contract.js';
import { dispatchTool } from '../tool-dispatch.js';
import { addRepo } from '../../federation/registry.js';
import {
  OPENLORE_DIR,
  OPENLORE_CONFIG_FILENAME,
  OPENLORE_ANALYSIS_REL_PATH,
  ARTIFACT_FINGERPRINT,
} from '../../../constants.js';
import type { SpecStoreConfig } from '../../../types/index.js';

let home: string;
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'workingset-'));
  home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeBinding(binding: SpecStoreConfig | undefined): void {
  mkdirSync(join(home, OPENLORE_DIR), { recursive: true });
  const config: Record<string, unknown> = {
    version: '1.0.0', projectType: 'library', openspecPath: 'openspec',
    analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
    generation: { model: 'x', domains: 'auto' },
    createdAt: new Date().toISOString(), lastRun: null,
  };
  if (binding) config.specStore = binding;
  writeFileSync(join(home, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME), JSON.stringify(config, null, 2));
}

function makeRepo(name: string, fingerprint: string | null): string {
  const repoPath = join(scratch, name);
  mkdirSync(repoPath, { recursive: true });
  if (fingerprint !== null) {
    mkdirSync(join(repoPath, OPENLORE_ANALYSIS_REL_PATH), { recursive: true });
    writeFileSync(join(repoPath, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_FINGERPRINT), JSON.stringify({ hash: fingerprint }));
  }
  return repoPath;
}

/** Write a change proposal (and optional spec-delta domains) under a store path. */
function writeChange(storePath: string, id: string, proposal: string, scopeDomains: string[] = []): void {
  const changeDir = join(storePath, 'openspec', 'changes', id);
  mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, 'proposal.md'), proposal);
  for (const d of scopeDomains) {
    mkdirSync(join(changeDir, 'specs', d), { recursive: true });
    writeFileSync(join(changeDir, 'specs', d, 'spec.md'), `# ${d} delta\n`);
  }
}

// ── Pure: intent extraction ──────────────────────────────────────────────────
describe('extractIntent', () => {
  it('combines the title with the first paragraph of the Why section', () => {
    const intent = extractIntent(
      '# Add rate limiting\n\n> Status: PROPOSED\n\n## Why\n\nThe API has no throttle.\n\nMore detail.\n\n## What changes\n\nfoo',
      'add-rate-limiting',
    );
    expect(intent).toBe('Add rate limiting. The API has no throttle.');
  });

  it('falls back to the change id and first prose paragraph when no Why section exists', () => {
    const intent = extractIntent('Just some prose with no heading at all.', 'my-change');
    expect(intent).toContain('my-change');
    expect(intent).toContain('Just some prose');
  });

  it('truncates to stay clear of MAX_QUERY_LENGTH (1000)', () => {
    const long = '# T\n\n## Why\n\n' + 'word '.repeat(500);
    const intent = extractIntent(long, 'c');
    expect(intent.length).toBeLessThanOrEqual(950);
  });

  // Adversarial: CRLF (Windows-authored) proposals must not lose the Why body.
  it('preserves the Why body under CRLF line endings', () => {
    const intent = extractIntent('# Title\r\n\r\n## Why\r\n\r\nReason here.\r\n', 'c');
    expect(intent).toBe('Title. Reason here.');
  });

  // Adversarial: an empty Why section must not spill the next heading into the query.
  it('does not leak the next heading when the Why section is empty', () => {
    const intent = extractIntent('# Title\n\n## Why\n\n## What changes\n\nfoo bar', 'c');
    expect(intent).not.toContain('#');
    expect(intent).toBe('Title. foo bar');
  });

  // Adversarial: truncation must never end on a dangling lone surrogate, and never
  // exceed MAX_QUERY_LENGTH (1000) even for an emoji-dense proposal.
  it('truncates an emoji-dense proposal without leaving a lone surrogate', () => {
    const intent = extractIntent('# T\n\n## Why\n\n' + '😀'.repeat(600), 'c');
    expect(intent.length).toBeLessThanOrEqual(1000);
    expect(/[\uD800-\uDBFF]$/.test(intent)).toBe(false);
  });
});

// ── Pure: per-target projection ──────────────────────────────────────────────
describe('briefTargetFromOrient', () => {
  const orient: OrientView = {
    relevantFunctions: [
      { name: 'handleX', filePath: 'src/x.ts', score: 9, expand: 'handleX::src/x.ts' },
      { name: 'helperY', filePath: 'src/y.ts', score: 4, expand: 'helperY::src/y.ts' },
    ],
    callPaths: [
      { function: 'handleX', filePath: 'src/x.ts', callers: [{ name: 'main' }, { name: 'cli' }] },
    ],
    specDomains: [{ domain: 'api' }],
    insertionPoints: [
      { name: 'handleX', filePath: 'src/x.ts', strategy: 'extend_entry_point' },
    ],
    // orient's pendingDecisions: a fresh one, a drifted one (freshness), and one
    // flagged only via `verify`. Orphaned anchors NEVER appear here (orient routes
    // them to staleDecisions, which the handler deliberately does not consume).
    pendingDecisions: [
      { id: 'd1', title: 'Use JWTs', status: 'approved', freshness: 'fresh', provenance: 'reviewed-corpus' },
      { id: 'd2', title: 'Old cache policy', status: 'approved', freshness: 'drifted', provenance: 'reviewed-corpus' },
      { id: 'd3', title: 'Verify me', status: 'draft', verify: true, provenance: 'local-unreviewed' },
    ],
  };

  it('attributes every item to its target and maps callers + spec domains', () => {
    const { items, brief } = briefTargetFromOrient('api', orient);
    expect(items).toHaveLength(2);
    expect(items.every(i => i.target === 'api')).toBe(true);
    expect(items[0]).toMatchObject({ name: 'handleX', callers: ['main', 'cli'], specDomains: ['api'] });
    expect(items[1].callers).toEqual([]); // helperY has no call path
    expect(brief.insertionPoints).toHaveLength(1);
    expect(brief.specDomains).toEqual(['api']);
  });

  it('flags drifted (or verify-marked) anchored intent and marks the rest current', () => {
    const { brief } = briefTargetFromOrient('api', orient);
    const current = brief.anchoredIntent.filter(a => a.verdict === 'current');
    const drifted = brief.anchoredIntent.filter(a => a.verdict === 'drifted');
    expect(current.map(a => a.id)).toEqual(['d1']);
    expect(drifted.map(a => a.id)).toEqual(['d2', 'd3']); // freshness:'drifted' AND verify:true
    expect(brief.anchoredIntent.map(a => a.provenance)).toEqual([
      'reviewed-corpus', 'reviewed-corpus', 'local-unreviewed',
    ]);
  });

  // Spec: "orphaned intent SHALL be withheld." Orphaned anchors live in orient's
  // staleDecisions, which the handler does not consume — so they never appear here,
  // and they are NEVER presented as current.
  it('withholds orphaned intent entirely (orient routes it away from pendingDecisions)', () => {
    const { brief } = briefTargetFromOrient('api', {
      relevantFunctions: [],
      // an orphaned decision would only ever arrive via staleDecisions/governingDecisions,
      // neither of which the handler reads; pendingDecisions is empty here.
      pendingDecisions: [],
    });
    expect(brief.anchoredIntent).toHaveLength(0);
  });
});

// ── Pure: rank + budget ──────────────────────────────────────────────────────
describe('rankAndBudget', () => {
  const items: WorkingSetItem[] = [
    { target: 'web', provenance: 'source-derived', name: 'low', filePath: 'a', score: 1, expand: 'x', callers: [], specDomains: [] },
    { target: 'api', provenance: 'source-derived', name: 'high', filePath: 'b', score: 9, expand: 'y', callers: [], specDomains: [] },
    { target: 'api', provenance: 'source-derived', name: 'mid', filePath: 'c', score: 5, expand: 'z', callers: [], specDomains: [] },
  ];

  it('ranks by score descending and keeps all when budget is ample', () => {
    const { kept, omitted } = rankAndBudget(items, 100_000);
    expect(kept.map(i => i.name)).toEqual(['high', 'mid', 'low']);
    expect(omitted).toBe(0);
  });

  it('truncates an over-budget set and reports how many were omitted', () => {
    const { kept, omitted } = rankAndBudget(items, 1); // tiny budget keeps ≥1
    expect(kept).toHaveLength(1);
    expect(kept[0].name).toBe('high'); // the highest-scored survives
    expect(omitted).toBe(2);
  });

  it('is deterministic for equal scores (stable on target then name)', () => {
    const tie: WorkingSetItem[] = [
      { target: 'b', provenance: 'source-derived', name: 'q', filePath: 'p', score: 3, expand: 'e', callers: [], specDomains: [] },
      { target: 'a', provenance: 'source-derived', name: 'z', filePath: 'p', score: 3, expand: 'e', callers: [], specDomains: [] },
      { target: 'a', provenance: 'source-derived', name: 'a', filePath: 'p', score: 3, expand: 'e', callers: [], specDomains: [] },
    ];
    expect(rankAndBudget(tie, 100_000).kept.map(i => `${i.target}/${i.name}`))
      .toEqual(['a/a', 'a/z', 'b/q']);
  });

  // Total order: two same-named symbols in one target, differing only by file, must
  // sort by filePath — so a tight budget's truncation boundary is reproducible
  // regardless of input order / engine sort stability.
  it('breaks score+target+name ties on filePath', () => {
    const fwd: WorkingSetItem[] = [
      { target: 'api', provenance: 'source-derived', name: 'init', filePath: 'b.ts', score: 5, expand: 'e', callers: [], specDomains: [] },
      { target: 'api', provenance: 'source-derived', name: 'init', filePath: 'a.ts', score: 5, expand: 'e', callers: [], specDomains: [] },
    ];
    const rev = [...fwd].reverse();
    expect(rankAndBudget(fwd, 100_000).kept.map(i => i.filePath)).toEqual(['a.ts', 'b.ts']);
    // Same result whichever order they arrive in, and a 1-item budget keeps a.ts.
    expect(rankAndBudget(rev, 100_000).kept.map(i => i.filePath)).toEqual(['a.ts', 'b.ts']);
    expect(rankAndBudget(rev, 1).kept[0].filePath).toBe('a.ts');
  });
});

// ── Handler over a spec-store binding (no real index required) ────────────────
describe('handleWorkingSetContext', () => {
  it('reports bound:false with a no-binding finding when nothing is configured', async () => {
    writeBinding(undefined);
    const report = await handleWorkingSetContext(home, 'some-change');
    expect(report.bound).toBe(false);
    expect(report.ready).toBe(false);
    expect(report.findings[0].code).toBe('no-binding');
    expect(() => assertConclusionShape('working_set_context', report)).not.toThrow();
  });

  it('without a change id, returns a change-unspecified info finding and does not brief', async () => {
    const api = makeRepo('api', 'h');
    addRepo(home, api, { name: 'api' });
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'] });

    const report = await handleWorkingSetContext(home);
    expect(report.bound).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.findings.some(f => f.code === 'change-unspecified')).toBe(true);
    expect(report.targets.every(t => !t.briefed)).toBe(true);
  });

  it('an unknown change id yields a change-not-found error finding', async () => {
    const api = makeRepo('api', 'h');
    addRepo(home, api, { name: 'api' });
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'] });

    const report = await handleWorkingSetContext(home, 'no-such-change');
    expect(report.findings.some(f => f.code === 'change-not-found')).toBe(true);
    expect(report.ready).toBe(false);
    expect(() => assertConclusionShape('working_set_context', report)).not.toThrow();
  });

  // SECURITY: a path-traversal change id must NOT read a proposal outside the store.
  // It degrades to change-not-found (the change does not resolve under the store),
  // never leaking out-of-store file contents into the briefing.
  it('refuses a path-traversal change id and leaks nothing outside the store', async () => {
    const api = makeRepo('api', 'h');
    addRepo(home, api, { name: 'api' });
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'] });
    // Plant a proposal OUTSIDE the store that traversal would otherwise reach:
    // <scratch>/secret/proposal.md, reachable from <store>/openspec/changes via ../../../secret
    mkdirSync(join(scratch, 'secret'), { recursive: true });
    writeFileSync(join(scratch, 'secret', 'proposal.md'), '# SECRET\n\n## Why\n\nOut-of-store content.');

    const report = await handleWorkingSetContext(home, '../../../secret');
    expect(report.findings.some(f => f.code === 'change-not-found')).toBe(true);
    expect(report.change?.intent ?? '').not.toContain('Out-of-store');
    expect(report.change?.intent ?? '').not.toContain('SECRET');
    expect(report.ready).toBe(false);
    expect(() => assertConclusionShape('working_set_context', report)).not.toThrow();
  });

  it('a resolved-but-unindexed target is reported as target-not-briefable, not briefed', async () => {
    const api = makeRepo('api', null); // dir exists, no index
    addRepo(home, api, { name: 'api' });
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: ['api'] });
    writeChange(store, 'feat-x', '# Feat X\n\n## Why\n\nReason for X.');

    const report = await handleWorkingSetContext(home, 'feat-x');
    expect(report.change?.id).toBe('feat-x');
    expect(report.targets.find(t => t.target === 'api')?.briefed).toBe(false);
    expect(report.findings.some(f => f.code === 'target-not-briefable')).toBe(true);
    // No briefable target at all → a blocking no-briefable-targets finding.
    expect(report.findings.some(f => f.code === 'no-briefable-targets')).toBe(true);
  });

  it('surfaces declared scope and an unsound binding as a warning while still reporting', async () => {
    const api = makeRepo('api', null);
    addRepo(home, api, { name: 'api' });
    const store = makeRepo('plans', null);
    // "web" is declared but unregistered → the binding is unsound (an error finding).
    writeBinding({ name: 'plans', path: store, targets: ['api', 'web'] });
    writeChange(store, 'feat-x', '# Feat X\n\n## Why\n\nReason for X.', ['api', 'cli']);

    const report = await handleWorkingSetContext(home, 'feat-x');
    expect(report.change?.declaredScope).toEqual(['api', 'cli']);
    expect(report.findings.some(f => f.code === 'binding-unsound')).toBe(true);
  });

  it('dispatchTool(working_set_context) resolves to a conclusion-shaped report', async () => {
    const store = makeRepo('plans', null);
    writeBinding({ name: 'plans', path: store, targets: [] });
    writeChange(store, 'feat-x', '# Feat X\n\n## Why\n\nReason.');

    const result = await dispatchTool('working_set_context', { directory: home, change: 'feat-x' }, home);
    expect(() => assertConclusionShape('working_set_context', result)).not.toThrow();
    expect((result as { bound: boolean }).bound).toBe(true);
  });
});
