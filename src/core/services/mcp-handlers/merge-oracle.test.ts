/**
 * Textual merge oracle against real git repositories (change: add-merge-tree-conflict-oracle).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileGitSync } from '../../../utils/git-exec.js';
import { simulateMerge, gitVersionAtLeast } from './merge-oracle.js';
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

  it('is not-assessed for merge.default, branch merge options, replace refs, and a rename onto an attributed name', async () => {
    const i1 = git(repo, 'rev-parse', 'info-a');
    const i2 = git(repo, 'rev-parse', 'info-b');
    expect((await simulateMerge(repo, i1, i2)).verdict).toBe('clean-automerge');
    for (const [key, value, pattern] of [
      ['merge.default', 'binary', /merge\.default is "binary"/],
      ['branch.info-a.mergeOptions', '-Xno-renames', /mergeoptions is set/],
    ] as const) {
      git(repo, 'config', key, value);
      try {
        expect(await simulateMerge(repo, i1, i2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(pattern) });
      } finally {
        git(repo, 'config', '--unset', key);
      }
    }
    git(repo, 'config', 'merge.default', 'text');
    try {
      expect((await simulateMerge(repo, i1, i2)).verdict).toBe('clean-automerge');
    } finally {
      git(repo, 'config', '--unset', 'merge.default');
    }

    git(repo, 'replace', i2, i1);
    try {
      expect(await simulateMerge(repo, i1, git(repo, 'rev-parse', 'top'))).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/replace refs or grafts/) });
    } finally {
      git(repo, 'replace', '-d', i2);
    }

    // A renames f.txt onto *.bin (-merge) and edits it; B edits f.txt elsewhere.
    git(repo, 'switch', '-q', '-c', 'mv-base', 'main');
    writeFileSync(join(repo, 'm.txt'), Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n');
    writeFileSync(join(repo, '.gitattributes'), '*.bin -merge\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'mv-base');
    git(repo, 'switch', '-q', '-c', 'mv-a');
    git(repo, 'mv', 'm.txt', 'm.bin');
    writeFileSync(join(repo, 'm.bin'), ['LINE 0', ...Array.from({ length: 39 }, (_, i) => `line ${i + 1}`)].join('\n') + '\n');
    git(repo, 'commit', '-q', '-am', 'mv-a');
    const moved = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', '-c', 'mv-b', 'mv-base');
    writeFileSync(join(repo, 'm.txt'), [...Array.from({ length: 39 }, (_, i) => `line ${i}`), 'LINE 39'].join('\n') + '\n');
    git(repo, 'commit', '-q', '-am', 'mv-b');
    const edited = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', 'main');
    expect(await simulateMerge(repo, moved, edited)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/m\.bin has merge attribute "unset"/) });
  });

  it('parses git versions for the lazy-fetch guard', () => {
    expect(gitVersionAtLeast('git version 2.50.1 (Apple Git-155)', 2, 45)).toBe(true);
    expect(gitVersionAtLeast('git version 2.45.0', 2, 45)).toBe(true);
    expect(gitVersionAtLeast('git version 2.44.2.windows.1', 2, 45)).toBe(false);
    expect(gitVersionAtLeast('git version 3.0.0', 2, 45)).toBe(true);
    expect(gitVersionAtLeast('not git', 2, 45)).toBe(false);
  });

  it('is not-assessed for a merge driver named like a default state, and parses git booleans', async () => {
    const i1 = git(repo, 'rev-parse', 'info-a');
    const i2 = git(repo, 'rev-parse', 'info-b');
    git(repo, 'config', 'merge.text.driver', 'false');
    try {
      expect(await simulateMerge(repo, i1, i2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/merge driver named "text"/) });
    } finally {
      git(repo, 'config', '--unset', 'merge.text.driver');
    }
    git(repo, 'config', 'merge.renormalize', '2');
    try {
      expect(await simulateMerge(repo, i1, i2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/merge\.renormalize/) });
    } finally {
      git(repo, 'config', '--unset', 'merge.renormalize');
    }
    expect((await simulateMerge(repo, i1, i2)).verdict).toBe('clean-automerge');
  });

  it('checks attributes by top-level path when run from a subdirectory', async () => {
    git(repo, 'switch', '-q', '-c', 'subdir-base', 'main');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, 'sub', 'f.txt'), 'a\nb\nc\nd\ne\nf\ng\nh\ni\n');
    writeFileSync(join(repo, '.gitattributes'), 'sub/f.txt merge=binary\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'subdir-base');
    git(repo, 'switch', '-q', '-c', 'subdir-a');
    writeFileSync(join(repo, 'sub', 'f.txt'), 'a\nB\nc\nd\ne\nf\ng\nh\ni\n');
    git(repo, 'commit', '-q', '-am', 'subdir-a');
    const a = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', '-c', 'subdir-b', 'subdir-base');
    writeFileSync(join(repo, 'sub', 'f.txt'), 'a\nb\nc\nd\ne\nf\ng\nh\nI\n');
    git(repo, 'commit', '-q', '-am', 'subdir-b');
    const b = git(repo, 'rev-parse', 'HEAD');
    try {
      expect(await simulateMerge(join(repo, 'sub'), a, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/sub\/f\.txt has merge attribute "binary"/) });
    } finally {
      git(repo, 'switch', '-q', '-f', 'main');
    }
  });

  /** Commit file contents on top of `parent` through a temporary index, keeping path bytes exact. */
  const commitFiles = (cwd: string, parent: string, files: Record<string, string>, message: string) => {
    const env = { ...process.env, GIT_INDEX_FILE: join(root, `index-${message}`) };
    execFileGitSync('git', ['read-tree', parent], { cwd, env });
    const entries = Object.entries(files).map(([path, content]) => {
      const blob = execFileGitSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: content }).trim();
      return `100644 ${blob}\t${path}\n`;
    }).join('');
    execFileGitSync('git', ['update-index', '--index-info'], { cwd, env, input: entries });
    const tree = execFileGitSync('git', ['write-tree'], { cwd, env }).trim();
    rmSync(env.GIT_INDEX_FILE, { force: true });
    return execFileGitSync('git', ['commit-tree', tree, '-p', parent, '-m', message], { cwd }).trim();
  };
  const lines = (edit: Record<number, string> = {}) => ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((l, i) => edit[i] ?? l).join('\n') + '\n';

  it('is not-assessed for any merge driver section named like a default state, and for unknown repository merge keys', async () => {
    const i1 = git(repo, 'rev-parse', 'info-a');
    const i2 = git(repo, 'rev-parse', 'info-b');
    for (const [key, value, pattern] of [
      ['merge.text.name', 'foo', /merge driver named "text"/],
      ['merge.unspecified.recursive', 'binary', /merge driver named "unspecified"/],
      ['merge.somethingNew', 'x', /merge\.somethingnew is set in the repository config/],
    ] as const) {
      git(repo, 'config', key, value);
      try {
        expect(await simulateMerge(repo, i1, i2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(pattern) });
      } finally {
        git(repo, 'config', '--unset', key);
      }
    }
    git(repo, 'config', 'merge.conflictStyle', 'diff3');
    try {
      expect((await simulateMerge(repo, i1, i2)).verdict).toBe('clean-automerge');
    } finally {
      git(repo, 'config', '--unset', 'merge.conflictStyle');
    }
  });

  it('forwards diff.algorithm so the verdict matches a merge in the repository itself', async () => {
    const alg = join(root, 'alg');
    execFileGitSync('git', ['init', '-q', '-b', 'main', alg]);
    git(alg, 'config', 'user.email', 't@example.com');
    git(alg, 'config', 'user.name', 't');
    const emptyTree = execFileGitSync('git', ['mktree'], { cwd: alg, input: '' }).trim();
    const empty = execFileGitSync('git', ['commit-tree', emptyTree, '-m', 'root'], { cwd: alg }).trim();
    const base = commitFiles(alg, empty, { f: 'x\nb\n{\nb\n{\na\n' }, 'alg-base');
    const a = commitFiles(alg, base, { f: 'x\n{\nc\nb\n{\n{\n' }, 'alg-a');
    const b = commitFiles(alg, base, { f: 'x\nb\n{\nb\n{\n' }, 'alg-b');
    for (const algorithm of ['patience', 'myers', 'histogram']) {
      git(alg, 'config', 'diff.algorithm', algorithm);
      let truth: 'clean-automerge' | 'textual-conflict' = 'clean-automerge';
      try { git(alg, 'merge-tree', '--write-tree', a, b); } catch { truth = 'textual-conflict'; }
      expect((await simulateMerge(alg, a, b)).verdict, algorithm).toBe(truth);
    }
  });

  it('matches decomposed (NFD) attribute patterns and case-variant attributes files', async () => {
    const nfd = 'é.txt';
    const main = git(repo, 'rev-parse', 'main');
    const base = commitFiles(repo, main, { [nfd]: lines(), '.gitattributes': `${nfd} merge=binary\n` }, 'nfd-base');
    const a = commitFiles(repo, base, { [nfd]: lines({ 1: 'B' }) }, 'nfd-a');
    const b = commitFiles(repo, base, { [nfd]: lines({ 7: 'H' }) }, 'nfd-b');
    expect(await simulateMerge(repo, a, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/merge attribute "binary"/) });

    const plain = commitFiles(repo, main, { 'k.txt': lines() }, 'case-base');
    const upper = commitFiles(repo, plain, { 'k.txt': lines({ 1: 'B' }), '.GITATTRIBUTES': '* merge=binary\n' }, 'case-a');
    const other = commitFiles(repo, plain, { 'k.txt': lines({ 7: 'H' }) }, 'case-b');
    // The case check runs whatever core.ignorecase says (a real merge reads the filesystem).
    git(repo, 'config', 'core.ignorecase', 'false');
    try {
      expect(await simulateMerge(repo, upper, other)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/\.GITATTRIBUTES differs from a changed path only by letter case/) });
      // A newline in a config value must not forge a config entry.
      git(repo, 'config', 'merge.tool', 'vimdiff\ncore.ignorecase false');
      expect(await simulateMerge(repo, upper, other)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/\.GITATTRIBUTES differs/) });
    } finally {
      git(repo, 'config', '--unset', 'core.ignorecase');
      try { git(repo, 'config', '--unset', 'merge.tool'); } catch { /* not set */ }
    }
    const dirBase = commitFiles(repo, main, { 'sub/k.txt': lines(), 'Sub/.gitattributes': 'k.txt merge=binary\n', 'Sub/other.txt': 'o\n' }, 'dircase-base');
    const d1 = commitFiles(repo, dirBase, { 'sub/k.txt': lines({ 1: 'B' }) }, 'dircase-a');
    const d2 = commitFiles(repo, dirBase, { 'sub/k.txt': lines({ 7: 'H' }) }, 'dircase-b');
    expect(await simulateMerge(repo, d1, d2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/Sub differs from a changed path only by letter case/) });
    // Both spellings are ancestors of changed paths.
    const both = commitFiles(repo, dirBase, { 'sub/k.txt': lines({ 1: 'B' }), 'Sub/other.txt': 'O\n' }, 'dircase-both');
    expect(await simulateMerge(repo, both, d2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/differs from another changed directory only by letter case/) });
    // Names that look like pathspec magic are listed literally.
    const colonBase = commitFiles(repo, main, { ':/sub/k.txt': lines(), ':/Sub/.gitattributes': 'k.txt merge=binary\n' }, 'colon-base');
    const c1 = commitFiles(repo, colonBase, { ':/sub/k.txt': lines({ 1: 'B' }) }, 'colon-a');
    const c2 = commitFiles(repo, colonBase, { ':/sub/k.txt': lines({ 7: 'H' }) }, 'colon-b');
    expect(await simulateMerge(repo, c1, c2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/:\/Sub differs/) });
  });

  it('is not-assessed when core.worktree points at another repository', async () => {
    const other = join(root, 'other-worktree');
    execFileGitSync('git', ['clone', '-q', repo, other]);
    const lone = join(root, 'lone');
    execFileGitSync('git', ['init', '-q', lone]);
    git(lone, 'config', 'core.worktree', other);
    const main = git(repo, 'rev-parse', 'main');
    expect(await simulateMerge(join(lone, '.git'), main, main)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/different git directory/) });
  });
});
