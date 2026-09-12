/**
 * LocalEmbeddingService
 *
 * A zero-config, on-device embedder. It runs a small, pinned, CPU-only model
 * via the optional `@huggingface/transformers` package (Transformers.js +
 * onnxruntime) — no endpoint, no API key, no network beyond a one-time model
 * download that is cached on disk.
 *
 * It implements the same {@link Embedder} contract as the remote
 * `EmbeddingService`, so `VectorIndex` is agnostic to which one it was handed.
 *
 * The heavy dependency is loaded lazily, the first time `embed()` runs, and is
 * declared as an *optional* dependency: if it is not installed (or failed to
 * build on the platform), `embed()` throws a clear, actionable error instead of
 * breaking the build/install. The first-class keyword (BM25) index never depends
 * on it.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from './embedding-service.js';
import type { EmbeddingConfig } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Pinned default model: all-MiniLM-L6-v2 (~22M params, 384-dim), the standard
 * small, CPU-runnable sentence embedder. Pre-quantized ONNX weights (~23 MB) are
 * fetched once and cached. Pinned so results are reproducible across machines.
 */
export const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Where downloaded model weights are cached — shared across repositories. */
export const LOCAL_MODEL_CACHE_DIR = join(homedir(), '.openlore', 'models');

/**
 * Additional model ids the local provider will load. Small, pinned, CPU-only sentence
 * embedders of the same family as the default — enough to cover the reason someone
 * changes the field at all (a different dimension or a multilingual model).
 */
const LOCAL_MODEL_ALLOWLIST: ReadonlySet<string> = new Set([
  DEFAULT_LOCAL_MODEL,
  'Xenova/all-MiniLM-L12-v2',
  'Xenova/bge-small-en-v1.5',
  'Xenova/gte-small',
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
]);

/** Operator signal for any other model id: set outside the repository. */
export const LOCAL_MODEL_ENV = 'OPENLORE_LOCAL_EMBED_MODEL';

/**
 * Resolve the model id for the local provider, refusing an arbitrary one that came out
 * of the repository's `.openlore/config.json`.
 *
 * `embedding.model` is committed IN the analyzed repo, so on a clone it is
 * attacker-authored — the same premise `repo-config-trust` acts on for
 * `embedding.baseUrl`. The local path is the sharper end of it: this string is a
 * HuggingFace repo id handed to Transformers.js, which downloads it and loads the
 * weights into onnxruntime IN-PROCESS, on the READ path (orient / search_code), not only
 * during `analyze`. `allowLocalModels = false` stops a local filesystem path; it does
 * nothing about a remote repo the clone chose. So a value that is neither allowlisted nor
 * named by the operator's environment is ignored, with the default used instead — the
 * warn-and-ignore shape the rest of the trust boundary uses.
 *
 * `openlore embed --local --model X` writes the field into that same file, so it cannot
 * itself be the consent signal; set `OPENLORE_LOCAL_EMBED_MODEL` for an id outside the
 * allowlist.
 */
export function resolveTrustedLocalModel(configValue: string | undefined): string {
  const operatorValue = process.env[LOCAL_MODEL_ENV]?.trim();
  if (operatorValue) return operatorValue;
  if (!configValue) return DEFAULT_LOCAL_MODEL;
  if (LOCAL_MODEL_ALLOWLIST.has(configValue)) return configValue;
  logger.warning(
    `Ignoring embedding.model "${configValue}" from .openlore/config.json: a repository may ` +
      'not choose which model weights are downloaded and executed in this process. ' +
      `Using ${DEFAULT_LOCAL_MODEL}. Set ${LOCAL_MODEL_ENV} to use it deliberately.`,
  );
  return DEFAULT_LOCAL_MODEL;
}

/** The optional package providing the on-device runtime. */
const TRANSFORMERS_PACKAGE = '@huggingface/transformers';

// Minimal shape of the bits of Transformers.js we use. Kept local so this file
// compiles whether or not the optional dependency is installed.
interface FeatureExtractionTensor {
  tolist(): number[][];
}
type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<FeatureExtractionTensor>;
interface TransformersModule {
  pipeline: (task: 'feature-extraction', model: string) => Promise<FeatureExtractor>;
  env: { cacheDir?: string; allowLocalModels?: boolean };
}

export class LocalEmbeddingService implements Embedder {
  private readonly model: string;
  private readonly batchSize: number;
  /** Lazily-initialised, memoised extractor (model loads once per process). */
  private extractorPromise: Promise<FeatureExtractor> | null = null;

  /** Mirrors EmbeddingService: keep texts under the model's token window. */
  private static readonly MAX_CHARS_PER_TEXT = 24000;

  constructor(model: string = DEFAULT_LOCAL_MODEL, batchSize = 64) {
    this.model = model;
    this.batchSize = batchSize;
  }

  /**
   * Build from repository config. `cfg` comes from `.openlore/config.json`, so the model
   * id passes through {@link resolveTrustedLocalModel} — the constructor stays open for
   * operator-driven callers that pass a model they chose themselves.
   */
  static fromConfig(cfg: EmbeddingConfig): LocalEmbeddingService {
    return new LocalEmbeddingService(resolveTrustedLocalModel(cfg.model), cfg.batchSize ?? 64);
  }

  /** `local:` prefix lets the served retrieval mode be derived from the sidecar. */
  get modelName(): string {
    return `local:${this.model}`;
  }

  private async getExtractor(): Promise<FeatureExtractor> {
    if (this.extractorPromise) return this.extractorPromise;
    this.extractorPromise = (async () => {
      let mod: TransformersModule;
      try {
        // Variable specifier: keep the optional package out of the static module
        // graph so a clean build/typecheck does not require it to be installed.
        const specifier = TRANSFORMERS_PACKAGE;
        mod = (await import(specifier)) as unknown as TransformersModule;
      } catch (err) {
        throw new Error(
          `Local embeddings need the optional "${TRANSFORMERS_PACKAGE}" package, which is not available ` +
            `(${(err as Error).message}). Install it with:\n` +
            `  npm install ${TRANSFORMERS_PACKAGE}\n` +
            `Keyword (BM25) search continues to work without it.`,
          { cause: err }
        );
      }
      // Resolve weights from the on-disk cache or the HF hub; never from an
      // arbitrary local path. One-time download, cached for every later run.
      mod.env.cacheDir = LOCAL_MODEL_CACHE_DIR;
      mod.env.allowLocalModels = false;
      try {
        return await mod.pipeline('feature-extraction', this.model);
      } catch (err) {
        // Distinguish a model-load failure (bad model id, or no network on first
        // fetch) from the package-missing case above, so the surfaced message is
        // actionable. Callers degrade to keyword (BM25) on any throw.
        throw new Error(
          `Could not load the local embedding model "${this.model}" (${(err as Error).message}). ` +
            `Check the model id (--model) and your network for the one-time download. ` +
            `Keyword (BM25) search continues to work without it.`,
          { cause: err }
        );
      }
    })().catch((err) => {
      // Preserve the actionable error for this call, but do not replay a
      // transient loader failure for the lifetime of the service instance.
      this.extractorPromise = null;
      throw err;
    });
    return this.extractorPromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map(t =>
        t.length > LocalEmbeddingService.MAX_CHARS_PER_TEXT
          ? t.slice(0, LocalEmbeddingService.MAX_CHARS_PER_TEXT)
          : t
      );
      const out = await extractor(batch, { pooling: 'mean', normalize: true });
      results.push(...out.tolist());
    }
    return results;
  }
}
