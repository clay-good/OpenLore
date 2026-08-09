import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildViewerFreshness, readViewerFreshness, setViewerFreshnessHeaders } from './viewer-freshness.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('viewer freshness', () => {
  it('distinguishes stale, current, and unassessable metadata', () => {
    const common = { generatedAt: '2026-08-09T00:00:00.000Z', analyzedCommit: 'a', currentCommit: 'b' };
    expect(buildViewerFreshness({ ...common, filesChangedSince: 1 }).status).toBe('stale');
    expect(buildViewerFreshness({ ...common, filesChangedSince: 0 }).status).toBe('current');
    expect(buildViewerFreshness({ ...common, currentCommit: null, filesChangedSince: null }).status)
      .toBe('unassessable');
  });

  it('reports a tracked source edit since the analyzed commit as stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-view-freshness-'));
    roots.push(root);
    await execFileAsync('git', ['init', '--quiet'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1;\n');
    await execFileAsync('git', ['add', 'src/app.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: root });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });

    const analysisDir = join(root, '.openlore', 'custom-analysis');
    const artifactPath = join(analysisDir, 'dependency-graph.json');
    await mkdir(analysisDir, { recursive: true });
    await writeFile(artifactPath, '{}');
    await writeFile(join(analysisDir, 'fingerprint.json'), JSON.stringify({ commit: stdout.trim() }));
    await writeFile(join(root, 'src', 'app.ts'), 'export const value = 2;\n');

    const freshness = await readViewerFreshness(root, analysisDir, artifactPath);
    expect(freshness).toMatchObject({
      analyzedCommit: stdout.trim(),
      currentCommit: stdout.trim(),
      status: 'stale',
      filesChangedSince: 1,
    });
  });

  it('reports an untracked source file missing from the index as stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-view-untracked-'));
    roots.push(root);
    await execFileAsync('git', ['init', '--quiet'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    await writeFile(join(root, 'README.md'), 'initial\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: root });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: root });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });

    const analysisDir = join(root, '.openlore', 'custom-analysis');
    const artifactPath = join(analysisDir, 'dependency-graph.json');
    await mkdir(analysisDir, { recursive: true });
    await writeFile(artifactPath, '{}');
    await writeFile(join(analysisDir, 'fingerprint.json'), JSON.stringify({ commit: stdout.trim() }));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'new.ts'), 'export const value = 1;\n');

    await expect(readViewerFreshness(root, analysisDir, artifactPath)).resolves.toMatchObject({
      status: 'stale', filesChangedSince: 1,
    });
  });

  it('invalidates the memo when analysis advances to a new fingerprint commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-view-reanalyze-'));
    roots.push(root);
    await execFileAsync('git', ['init', '--quiet'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1;\n');
    await execFileAsync('git', ['add', 'src/app.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'first'], { cwd: root });
    const first = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();

    const analysisDir = join(root, '.openlore', 'custom-analysis');
    const artifactPath = join(analysisDir, 'dependency-graph.json');
    await mkdir(analysisDir, { recursive: true });
    await writeFile(artifactPath, '{}');
    await writeFile(join(analysisDir, 'fingerprint.json'), JSON.stringify({ commit: first }));
    await writeFile(join(root, 'src', 'app.ts'), 'export const value = 2;\n');
    await execFileAsync('git', ['add', 'src/app.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'second'], { cwd: root });
    await expect(readViewerFreshness(root, analysisDir, artifactPath)).resolves
      .toMatchObject({ status: 'stale' });

    const second = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await writeFile(join(analysisDir, 'fingerprint.json'), JSON.stringify({ commit: second }));
    await expect(readViewerFreshness(root, analysisDir, artifactPath)).resolves
      .toMatchObject({ analyzedCommit: second, status: 'current', filesChangedSince: 0 });
  });

  it('publishes additive headers without changing the artifact body', () => {
    const headers = new Map<string, string>();
    setViewerFreshnessHeaders((name, value) => headers.set(name, value), {
      generatedAt: '2026-08-09T00:00:00.000Z',
      analyzedCommit: 'abc', currentCommit: 'def', status: 'stale', filesChangedSince: 2,
    });
    expect(Object.fromEntries(headers)).toEqual(expect.objectContaining({
      'X-OpenLore-Generated-At': '2026-08-09T00:00:00.000Z',
      'X-OpenLore-Analysis-Freshness': 'stale',
      'X-OpenLore-Files-Changed-Since': '2',
    }));
  });
});
