/**
 * Embedder resolution — the single provider-selection path shared by every
 * consumer (analyze, watch, orient, search_code, search_specs, generate, view).
 *
 * Kept in its own module (separate from `embedding-service.ts`) so the remote
 * `EmbeddingService` can be unit-mocked without also having to stub this shared
 * logic: `resolveEmbedder` calls the real (or mocked) `EmbeddingService`
 * internally, so a mock of `fromEnv`/`fromConfig` continues to drive it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Embedder } from './embedding-service.js';
import type { OpenLoreConfig } from '../../types/index.js';
import { loadRepositoryVocabulary } from './repo-vocabulary.js';

/** Honest, served retrieval mode — first-class keyword default or a semantic upgrade. */
export type RetrievalMode = 'keyword' | 'keyword+vocabulary' | 'local-semantic' | 'remote-semantic';

export function isKeywordRetrievalMode(mode: RetrievalMode | string): boolean {
  return mode === 'keyword' || mode === 'keyword+vocabulary';
}

// Sidecar filenames, kept in sync with VectorIndex.META_FILE /
// SpecVectorIndex.META_FILE. Referenced as literals (not imported) so this module
// stays decoupled from those classes, which unit tests routinely mock.
const CODE_INDEX_META = 'vector-index-meta.json';
const SPEC_INDEX_META = 'spec-index-meta.json';

/**
 * Resolve the active embedder from environment and config, in priority order:
 *   1. config `embedding.provider: 'local'` → on-device {@link LocalEmbeddingService}
 *      (an explicit, just-written intent — e.g. `openlore embed --local` — wins over
 *      ambient `EMBED_*` env so the command is never silently overridden)
 *   2. `EMBED_*` environment variables (remote OpenAI-compatible endpoint)
 *   3. config remote endpoint (`embedding.baseUrl` + `embedding.model`)
 * Returns null when nothing is configured — the first-class keyword (BM25)
 * default, never an error. Sharing one resolver means the configured provider is
 * honoured identically at build time and query time.
 *
 * Dependencies are imported dynamically (matching the rest of the codebase) so
 * the remote `EmbeddingService` stays unit-mockable via `vi.doMock`.
 */
export async function resolveEmbedder(cfg?: OpenLoreConfig | null): Promise<Embedder | null> {
  // Explicit local provider takes precedence over ambient EMBED_* env: it is a
  // deliberate, written-down choice, and a stale env var must not silently turn a
  // requested local index into a remote one (which would also mismatch dimensions).
  if (cfg?.embedding?.provider === 'local') {
    const { LocalEmbeddingService } = await import('./local-embedding-service.js');
    return LocalEmbeddingService.fromConfig(cfg.embedding);
  }
  const { EmbeddingService } = await import('./embedding-service.js');
  try {
    return EmbeddingService.fromEnv();
  } catch {
    // Falling through is correct when NOTHING is set in the environment — that is the
    // ordinary unconfigured case. But a HALF-configured environment is an operator
    // mistake, not a preference: EMBED_BASE_URL alone makes `fromEnv` throw, and
    // silently using BM25 left the operator staring at a variable they had demonstrably
    // set, with no output explaining why it did nothing. The message names the
    // misconfiguration, NOT a degraded index: the keyword index is a first-class default
    // (spec `config` / KeywordIndexIsAFirstClassDefaultNotADegradedFallback), so it must
    // never be framed as a fallback.
    const missing = !process.env.EMBED_BASE_URL
      ? 'EMBED_BASE_URL'
      : !process.env.EMBED_MODEL
        ? 'EMBED_MODEL'
        : null;
    // Exactly one of the pair supplied is the half-configured case, in EITHER direction.
    if (missing && (process.env.EMBED_BASE_URL || process.env.EMBED_MODEL)) {
      const { logger } = await import('../../utils/logger.js');
      logger.warning(
        `${missing} is not set — a remote embedding endpoint needs both EMBED_BASE_URL and ` +
          'EMBED_MODEL. Using the keyword (BM25) index.',
      );
    }
  }
  // Remote (or unconfigured): fromConfig returns null when no remote endpoint
  // is set, which is the first-class keyword default.
  return cfg ? EmbeddingService.fromConfig(cfg) : null;
}

/**
 * The retrieval mode implied by the active embedder: `keyword` when there is no
 * embedder, otherwise `local-semantic` / `remote-semantic` per its origin
 * (local-provider model names are prefixed `local:`). Used for honest, low-noise
 * mode reporting in query handlers and CLI summaries.
 */
export function embedderMode(embedSvc: Embedder | null | undefined): RetrievalMode {
  if (!embedSvc) return 'keyword';
  return String(embedSvc.modelName ?? '').startsWith('local:') ? 'local-semantic' : 'remote-semantic';
}

/** True unless the index sidecar explicitly records `hasEmbeddings:false`. Mirrors
 * the search() routing source of truth (a missing/legacy sidecar ⇒ embeddings present). */
function indexHasVectors(metaPath: string): boolean {
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { hasEmbeddings?: boolean };
    return meta.hasEmbeddings !== false;
  } catch {
    return true;
  }
}

/**
 * The retrieval mode actually SERVED for a query — honest about what the index can
 * do, not just what is configured. Returns `keyword` whenever no embedder is
 * resolved OR the on-disk index has no vectors (e.g. it was built keyword-only, or
 * a local build fell back after a missing optional dependency), even if config
 * still names a semantic provider. `kind` selects which index sidecar to consult.
 */
export function servedRetrievalMode(
  embedSvc: Embedder | null | undefined,
  outputDir: string,
  kind: 'code' | 'spec' = 'code',
  vocabularyExpansion = true,
): RetrievalMode {
  const keywordMode = (): RetrievalMode => vocabularyExpansion
    && (loadRepositoryVocabulary(outputDir)?.entries.length ?? 0) > 0
    ? 'keyword+vocabulary'
    : 'keyword';
  if (!embedSvc) return keywordMode();
  const metaFile = kind === 'spec' ? SPEC_INDEX_META : CODE_INDEX_META;
  if (!indexHasVectors(join(outputDir, metaFile))) return keywordMode();
  return embedderMode(embedSvc);
}
