import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureSourceState, reconcileSourceStates } from './source-state.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root },
  ).toString().trim();
}

describe('captureSourceState', () => {
  it('distinguishes clean and dirty analyzed trees at the same commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-source-state-'));
    roots.push(root);
    git(root, 'init', '-q');
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    git(root, 'add', 'a.ts');
    git(root, 'commit', '-q', '-m', 'initial');

    const clean = await captureSourceState(root);
    expect(clean).toMatchObject({ treeState: 'clean' });
    expect(clean.commit).toBe(git(root, 'rev-parse', '--verify', 'HEAD'));

    await writeFile(join(root, 'a.ts'), 'export const a = 2;\n');
    expect(await captureSourceState(root)).toMatchObject({ commit: clean.commit, treeState: 'dirty' });

    git(root, 'add', 'a.ts');
    expect(await captureSourceState(root)).toMatchObject({ commit: clean.commit, treeState: 'dirty' });

    git(root, 'restore', '--staged', 'a.ts');
    git(root, 'restore', 'a.ts');
    await writeFile(join(root, 'untracked.ts'), 'export const b = 1;\n');
    expect(await captureSourceState(root)).toMatchObject({ commit: clean.commit, treeState: 'dirty' });
  });

  it('never calls a changed analysis interval clean', () => {
    expect(reconcileSourceStates(
      { commit: 'a'.repeat(40), treeState: 'clean' },
      { commit: 'b'.repeat(40), treeState: 'clean' },
    )).toEqual({ commit: 'b'.repeat(40), treeState: 'unknown' });
    expect(reconcileSourceStates(
      { commit: 'a'.repeat(40), treeState: 'dirty' },
      { commit: 'a'.repeat(40), treeState: 'clean' },
    )).toEqual({ commit: 'a'.repeat(40), treeState: 'dirty' });
  });

  it('uses unknown rather than guessing clean when git identity is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-source-state-nongit-'));
    roots.push(root);
    expect(await captureSourceState(root)).toEqual({ commit: null, treeState: 'unknown' });
  });
});
