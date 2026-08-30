import type { OpenLoreConfig } from '../../types/index.js';
import type { SemanticSearchFn } from '../generator/mapping-generator.js';

/** Resolve the optional code-index retrieval seam shared by CLI and API generation. */
export async function resolveGenerationSemanticSearch(
  analysisPath: string,
  config: OpenLoreConfig,
): Promise<SemanticSearchFn | undefined> {
  const { VectorIndex } = await import('../analyzer/vector-index.js');
  if (!VectorIndex.exists(analysisPath)) return undefined;

  const { resolveEmbedder } = await import('../analyzer/embedder.js');
  const embedder = await resolveEmbedder(config);
  if (!embedder) return undefined;

  return (query, limit) => VectorIndex.search(analysisPath, query, embedder, {
    limit,
    vocabularyExpansion: config.retrieval?.vocabularyExpansion !== false,
  });
}
