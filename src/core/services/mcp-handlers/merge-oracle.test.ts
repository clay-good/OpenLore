/**
 * Textual merge oracle against real git repositories (change: add-merge-tree-conflict-oracle).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileGitSync } from '../../../utils/git-exec.js';
import { simulateMerge } from './merge-oracle.js';
import { defaultEnumeratePullRequests } from './interference-map.js';

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
const scratchDirs = () => readdirSync(root).filter(n => n.startsWith('openlore-merge-')).length;

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
    expect(await simulateMerge(repo, top, sameLine)).toEqual({ verdict: 'textual-conflict', conflictedFiles: ['x.js'], conflictedFileCount: 1 });
  });

  it('writes nothing into the analyzed repository and removes its scratch repository', async () => {
    const one = commitOn('w1', 'main', fn(['a', 'b', 'Q', 'd', 'e']));
    const two = commitOn('w2', 'main', fn(['a', 'b', 'R', 'd', 'e']));
    const objects = join(repo, '.git', 'objects');
    const before = countObjects(objects);
    expect((await simulateMerge(repo, one, two, { scratchParent: root })).verdict).toBe('textual-conflict');
    expect(countObjects(objects)).toBe(before);
    expect(scratchDirs()).toBe(0);
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
      expect(await simulateMerge(repo, one, two)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/merge attribute "evil"/) });
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
    execFileGitSync('git', ['clone', '-q', '--depth', '1', '--no-single-branch', pathToFileURL(repo).href, shallow]);
    expect(await simulateMerge(shallow, one, two)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/no merge base/) });
  });

  it('never lazy-fetches a missing object through a repository-chosen promisor command', async () => {
    const promisor = join(root, 'promisor');
    const marker = join(root, 'uploadpack-ran');
    execFileGitSync('git', ['clone', '-q', repo, promisor]);
    git(promisor, 'config', 'core.repositoryformatversion', '1');
    git(promisor, 'config', 'extensions.partialClone', 'origin');
    git(promisor, 'config', 'remote.origin.url', repo.replace(/\\/g, '/'));
    git(promisor, 'config', 'remote.origin.promisor', 'true');
    git(promisor, 'config', 'remote.origin.uploadpack', `touch "${marker.replace(/\\/g, '/')}"; git-upload-pack`);
    const tip = git(promisor, 'rev-parse', 'HEAD');
    const missing = 'd'.repeat(40);

    expect((await simulateMerge(promisor, tip, missing)).verdict).toBe('not-assessed');
    const prs = await defaultEnumeratePullRequests(promisor, 'this-repo', 'main', async (_p, args) => (args[1] === 'list'
      ? JSON.stringify([{ number: 1, headRefName: 'f', headRefOid: missing, title: 't' }])
      : 'diff --git a/n.md b/n.md\n--- a/n.md\n+++ b/n.md\n@@ -1 +1 @@\n-a\n+b\n'));
    expect(prs.changes[0].tip).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    // Non-vacuity: a plain read of the missing object in that repository does run the command.
    if (process.platform !== 'win32') {
      try { git(promisor, 'cat-file', '-e', `${missing}^{commit}`); } catch { /* missing object */ }
      expect(existsSync(marker)).toBe(true);
    }
  });

  it('is not-assessed, never clean, when a merge attribute on a path both sides change disables the text merge', async () => {
    const lock = (tag: string, lines: string[]) => ({ 'f.lock': lines.join('\n') + '\n', '.gitattributes': `f.lock ${tag}\n` });
    git(repo, 'switch', '-q', '-c', 'attr-base', 'main');
    writeFileSync(join(repo, 'f.lock'), 'a\nb\nc\nd\ne\n');
    writeFileSync(join(repo, '.gitattributes'), 'f.lock -merge\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'attr-base');
    git(repo, 'switch', '-q', 'main');
    const top = commitOn('attr-top', 'attr-base', fn(['a', 'b', 'c', 'd', 'e']), lock('-merge', ['A', 'b', 'c', 'd', 'e']));
    const bottom = commitOn('attr-bottom', 'attr-base', fn(['a', 'b', 'c', 'd', 'e']), lock('-merge', ['a', 'b', 'c', 'd', 'E']));
    expect(await simulateMerge(repo, top, bottom)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/f\.lock has merge attribute "unset"/) });

    // Attributes that live only in $GIT_DIR/info/attributes count too.
    const p1 = commitOn('info-1', 'main', fn(['a', 'b', 'c', 'd', 'e']), { 'g.txt': 'X\nb\nc\n' });
    git(repo, 'switch', '-q', '-c', 'info-base', 'main');
    writeFileSync(join(repo, 'g.txt'), 'a\nb\nc\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'info-base');
    git(repo, 'switch', '-q', 'main');
    const i1 = commitOn('info-a', 'info-base', fn(['a', 'b', 'c', 'd', 'e']), { 'g.txt': 'A\nb\nc\n' });
    const i2 = commitOn('info-b', 'info-base', fn(['a', 'b', 'c', 'd', 'e']), { 'g.txt': 'a\nb\nC\n' });
    expect((await simulateMerge(repo, i1, i2)).verdict).toBe('clean-automerge');
    writeFileSync(join(repo, '.git', 'info', 'attributes'), 'g.txt merge=binary\n');
    try {
      expect(await simulateMerge(repo, i1, i2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/g\.txt has merge attribute "binary"/) });
    } finally {
      rmSync(join(repo, '.git', 'info', 'attributes'), { force: true });
    }
    expect(p1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('forwards repository rename settings and refuses merge.renormalize', async () => {
    git(repo, 'switch', '-q', '-c', 'ren-base', 'main');
    writeFileSync(join(repo, 'r.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'ren-base');
    git(repo, 'switch', '-q', '-c', 'ren-move');
    git(repo, 'mv', 'r.txt', 's.txt');
    git(repo, 'commit', '-q', '-m', 'move');
    const moved = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', '-c', 'ren-edit', 'ren-base');
    writeFileSync(join(repo, 'r.txt'), 'one\ntwo\nTHREE\nfour\nfive\nsix\n');
    git(repo, 'commit', '-q', '-am', 'edit');
    const edited = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', 'main');
    expect((await simulateMerge(repo, moved, edited)).verdict).toBe('clean-automerge');
    git(repo, 'config', 'merge.renames', 'false');
    try {
      expect((await simulateMerge(repo, moved, edited)).verdict).toBe('textual-conflict');
    } finally {
      git(repo, 'config', '--unset', 'merge.renames');
    }
    git(repo, 'config', 'merge.renormalize', 'true');
    try {
      expect(await simulateMerge(repo, moved, edited)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/merge\.renormalize/) });
    } finally {
      git(repo, 'config', '--unset', 'merge.renormalize');
    }
  });

  it('is not-assessed for a submodule conflict it cannot see into', async () => {
    const gitlink = (branch: string, from: string, sha: string) => {
      git(repo, 'switch', '-q', '-c', branch, from);
      git(repo, 'update-index', '--add', '--cacheinfo', `160000,${sha},mod`);
      git(repo, 'commit', '-q', '-m', branch);
      const tip = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'switch', '-q', '-f', 'main');
      return tip;
    };
    gitlink('sub-base', 'main', '1'.repeat(40));
    const a = gitlink('sub-a', 'sub-base', '2'.repeat(40));
    const b = gitlink('sub-b', 'sub-base', '3'.repeat(40));
    expect(await simulateMerge(repo, a, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/mod is a submodule conflict/) });
  });

  it('reports a spent time budget instead of running git', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const top = git(repo, 'rev-parse', 'top');
    expect(await simulateMerge(repo, main, top, { deadline: Date.now() - 1 })).toEqual({ verdict: 'not-assessed', detail: 'the merge simulation time budget was spent' });
  });
});
