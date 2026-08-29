import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPinnedAnalysis, markPinnedAnalysis, verifyPinnedRepository } from './pinned-repository.js';

describe('pinned benchmark repository', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function repository(): { root: string; pin: { id: string; sha: string } } {
    const root = mkdtempSync(join(tmpdir(), 'openlore-bench-repo-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'bench@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Benchmark Test'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', 'source.ts'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'test: pin source'], { cwd: root });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    return { root, pin: { id: 'fixture', sha } };
  }

  it('rejects tracked modifications at the pinned SHA', () => {
    const { root, pin } = repository();
    writeFileSync(join(root, 'source.ts'), 'export const value = 2;\n');
    expect(() => verifyPinnedRepository(pin, root)).toThrow('tracked modifications');
  });

  it('binds reusable analysis to the pinned source SHA', () => {
    const { root, pin } = repository();
    markPinnedAnalysis(pin, root);
    expect(() => assertPinnedAnalysis(pin, root)).not.toThrow();
    expect(() => assertPinnedAnalysis({ ...pin, sha: '0'.repeat(40) }, root)).toThrow('absent or stale');
  });
});
