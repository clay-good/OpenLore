import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../services/config-manager.js';
import { EdgeStore } from '../services/edge-store.js';
import { runAnalysisCore, type AnalysisReport } from './analysis-core.js';

async function repo(): Promise<{ root: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-analysis-shards-'));
  const output = join(root, '.openlore', 'analysis');
  await mkdir(join(root, 'packages', 'a'), { recursive: true });
  await mkdir(join(root, 'packages', 'b'), { recursive: true });
  await mkdir(join(root, 'packages', 'c'), { recursive: true });
  await writeFile(join(root, 'packages/a/a.ts'), 'export function existing() { return 1 }');
  await writeFile(join(root, 'packages/b/b.ts'), 'export function consumer() { return addedLater() }');
  await writeFile(join(root, 'packages/c/c.ts'), 'export function retained() { return 3 }');
  return { root, output };
}

describe('runAnalysisCore workspace shards', () => {
  it('updates only the graph, retains repo-wide artifacts, and leaves the full fingerprint stale', async () => {
    const { root, output } = await repo();
    const config = {
      ...getDefaultConfig('nodejs', 'openspec'),
      workspace: { shards: [{ name: 'a', root: 'packages/a' }, { name: 'b', root: 'packages/b' }, { name: 'c', root: 'packages/c' }] },
    };
    await runAnalysisCore(root, output, { maxFiles: 100, config });
    const initialStore = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      expect(initialStore.listPass1FactKeys().map(row => row.filePath)).toContain('packages/b/b.ts');
    } finally { initialStore.close(); }
    const repoStructureBefore = await readFile(join(output, 'repo-structure.json'), 'utf8');
    const contextBefore = await readFile(join(output, 'llm-context.json'), 'utf8');
    const fingerprintBefore = await readFile(join(output, 'fingerprint.json'), 'utf8');
    const retainedStat = await stat(join(root, 'packages/c/c.ts'));

    await writeFile(join(root, 'packages/a/a.ts'), 'export function existing() { return 1 }\nexport function addedLater() { return 2 }');
    await writeFile(join(root, 'packages/c/c.ts'), 'export function retained() { return 4 }');
    await utimes(join(root, 'packages/c/c.ts'), retainedStat.atime, retainedStat.mtime);
    const events: AnalysisReport[] = [];
    const result = await runAnalysisCore(root, output, {
      maxFiles: 100,
      config,
      shards: ['a'],
      reporter: { report: event => events.push(event) },
    });

    expect(result.shardReceipt).toMatchObject({ mode: 'scoped', recomputed: ['a'], retained: ['b', 'c', 'root'] });
    expect(result.shardReceipt?.shards.find(shard => shard.name === 'c')?.freshness).toBe('unknown');
    expect(result.shardReceipt?.frontierFiles).toContain('packages/b/b.ts');
    expect(await readFile(join(output, 'repo-structure.json'), 'utf8')).toBe(repoStructureBefore);
    expect(await readFile(join(output, 'llm-context.json'), 'utf8')).toBe(contextBefore);
    expect(await readFile(join(output, 'fingerprint.json'), 'utf8')).toBe(fingerprintBefore);
    expect(events.some(event => event.detail?.includes('Repo-wide artifacts retained'))).toBe(true);
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      expect(store.getAllEdges()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          callerId: 'packages/b/b.ts::consumer',
          calleeId: 'packages/a/a.ts::addedLater',
        }),
      ]));
    } finally { store.close(); }
  }, 30_000);

  it('removes an obsolete shard receipt when a later full analysis is single-root', async () => {
    const { root, output } = await repo();
    const configured = {
      ...getDefaultConfig('nodejs', 'openspec'),
      workspace: { shards: [{ name: 'a', root: 'packages/a' }] },
    };
    await runAnalysisCore(root, output, { maxFiles: 100, config: configured });
    expect(JSON.parse(await readFile(join(output, 'workspace-shards.json'), 'utf8')).mode).toBe('full');

    await runAnalysisCore(root, output, { maxFiles: 100, config: getDefaultConfig('nodejs', 'openspec') });
    await expect(readFile(join(output, 'workspace-shards.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('discloses and performs a full build when no retained index exists', async () => {
    const { root, output } = await repo();
    const config = {
      ...getDefaultConfig('nodejs', 'openspec'),
      workspace: { shards: [{ name: 'a', root: 'packages/a' }, { name: 'b', root: 'packages/b' }, { name: 'c', root: 'packages/c' }] },
    };
    const events: AnalysisReport[] = [];
    const result = await runAnalysisCore(root, output, {
      maxFiles: 100,
      config,
      shards: ['a'],
      reporter: { report: event => events.push(event) },
    });
    expect(result.shardReceipt).toBeUndefined();
    expect(events.some(event => event.detail?.includes('no prior graph index') && event.detail.includes('full rebuild'))).toBe(true);
    expect(JSON.parse(await readFile(join(output, 'workspace-shards.json'), 'utf8'))).toMatchObject({ mode: 'full' });
  }, 30_000);
});
