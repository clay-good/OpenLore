import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGenerationSemanticSearch } from './generation-semantic-search.js';
import { VectorIndex } from '../analyzer/vector-index.js';
import { resolveEmbedder } from '../analyzer/embedder.js';

vi.mock('../analyzer/vector-index.js', () => ({
  VectorIndex: { exists: vi.fn(), search: vi.fn() },
}));
vi.mock('../analyzer/embedder.js', () => ({ resolveEmbedder: vi.fn() }));

describe('resolveGenerationSemanticSearch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns no seam when the selected analysis directory has no vector index', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(false);

    await expect(resolveGenerationSemanticSearch('/custom/analysis', {} as never)).resolves.toBeUndefined();

    expect(VectorIndex.exists).toHaveBeenCalledWith('/custom/analysis');
    expect(resolveEmbedder).not.toHaveBeenCalled();
  });

  it('binds queries to the selected analysis directory and resolved embedder', async () => {
    const embedder = { modelName: 'test' } as never;
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(resolveEmbedder).mockResolvedValue(embedder);
    vi.mocked(VectorIndex.search).mockResolvedValue([]);

    const search = await resolveGenerationSemanticSearch('/custom/analysis', {} as never);
    await search?.('authentication', 7);

    expect(VectorIndex.search).toHaveBeenCalledWith(
      '/custom/analysis', 'authentication', embedder, { limit: 7, vocabularyExpansion: true },
    );
  });
});
