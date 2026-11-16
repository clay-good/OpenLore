import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexWithinDiff } from './blast-radius.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };

function repoWithCommits(n: number): { dir: string; shas: string[] } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ol-within-')));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const shas: string[] = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, 'a.ts'), `export const a = ${i};\n`);
    git('add', '-A');
    git('commit', '-qm', `c${i}`);
    shas.push(git('rev-parse', 'HEAD'));
  }
  return { dir, shas };
}

describe('blast_radius: is the index within the diff?', () => {
  it('an index at or after the base, on HEAD history, is the diff, not staleness', async () => {
    const { dir, shas } = repoWithCommits(3);
    expect(await indexWithinDiff(dir, shas[2], 'HEAD')).toBe(true);
    expect(await indexWithinDiff(dir, shas[2], shas[0])).toBe(true);
    expect(await indexWithinDiff(dir, shas[1], shas[0])).toBe(true);
  });

  it('an index older than the base is stale, and an unusable value is never trusted', async () => {
    const { dir, shas } = repoWithCommits(3);
    expect(await indexWithinDiff(dir, shas[0], 'HEAD')).toBe(false);
    expect(await indexWithinDiff(dir, 'not-a-hash', 'HEAD')).toBe(false);
    expect(await indexWithinDiff(dir, shas[2], '--output=x')).toBe(false);
    expect(await indexWithinDiff(dir, 'deadbeef', 'HEAD')).toBe(false);
  });
});
