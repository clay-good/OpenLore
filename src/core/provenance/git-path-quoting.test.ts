/**
 * fix-git-path-quoting — non-ASCII paths survive every history/diff join.
 *
 * Under git's default `core.quotepath=true`, a path with bytes above 0x80 comes
 * back from `--name-only` / `--name-status` / `--numstat` as a double-quoted,
 * octal-escaped C string (`"src/caf\303\251.ts"`). Every parser that joins those
 * lines against the analyzer's repo-relative paths then silently drops the file.
 * These tests commit a real `café.ts` into a temp repo and assert provenance,
 * change-coupling, and drift changed-file detection each return the exact,
 * UNQUOTED repo-relative path — i.e., the file is not silently dropped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractProvenance } from './git-provenance.js';
import { analyzeChangeCoupling } from './change-coupling.js';
import { getChangedFiles } from '../drift/git-diff.js';

const NON_ASCII = 'café.ts';        // é = U+00E9 → UTF-8 c3 a9 → git octal "\303\251"
const ASCII_PEER = 'index.ts';

function git(cwd: string, args: string[]): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_AUTHOR_DATE: '2026-01-01T10:00:00',
    GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_COMMITTER_DATE: '2026-01-01T10:00:00',
  };
  execFileSync('git', args, { cwd, env, stdio: 'ignore' });
}

describe('git path quoting — non-ASCII filenames are not silently dropped', () => {
  let repo: string;
  let baseSha: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-quote-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Tester']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    // Leave core.quotepath at its default (true) — the code under test must be
    // the thing that disables it, not the repo config.

    // Base commit: an ASCII peer only.
    writeFileSync(join(repo, ASCII_PEER), 'export const a = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'base', '--no-gpg-sign']);
    baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();

    // Second commit: add the non-ASCII file AND touch the peer, twice, so the two
    // files co-change (coupling support) and the non-ASCII file accrues churn.
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(repo, NON_ASCII), `export const cafe = ${i};\n`);
      writeFileSync(join(repo, ASCII_PEER), `export const a = ${i};\n`);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', `touch both #${i}`, '--no-gpg-sign']);
    }
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('sanity: git DOES octal-escape the non-ASCII path by default (guard is meaningful)', () => {
    const raw = execFileSync('git', ['log', '--name-only', '--format=', '-1'], {
      cwd: repo, encoding: 'utf-8',
    });
    // Default quotepath renders café.ts as a quoted, backslash-escaped string.
    expect(raw).toContain('\\303\\251');
    expect(raw).not.toContain(NON_ASCII);
  });

  it('provenance returns the exact unquoted path for the non-ASCII file', async () => {
    const recs = await extractProvenance(repo, [NON_ASCII, ASCII_PEER], { useGh: false });
    const paths = recs.map(r => r.filePath);
    expect(paths).toContain(NON_ASCII);
    const cafe = recs.find(r => r.filePath === NON_ASCII);
    expect(cafe).toBeDefined();
    expect(cafe!.lastAuthor.name).toBe('Tester'); // actually joined, not dropped
  });

  it('change-coupling counts churn and co-change for the non-ASCII file (unquoted key)', async () => {
    const result = await analyzeChangeCoupling(repo, { minSupport: 2, minConfidence: 0.1 });
    // Churn is keyed by the exact repo-relative path.
    expect(result.churn.has(NON_ASCII)).toBe(true);
    expect(result.churn.get(NON_ASCII)).toBeGreaterThanOrEqual(3);
    // And it co-changes with its ASCII peer, keyed unquoted on both sides.
    const coupled = result.coupling.get(NON_ASCII) ?? [];
    expect(coupled.some(c => c.file === ASCII_PEER)).toBe(true);
  });

  it('drift changed-file detection returns the exact unquoted path', async () => {
    const diff = await getChangedFiles({
      rootPath: repo, baseRef: baseSha, includeUnstaged: false,
    });
    const paths = diff.files.map(f => f.path);
    expect(paths).toContain(NON_ASCII);
    // No quoted/escaped variant leaks through.
    expect(paths.every(p => !p.startsWith('"') && !p.includes('\\'))).toBe(true);
  });

  it('drift picks up a staged non-ASCII file (decisions-gate path form)', async () => {
    // Stage a new non-ASCII source file; the gate parses --cached --name-status.
    const staged = 'módulo.py';
    writeFileSync(join(repo, staged), 'x = 1\n');
    git(repo, ['add', staged]);
    const diff = await getChangedFiles({
      rootPath: repo, baseRef: 'HEAD', includeUnstaged: true,
    });
    expect(diff.files.map(f => f.path)).toContain(staged);
    // Clean up staged change so afterAll rm is unaffected (repo is temp anyway).
    git(repo, ['reset', '-q', 'HEAD', staged]);
  });
});
