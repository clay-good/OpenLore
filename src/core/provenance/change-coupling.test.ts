/**
 * Spec-22 — change-coupling & volatility over a crafted git history.
 * Verifies coupled pairs surface, thresholds filter weak pairs, a bulk commit is
 * filtered (manufactures no coupling), churn → volatility, and determinism.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeChangeCoupling, volatilityLevel } from './change-coupling.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}
function commit(cwd: string, files: string[], msg: string): void {
  for (const f of files) writeFileSync(join(cwd, f), `${f} ${msg}\n`);
  git(cwd, ['add', ...files]);
  git(cwd, ['commit', '-q', '-m', msg, '--no-gpg-sign']);
}

describe('volatilityLevel', () => {
  it('maps churn to documented levels', () => {
    expect(volatilityLevel(12)).toBe('high');
    expect(volatilityLevel(5)).toBe('medium');
    expect(volatilityLevel(4)).toBe('low');
    expect(volatilityLevel(0)).toBe('low');
  });
});

describe('analyzeChangeCoupling (crafted history)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'coupling-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'T']); git(repo, ['config', 'user.email', 't@e.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    // a.ts & b.ts move in lockstep (coupled); c.ts becomes volatile; one bulk commit.
    commit(repo, ['a.ts', 'b.ts'], 'c1');
    commit(repo, ['a.ts', 'b.ts'], 'c2');
    commit(repo, ['a.ts', 'b.ts'], 'c3');
    commit(repo, ['a.ts', 'b.ts', 'c.ts'], 'c4');
    commit(repo, ['c.ts'], 'c5');
    commit(repo, ['c.ts'], 'c6');
    commit(repo, ['c.ts'], 'c7');
    commit(repo, ['c.ts'], 'c8');
    // Bulk commit: 30 files (> threshold 25) — must be filtered, manufacture no coupling.
    const bulk = Array.from({ length: 30 }, (_, i) => `g${i}.ts`);
    commit(repo, bulk, 'format sweep');
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('reports the coupled pair above thresholds with correct support/confidence', async () => {
    const r = await analyzeChangeCoupling(repo);
    const a = r.coupling.get('a.ts') ?? [];
    const bForA = a.find(c => c.file === 'b.ts');
    expect(bForA).toBeDefined();
    expect(bForA!.support).toBe(4);          // 4 commits changed both
    expect(bForA!.confidence).toBe(1);       // 4 / churn(a)=4
    // symmetric
    expect((r.coupling.get('b.ts') ?? []).some(c => c.file === 'a.ts')).toBe(true);
  });

  it('filters weak pairs below support/confidence thresholds', async () => {
    const r = await analyzeChangeCoupling(repo);
    // a & c co-changed once (commit c4): support 1, confidence 0.25 — excluded.
    expect((r.coupling.get('a.ts') ?? []).some(c => c.file === 'c.ts')).toBe(false);
  });

  it('filters the bulk commit (no churn or coupling for its files)', async () => {
    const r = await analyzeChangeCoupling(repo);
    expect(r.stats.bulkCommitsFiltered).toBe(1);
    expect(r.churn.has('g0.ts')).toBe(false);
    expect(r.coupling.has('g0.ts')).toBe(false);
  });

  it('tracks churn (volatility) per file', async () => {
    const r = await analyzeChangeCoupling(repo);
    expect(r.churn.get('a.ts')).toBe(4);
    expect(r.churn.get('c.ts')).toBe(5);            // commits c4..c8
    expect(volatilityLevel(r.churn.get('c.ts')!)).toBe('medium');
  });

  it('is deterministic for a fixed git state', async () => {
    const a = await analyzeChangeCoupling(repo);
    const b = await analyzeChangeCoupling(repo);
    const norm = (r: Awaited<ReturnType<typeof analyzeChangeCoupling>>) =>
      JSON.stringify([...r.coupling.entries()].sort());
    expect(norm(a)).toBe(norm(b));
  });
});

describe('analyzeChangeCoupling — start-ref window (fix-git-derived-signal-honesty)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'coupling-window-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'T']); git(repo, ['config', 'user.email', 't@e.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    // Two commits BEFORE the cursor, then a burst AFTER it (the "briefed range").
    commit(repo, ['h.ts'], 'before-1');
    commit(repo, ['h.ts'], 'before-2');
    git(repo, ['tag', 'cursor']);
    commit(repo, ['h.ts'], 'after-1');
    commit(repo, ['h.ts'], 'after-2');
    commit(repo, ['h.ts'], 'after-3');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('mines the whole history from HEAD when no start ref is given (unchanged behavior)', async () => {
    const r = await analyzeChangeCoupling(repo);
    expect(r.churn.get('h.ts')).toBe(5);
    expect(r.stats.commitsScanned).toBe(5);
  });

  it('mines only the start ref and its ancestors — the burst after the cursor is excluded', async () => {
    const r = await analyzeChangeCoupling(repo, { startRef: 'cursor' });
    expect(r.churn.get('h.ts')).toBe(2); // before-1, before-2 only
    expect(r.stats.commitsScanned).toBe(2);
  });

  it('degrades to empty for an argument-injection-shaped start ref', async () => {
    const r = await analyzeChangeCoupling(repo, { startRef: '--output=/tmp/pwned' });
    expect(r.churn.size).toBe(0);
    expect(r.stats.commitsScanned).toBe(0);
  });
});

describe('analyzeChangeCoupling — below-root re-framing (fix-git-derived-signal-honesty)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'coupling-subdir-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'T']); git(repo, ['config', 'user.email', 't@e.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    mkdirSync(join(repo, 'packages', 'foo'), { recursive: true });
    // Two files inside the package move in lockstep; a root-level file is outside it.
    commit(repo, ['packages/foo/a.ts', 'packages/foo/b.ts', 'root.ts'], 'c1');
    commit(repo, ['packages/foo/a.ts', 'packages/foo/b.ts'], 'c2');
    commit(repo, ['packages/foo/a.ts', 'packages/foo/b.ts'], 'c3');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('at the repo root, churn keys are repo-root-relative (unchanged)', async () => {
    const r = await analyzeChangeCoupling(repo);
    expect(r.churn.get('packages/foo/a.ts')).toBe(3);
    expect(r.churn.get('root.ts')).toBe(1);
  });

  it('below the root, churn keys are re-framed to the analyzed subtree and outside files are dropped', async () => {
    const r = await analyzeChangeCoupling(join(repo, 'packages', 'foo'));
    // Re-framed to analyzed-root-relative paths...
    expect(r.churn.get('a.ts')).toBe(3);
    expect(r.churn.get('b.ts')).toBe(3);
    // ...never the repo-root-relative form...
    expect(r.churn.has('packages/foo/a.ts')).toBe(false);
    // ...and a file outside the subtree never enters the signal.
    expect(r.churn.has('root.ts')).toBe(false);
    // Coupling within the subtree still resolves (a ↔ b, 3 co-changes).
    expect((r.coupling.get('a.ts') ?? []).some(c => c.file === 'b.ts')).toBe(true);
  });
});

describe('analyzeChangeCoupling — graceful degradation', () => {
  it('returns empty for a non-git directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coupling-nogit-'));
    try {
      const r = await analyzeChangeCoupling(dir);
      expect(r.churn.size).toBe(0);
      expect(r.coupling.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
