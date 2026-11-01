/**
 * One worker of the local embedding pool (see `embedInWorkers` in local-embedding-service.ts).
 *
 * Loads the model the parent already resolved and trusted, then embeds the batches it is sent.
 * Each worker runs its own ONNX session with a small thread count, so a bulk build uses several
 * cores where one session left most of them idle.
 */

import { parentPort, workerData } from 'node:worker_threads';

interface WorkerInput { model: string; cacheDir: string; threads: number; maxTokens: number }
interface FeatureExtractor {
  (texts: string[], opts: { pooling: 'mean'; normalize: boolean }): Promise<{ tolist(): number[][] }>;
  tokenizer?: { model_max_length?: number };
}
interface TransformersModule {
  pipeline: (task: 'feature-extraction', model: string, opts: object) => Promise<FeatureExtractor>;
  env: { cacheDir?: string; allowLocalModels?: boolean };
}

const { model, cacheDir, threads, maxTokens } = workerData as WorkerInput;
const port = parentPort;

async function start(): Promise<void> {
  if (!port) return;
  const specifier = '@huggingface/transformers';
  const mod = (await import(specifier)) as unknown as TransformersModule;
  mod.env.cacheDir = cacheDir;
  mod.env.allowLocalModels = false;
  const extractor = await mod.pipeline('feature-extraction', model, {
    dtype: 'fp32',
    session_options: { intraOpNumThreads: threads },
  });
  // An own property: the library exposes this as a getter over its tokenizer config.
  if (extractor.tokenizer) Object.defineProperty(extractor.tokenizer, 'model_max_length', { value: maxTokens });
  port.on('message', (texts: string[]) => {
    extractor(texts, { pooling: 'mean', normalize: true })
      .then(out => port.postMessage({ vectors: out.tolist() }))
      .catch((error: unknown) => port.postMessage({ error: String(error) }));
  });
  port.postMessage({ ready: true });
}

start().catch((error: unknown) => port?.postMessage({ error: String(error) }));
