/**
 * Spec-18 — local provenance extractor over a real temporary git repo.
 * Deterministic (fixed authors/dates/subjects), fully offline (no remote, no gh).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractProvenance, parsePrNumber, enrichWithGh } from './git-provenance.js';

function git(cwd: string, args: string[], author?: { name: string; email: string; date: string }): void {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  if (author) {
    env.GIT_AUTHOR_NAME = author.name; env.GIT_AUTHOR_EMAIL = author.email; env.GIT_AUTHOR_DATE = author.date;
    env.GIT_COMMITTER_NAME = author.name; env.GIT_COMMITTER_EMAIL = author.email; env.GIT_COMMITTER_DATE = author.date;
  }
  execFileSync('git', args, { cwd, env, stdio: 'ignore' });
}

function commit(cwd: string, file: string, content: string, subject: string, author: { name: string; email: string; date: string }): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-m', subject, '--no-gpg-sign'], author);
}

const ALICE = { name: 'Alice', email: 'alice@example.com', date: '2026-01-01T10:00:00' };
const BOB   = { name: 'Bob',   email: 'bob@example.com',   date: '2026-02-01T10:00:00' };
const ALICE2 = { ...ALICE, date: '2026-03-01T10:00:00' };

describe('parsePrNumber', () => {
  it('parses squash and merge subjects', () => {
    expect(parsePrNumber('fix: thing (#42)')).toBe(42);
    expect(parsePrNumber('Merge pull request #7 from foo/bar')).toBe(7);
    expect(parsePrNumber('feat: no pr here')).toBeUndefined();
  });
});

describe('extractProvenance (real git repo)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'prov-repo-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    // c1: Alice adds fileA               (oldest)
    commit(repo, 'fileA.ts', 'a1\n', 'feat: a', ALICE);
    // c2: Bob touches fileA + fileB, squash PR #42
    writeFileSync(join(repo, 'fileA.ts'), 'a2\n');
    writeFileSync(join(repo, 'fileB.ts'), 'b1\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'fix: b (#42)', '--no-gpg-sign'], BOB);
    // c3: Alice touches fileB             (newest)
    commit(repo, 'fileB.ts', 'b2\n', 'chore: c', ALICE2);
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('attributes last-touch author, recent authors, and PR per file (deterministic)', async () => {
    const recs = await extractProvenance(repo, ['fileA.ts', 'fileB.ts'], { useGh: false });
    const byFile = Object.fromEntries(recs.map(r => [r.filePath, r]));

    expect(byFile['fileA.ts'].lastAuthor.name).toBe('Bob');
    expect(byFile['fileA.ts'].recentAuthors.map(a => a.name)).toEqual(['Bob', 'Alice']);
    expect(byFile['fileA.ts'].prs.map(p => p.number)).toEqual([42]);

    expect(byFile['fileB.ts'].lastAuthor.name).toBe('Alice');
    expect(byFile['fileB.ts'].recentAuthors.map(a => a.name)).toEqual(['Alice', 'Bob']);
    expect(byFile['fileB.ts'].prs.map(p => p.number)).toEqual([42]);
  });

  it('only returns provenance for requested files', async () => {
    const recs = await extractProvenance(repo, ['fileA.ts'], { useGh: false });
    expect(recs.map(r => r.filePath)).toEqual(['fileA.ts']);
  });

  it('git-only path leaves PR titles unpopulated (no gh, no network)', async () => {
    const recs = await extractProvenance(repo, ['fileA.ts'], { useGh: false });
    expect(recs[0].prs[0].title).toBeUndefined();
    expect(recs[0].prs[0].state).toBeUndefined();
  });

  it('is deterministic across runs', async () => {
    const a = await extractProvenance(repo, ['fileA.ts', 'fileB.ts'], { useGh: false });
    const b = await extractProvenance(repo, ['fileA.ts', 'fileB.ts'], { useGh: false });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('extractProvenance — graceful degradation', () => {
  it('returns [] for a non-git directory (never throws, never blocks)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-nogit-'));
    try {
      expect(await extractProvenance(dir, ['x.ts'], { useGh: false })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when no files are requested', async () => {
    expect(await extractProvenance('/tmp', [], { useGh: false })).toEqual([]);
  });

  it('enrichWithGh degrades to an empty map when gh has no GitHub remote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-gh-'));
    try {
      const meta = await enrichWithGh(dir);
      expect(meta.size).toBe(0); // no remote / gh absent → empty, no throw
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extractProvenance — below-root re-framing (fix-git-derived-signal-honesty)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'prov-subdir-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    mkdirSync(join(repo, 'packages', 'foo'), { recursive: true });
    commit(repo, 'packages/foo/x.ts', 'x1\n', 'feat: x (#11)', ALICE);
    commit(repo, 'root.ts', 'r1\n', 'feat: root (#22)', BOB);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('matches analyzed-root-relative files against re-framed git paths below the repo root', async () => {
    const sub = join(repo, 'packages', 'foo');
    // The caller passes analyzed-root-relative paths (as the call graph stores them).
    const prov = await extractProvenance(sub, ['x.ts'], { useGh: false });
    expect(prov).toHaveLength(1);
    expect(prov[0].filePath).toBe('x.ts'); // re-framed, not 'packages/foo/x.ts'
    expect(prov[0].lastAuthor.name).toBe('Alice');
    expect(prov[0].prs.map(p => p.number)).toContain(11);
  });

  it('at the repo root, paths stay repo-root-relative (unchanged behavior)', async () => {
    const prov = await extractProvenance(repo, ['packages/foo/x.ts'], { useGh: false });
    expect(prov).toHaveLength(1);
    expect(prov[0].filePath).toBe('packages/foo/x.ts');
  });
});
