/**
 * Textual merge oracle against real git repositories (change: add-merge-tree-conflict-oracle).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileGitSync } from '../../../utils/git-exec.js';
import { simulateMerge } from './merge-oracle.js';

let root: string;
let repo: string;

const git = (cwd: string, ...args: string[]) => execFileGitSync('git', args, { cwd }).trim();
const fn = (lines: string[]) => `function f() {\n${lines.map(l => `  ${l}();`).join('\n')}\n}\n`;
const commitOn = (branch: string, from: string, content: string, extra: Record<string, string> = {}) => {
  git(repo, 'switch', '-q', '-c', branch, from);
  writeFileSync(join(repo, 'x.js'), content);
  for (const [path, body] of Object.entries(extra)) writeFileSync(join(repo, path), body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', branch);
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', 'main');
  return tip;
};
const countObjects = (dir: string): number => readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? countObjects(join(dir, e.name)) : 1), 0);
const scratchDirs = () => readdirSync(tmpdir()).filter(n => n.startsWith('openlore-merge-')).length;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'merge-oracle-test-'));
  repo = join(root, 'repo');
  execFileGitSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'x.js'), fn(['a', 'b', 'c', 'd', 'e']));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('simulateMerge', () => {
  it('reports clean-automerge for disjoint edits to one function, and textual-conflict for the same line', async () => {
    const top = commitOn('top', 'main', fn(['A', 'b', 'c', 'd', 'e']));
    const bottom = commitOn('bottom', 'main', fn(['a', 'b', 'c', 'd', 'E']));
    const sameLine = commitOn('same-line', 'main', fn(['Z', 'b', 'c', 'd', 'e']));
    expect(await simulateMerge(repo, top, bottom)).toEqual({ verdict: 'clean-automerge' });
    expect(await simulateMerge(repo, top, sameLine)).toEqual({ verdict: 'textual-conflict', conflictedFiles: ['x.js'] });
  });

  it('writes nothing into the analyzed repository and removes its scratch repository', async () => {
    const one = commitOn('w1', 'main', fn(['a', 'b', 'Q', 'd', 'e']));
    const two = commitOn('w2', 'main', fn(['a', 'b', 'R', 'd', 'e']));
    const objects = join(repo, '.git', 'objects');
    const before = countObjects(objects);
    const scratchBefore = scratchDirs();
    expect((await simulateMerge(repo, one, two)).verdict).toBe('textual-conflict');
    expect(countObjects(objects)).toBe(before);
    expect(scratchDirs()).toBe(scratchBefore);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('never runs a merge driver the repository chooses', async () => {
    const marker = join(root, 'driver-ran');
    const attrs = { '.gitattributes': 'x.js merge=evil\n' };
    const one = commitOn('d1', 'main', fn(['a', 'b', 'c', 'P', 'e']), attrs);
    const two = commitOn('d2', 'main', fn(['a', 'b', 'c', 'S', 'e']), attrs);
    git(repo, 'config', 'merge.evil.driver', `echo ran > "${marker.replace(/\\/g, '/')}"; false`);
    writeFileSync(join(repo, '.git', 'info', 'attributes'), 'x.js merge=evil\n');
    try {
      expect((await simulateMerge(repo, one, two)).verdict).toBe('textual-conflict');
      expect(existsSync(marker)).toBe(false);
      // Non-vacuity: the same merge run inside the analyzed repository does run the driver.
      if (process.platform !== 'win32') {
        try { git(repo, 'merge-tree', '--write-tree', one, two); } catch { /* conflict exit code */ }
        expect(existsSync(marker)).toBe(true);
      }
    } finally {
      git(repo, 'config', '--unset', 'merge.evil.driver');
      rmSync(join(repo, '.git', 'info', 'attributes'), { force: true });
    }
  });

  it('is not-assessed, never clean, without a single merge base or a resolvable tip', async () => {
    git(repo, 'switch', '-q', '--orphan', 'unrelated');
    writeFileSync(join(repo, 'x.js'), fn(['u']));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'unrelated');
    const unrelated = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', '-f', 'main');
    const main = git(repo, 'rev-parse', 'main');
    expect(await simulateMerge(repo, main, unrelated)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/no merge base/) });
    expect(await simulateMerge(repo, main, 'f'.repeat(40))).toMatchObject({ verdict: 'not-assessed' });
    expect(await simulateMerge(repo, main, '--output=/tmp/x')).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/not a resolved commit/) });

    // Criss-cross history has two merge bases.
    const l = commitOn('cross-l', 'main', fn(['a', 'L', 'c', 'd', 'e']));
    const r = commitOn('cross-r', 'main', fn(['a', 'b', 'c', 'R', 'e']));
    git(repo, 'switch', '-q', 'cross-l');
    git(repo, 'merge', '-q', '--no-edit', 'cross-r');
    const l2 = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', '-c', 'cross-r2', r);
    git(repo, 'merge', '-q', '--no-edit', l);
    const r2 = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', 'main');
    expect(await simulateMerge(repo, l2, r2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/2 merge bases/) });
  });

  it('is not-assessed in a shallow clone whose history does not reach the merge base', async () => {
    const one = commitOn('s1', 'main', fn(['a', 'b', 'c', 'd', 'T']));
    const two = commitOn('s2', 'main', fn(['V', 'b', 'c', 'd', 'e']));
    const shallow = join(root, 'shallow');
    execFileGitSync('git', ['clone', '-q', '--depth', '1', '--no-single-branch', `file://${repo.replace(/\\/g, '/')}`, shallow]);
    expect(await simulateMerge(shallow, one, two)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/no merge base/) });
  });
});
