/**
 * Pass-1 extraction worker pool (change: optimize-parallel-extraction-pool).
 *
 * Per-file tree-sitter parsing and fact extraction is the dominant cost of
 * `openlore analyze`, and it is embarrassingly parallel: no file's extraction reads
 * another file's state. This module runs that pass on a fixed-size pool of
 * `worker_threads` while preserving the one property the rest of the pipeline
 * depends on — **input order**.
 *
 * Determinism rules (the reason this module exists rather than a bare `Promise.all`):
 *
 *  1. **Index-keyed slots, never completion order.** Each file is dispatched with its
 *     input index and its result is written to `outcomes[index]`. Completion order is
 *     free to vary with core contention; the array the caller merges from is always in
 *     input order, so every downstream pass sees byte-identical input to the serial lane.
 *  2. **No extraction logic lives here.** Workers call the same `dispatchFileExtract`
 *     the serial lane calls (via {@link ./extraction-worker.ts}), and the serial lane
 *     stays the reference implementation — the caller passes it in as `serialExtract`,
 *     which is also the fallback executor.
 *  3. **Fail-soft, never fail-different.** A worker that dies mid-file leaves its slot
 *     empty and the file is re-extracted on the main thread. A worker that cannot start,
 *     or fails its startup health probe, disables the lane wholesale. An extractor that
 *     *throws inside* a worker is reported as an error for that file — exactly what the
 *     serial lane would record — and is NOT retried, so a deterministic parse failure
 *     costs the same in both lanes.
 *  4. **Silence is disclosed, not assumed benign.** The extractors return an empty result
 *     (rather than throwing) when a grammar is unavailable, so a worker with a broken
 *     grammar load would silently contribute nothing. Two guards close that: a startup
 *     probe that requires a real parse before the worker accepts work, and relaying the
 *     worker's grammar-unavailable warnings to the parent logger.
 *
 * File contents are sent to workers rather than re-read from disk. Deliberate: `build`'s
 * input content is authoritative and is not always what's on disk — HTML pages arrive as
 * inline-script-blanked text, and the incremental path passes in-memory content — so a
 * worker-side re-read would change extracted facts, not just I/O.
 */

import { availableParallelism } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  EXTRACTION_POOL_MAX,
  EXTRACTION_POOL_MIN_FILES,
  EXTRACTION_POOL_STARTUP_TIMEOUT_MS,
} from '../../constants.js';
import { logger } from '../../utils/logger.js';

/** One Pass-1 input record — the same shape `CallGraphBuilder.build` receives. */
export interface ExtractionFile {
  path: string;
  content: string;
  language: string;
}

/**
 * The outcome for one file. `ok` carries the extractor's return value (`undefined` for a
 * language with no extractor); `error` carries whatever the extractor threw, so the caller
 * can record the identical parse-health failure it records on the serial lane.
 */
export type ExtractOutcome<T> =
  | { status: 'ok'; value: T | undefined }
  | { status: 'error'; error: unknown };

/** Why the serial lane ran instead of the pool. */
export type SerialLaneReason =
  | 'disabled-by-env'
  | 'too-few-files'
  | 'insufficient-cores'
  | 'worker-entry-unresolved'
  | 'pool-unavailable';

/** What lane Pass 1 actually ran on, and what (if anything) degraded. */
export interface ExtractionLaneDisclosure {
  lane: 'pooled' | 'serial';
  /** Worker count actually started (0 on the serial lane). */
  poolSize: number;
  /** Present only on the serial lane. */
  serialReason?: SerialLaneReason;
  /**
   * Files whose worker died mid-extraction and which were re-extracted on the main
   * thread. Non-empty means the pool degraded but the facts are still whole.
   */
  workerFallbackFiles: string[];
}

/**
 * The subset of `worker_threads.Worker` the pool uses. Narrow on purpose: tests
 * inject a fake handle to drive completion order and worker death deterministically,
 * without spawning threads.
 */
export interface ExtractionWorkerHandle {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  terminate(): void | Promise<unknown>;
}

/** Creates one worker. Returns the handle, or throws if the worker cannot start. */
export type ExtractionWorkerFactory = () => ExtractionWorkerHandle;

/** Parent → worker. */
export type ExtractionRequest =
  | { type: 'extract'; id: number; file: ExtractionFile }
  | { type: 'shutdown' };

/** Worker → parent. */
export type ExtractionResponse =
  | { type: 'ready' }
  | { type: 'unhealthy'; reason: string }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'failed'; id: number; message: string }
  | { type: 'log'; level: 'warning' | 'debug'; message: string };

/** Set to `1`/`true` to force the serial lane (the documented escape hatch). */
const NO_WORKERS_ENV = 'OPENLORE_NO_WORKERS';

/** Resolved worker entry: the module a worker loads, plus any exec args it needs. */
export interface ResolvedWorkerEntry {
  specifier: URL;
  execArgv?: string[];
}

/**
 * Locate the worker entry module for the current runtime.
 *
 * Compiled (`dist/`) is the production case: the sibling `.js` exists and needs no exec
 * args. Running from TypeScript source (dev, vitest) needs a loader, so the `.ts` sibling
 * is used with `--import tsx` — and only when `tsx` actually resolves. When neither is
 * available the pool is simply not offered; the serial lane covers it.
 */
export function resolveWorkerEntry(): ResolvedWorkerEntry | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, 'extraction-worker.js');
  if (existsSync(compiled)) return { specifier: pathToFileURL(compiled) };
  const source = join(here, 'extraction-worker.ts');
  if (existsSync(source) && canResolveTsx()) {
    return { specifier: pathToFileURL(source), execArgv: ['--import', 'tsx'] };
  }
  return undefined;
}

function canResolveTsx(): boolean {
  try {
    createRequire(import.meta.url).resolve('tsx');
    return true;
  } catch {
    return false;
  }
}

/**
 * How many workers Pass 1 should use for `fileCount` files, or `0` for the serial lane.
 * One core is left for the main thread (which merges results and runs Pass 2+).
 */
export function plannedPoolSize(fileCount: number): number {
  if (fileCount < EXTRACTION_POOL_MIN_FILES) return 0;
  const cores = availableParallelism();
  if (cores < 3) return 0;
  return Math.min(cores - 1, EXTRACTION_POOL_MAX, fileCount);
}

/** Why `plannedPoolSize` returned 0 — for disclosure only. */
function serialReasonFor(fileCount: number): SerialLaneReason {
  if (fileCount < EXTRACTION_POOL_MIN_FILES) return 'too-few-files';
  return 'insufficient-cores';
}

function workersDisabledByEnv(): boolean {
  const v = process.env[NO_WORKERS_ENV];
  return v === '1' || v === 'true';
}

/**
 * Run Pass-1 extraction over `files`, on the worker pool when it is available and worth
 * it, otherwise serially. `serialExtract` is both the reference implementation and the
 * fallback executor — extraction logic never forks between lanes.
 *
 * The returned `outcomes` array is always the same length as `files` and in input order.
 */
export async function extractFilesForPass1<T>(
  files: ExtractionFile[],
  serialExtract: (file: ExtractionFile) => Promise<T | undefined>,
  opts: { workerFactory?: ExtractionWorkerFactory; poolSize?: number } = {},
): Promise<{ outcomes: Array<ExtractOutcome<T>>; disclosure: ExtractionLaneDisclosure }> {
  const serial = async (reason: SerialLaneReason): Promise<{
    outcomes: Array<ExtractOutcome<T>>;
    disclosure: ExtractionLaneDisclosure;
  }> => {
    const outcomes: Array<ExtractOutcome<T>> = [];
    for (const file of files) outcomes.push(await runSerial(file, serialExtract));
    return { outcomes, disclosure: { lane: 'serial', poolSize: 0, serialReason: reason, workerFallbackFiles: [] } };
  };

  // Reasons are checked most-intrinsic first, so the disclosed reason is the one that
  // actually decided the lane: a 6-file build is "too-few-files" whether or not workers
  // are also switched off.
  const size = opts.poolSize ?? plannedPoolSize(files.length);
  if (size <= 0) return serial(serialReasonFor(files.length));

  // `OPENLORE_NO_WORKERS` disables worker THREADS. An explicitly injected factory is not a
  // thread — it is a test lane — so it is honored either way; production never passes one.
  const explicitFactory = opts.workerFactory;
  if (!explicitFactory && workersDisabledByEnv()) return serial('disabled-by-env');

  let factory = explicitFactory;
  if (!factory) {
    const entry = resolveWorkerEntry();
    if (!entry) return serial('worker-entry-unresolved');
    factory = () => createNodeWorker(entry);
  }

  const pooled = await runPooled(files, factory, size, serialExtract);
  if (!pooled) return serial('pool-unavailable');
  return pooled;
}

async function runSerial<T>(
  file: ExtractionFile,
  serialExtract: (file: ExtractionFile) => Promise<T | undefined>,
): Promise<ExtractOutcome<T>> {
  try {
    return { status: 'ok', value: await serialExtract(file) };
  } catch (error) {
    return { status: 'error', error };
  }
}

/**
 * Spawn a real `worker_threads` worker for the resolved entry. stdout/stderr are left
 * inherited (Node's default) so an unexpected write is still visible; the worker routes
 * its own logging through the parent instead (see the `log` message), which is what keeps
 * per-worker warnings from being printed N times.
 */
function createNodeWorker(entry: ResolvedWorkerEntry): ExtractionWorkerHandle {
  return new Worker(entry.specifier, {
    ...(entry.execArgv ? { execArgv: entry.execArgv } : {}),
  }) as unknown as ExtractionWorkerHandle;
}

/**
 * Drive the pool. Returns `undefined` when not a single worker could be brought up
 * healthy (the caller then runs the serial lane wholesale, disclosed).
 */
async function runPooled<T>(
  files: ExtractionFile[],
  factory: ExtractionWorkerFactory,
  size: number,
  serialExtract: (file: ExtractionFile) => Promise<T | undefined>,
): Promise<{ outcomes: Array<ExtractOutcome<T>>; disclosure: ExtractionLaneDisclosure } | undefined> {
  const slots: Array<ExtractOutcome<T> | undefined> = new Array(files.length).fill(undefined);
  /** Next unclaimed input index. Shared across workers; each claims by post-increment. */
  let cursor = 0;
  let started = 0;
  /** Grammar-unavailable warnings relayed from workers, deduped across the pool. */
  const relayedWarnings = new Set<string>();

  const runOne = async (): Promise<void> => {
    let worker: ExtractionWorkerHandle;
    try {
      worker = factory();
    } catch {
      return; // this worker never existed; siblings (or the serial fallback) cover its share
    }

    let dead = false;
    let deadReason: Error | undefined;
    let pending: { id: number; resolve: (v: ExtractOutcome<T>) => void; reject: (e: Error) => void } | undefined;
    /** Resolves on `ready`, rejects if the worker dies or reports itself unhealthy first. */
    let settleStartup: ((err?: Error) => void) | undefined;

    const die = (err: Error): void => {
      if (dead) return;
      dead = true;
      deadReason = err;
      settleStartup?.(err);
      const p = pending;
      pending = undefined;
      p?.reject(err);
    };

    worker.on('message', (raw) => {
      const msg = raw as ExtractionResponse;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        settleStartup?.();
        return;
      }
      if (msg.type === 'unhealthy') {
        die(new Error(`extraction worker unhealthy: ${msg.reason}`));
        return;
      }
      if (msg.type === 'log') {
        if (msg.level === 'warning') {
          if (!relayedWarnings.has(msg.message)) {
            relayedWarnings.add(msg.message);
            logger.warning(msg.message);
          }
        } else {
          logger.debug(msg.message);
        }
        return;
      }
      const p = pending;
      if (!p || p.id !== msg.id) return; // stale/unmatched reply — ignore, the slot stays open
      pending = undefined;
      if (msg.type === 'result') p.resolve({ status: 'ok', value: msg.value as T | undefined });
      else p.resolve({ status: 'error', error: new Error(msg.message) });
    });
    worker.on('error', (err) => die(err instanceof Error ? err : new Error(String(err))));
    worker.on('exit', () => die(deadReason ?? new Error('extraction worker exited')));

    // Wait for the startup probe before handing this worker any real file. A worker that
    // neither reports ready nor dies (a hung module load / grammar dlopen) must not hang
    // analyze, so startup is bounded — a timed-out worker is simply dropped from the pool.
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          settleStartup?.(new Error(`extraction worker did not start within ${EXTRACTION_POOL_STARTUP_TIMEOUT_MS}ms`));
        }, EXTRACTION_POOL_STARTUP_TIMEOUT_MS);
        timer.unref?.();
        settleStartup = (err) => {
          settleStartup = undefined;
          clearTimeout(timer);
          if (err) reject(err); else resolve();
        };
      });
    } catch {
      await terminateQuietly(worker);
      return;
    }
    started++;

    try {
      while (!dead) {
        const index = cursor;
        if (index >= files.length) break;
        cursor = index + 1;
        try {
          slots[index] = await new Promise<ExtractOutcome<T>>((resolve, reject) => {
            pending = { id: index, resolve, reject };
            worker.postMessage({ type: 'extract', id: index, file: files[index] } satisfies ExtractionRequest);
          });
        } catch {
          // The worker died holding this file. Leave the slot empty — the main thread
          // re-extracts it below — and stop feeding this worker.
          break;
        }
      }
    } finally {
      if (!dead) {
        try { worker.postMessage({ type: 'shutdown' } satisfies ExtractionRequest); } catch { /* already gone */ }
      }
      await terminateQuietly(worker);
    }
  };

  // A worker lane must never be able to reject the whole pass: anything unexpected inside
  // `runOne` costs that worker's share, which the main-thread fallback below picks up.
  await Promise.all(Array.from({ length: size }, () => runOne().catch(() => undefined)));

  if (started === 0) return undefined;

  // Any slot the pool did not fill — a worker died holding it, or every worker died
  // before claiming it — is re-extracted on the main thread, in input order.
  const workerFallbackFiles: string[] = [];
  for (let i = 0; i < files.length; i++) {
    if (slots[i] !== undefined) continue;
    workerFallbackFiles.push(files[i].path);
    slots[i] = await runSerial(files[i], serialExtract);
  }

  return {
    outcomes: slots as Array<ExtractOutcome<T>>,
    disclosure: { lane: 'pooled', poolSize: started, workerFallbackFiles },
  };
}

async function terminateQuietly(worker: ExtractionWorkerHandle): Promise<void> {
  try {
    await worker.terminate();
  } catch {
    /* nothing left to terminate */
  }
}

/**
 * One-line disclosure of the lane Pass 1 ran on, or `undefined` when there is nothing to
 * disclose (the pool ran clean, or the serial lane was the ordinary choice). Only genuine
 * degradations speak: a lane that ran as designed says nothing, so a message here always
 * means analysis was slower than it should have been — never that it was less complete.
 */
export function describeExtractionLane(d: ExtractionLaneDisclosure): string | undefined {
  if (d.lane === 'pooled') {
    if (d.workerFallbackFiles.length === 0) return undefined;
    return `extraction pool degraded: ${d.workerFallbackFiles.length} file(s) re-extracted on the main thread after a worker failed`;
  }
  // A small build, a small machine, or an explicit opt-out are ordinary choices, not
  // degradations — warning about them would be noise on every run.
  if (
    d.serialReason === 'too-few-files' ||
    d.serialReason === 'insufficient-cores' ||
    d.serialReason === 'disabled-by-env'
  ) return undefined;
  return `extraction ran on the serial lane (${d.serialReason}) — analysis is complete but slower`;
}
