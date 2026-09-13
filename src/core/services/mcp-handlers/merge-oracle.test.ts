/**
 * Textual merge oracle against real git repositories (change: add-merge-tree-conflict-oracle).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
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
      // A fresh clone or hosted merge does not carry the local setting, so it is not assessed.
      expect(await simulateMerge(repo, moved, edited)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/merge\.renames=false in git config can hide a conflict/) });
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
      ['merge.somethingNew', 'x', /merge\.somethingnew is set in git config/],
    ] as const) {
      git(repo, 'config', key, value);
      try {
        expect(await simulateMerge(repo, i1, i2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(pattern) });
      } finally {
        git(repo, 'config', '--unset', key);
      }
    }
    git(repo, 'config', 'merge.tool', 'vimdiff');
    try {
      expect((await simulateMerge(repo, i1, i2)).verdict).toBe('clean-automerge');
    } finally {
      git(repo, 'config', '--unset', 'merge.tool');
    }
    for (const [key, value, pattern] of [
      ['pull.twohead', 'resolve', /pull\.twohead selects the "resolve"/],
      ['pull.twohead', 'ORT', /pull\.twohead selects the "ORT"/],
      ['pull.twohead', 'ort ', /pull\.twohead selects the "ort"/],
      ['merge.stat', 'bogus', /merge\.stat has a value git merge cannot parse/],
      ['merge.stat', ' true', /merge\.stat has a value git merge cannot parse/],
      ['merge.log', '-1', /merge\.log has a value git merge cannot parse/],
      ['merge.log', '2g', /merge\.log has a value git merge cannot parse/],
      ['merge.stat', '3g', /merge\.stat has a value git merge cannot parse/],
      ['core.bigFileThreshold', '17179869184g', /core\.bigfilethreshold has a value git merge cannot parse/],
      ['merge.verbosity', '6', /merge\.verbosity has a value git merge cannot parse/],
      ['merge.renames', ' true', /merge\.renames has a value the simulation cannot forward/],
      ['commit.cleanup', 'bogus', /commit\.cleanup has a value git merge cannot parse/],
      ['diff.algorithm', 'bogus', /diff\.algorithm "bogus"/],
      ['merge.conflictStyle', 'weird', /merge\.conflictStyle "weird"/],
    ] as const) {
      git(repo, 'config', key, value);
      try {
        expect(await simulateMerge(repo, i1, i2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(pattern) });
      } finally {
        git(repo, 'config', '--unset', key);
      }
    }
    writeFileSync(join(repo, '.git', 'config'), `${readFileSync(join(repo, '.git', 'config'), 'utf8')}[merge]\n\trenames\n`);
    try {
      expect(await simulateMerge(repo, i1, i2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/merge\.renames has a value the simulation cannot forward/) });
    } finally {
      git(repo, 'config', '--unset', 'merge.renames');
    }
  });

  it('assesses only the default diff.algorithm, and matches a real merge for it', async () => {
    const alg = join(root, 'alg');
    execFileGitSync('git', ['init', '-q', '-b', 'main', alg]);
    git(alg, 'config', 'user.email', 't@example.com');
    git(alg, 'config', 'user.name', 't');
    const emptyTree = execFileGitSync('git', ['mktree'], { cwd: alg, input: '' }).trim();
    const empty = execFileGitSync('git', ['commit-tree', emptyTree, '-m', 'root'], { cwd: alg }).trim();
    const base = commitFiles(alg, empty, { f: 'x\nb\n{\nb\n{\na\n' }, 'alg-base');
    const a = commitFiles(alg, base, { f: 'x\n{\nc\nb\n{\n{\n' }, 'alg-a');
    const b = commitFiles(alg, base, { f: 'x\nb\n{\nb\n{\n' }, 'alg-b');
    // Ground truth is a real `git merge` in a worktree: merge-tree itself ignores diff.algorithm config.
    const realMerge = (x: string, y: string, name: string): 'clean-automerge' | 'textual-conflict' => {
      const wt = join(root, `wt-${name}`);
      git(alg, 'worktree', 'add', '-q', '--detach', wt, x);
      try {
        git(wt, 'merge', '--no-commit', '--no-ff', y);
        return 'clean-automerge';
      } catch {
        return 'textual-conflict';
      } finally {
        git(alg, 'worktree', 'remove', '--force', wt);
      }
    };
    const myersBase = commitFiles(alg, empty, { m: '{\na\na\n{\n{\nb\nc\nb\n' }, 'myers-base');
    const ma = commitFiles(alg, myersBase, { m: '{\na\na\n{\n{\na\nb\nc\nb\n' }, 'myers-a');
    const mb = commitFiles(alg, myersBase, { m: '{\na\na\nz\n{\nb\nb\nb\n' }, 'myers-b');
    // Only git's default algorithm is assessed; a local non-default one can hide a conflict a fresh clone reports.
    let differs = false;
    let myersTruth: string | undefined;
    for (const algorithm of ['patience', 'myers', 'histogram']) {
      git(alg, 'config', 'diff.algorithm', algorithm);
      for (const [x, y, label] of [[a, b, 'alg'], [ma, mb, 'myers']] as const) {
        const truth = realMerge(x, y, `${algorithm}-${label}`);
        if (algorithm === 'histogram') {
          expect((await simulateMerge(alg, x, y)).verdict, `${algorithm} ${label}`).toBe(truth);
          if (label === 'myers') differs = myersTruth !== undefined && truth !== myersTruth;
        } else {
          expect(await simulateMerge(alg, x, y), `${algorithm} ${label}`).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/can hide a conflict/) });
          if (algorithm === 'myers' && label === 'myers') myersTruth = truth;
        }
      }
    }
    expect(differs).toBe(true); // non-vacuity: the algorithm really changes this merge
    git(alg, 'config', '--unset', 'diff.algorithm');
    // diff3 skips conflict refinement, so it can turn a clean merge into a conflict.
    const styleBase = commitFiles(alg, empty, { s: 'a\nc\nc\nb\nc\na\n' }, 'style-base');
    const sa = commitFiles(alg, styleBase, { s: 'a\nc\nb\nc\na\n' }, 'style-a');
    const sb = commitFiles(alg, styleBase, { s: 'y\na\na\nc\nb\nc\nb\n' }, 'style-b');
    for (const style of ['merge', 'diff3', 'zdiff3']) {
      git(alg, 'config', 'merge.conflictStyle', style);
      let truth: 'clean-automerge' | 'textual-conflict' = 'clean-automerge';
      try { git(alg, 'merge-tree', '--write-tree', sa, sb); } catch { truth = 'textual-conflict'; }
      expect((await simulateMerge(alg, sa, sb)).verdict, style).toBe(truth);
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
    // Names that look like pathspec magic are listed literally. Skipped on Windows: NTFS cannot hold a
    // path containing ':', and git for Windows refuses to check one out (core.protectNTFS).
    if (process.platform !== 'win32') {
      const colonBase = commitFiles(repo, main, { ':/sub/k.txt': lines(), ':/Sub/.gitattributes': 'k.txt merge=binary\n' }, 'colon-base');
      const c1 = commitFiles(repo, colonBase, { ':/sub/k.txt': lines({ 1: 'B' }) }, 'colon-a');
      const c2 = commitFiles(repo, colonBase, { ':/sub/k.txt': lines({ 7: 'H' }) }, 'colon-b');
      expect(await simulateMerge(repo, c1, c2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/:\/Sub differs/) });
    }
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

  it('is not-assessed for non-ASCII names a filesystem may case-fold, and reads an empty config value as false', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const base = commitFiles(repo, main, { 'sub/f.txt': lines() }, 'fold-base');
    const a = commitFiles(repo, base, { 'sub/f.txt': lines({ 1: 'B' }), 'sub/.gitattributeſ': 'f.txt -merge\n' }, 'fold-a');
    const b = commitFiles(repo, base, { 'sub/f.txt': lines({ 7: 'H' }), 'sub/.gitattributeſ': 'f.txt -merge\n' }, 'fold-b');
    expect(await simulateMerge(repo, a, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/may alias \(non-ASCII/) });
    const sigmaBase = commitFiles(repo, main, { 'σ/f.txt': lines() }, 'sigma-base');
    const s1 = commitFiles(repo, sigmaBase, { 'σ/f.txt': lines({ 1: 'B' }), 'ς/.gitattributes': 'f.txt -merge\n' }, 'sigma-a');
    const s2 = commitFiles(repo, sigmaBase, { 'σ/f.txt': lines({ 7: 'H' }), 'ς/.gitattributes': 'f.txt -merge\n' }, 'sigma-b');
    expect(await simulateMerge(repo, s1, s2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/non-ASCII/) });

    const moved = git(repo, 'rev-parse', 'ren-move');
    const edited = git(repo, 'rev-parse', 'ren-edit');
    expect((await simulateMerge(repo, moved, edited)).verdict).toBe('clean-automerge');
    git(repo, 'config', 'merge.renames', '');
    try {
      expect((await simulateMerge(repo, moved, edited)).verdict).not.toBe('clean-automerge');
    } finally {
      git(repo, 'config', '--unset', 'merge.renames');
    }
  });

  it('is not-assessed for a changed path with a .git component', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const base = commitFiles(repo, main, { 'g.txt': lines() }, 'dotgit-base');
    // update-index refuses such a path (core.protectHFS/NTFS), so build the tree with mktree.
    const edited = commitFiles(repo, base, { 'g.txt': lines({ 1: 'B' }) }, 'dotgit-edit');
    const mktree = (entries: string) => execFileGitSync('git', ['mktree'], { cwd: repo, input: entries }).trim();
    const blob = execFileGitSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'x\n' }).trim();
    const dotGit = mktree(`100644 blob ${blob}\tx\n`);
    const sub = mktree(`040000 tree ${dotGit}\t.GIT\n`);
    const rootEntries = execFileGitSync('git', ['ls-tree', `${edited}^{tree}`], { cwd: repo });
    const tree = mktree(`${rootEntries}040000 tree ${sub}\tsub\n`);
    const a = execFileGitSync('git', ['commit-tree', tree, '-p', base, '-m', 'dotgit-a'], { cwd: repo }).trim();
    const b = commitFiles(repo, base, { 'g.txt': lines({ 7: 'H' }) }, 'dotgit-b');
    expect(await simulateMerge(repo, a, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/\.GIT\/x has a \.git path component/) });
  });

  it('is not-assessed for paths a real checkout refuses (NTFS/HFS .git aliases, .gitmodules symlinks)', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const base = commitFiles(repo, main, { 'g.txt': lines() }, 'protect-base');
    const b = commitFiles(repo, base, { 'g.txt': lines({ 7: 'H' }) }, 'protect-b');
    const edited = commitFiles(repo, base, { 'g.txt': lines({ 1: 'B' }) }, 'protect-edit');
    const mktree = (entries: string) => execFileGitSync('git', ['mktree'], { cwd: repo, input: entries }).trim();
    const blob = execFileGitSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'x\n' }).trim();
    const rootEntries = execFileGitSync('git', ['ls-tree', `${edited}^{tree}`], { cwd: repo });
    const withEntry = (entry: string, message: string) =>
      execFileGitSync('git', ['commit-tree', mktree(`${rootEntries}${entry}`), '-p', base, '-m', message], { cwd: repo }).trim();
    const inner = mktree(`100644 blob ${blob}\tx\n`);
    for (const [entry, message] of [
      [`040000 tree ${mktree(`040000 tree ${inner}\t.git.\n`)}\tsub\n`, 'protect-dot'],
      [`040000 tree ${mktree(`040000 tree ${inner}\tGIT~1\n`)}\tsub\n`, 'protect-short'],
      [`120000 blob ${blob}\t.gitmodules\n`, 'protect-symlink'],
    ] as const) {
      expect(await simulateMerge(repo, withEntry(entry, message), b), message).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/contains a path a real checkout refuses/) });
    }
    // A plain symlink elsewhere is fine.
    expect((await simulateMerge(repo, withEntry(`120000 blob ${blob}\tlink\n`, 'protect-ok'), b)).verdict).toBe('clean-automerge');
  });

  it('accepts in-range git numbers and harmless attributes, and refuses any other attribute', async () => {
    const i1 = git(repo, 'rev-parse', 'info-a');
    const i2 = git(repo, 'rev-parse', 'info-b');
    for (const [key, value] of [['merge.stat', '1k'], ['merge.log', ' 7'], ['merge.verbosity', '+3']] as const) {
      git(repo, 'config', key, value);
      try {
        expect((await simulateMerge(repo, i1, i2)).verdict, `${key}=${value}`).toBe('clean-automerge');
      } finally {
        git(repo, 'config', '--unset', key);
      }
    }
    const attributes = join(repo, '.git', 'info', 'attributes');
    try {
      writeFileSync(attributes, '* text=auto eol=lf whitespace=trailing-space linguist-generated\n');
      expect((await simulateMerge(repo, i1, i2)).verdict).toBe('clean-automerge');
      writeFileSync(attributes, 'g.txt -diff\n');
      expect(await simulateMerge(repo, i1, i2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/g\.txt has attribute "diff"/) });
      writeFileSync(attributes, 'g.txt filter=lfs\n');
      expect(await simulateMerge(repo, i1, i2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/g\.txt has attribute "filter"/) });
    } finally {
      rmSync(attributes, { force: true });
    }
  });

  it('checks attributes that only the merged .gitattributes holds', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const rules = (keepFirst: boolean, keepSecond: boolean) =>
      ['f.txt filter=x', '# pad', '# pad', ...(keepFirst ? ['f.txt !filter'] : []), '# pad', '# pad', '# pad', ...(keepSecond ? ['f.txt !filter'] : []), ''].join('\n');
    const base = commitFiles(repo, main, { 'f.txt': lines(), '.gitattributes': rules(true, true) }, 'merged-attr-base');
    const a = commitFiles(repo, base, { '.gitattributes': rules(false, true) }, 'merged-attr-a');
    const b = commitFiles(repo, base, { '.gitattributes': rules(true, false), 'f.txt': lines({ 7: 'H' }) }, 'merged-attr-b');
    expect(await simulateMerge(repo, a, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/in the merged tree, f\.txt has attribute "filter"/) });
  });

  it('is not-assessed when a directory rename places a path neither change touched', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const base = commitFiles(repo, main, { 'd/x': 'x\n', '.gitattributes': 'e/y filter=x\n' }, 'dirrename-base');
    // A moves d/ to e/ (delete d/x, add e/x); B adds d/y.
    const aTree = execFileGitSync('git', ['ls-tree', `${base}^{tree}`], { cwd: repo })
      .split('\n').filter(line => line && !line.endsWith('\td')).join('\n');
    const dTree = execFileGitSync('git', ['rev-parse', `${base}:d`], { cwd: repo }).trim();
    const tree = execFileGitSync('git', ['mktree'], { cwd: repo, input: `${aTree}\n040000 tree ${dTree}\te\n` }).trim();
    const a = execFileGitSync('git', ['commit-tree', tree, '-p', base, '-m', 'dirrename-a'], { cwd: repo }).trim();
    const b = commitFiles(repo, base, { 'd/y': 'y\n' }, 'dirrename-b');
    // With the default merge.directoryRenames=conflict the merge conflicts, and that verdict stands.
    expect((await simulateMerge(repo, a, b)).verdict).toBe('textual-conflict');
    git(repo, 'config', 'merge.directoryRenames', 'true');
    try {
      expect(await simulateMerge(repo, a, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/merge\.directoryrenames=true in git config can hide a conflict/) });
    } finally {
      git(repo, 'config', '--unset', 'merge.directoryRenames');
    }
  });

  it('is not-assessed when a submodule is replaced by ordinary files (vendoring)', async () => {
    const base = git(repo, 'rev-parse', 'sub-base'); // has a gitlink at `mod`
    const edited = commitFiles(repo, base, { 'code.txt': 'x\n' }, 'vendor-edit');
    const env = { ...process.env, GIT_INDEX_FILE: join(root, 'index-vendor') };
    execFileGitSync('git', ['read-tree', base], { cwd: repo, env });
    execFileGitSync('git', ['update-index', '--force-remove', 'mod'], { cwd: repo, env });
    const blob = execFileGitSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 's\n' }).trim();
    execFileGitSync('git', ['update-index', '--index-info'], { cwd: repo, env, input: `100644 ${blob}\tmod/s.txt\n` });
    const tree = execFileGitSync('git', ['write-tree'], { cwd: repo, env }).trim();
    rmSync(env.GIT_INDEX_FILE, { force: true });
    const vendored = execFileGitSync('git', ['commit-tree', tree, '-p', base, '-m', 'vendor'], { cwd: repo }).trim();
    expect(await simulateMerge(repo, edited, vendored)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/mod changes between a submodule and a regular entry/) });
  });

  it('is not-assessed for a changed path longer than a checkout filesystem allows', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const base = commitFiles(repo, main, { 'g.txt': lines() }, 'long-base');
    const a = commitFiles(repo, base, { 'g.txt': lines({ 1: 'B' }) }, 'long-a');
    const longName = commitFiles(repo, base, { [`${'n'.repeat(300)}.txt`]: 'x\n' }, 'long-name');
    expect(await simulateMerge(repo, a, longName)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/longer than a checkout filesystem allows/) });
    const deep = commitFiles(repo, base, { [`${Array.from({ length: 6 }, () => 'd'.repeat(200)).join('/')}/f.txt`]: 'x\n' }, 'long-deep');
    expect(await simulateMerge(repo, a, deep)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/longer than a checkout filesystem allows/) });
  });

  it('is not-assessed for a symlink whose target is longer than a checkout filesystem allows', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const base = commitFiles(repo, main, { 'g.txt': lines() }, 'symlink-base');
    const a = commitFiles(repo, base, { 'g.txt': lines({ 1: 'B' }) }, 'symlink-a');
    const withLink = (target: string, message: string) => {
      const env = { ...process.env, GIT_INDEX_FILE: join(root, `index-${message}`) };
      execFileGitSync('git', ['read-tree', base], { cwd: repo, env });
      const blob = execFileGitSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: target }).trim();
      execFileGitSync('git', ['update-index', '--index-info'], { cwd: repo, env, input: `120000 ${blob}\tlnk\n` });
      const tree = execFileGitSync('git', ['write-tree'], { cwd: repo, env }).trim();
      rmSync(env.GIT_INDEX_FILE, { force: true });
      return execFileGitSync('git', ['commit-tree', tree, '-p', base, '-m', message], { cwd: repo }).trim();
    };
    expect(await simulateMerge(repo, a, withLink('z'.repeat(1024), 'symlink-long'))).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/lnk is a symlink whose target is longer/) });
    expect((await simulateMerge(repo, a, withLink('target.txt', 'symlink-short'))).verdict).toBe('clean-automerge');
  });

  it('is not-assessed when a changed file differs from another entry only by letter case', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const base = commitFiles(repo, main, { readme: 'r\n', f: 'f\n' }, 'filecase-base');
    const a = commitFiles(repo, base, { README: 'R\n' }, 'filecase-a');
    const b = commitFiles(repo, base, { readme: 'r2\n' }, 'filecase-b');
    expect(await simulateMerge(repo, a, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/only by letter case/) });
    // An unchanged case variant already beside a changed file is caught through the directory listing.
    const both = commitFiles(repo, main, { readme: 'r\n', README: 'R\n', f: 'f\n' }, 'filecase-both');
    const e1 = commitFiles(repo, both, { readme: 'r2\n' }, 'filecase-edit');
    const e2 = commitFiles(repo, both, { f: 'f2\n' }, 'filecase-other');
    expect(await simulateMerge(repo, e1, e2)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/README differs from a changed path only by letter case/) });
  });

  it('is not-assessed when a .gitattributes is a symlink', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const env = { ...process.env, GIT_INDEX_FILE: join(root, 'index-attr-symlink') };
    const blob = (content: string) => execFileGitSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content }).trim();
    execFileGitSync('git', ['read-tree', main], { cwd: repo, env });
    execFileGitSync('git', ['update-index', '--index-info'], {
      cwd: repo, env,
      input: `100644 ${blob('d/f merge=binary\n')}\t.gitattributes\n100644 ${blob(lines())}\td/f\n120000 ${blob('f merge')}\td/.gitattributes\n`,
    });
    const tree = execFileGitSync('git', ['write-tree'], { cwd: repo, env }).trim();
    rmSync(env.GIT_INDEX_FILE, { force: true });
    const base = execFileGitSync('git', ['commit-tree', tree, '-p', main, '-m', 'attr-symlink-base'], { cwd: repo }).trim();
    const a = commitFiles(repo, base, { 'd/f': lines({ 0: 'A' }) }, 'attr-symlink-a');
    const b = commitFiles(repo, base, { 'd/f': lines({ 8: 'I' }) }, 'attr-symlink-b');
    expect(await simulateMerge(repo, a, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/d\/\.gitattributes is a symlink/) });
  });

  it('is not-assessed for a .gitattributes with a byte-order mark, a NUL byte, or a non-file mode', async () => {
    // The analyzed worktree stays on main, which has no attributes file, so only the tree checks apply.
    const main = git(repo, 'rev-parse', 'main');
    const start = commitFiles(repo, main, { 'd/f': lines() }, 'attr-bytes-start');
    const b = commitFiles(repo, start, { 'd/f': lines({ 8: 'I' }) }, 'attr-bytes-b');
    const bom = commitFiles(repo, start, { '.gitattributes': '\uFEFFd/f merge=binary\n', 'd/f': lines({ 0: 'A' }) }, 'attr-bom');
    expect(await simulateMerge(repo, bom, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/byte-order mark or a NUL byte/) });
    const nul = commitFiles(repo, start, { '.gitattributes': 'x\0y\nd/f merge=binary\n', 'd/f': lines({ 0: 'A' }) }, 'attr-nul');
    expect(await simulateMerge(repo, nul, b)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/byte-order mark or a NUL byte/) });

    const env = { ...process.env, GIT_INDEX_FILE: join(root, 'index-attr-gitlink') };
    const blob = (content: string) => execFileGitSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content }).trim();
    execFileGitSync('git', ['read-tree', start], { cwd: repo, env });
    execFileGitSync('git', ['update-index', '--index-info'], {
      cwd: repo, env,
      input: `100644 ${blob('d/f merge=binary\n')}\t.gitattributes\n160000 ${blob('f merge\n')}\td/.gitattributes\n`,
    });
    const tree = execFileGitSync('git', ['write-tree'], { cwd: repo, env }).trim();
    rmSync(env.GIT_INDEX_FILE, { force: true });
    const base = execFileGitSync('git', ['commit-tree', tree, '-p', start, '-m', 'attr-gitlink-base'], { cwd: repo }).trim();
    const la = commitFiles(repo, base, { 'd/f': lines({ 0: 'A' }) }, 'attr-gitlink-a');
    const lb = commitFiles(repo, base, { 'd/f': lines({ 8: 'I' }) }, 'attr-gitlink-b');
    expect(await simulateMerge(repo, la, lb)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/d\/\.gitattributes has mode 160000/) });
  });

  it('is not-assessed when a .gitattributes carries a checkout attribute or a near-limit line', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const start = commitFiles(repo, main, { 'f.txt': lines() }, 'attr-ident-start');
    const other = commitFiles(repo, start, { 'f.txt': lines({ 8: 'I' }) }, 'attr-ident-b');
    const ident = commitFiles(repo, start, { '.gitattributes': '.gitattributes ident\n', 'f.txt': lines({ 0: 'A' }) }, 'attr-ident-a');
    expect(await simulateMerge(repo, ident, other)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/\.gitattributes has attribute "ident"/) });
    // A local info/attributes (never in a fresh clone) must not hide the tree's rule.
    const info = join(repo, '.git', 'info', 'attributes');
    writeFileSync(info, '.gitattributes !ident\n');
    try {
      expect(await simulateMerge(repo, ident, other)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/\.gitattributes has attribute "ident"/) });
    } finally {
      rmSync(info, { force: true });
    }
    const long = commitFiles(repo, start, { '.gitattributes': `f.txt${' '.repeat(2000)}text\n`, 'f.txt': lines({ 0: 'A' }) }, 'attr-long-a');
    expect(await simulateMerge(repo, long, other)).toMatchObject({ verdict: 'not-assessed', detail: expect.stringMatching(/line-length limit/) });
  });
});
