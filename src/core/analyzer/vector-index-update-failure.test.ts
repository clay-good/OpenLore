import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FunctionNode } from './call-graph.js';

const table = vi.hoisted(() => ({
  query: vi.fn(),
  delete: vi.fn(),
  add: vi.fn(),
}));
const atomicWrite = vi.hoisted(() => vi.fn());

vi.mock('@lancedb/lancedb', () => ({
  connect: vi.fn().mockResolvedValue({
    openTable: vi.fn().mockResolvedValue(table),
  }),
}));
vi.mock('../decisions/atomic-store.js', () => ({ atomicWriteFile: atomicWrite }));

import { VectorIndex, TOKENIZER_VERSION, _resetVectorIndexCachesForTesting } from './vector-index.js';

const NODE: FunctionNode = {
  id: 'src/a.ts::changed',
  name: 'changed',
  filePath: 'src/a.ts',
  language: 'TypeScript',
  isAsync: false,
  startIndex: 0,
  endIndex: 10,
  fanIn: 1,
  fanOut: 0,
};

describe('VectorIndex update failure persistence', () => {
  let outputDir: string;
  const previousRows = [{
    id: 'src/a.ts::old', name: 'old', filePath: 'src/a.ts', className: '',
    language: 'TypeScript', signature: '', docstring: '', fanIn: 1, fanOut: 0,
    isHub: false, isEntryPoint: false, text: '[TypeScript] src/a.ts old',
  }];

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'openlore-update-failure-'));
    await mkdir(join(outputDir, 'vector-index'), { recursive: true });
    await writeFile(join(outputDir, 'vector-index-meta.json'), JSON.stringify({
      hasEmbeddings: false,
      dim: 0,
      model: null,
      builtAt: new Date().toISOString(),
      schemaVersion: 1,
      tokenizerVersion: TOKENIZER_VERSION,
    }));
    table.query.mockReset().mockReturnValue({
      where: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue(previousRows) }),
    });
    table.delete.mockReset().mockResolvedValue(undefined);
    table.add.mockReset();
    atomicWrite.mockReset().mockImplementation((path: string, data: string) => writeFile(path, data));
    _resetVectorIndexCachesForTesting();
  });

  it('writes a degraded marker after add and restore fail, and a partial success cannot clear it', async () => {
    table.add
      .mockRejectedValueOnce(new Error('add failed'))
      .mockRejectedValueOnce(new Error('restore failed'));

    await expect(VectorIndex.updateFiles(
      outputDir, [NODE], new Set(['src/a.ts']), [], new Set(), new Set(), null,
    )).rejects.toThrow('update and rollback both failed');

    const failedMeta = JSON.parse(await readFile(join(outputDir, 'vector-index-meta.json'), 'utf-8'));
    expect(failedMeta.degraded?.reason).toBe('incremental-update-restore-failed');
    expect(VectorIndex.degradationNotice(outputDir)).toBe('Index degraded — re-run "openlore analyze".');

    table.add.mockReset().mockResolvedValue(undefined);
    await VectorIndex.updateFiles(
      outputDir, [NODE], new Set(['src/a.ts']), [], new Set(), new Set(), null,
    );
    expect(VectorIndex.degradationNotice(outputDir)).toBe('Index degraded — re-run "openlore analyze".');
  });

  it('keeps a process-local disclosure when the degraded marker cannot be persisted', async () => {
    table.add
      .mockRejectedValueOnce(new Error('add failed'))
      .mockRejectedValueOnce(new Error('restore failed'));
    atomicWrite.mockRejectedValueOnce(new Error('disk full'));

    await expect(VectorIndex.updateFiles(
      outputDir, [NODE], new Set(['src/a.ts']), [], new Set(), new Set(), null,
    )).rejects.toThrow('marker persistence failed');
    expect(VectorIndex.degradationNotice(outputDir)).toBe('Index degraded — re-run "openlore analyze".');
  });

  it('restores the previous rows when the coherence metadata cannot be published', async () => {
    table.add.mockResolvedValue(undefined);
    atomicWrite.mockRejectedValueOnce(new Error('disk full'));

    await expect(VectorIndex.updateFiles(
      outputDir, [NODE], new Set(['src/a.ts']), [], new Set(), new Set(), null,
    )).rejects.toThrow('disk full');

    expect(table.delete).toHaveBeenCalledTimes(2);
    expect(table.add).toHaveBeenCalledTimes(2);
    expect(table.add.mock.calls[1][0]).toEqual(previousRows);
    expect(VectorIndex.degradationNotice(outputDir)).toBeNull();
  });

  it('does not mutate the table for an empty changed-file set', async () => {
    const result = await VectorIndex.updateFiles(
      outputDir, [NODE], new Set(), [], new Set(), new Set(), null,
    );
    expect(result.total).toBe(0);
    expect(table.query).not.toHaveBeenCalled();
    expect(table.delete).not.toHaveBeenCalled();
    expect(table.add).not.toHaveBeenCalled();
  });
});
