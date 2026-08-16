import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FunctionNode } from './call-graph.js';

const beforeMetaWrite = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));

vi.mock('../decisions/atomic-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../decisions/atomic-store.js')>();
  return {
    ...actual,
    atomicWriteFile: async (path: string, data: string) => {
      if (path.endsWith('vector-index-meta.json')) await beforeMetaWrite.run?.();
      return actual.atomicWriteFile(path, data);
    },
  };
});

import { VectorIndex, _resetVectorIndexCachesForTesting } from './vector-index.js';

function node(name: string): FunctionNode {
  return {
    id: `src/a.ts::${name}`,
    name,
    filePath: 'src/a.ts',
    language: 'TypeScript',
    isAsync: false,
    startIndex: 0,
    endIndex: 10,
    fanIn: 1,
    fanOut: 0,
  };
}

describe('VectorIndex build publication', () => {
  beforeEach(() => {
    beforeMetaWrite.run = null;
    _resetVectorIndexCachesForTesting();
  });

  it('publishes the replacement BM25 corpus before the metadata commit point', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'openlore-vector-publication-'));
    await VectorIndex.build(outputDir, [node('oldMarker')], [], new Set(), new Set(), null);

    beforeMetaWrite.run = async () => {
      const corpus = JSON.parse(await readFile(
        join(outputDir, 'vector-index', 'bm25-corpus.json'),
        'utf-8',
      )) as { docs: Array<{ id: string }> };
      expect(corpus.docs.map((doc) => doc.id)).toEqual(['src/a.ts::newMarker']);
    };

    await VectorIndex.build(outputDir, [node('newMarker')], [], new Set(), new Set(), null);
  });
});
