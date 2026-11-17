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

import { existsSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Embedder } from './embedding-service.js';
import type { EmbeddingConfig } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { isUserConfiguredValue } from '../../utils/config-layers.js';

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
  if (LOCAL_MODEL_ALLOWLIST.has(configValue) || isUserConfiguredValue('embedding.model', configValue)) return configValue;
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
type FeatureExtractor = ((
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<FeatureExtractionTensor>) & { tokenizer?: { model_max_length?: number } };

/**
 * Tokens the model reads per text. all-MiniLM-L6-v2 was trained on, and its model card
 * documents, 256 word pieces; its tokenizer config says 512, which spent about a third of a
 * bulk build attending to input the model was never trained to read (the 6% of functions over
 * 256 tokens). Applied to every session, the pool's included, so vectors stay comparable.
 */
export const LOCAL_MODEL_MAX_TOKENS = 256;
interface TransformersModule {
  pipeline: (task: 'feature-extraction', model: string, opts?: object) => Promise<FeatureExtractor>;
  env: { cacheDir?: string; allowLocalModels?: boolean };
}

const sharedServices = new Map<string, LocalEmbeddingService>();

export class LocalEmbeddingService implements Embedder {
  private readonly model: string;
  private readonly batchSize: number;
  /** Lazily-initialised, memoised extractor (model loads once per process). */
  private extractorPromise: Promise<FeatureExtractor> | null = null;

  /**
   * The model reads at most 512 tokens and truncates the rest, so characters past what fills
   * that window change nothing but tokenizer time. A code token covers well under 16 characters,
   * so this cap is always past the window and the vectors are unchanged.
   */
  private static readonly MAX_CHARS_PER_TEXT = 8192;

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
    return LocalEmbeddingService.shared(resolveTrustedLocalModel(cfg.model), cfg.batchSize ?? 64);
  }

  /**
   * One instance per model for the life of the process. The loaded model is held by the
   * instance, so a fresh one per query re-created the ONNX session on every orient and search
   * in a long-lived server.
   */
  static shared(model: string = DEFAULT_LOCAL_MODEL, batchSize = 64): LocalEmbeddingService {
    const key = `${model}\n${batchSize}`;
    let service = sharedServices.get(key);
    if (!service) {
      service = new LocalEmbeddingService(model, batchSize);
      sharedServices.set(key, service);
    }
    return service;
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
        // fp32 named explicitly so the pool's workers (local-embedding-worker.ts) load the same
        // weights: vectors from both must be interchangeable in one index.
        const extractor = await mod.pipeline('feature-extraction', this.model, { dtype: 'fp32' });
        // An own property: the library exposes this as a getter over its tokenizer config.
        if (extractor.tokenizer) Object.defineProperty(extractor.tokenizer, 'model_max_length', { value: LOCAL_MODEL_MAX_TOKENS });
        return extractor;
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
    const capped = texts.map(t =>
      t.length > LocalEmbeddingService.MAX_CHARS_PER_TEXT ? t.slice(0, LocalEmbeddingService.MAX_CHARS_PER_TEXT) : t);
    // Batches of similar length: each batch is padded to its longest text, and in source order
    // nearly every batch held one long function, so all of it ran at full length. Sorting gave
    // about 5x on this repository's 9,041 texts with bit-identical vectors.
    const order = capped.map((_, index) => index).sort((a, b) => capped[a].length - capped[b].length);
    const batches: number[][] = [];
    for (let i = 0; i < order.length; i += this.batchSize) batches.push(order.slice(i, i + this.batchSize));

    const results = new Array<number[]>(texts.length);
    const store = (batch: number[], vectors: number[][]): void => {
      batch.forEach((index, k) => { results[index] = vectors[k]; });
    };
    const remaining = texts.length >= PARALLEL_MIN_TEXTS
      ? await embedInWorkers(this.model, batches, capped, store)
      : batches;
    if (remaining.length > 0) {
      const extractor = await this.getExtractor();
      for (const batch of remaining) {
        store(batch, (await extractor(batch.map(index => capped[index]), { pooling: 'mean', normalize: true })).tolist());
      }
    }
    return results;
  }

}

/** Below this many texts a call stays on this thread: queries and watcher updates are small. */
const PARALLEL_MIN_TEXTS = 512;
/** Threads per worker session; a few workers of two threads beat one session of many. */
const THREADS_PER_WORKER = 2;
/** Bounded: each worker holds its own copy of the model (about 100 MB). */
const MAX_WORKERS = 4;

/**
 * Embed `batches` across a small pool of worker threads, one ONNX session each. Returns the
 * batches it did not finish, for the caller to run on this thread: no built worker beside this
 * module (running from TypeScript source), a worker that failed to start, or one that failed
 * mid-run. Never throws.
 */
async function embedInWorkers(
  model: string,
  batches: number[][],
  texts: string[],
  store: (batch: number[], vectors: number[][]) => void,
): Promise<number[][]> {
  const workerPath = fileURLToPath(new URL('./local-embedding-worker.js', import.meta.url));
  // Leave a core for the rest of the machine; the background pass also runs at low priority.
  const count = Math.min(MAX_WORKERS, Math.floor((availableParallelism() - 1) / THREADS_PER_WORKER), batches.length);
  if (count < 2 || !existsSync(workerPath)) return batches;

  const pending = [...batches];
  const failed: number[][] = [];
  const runWorker = (): Promise<void> => new Promise(resolve => {
    let worker: Worker;
    try {
      worker = new Worker(workerPath, {
        // Not the parent's flags: `-e`/`--input-type` and loader hooks are meaningless to a worker
        // that only imports this module, and one of them made every worker fail to start.
        execArgv: [],
        workerData: { model, cacheDir: LOCAL_MODEL_CACHE_DIR, threads: THREADS_PER_WORKER, maxTokens: LOCAL_MODEL_MAX_TOKENS },
      });
    } catch {
      resolve();
      return;
    }
    let current: number[] | undefined;
    const finish = (): void => {
      if (current) failed.push(current);
      current = undefined;
      // Resolved only once the worker is gone: an ONNX session still tearing down when the
      // process exits aborts it natively (libc++ "recursive_mutex lock failed").
      worker.terminate().then(() => resolve(), () => resolve());
    };
    const next = (): void => {
      current = pending.shift();
      if (!current) return finish();
      worker.postMessage(current.map(index => texts[index]));
    };
    worker.on('message', (message: { ready?: true; vectors?: number[][]; error?: string }) => {
      if (message.error || (!message.ready && !message.vectors)) return finish();
      if (message.vectors && current) store(current, message.vectors);
      current = undefined;
      next();
    });
    worker.once('error', finish);
    worker.once('exit', () => { if (current) finish(); else resolve(); });
  });
  await Promise.all(Array.from({ length: count }, runWorker));
  return [...failed, ...pending];
}
