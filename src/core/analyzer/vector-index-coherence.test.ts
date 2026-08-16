import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VectorIndex,
  TOKENIZER_VERSION,
  _replaceRowsWithRestoreForTesting,
  _resetVectorIndexCachesForTesting,
  _vectorIndexCacheIdentityForTesting,
} from './vector-index.js';
import type { FunctionNode } from './call-graph.js';
import type { Embedder } from './embedding-service.js';

const OLD_NODE: FunctionNode = {
  id: 'src/old.ts::oldMarker',
  name: 'oldMarker',
  filePath: 'src/old.ts',
  language: 'TypeScript',
  isAsync: false,
  startIndex: 0,
  endIndex: 10,
  fanIn: 1,
  fanOut: 0,
};

function replacementRow(): Record<string, unknown> {
  return {
    id: 'src/new.ts::newMarker',
    name: 'newMarker',
    filePath: 'src/new.ts',
    className: '',
    language: 'TypeScript',
    signature: '',
    docstring: '',
    fanIn: 1,
    fanOut: 0,
    isHub: false,
    isEntryPoint: false,
    text: '[TypeScript] src/new.ts newMarker',
  };
}

describe('VectorIndex cross-process coherence', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'openlore-vector-coherence-'));
    _resetVectorIndexCachesForTesting();
  });

  afterEach(() => _resetVectorIndexCachesForTesting());

  it('reopens the table and rebuilds BM25 after an out-of-band overwrite', async () => {
    await VectorIndex.build(outputDir, [OLD_NODE], [], new Set(), new Set(), null);
    expect((await VectorIndex.search(outputDir, 'oldMarker', null))[0]?.record.name).toBe('oldMarker');

    const { connect } = await import('@lancedb/lancedb');
    const db = await connect(join(outputDir, 'vector-index'));
    await db.createTable('functions', [replacementRow()], { mode: 'overwrite' });
    await rm(join(outputDir, 'vector-index', 'bm25-corpus.json'), { force: true });
    await writeFile(join(outputDir, 'vector-index-meta.json'), JSON.stringify({
      hasEmbeddings: false,
      dim: 0,
      model: null,
      builtAt: new Date(Date.now() + 1_000).toISOString(),
      schemaVersion: 1,
      tokenizerVersion: TOKENIZER_VERSION,
    }));

    const results = await VectorIndex.search(outputDir, 'newMarker', null);
    expect(results[0]?.record.name).toBe('newMarker');
    expect(results.some((result) => result.record.name === 'oldMarker')).toBe(false);
  });

  it('routes on fresh BM25 metadata instead of invoking a stale dense path', async () => {
    const dense: Embedder = {
      modelName: 'test-dense',
      embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    };
    await VectorIndex.build(outputDir, [OLD_NODE], [], new Set(), new Set(), dense);
    await VectorIndex.search(outputDir, 'oldMarker', dense);
    vi.mocked(dense.embed).mockClear();

    const { connect } = await import('@lancedb/lancedb');
    const db = await connect(join(outputDir, 'vector-index'));
    await db.createTable('functions', [replacementRow()], { mode: 'overwrite' });
    await rm(join(outputDir, 'vector-index', 'bm25-corpus.json'), { force: true });
    await writeFile(join(outputDir, 'vector-index-meta.json'), JSON.stringify({
      hasEmbeddings: false,
      dim: 0,
      model: null,
      builtAt: new Date(Date.now() + 1_000).toISOString(),
      schemaVersion: 1,
      tokenizerVersion: TOKENIZER_VERSION,
    }));

    expect((await VectorIndex.search(outputDir, 'newMarker', dense))[0]?.record.name).toBe('newMarker');
    expect(dense.embed).not.toHaveBeenCalled();
  });

  it('re-stamps a successful out-of-band row mutation for warm readers', async () => {
    await VectorIndex.build(outputDir, [OLD_NODE], [], new Set(), new Set(), null);
    await VectorIndex.search(outputDir, 'oldMarker', null);

    const { connect } = await import('@lancedb/lancedb');
    const db = await connect(join(outputDir, 'vector-index'));
    const table = await db.openTable('functions');
    await table.delete("`filePath` IN ('src/old.ts')");
    await table.add([replacementRow()]);
    await rm(join(outputDir, 'vector-index', 'bm25-corpus.json'), { force: true });
    await writeFile(join(outputDir, 'vector-index-meta.json'), JSON.stringify({
      hasEmbeddings: false,
      dim: 0,
      model: null,
      builtAt: new Date(Date.now() + 1_000).toISOString(),
      schemaVersion: 1,
      tokenizerVersion: TOKENIZER_VERSION,
    }));

    expect((await VectorIndex.search(outputDir, 'newMarker', null))[0]?.record.name).toBe('newMarker');
  });

  it('canonicalizes symlink aliases to one cache identity', async () => {
    if (process.platform === 'win32') return;
    await mkdir(join(outputDir, 'vector-index'));
    const alias = `${outputDir}-alias`;
    await symlink(outputDir, alias, 'dir');
    expect(_vectorIndexCacheIdentityForTesting(alias)).toBe(_vectorIndexCacheIdentityForTesting(outputDir));
    await rm(alias, { force: true });
  });

  it('returns the persisted degraded disclosure', async () => {
    await writeFile(join(outputDir, 'vector-index-meta.json'), JSON.stringify({
      hasEmbeddings: false,
      dim: 0,
      model: null,
      builtAt: new Date().toISOString(),
      schemaVersion: 1,
      degraded: { reason: 'incremental-update-restore-failed', recordedAt: new Date().toISOString() },
    }));
    expect(VectorIndex.degradationNotice(outputDir)).toBe('Index degraded — re-run "openlore analyze".');
  });
});

describe('VectorIndex incremental replacement rollback', () => {
  it('restores the captured rows when adding replacements fails', async () => {
    const previous = [{ id: 'old' }];
    const replacement = [{ id: 'new' }];
    const table = {
      delete: vi.fn().mockResolvedValue(undefined),
      add: vi.fn()
        .mockRejectedValueOnce(new Error('add failed'))
        .mockResolvedValueOnce(undefined),
    };
    const markDegraded = vi.fn().mockResolvedValue(undefined);

    await expect(_replaceRowsWithRestoreForTesting(
      table, '`filePath` IN (\'src/a.ts\')', replacement, previous, markDegraded,
    )).rejects.toThrow('add failed');
    expect(table.add).toHaveBeenNthCalledWith(1, replacement);
    expect(table.add).toHaveBeenNthCalledWith(2, previous);
    expect(table.delete).toHaveBeenCalledTimes(2);
    expect(markDegraded).not.toHaveBeenCalled();
  });

  it('marks the index degraded when adding and restoring both fail', async () => {
    const table = {
      delete: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockRejectedValueOnce(new Error('add failed')).mockRejectedValueOnce(new Error('restore failed')),
    };
    const markDegraded = vi.fn().mockResolvedValue(undefined);

    await expect(_replaceRowsWithRestoreForTesting(
      table, '`filePath` IN (\'src/a.ts\')', [{ id: 'new' }], [{ id: 'old' }], markDegraded,
    )).rejects.toThrow('update and rollback both failed');
    expect(markDegraded).toHaveBeenCalledOnce();
  });

  it('preserves add and rollback failures when degraded-marker persistence also fails', async () => {
    const addError = new Error('add failed');
    const restoreError = new Error('restore failed');
    const markerError = new Error('disk full');
    const table = {
      delete: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockRejectedValueOnce(addError).mockRejectedValueOnce(restoreError),
    };

    let caught: unknown;
    try {
      await _replaceRowsWithRestoreForTesting(
        table,
        '`filePath` IN (\'src/a.ts\')',
        [{ id: 'new' }],
        [{ id: 'old' }],
        vi.fn().mockRejectedValue(markerError),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([addError, restoreError, markerError]);
    expect((caught as Error).message).toContain('marker persistence failed');
  });
});
