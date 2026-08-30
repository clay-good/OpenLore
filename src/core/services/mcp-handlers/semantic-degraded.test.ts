import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const vector = vi.hoisted(() => ({
  exists: vi.fn().mockReturnValue(true),
  search: vi.fn(),
  degradationNotice: vi.fn().mockReturnValue('Index degraded — re-run "openlore analyze".'),
}));
const textSearch = vi.hoisted(() => vi.fn());

vi.mock('../../analyzer/vector-index.js', () => ({ VectorIndex: vector }));
vi.mock('../../analyzer/text-line-index.js', () => ({
  TextLineIndex: {
    exists: vi.fn().mockReturnValue(true),
    searchText: textSearch,
  },
}));
vi.mock('../../analyzer/embedder.js', () => ({
  resolveEmbedder: vi.fn().mockResolvedValue(null),
  embedderMode: vi.fn().mockReturnValue('remote-semantic'),
  servedRetrievalMode: vi.fn().mockReturnValue('keyword'),
  isKeywordRetrievalMode: vi.fn().mockReturnValue(true),
}));
vi.mock('../config-manager.js', () => ({ readOpenLoreConfig: vi.fn().mockResolvedValue(null) }));
vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
  return {
    ...actual,
    validateDirectory: vi.fn(async (directory: string) => directory),
    loadMappingIndex: vi.fn().mockResolvedValue(null),
    readCachedContext: vi.fn().mockResolvedValue(null),
  };
});

import { handleSearchCode, handleSuggestInsertionPoints } from './semantic.js';

describe('vector-index degradation disclosure', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-degraded-search-'));
    vector.search.mockReset().mockResolvedValue([{
      score: 1,
      matchEvidence: { field: 'symbol', terms: ['a'], tier: 1 },
      record: {
        id: 'src/a.ts::a', name: 'a', filePath: 'src/a.ts', className: '',
        language: 'TypeScript', signature: '', docstring: '', fanIn: 1, fanOut: 0,
        isHub: false, isEntryPoint: false, text: 'a',
      },
    }]);
    textSearch.mockReset().mockResolvedValue([{
      filePath: 'web/index.html', lineNumber: 12, text: 'literal banner', score: 1,
    }]);
  });

  it('discloses degradation through search_code', async () => {
    const result = await handleSearchCode(root, 'a') as Record<string, unknown>;
    expect(result.indexDegraded).toBe('Index degraded — re-run "openlore analyze".');
  });

  it('discloses degradation through suggest_insertion_points', async () => {
    const result = await handleSuggestInsertionPoints(root, 'add a') as Record<string, unknown>;
    expect(result.indexDegraded).toBe('Index degraded — re-run "openlore analyze".');
  });

  it('discloses degradation when search_code falls back to literal text', async () => {
    vector.search.mockResolvedValueOnce([]);
    const result = await handleSearchCode(root, 'literal banner') as Record<string, unknown>;
    expect(result.searchMode).toBe('text_fallback');
    expect(result.indexDegraded).toBe('Index degraded — re-run "openlore analyze".');
  });
});
