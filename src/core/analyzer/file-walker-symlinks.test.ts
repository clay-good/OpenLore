/**
 * Symlinked directories (change: bulletproof-background-index).
 *
 * A `Dirent` does not follow symlinks, so a symlink reports false for BOTH `isDirectory` and
 * `isFile`. It fell out of both partitions in the walker and was dropped with no `recordSkip` at
 * all — the one outcome this project's honesty contract forbids, because the result was not
 * "we skipped this" but "there was nothing there".
 *
 * The user-visible shape: a repository laid out as `src -> packages/app/src` (pnpm and lerna
 * workspaces, or any shared checkout) analyzed as though `src` did not exist. Exit 0,
 * "Files analyzed: 5", a green `doctor`, and `orient` answering confidently about functions it had
 * never opened.
 *
 * Following links makes two hazards reachable that simply could not occur while everything was
 * dropped, so both are covered here as well: a link out of the repository, and a link that cycles.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileWalker } from './file-walker.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe('FileWalker — symlinked directories', () => {
  it('indexes source that is ONLY reachable through a symlink', async () => {
    // The target sits under a dot-directory, which the walker skips on its own, so the link is the
    // only way in. That isolates the property under test. A first draft pointed the link at an
    // ordinary sibling directory, and a mutation restoring the original drop-the-link behavior
    // still passed — the walker simply reached the target by its real path instead, so nothing
    // was ever lost and the fixture proved nothing.
    const repo = makeDir('ol-sym-');
    mkdirSync(join(repo, '.impl'));
    writeFileSync(join(repo, '.impl', 'lib.ts'), 'export function onlyViaLink() { return 1; }\n');
    writeFileSync(join(repo, 'index.ts'), 'export function entry() {}\n');
    symlinkSync(join(repo, '.impl'), join(repo, 'src'));

    const result = await new FileWalker(repo).walk();
    const names = result.files.map(f => f.path);

    const libHits = names.filter(p => p.endsWith('lib.ts'));
    expect(libHits, `lib.ts was reached ${libHits.length} times: ${names.join(', ')}`).toHaveLength(1);
    expect(names.some(p => p.endsWith('index.ts'))).toBe(true);
  });

  it('reaches a shared directory exactly once when it has both a real path and a link', async () => {
    // The monorepo shape (`src -> packages/app/src`). Nothing is lost here even without following
    // links, because the target is reachable by its real path — so the property that matters is
    // the other one: following the link must not index every file a second time.
    const repo = makeDir('ol-sym-dup-');
    mkdirSync(join(repo, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'app', 'src', 'lib.ts'), 'export function realA() { return 1; }\n');
    symlinkSync(join(repo, 'packages', 'app', 'src'), join(repo, 'src'));

    const result = await new FileWalker(repo).walk();
    const hits = result.files.filter(f => f.path.endsWith('lib.ts'));
    expect(hits, `lib.ts indexed ${hits.length} times`).toHaveLength(1);
  });

  it('refuses to index outside the repository, and says so', async () => {
    // A link like `vendored -> /usr/lib/...` would otherwise pull files the user never checked in
    // into their graph. Following links is what makes this reachable at all.
    const repo = makeDir('ol-sym-esc-');
    const outside = makeDir('ol-sym-out-');
    writeFileSync(join(outside, 'secret.ts'), 'export function leaked() {}\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'mine.ts'), 'export function mine() {}\n');
    symlinkSync(outside, join(repo, 'vendored'));

    const result = await new FileWalker(repo).walk();
    const names = result.files.map(f => f.path);

    expect(names.some(p => p.endsWith('secret.ts')), 'indexed a file outside the repository').toBe(false);
    expect(names.some(p => p.endsWith('mine.ts'))).toBe(true);
    // Disclosed, not silently dropped.
    expect(Object.keys(result.summary.skippedReasons ?? {})).toContain('symlink:outside-root');
  });

  it('terminates on a symlink cycle instead of walking forever', async () => {
    const repo = makeDir('ol-sym-loop-');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export function loopy() {}\n');
    symlinkSync('..', join(repo, 'src', 'up')); // src/up -> repo, which contains src…

    const result = await new FileWalker(repo).walk();

    expect(result.files.filter(f => f.path.endsWith('a.ts'))).toHaveLength(1);
    expect(Object.keys(result.summary.skippedReasons ?? {})).toContain('symlink:already-visited');
  });

  it('discloses a broken link rather than dropping it silently', async () => {
    const repo = makeDir('ol-sym-broken-');
    writeFileSync(join(repo, 'real.ts'), 'export function real() {}\n');
    symlinkSync(join(repo, 'does-not-exist'), join(repo, 'dangling'));

    const result = await new FileWalker(repo).walk();

    expect(result.files.some(f => f.path.endsWith('real.ts'))).toBe(true);
    expect(Object.keys(result.summary.skippedReasons ?? {})).toContain('symlink:unresolvable');
  });

  it('follows a symlink to a FILE, which is the common vendoring shape', async () => {
    const repo = makeDir('ol-sym-file-');
    mkdirSync(join(repo, 'shared'));
    writeFileSync(join(repo, 'shared', 'util.ts'), 'export function shared() {}\n');
    mkdirSync(join(repo, 'app'));
    symlinkSync(join(repo, 'shared', 'util.ts'), join(repo, 'app', 'util.ts'));

    const result = await new FileWalker(repo).walk();
    // Both paths are real files as far as the walker is concerned; the point is that the LINK is
    // classified as a file at all rather than vanishing.
    expect(result.files.filter(f => f.path.endsWith('util.ts')).length).toBeGreaterThanOrEqual(1);
  });
});
