/**
 * Regression tests for the merge-base old-content discipline
 * (change: fix-structural-diff-merge-base).
 *
 * `structural_diff`'s changed-file list is merge-base-scoped (three-dot), so its
 * OLD snapshots must be read at that same branch point — not the base ref's TIP.
 * Otherwise, on any branch whose base advanced past the branch point, a file
 * changed on BOTH sides yields an old snapshot polluted with the base branch's own
 * edits: a teammate's new function reads as REMOVED, and — with a declared
 * footprint — as a false out-of-scope/removed escape that a policy could block on.
 *
 * The call-graph mock is transparent (delegates to the real builder) EXCEPT for
 * files carrying the `__PARSE_CRASH__` marker, which lets the parse-boundary test
 * force a snapshot build failure without affecting the real-build fixtures.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

vi.mock('./utils.js', async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  return { ...actual, validateDirectory: vi.fn(async (d: string) => d), readCachedContext: vi.fn(async () => null) };
});

vi.mock('../../analyzer/call-graph.js', async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  const RealBuilder = actual.CallGraphBuilder as new () => { build(files: Array<{ content: string }>): Promise<unknown> };
  return {
    ...actual,
    // Transparent shim: delegate to the real builder unless a file carries the
    // parse-crash marker, in which case simulate a graph-build failure.
    CallGraphBuilder: class {
      async build(files: Array<{ content: string }>) {
        if (files.some(f => f.content.includes('__PARSE_CRASH__'))) throw new Error('simulated parse crash');
        return new RealBuilder().build(files);
      }
    },
  };
});

import { handleStructuralDiff } from './structural-diff.js';

// Identity and signing come from the environment rather than three extra
// `git config` invocations per fixture. Process spawn dominates the cost of
// these git-backed fixtures, so every avoided call is real wall time.
const GIT_FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com',
};

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: GIT_FIXTURE_ENV });
}
function write(cwd: string, rel: string, content: string): void {
  const p = join(cwd, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
}

// Branch point (C0): one shared function.
const C0 = `export function shared(a: string): number { return a.length; }\n`;
// Feature side: adds branchFn to the same file.
const FEATURE = `export function shared(a: string): number { return a.length; }\nexport function branchFn(): void {}\n`;
// Base side (advances past the branch point): adds mainFn to the same file.
const MAIN_ADVANCED = `export function shared(a: string): number { return a.length; }\nexport function mainFn(): void {}\n`;

interface DiffResult {
  changedFiles: Array<{ path: string; status: string }>;
  added: Array<{ name: string }>;
  removed: Array<{ name: string; staleCallers: Array<{ name: string }> }>;
  summary: Record<string, number>;
  soundness: { caveats: string[] };
  escapeAnalysis?: {
    escapes: Array<{ id: string; classification: string }>;
    findings: Array<{ code: string }>;
    summary: Record<string, number>;
  };
}

/**
 * Build a repo where `main` has advanced past the branch point of `feature`, and
 * `src/mod.ts` changed on BOTH sides (feature added branchFn; main added mainFn).
 * Leaves the given branch checked out.
 */
function buildAdvancedBaseRepo(checkout: 'feature' | 'main'): string {
  const repo = mkdtempSync(join(tmpdir(), 'struct-mb-'));
  git(repo, ['init', '-q', '-b', 'main']);
  // C0 — the branch point.
  write(repo, 'src/mod.ts', C0);
  git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'c0', '--no-gpg-sign']);
  // feature: add branchFn, commit.
  git(repo, ['checkout', '-q', '-b', 'feature']);
  write(repo, 'src/mod.ts', FEATURE);
  git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'feature', '--no-gpg-sign']);
  // main advances: add mainFn to the same file AND a main-only file, commit.
  git(repo, ['checkout', '-q', 'main']);
  write(repo, 'src/mod.ts', MAIN_ADVANCED);
  write(repo, 'src/mainonly.ts', `export function mainOnly(): void {}\n`);
  git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'main advances', '--no-gpg-sign']);
  git(repo, ['checkout', '-q', checkout]);
  return repo;
}

describe('structural_diff — merge-base old-content discipline', () => {
  let repo: string;
  afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

  it('working-tree path: an advanced base does not misattribute main-side edits', async () => {
    repo = buildAdvancedBaseRepo('feature');
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'main' }) as DiffResult;
    // The branch's own addition is reported.
    expect(r.added.map(n => n.name)).toContain('branchFn');
    // mainFn was added on main AFTER the branch point — it belongs to neither the
    // branch point nor the feature tip, so it must NOT read as removed.
    expect(r.removed.map(n => n.name)).not.toContain('mainFn');
    expect(r.summary.removedFunctions).toBe(0);
    // And no stale-caller noise attributed to a main-side symbol.
    expect(r.summary.staleCallers).toBe(0);
  });

  it('working-tree path: footprint-escape rests on the branch\'s own writes, not base drift', async () => {
    repo = buildAdvancedBaseRepo('feature');
    const r = await handleStructuralDiff({
      directory: repo,
      baseRef: 'main',
      declaredFootprint: { taskId: 'feat', writeSet: [{ id: 'src/mod.ts::branchFn' }] },
    }) as DiffResult;
    expect(r.escapeAnalysis).toBeDefined();
    // No escape may reference mainFn — it never was part of this change.
    expect(r.escapeAnalysis!.escapes.every(e => !e.id.includes('mainFn'))).toBe(true);
    // The branch's declared write (branchFn) is in-scope → no escape at all.
    expect(r.escapeAnalysis!.escapes).toHaveLength(0);
    expect(r.escapeAnalysis!.findings).toHaveLength(0);
  });

  it('two-ref path: main-side-only files are excluded from the delta (merge-base semantics)', async () => {
    repo = buildAdvancedBaseRepo('main'); // any checkout; both refs are named
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'main', headRef: 'feature' }) as DiffResult;
    // src/mainonly.ts was added on the base side after the branch point → it is not
    // part of feature's change and must not enter the delta (two-dot would show it
    // as deleted).
    expect(r.changedFiles.some(f => f.path === 'src/mainonly.ts')).toBe(false);
    // mainFn (added to src/mod.ts on main) must not read as removed on the feature side.
    expect(r.removed.map(n => n.name)).not.toContain('mainFn');
    // The genuine feature-side addition is still present.
    expect(r.added.map(n => n.name)).toContain('branchFn');
  });

  it('no-drift: base == branch point yields a clean delta (fix is a no-op here)', async () => {
    // main never advances → merge-base(main, HEAD) == main tip. Old content reads
    // from the same SHA the pre-fix code used, so behavior is unchanged.
    repo = mkdtempSync(join(tmpdir(), 'struct-mb-nodrift-'));
    git(repo, ['init', '-q', '-b', 'main']);
    write(repo, 'src/mod.ts', C0);
    git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'c0', '--no-gpg-sign']);
    write(repo, 'src/mod.ts', FEATURE); // working-tree change only, no divergence
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'main' }) as DiffResult;
    expect(r.added.map(n => n.name)).toEqual(['branchFn']);
    expect(r.summary.removedFunctions).toBe(0);
  });

  it('discloses the merge-base discipline in its soundness caveats', async () => {
    repo = buildAdvancedBaseRepo('feature');
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'main' }) as DiffResult;
    expect(r.soundness.caveats.some(c => /merge-base/i.test(c))).toBe(true);
  });
});

describe('structural_diff — snapshot build failure is a disclosed boundary', () => {
  let repo: string;
  afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

  it('names the failed snapshot instead of a silent empty comparison', async () => {
    repo = mkdtempSync(join(tmpdir(), 'struct-mb-crash-'));
    git(repo, ['init', '-q', '-b', 'main']);
    // Old version carries the parse-crash marker → its snapshot build throws.
    write(repo, 'src/mod.ts', `// __PARSE_CRASH__\nexport function keep(): void {}\n`);
    git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'c0', '--no-gpg-sign']);
    // New version parses fine and adds a function.
    write(repo, 'src/mod.ts', `export function keep(): void {}\nexport function fresh(): void {}\n`);
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as DiffResult;
    const disclosed = r.soundness.caveats.some(c => /old \(base\)/.test(c) && /build failure|could not be parsed/i.test(c));
    expect(disclosed).toBe(true);
    // Not authoritative: the caveat must warn the comparison is unreliable.
    expect(r.soundness.caveats.some(c => /not authoritative/i.test(c))).toBe(true);
  });
});
