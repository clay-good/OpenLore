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

/**
 * Pinned default model: all-MiniLM-L6-v2 (~22M params, 384-dim), the standard
 * small, CPU-runnable sentence embedder. Pre-quantized ONNX weights (~23 MB) are
 * fetched once and cached. Pinned so results are reproducible across machines.
 */
export const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Where downloaded model weights are cached — shared across repositories. */
export const LOCAL_MODEL_CACHE_DIR = join(homedir(), '.openlore', 'models');

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

  static fromConfig(cfg: EmbeddingConfig): LocalEmbeddingService {
    return new LocalEmbeddingService(cfg.model || DEFAULT_LOCAL_MODEL, cfg.batchSize ?? 64);
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
