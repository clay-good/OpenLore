/**
 * A partial clone's lazy fetch must never run the repository's own `uploadpack` command
 * (see `hardenedEnv` in git-exec.ts). Real git, real clone: the marker file is the proof.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileGit, execFileGitSync, trustedLazyFetchEnv } from './git-exec.js';

function gitVersionAtLeast(major: number, minor: number): boolean {
  const out = execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  const [, a, b] = /(\d+)\.(\d+)/.exec(out) ?? [];
  return Number(a) > major || (Number(a) === major && Number(b) >= minor);
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

// GIT_NO_LAZY_FETCH needs git 2.45+; the hostile uploadpack is a POSIX shell script.
describe.skipIf(process.platform === 'win32' || !gitVersionAtLeast(2, 45))('partial-clone lazy fetch', () => {
  let root: string;
  let victim: string;
  let marker: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'openlore-lazy-fetch-')));
    const origin = join(root, 'origin');
    git(root, 'init', '-q', origin);
    git(origin, 'config', 'uploadpack.allowFilter', 'true');
    for (const content of ['one\n', 'two\n']) {
      writeFileSync(join(origin, 'file.txt'), content);
      git(origin, 'add', 'file.txt');
      git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', content.trim());
    }
    victim = join(root, 'victim');
    git(root, 'clone', '-q', '--filter=blob:none', pathToFileURL(origin).href, victim);
    marker = join(root, 'PWNED');
    const hostile = join(root, 'hostile-upload-pack');
    writeFileSync(hostile, `#!/bin/sh\ntouch '${marker}'\nexec git-upload-pack "$@"\n`);
    chmodSync(hostile, 0o755);
    git(victim, 'config', 'remote.origin.uploadpack', hostile);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('the fixture is live: plain git runs the repository uploadpack on a missing blob', () => {
    git(victim, 'show', 'HEAD~1:file.txt');
    expect(existsSync(marker)).toBe(true);
  });

  it('execFileGit and execFileGitSync fail the read instead of running it', async () => {
    await expect(execFileGit('git', ['show', 'HEAD~1:file.txt'], { cwd: victim })).rejects.toThrow();
    expect(() => execFileGitSync('git', ['cat-file', 'blob', 'HEAD~1:file.txt'], { cwd: victim, stdio: 'pipe' })).toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it('ignores an inherited opt-out; only an explicit trusted env may lazy-fetch', async () => {
    const previous = process.env.GIT_NO_LAZY_FETCH;
    process.env.GIT_NO_LAZY_FETCH = '0';
    try {
      await expect(execFileGit('git', ['show', 'HEAD~1:file.txt'], { cwd: victim })).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GIT_NO_LAZY_FETCH;
      else process.env.GIT_NO_LAZY_FETCH = previous;
    }
    await execFileGit('git', ['show', 'HEAD~1:file.txt'], { cwd: victim, env: trustedLazyFetchEnv() });
    expect(existsSync(marker)).toBe(true);
  });

  it('keeps a caller-supplied environment', async () => {
    const env = { ...process.env, OPENLORE_PROBE: '1' };
    await expect(execFileGit('git', ['show', 'HEAD~1:file.txt'], { cwd: victim, env })).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });
});
