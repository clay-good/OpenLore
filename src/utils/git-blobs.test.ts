/**
 * Batched blob reads (change: add-phantom-reference-findings — extracted from the merge-semantic
 * certificate). The batch correlates replies to fed paths BY ORDER, so the cases that could shift
 * that correlation are the ones worth pinning: a missing path in the middle, duplicates, and a path
 * holding a newline, which the batch must refuse rather than mis-answer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readBlobsAtRef, readBlobsPerFile } from './git-blobs.js';

const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com',
};
let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'openlore-blobs-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d, env: ENV });
  for (const [f, c] of Object.entries(files)) {
    const p = join(d, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c);
  }
  execFileSync('git', ['add', '-A'], { cwd: d, env: ENV });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: d, env: ENV });
  return d;
}

describe('readBlobsAtRef', () => {
  it('reads many paths in order, skipping one that is absent in the middle', async () => {
    const d = repo({ 'a.ts': 'A\n', 'c.ts': 'C\n', 'dir/d.ts': 'D\n' });
    const got = await readBlobsAtRef(d, 'HEAD', ['a.ts', 'missing.ts', 'c.ts', 'dir/d.ts']);
    expect([...got.entries()]).toEqual([['a.ts', 'A\n'], ['c.ts', 'C\n'], ['dir/d.ts', 'D\n']]);
  });

  it('reads a path with spaces and non-ASCII characters', async () => {
    const d = repo({ 'a file.ts': 'S\n', 'café/β.ts': 'U\n' });
    const got = await readBlobsAtRef(d, 'HEAD', ['a file.ts', 'café/β.ts']);
    expect(got.get('a file.ts')).toBe('S\n');
    expect(got.get('café/β.ts')).toBe('U\n');
  });

  it('refuses a path containing a newline instead of mis-answering the rest', async () => {
    const d = repo({ 'one.ts': 'ONE\n' });
    await expect(readBlobsAtRef(d, 'HEAD', ['with\nnewline.ts', 'one.ts'])).rejects.toThrow(/newline/);
    // The per-file reader is the fallback and still answers what it can.
    const got = await readBlobsPerFile(d, 'HEAD', ['with\nnewline.ts', 'one.ts']);
    expect(got.get('one.ts')).toBe('ONE\n');
  });

  it('returns an empty map for no paths', async () => {
    const d = repo({ 'a.ts': 'A\n' });
    expect(await readBlobsAtRef(d, 'HEAD', [])).toEqual(new Map());
  });
});
