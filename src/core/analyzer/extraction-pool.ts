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
 *  4. **An unproven silence is never trusted.** The extractors return an empty result
 *     (rather than throwing) when a grammar is unavailable, so a worker whose grammar for
 *     some language failed to load in ITS thread would report every file of that language
 *     as containing nothing — and the merge would read that as "no symbols here". A startup
 *     probe cannot close this (it proves one grammar; the other ~20 load lazily per thread),
 *     so the pool re-checks an empty result on the main thread until that worker has PROVEN
 *     it can extract that language. See {@link runPooled}.
 *  5. **Nothing here writes to stdout.** `openlore mcp` speaks JSON-RPC over stdout, and
 *     `build()` runs inside it. Workers keep their stdout off the parent's, relay their
 *     logging as messages, and the lane's own disclosure is returned on the build result
 *     for the CLI to render — never logged from the builder.
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
  EXTRACTION_POOL_REQUEST_TIMEOUT_MS,
  EXTRACTION_POOL_TERMINATE_TIMEOUT_MS,
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
  | 'pool-saturated'
  | 'worker-entry-unresolved'
  | 'pool-unavailable';

/** What lane Pass 1 actually ran on, and what (if anything) degraded. */
export interface ExtractionLaneDisclosure {
  lane: 'pooled' | 'serial';
  /**
   * Workers that passed the startup probe and accepted work (0 on the serial lane).
   * Counts workers that ever came up, not workers still alive at the end — a worker that
   * died mid-run is still counted here, and its files appear in `workerFallbackFiles`.
   */
  poolSize: number;
  /** Present only on the serial lane. */
  serialReason?: SerialLaneReason;
  /**
   * Files whose worker died mid-extraction and which were re-extracted on the main
   * thread. Non-empty means the pool degraded but the facts are still whole.
   */
  workerFallbackFiles: string[];
  /**
   * Files a worker reported as containing NOTHING where the main thread then found real
   * facts — a worker-local extraction defect (typically a grammar that loaded on the main
   * thread but not in that thread). The facts are whole because the main-thread result is
   * the one that is used, but this is a genuine defect and is disclosed loudly.
   */
  laneDefectFiles: string[];
  /**
   * How many worker answers were re-checked on the main thread because that worker had not
   * yet proven it can extract that language — an empty result, or a throw. Routine, not a
   * degradation: the cost of never trusting an unproven worker. See {@link runPooled}.
   */
  unprovenRechecks: number;
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

/** Caller-side control over the Pass-1 lane. Production passes none of these. */
export interface ExtractionLaneOptions {
  /** Test-only: drive a stub lane whose completion order and failures are deterministic. */
  workerFactory?: ExtractionWorkerFactory;
  /** Test-only: pin the worker count, bypassing the core/file-count/process-budget sizing. */
  poolSize?: number;
}

/** Handed to a worker at construction. */
export interface ExtractionWorkerData {
  /**
   * The language the worker should prove it can parse before accepting work. Chosen from
   * the build's own files so the probe never gates on a grammar this repo does not use —
   * every grammar is an optional dependency. Absent, or a language with no probe snippet,
   * means no startup probe: the per-language unproven-silence guard still covers it.
   */
  probeLanguage?: string;
}

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
 * Extraction workers alive across THIS PROCESS, not this build.
 *
 * Pool size is decided per `build()`, but the resident cost is per process: each worker
 * holds its own tree-sitter parsers and grammar handles, so a pool of 8 costs a few hundred
 * MB. `openlore mcp` runs builds concurrently — a background self-heal rebuild alongside a
 * tool-call build — and without a process-wide budget each would independently plan a full
 * pool, doubling the isolate count on the same cores. This is the ceiling that makes the
 * per-build sizing safe to compose.
 */
let liveWorkers = 0;

/** Workers this process may still start right now. */
function remainingWorkerBudget(): number {
  return Math.max(0, EXTRACTION_POOL_MAX - liveWorkers);
}

/**
 * Sticky "workers do not work here". Set once a pool comes up with zero healthy workers for
 * a DETERMINISTIC reason — every worker refused to spawn, or reported itself unhealthy.
 * Without it, every later build in a long-lived process would re-pay the startup cost to
 * learn what this one already knows. A pool that came up empty only because its workers ran
 * out of time does NOT set it: that is a transient load spike, and permanently dropping the
 * daemon to the serial lane over one bad moment would be worse than re-trying.
 */
let workersProvenUnavailable = false;

/**
 * How many workers Pass 1 should use for `fileCount` files, or `0` for the serial lane.
 * One core is left for the main thread (which merges results and runs Pass 2+), and the
 * process-wide budget is honored so concurrent builds cannot multiply the isolate count.
 */
export function plannedPoolSize(fileCount: number): number {
  if (fileCount < EXTRACTION_POOL_MIN_FILES) return 0;
  const cores = availableParallelism();
  if (cores < 3) return 0;
  return Math.min(cores - 1, remainingWorkerBudget(), fileCount);
}

/** Why `plannedPoolSize` returned 0 — for disclosure only. */
function serialReasonFor(fileCount: number): SerialLaneReason {
  if (fileCount < EXTRACTION_POOL_MIN_FILES) return 'too-few-files';
  if (availableParallelism() < 3) return 'insufficient-cores';
  return 'pool-saturated';
}

/** Test-only: forget the sticky unavailability and the live-worker count. */
export function __resetExtractionPoolStateForTests(): void {
  liveWorkers = 0;
  workersProvenUnavailable = false;
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
  isEmptyResult: (value: T | undefined) => boolean,
  opts: ExtractionLaneOptions = {},
): Promise<{ outcomes: Array<ExtractOutcome<T>>; disclosure: ExtractionLaneDisclosure }> {
  const serial = async (reason: SerialLaneReason): Promise<{
    outcomes: Array<ExtractOutcome<T>>;
    disclosure: ExtractionLaneDisclosure;
  }> => {
    const outcomes: Array<ExtractOutcome<T>> = [];
    for (const file of files) outcomes.push(await runSerial(file, serialExtract));
    return {
      outcomes,
      disclosure: {
        lane: 'serial', poolSize: 0, serialReason: reason,
        workerFallbackFiles: [], laneDefectFiles: [], unprovenRechecks: 0,
      },
    };
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
    if (workersProvenUnavailable) return serial('pool-unavailable');
    const entry = resolveWorkerEntry();
    if (!entry) return serial('worker-entry-unresolved');
    // Probe with a language this build actually contains: every grammar is an OPTIONAL
    // dependency, so probing a language the repo does not use could disable the pool over
    // a grammar the build would never have asked for.
    const probeLanguage = dominantLanguage(files);
    factory = () => createNodeWorker(entry, probeLanguage);
  }

  const pooled = await runPooled(files, factory, size, serialExtract, isEmptyResult);
  if (!pooled.disclosure) {
    // Zero healthy workers. Remember it only when the cause was deterministic — see
    // `workersProvenUnavailable`.
    if (!explicitFactory && pooled.deterministicFailure) workersProvenUnavailable = true;
    return serial('pool-unavailable');
  }
  return { outcomes: pooled.outcomes!, disclosure: pooled.disclosure };
}

/** The language most of this build's files are written in — the one worth probing. */
function dominantLanguage(files: ExtractionFile[]): string | undefined {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.language, (counts.get(f.language) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  // Ties break on language name so the probe choice is deterministic for a given input.
  for (const [language, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) { best = language; bestCount = count; }
  }
  return best;
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
 * Spawn a real `worker_threads` worker for the resolved entry.
 *
 * `stdout: true` keeps the worker's stdout OFF the parent's stdout. That is not tidiness:
 * `openlore mcp` speaks JSON-RPC over stdout, so a stray write from a worker would corrupt
 * the protocol frame. The captured stream is drained so it cannot apply backpressure, and
 * the worker's own logging is relayed to the parent as messages (see the `log` response)
 * — which is also what keeps a per-thread warning from being printed once per worker.
 * stderr stays inherited: it is not a protocol channel, and losing a crash trace is worse
 * than printing one.
 */
function createNodeWorker(entry: ResolvedWorkerEntry, probeLanguage?: string): ExtractionWorkerHandle {
  const worker = new Worker(entry.specifier, {
    ...(entry.execArgv ? { execArgv: entry.execArgv } : {}),
    workerData: { probeLanguage } satisfies ExtractionWorkerData,
    stdout: true,
  });
  worker.stdout.resume();
  return worker as unknown as ExtractionWorkerHandle;
}

/** Why a slot was left for the main thread to fill. */
type UnfilledReason = 'worker-died' | 'unproven';

/**
 * Drive the pool. Returns `undefined` when not a single worker could be brought up
 * healthy (the caller then runs the serial lane wholesale, disclosed).
 *
 * ## Never trust an unproven silence
 *
 * The extractors report an unavailable grammar by returning an EMPTY result, not by
 * throwing (`call-graph.ts` — `if (!r) return { nodes: [], rawEdges: [], cfg: new Map() }`).
 * A worker whose grammar for some language failed to load in ITS thread would therefore
 * report every file of that language as containing nothing, and the merge would treat the
 * missing symbols as genuinely absent — the exact silent loss the parse-health work exists
 * to prevent. The startup probe cannot close this: it proves one grammar, and each of the
 * ~20 others loads lazily and independently in each thread.
 *
 * So the pool tracks, per worker, which languages that worker has PROVEN it can extract —
 * proven by having returned a non-empty result for that language at least once. An empty
 * result for a language a worker has not yet proven is not trusted: the slot is left for
 * the main thread, which is the reference implementation. Once a worker proves a language,
 * its empty results for that language are trusted, so the cost is bounded by the files that
 * arrive before each worker's first real result per language — near zero on a healthy run,
 * and full main-thread coverage exactly when a worker is broken. If the main thread then
 * finds facts where the worker found none, that is a real defect and is disclosed loudly.
 */
async function runPooled<T>(
  files: ExtractionFile[],
  factory: ExtractionWorkerFactory,
  size: number,
  serialExtract: (file: ExtractionFile) => Promise<T | undefined>,
  isEmptyResult: (value: T | undefined) => boolean,
): Promise<{
  outcomes?: Array<ExtractOutcome<T>>;
  disclosure?: ExtractionLaneDisclosure;
  /** Set when no worker came up AND the cause was deterministic rather than a timeout. */
  deterministicFailure?: boolean;
}> {
  const slots: Array<ExtractOutcome<T> | undefined> = new Array(files.length).fill(undefined);
  const unfilled: Array<UnfilledReason | undefined> = new Array(files.length).fill(undefined);
  /** Next unclaimed input index. Shared across workers; each claims by post-increment. */
  let cursor = 0;
  let started = 0;
  /** A worker was dropped because it ran out of time, not because it refused to work. */
  let sawStartupTimeout = false;
  /** Grammar-unavailable warnings relayed from workers, deduped across the pool. */
  const relayedWarnings = new Set<string>();

  const runOne = async (): Promise<void> => {
    let worker: ExtractionWorkerHandle;
    try {
      worker = factory();
    } catch {
      return; // this worker never existed; siblings (or the serial fallback) cover its share
    }
    // Counted from spawn to termination, so a concurrent build in the same process sees
    // this worker in the budget even while it is still starting up.
    liveWorkers++;
    let released = false;
    const release = (): void => { if (!released) { released = true; liveWorkers--; } };

    let dead = false;
    let deadReason: Error | undefined;
    let pending: { id: number; resolve: (v: ExtractOutcome<T>) => void; reject: (e: Error) => void } | undefined;
    /** Resolves on `ready`, rejects if the worker dies or reports itself unhealthy first. */
    let settleStartup: ((err?: Error) => void) | undefined;
    /** Languages this worker has demonstrably extracted (see the doc comment above). */
    const proven = new Set<string>();

    const die = (err: Error): void => {
      if (dead) return;
      dead = true;
      deadReason = err;
      settleStartup?.(err);
      const p = pending;
      pending = undefined;
      p?.reject(err);
    };

    try {
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
        if (!p) return; // nothing in flight — a duplicate/late reply, safely ignored
        if (p.id !== msg.id) {
          // A reply that does not match the one outstanding request means this worker is
          // off-protocol. Retiring it hands its file to the main thread; ignoring it would
          // leave `pending` armed forever and hang the whole pass.
          die(new Error(`extraction worker replied for #${msg.id} while #${p.id} was in flight`));
          return;
        }
        pending = undefined;
        if (msg.type === 'result') p.resolve({ status: 'ok', value: msg.value as T | undefined });
        else p.resolve({ status: 'error', error: new Error(msg.message) });
      });
      worker.on('error', (err) => die(err instanceof Error ? err : new Error(String(err))));
      worker.on('exit', () => die(deadReason ?? new Error('extraction worker exited')));
    } catch (err) {
      await terminateQuietly(worker);
      release();
      throw err;
    }

    // Wait for the startup probe before handing this worker any real file. A worker that
    // neither reports ready nor dies (a hung module load / grammar dlopen) must not hang
    // analyze, so startup is bounded — a timed-out worker is simply dropped from the pool.
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sawStartupTimeout = true;
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
      release();
      return;
    }
    started++;

    try {
      while (!dead) {
        const index = cursor;
        if (index >= files.length) break;
        cursor = index + 1;
        const file = files[index];
        let outcome: ExtractOutcome<T>;
        try {
          outcome = await requestExtract<T>(worker, index, file, (p) => { pending = p; });
        } catch {
          // The worker died (or wedged past its deadline) holding this file. Leave the slot
          // for the main thread and stop feeding this worker.
          unfilled[index] = 'worker-died';
          break;
        }
        // A worker that cannot handle a language reports it two ways, and BOTH are
        // indistinguishable from a real answer: an empty result (the core binding failed to
        // load) or a throw (the per-language grammar `import` failed — those loads are not
        // wrapped). Neither is trusted until this worker has actually produced facts for the
        // language; until then the main thread decides.
        const producedFacts = outcome.status === 'ok'
          && outcome.value !== undefined
          && !isEmptyResult(outcome.value);
        if (producedFacts) {
          proven.add(file.language);
        } else if (outcome.status !== 'ok' || isEmptyResult(outcome.value)) {
          if (!proven.has(file.language)) {
            unfilled[index] = 'unproven';
            continue;
          }
        }
        slots[index] = outcome;
      }
    } finally {
      if (!dead) {
        try { worker.postMessage({ type: 'shutdown' } satisfies ExtractionRequest); } catch { /* already gone */ }
      }
      await terminateQuietly(worker);
      release();
    }
  };

  // A worker lane must never be able to reject the whole pass: anything unexpected inside
  // `runOne` costs that worker's share, which the main-thread fallback below picks up.
  await Promise.all(Array.from({ length: size }, () => runOne().catch(() => undefined)));

  // No worker survived startup. Distinguish "this environment cannot run workers" from
  // "everything was slow just now" — only the former is worth remembering for the process.
  if (started === 0) return { deterministicFailure: !sawStartupTimeout };

  // Fill every slot the pool left, on the main thread, in input order.
  const workerFallbackFiles: string[] = [];
  const laneDefectFiles: string[] = [];
  let unprovenRechecks = 0;
  for (let i = 0; i < files.length; i++) {
    if (slots[i] !== undefined) continue;
    // A slot with no recorded reason belongs to a file no worker ever claimed (every
    // worker died first) — the same situation as a worker dying while holding it.
    const reason = unfilled[i] ?? 'worker-died';
    const outcome = await runSerial(files[i], serialExtract);
    if (reason === 'worker-died') {
      workerFallbackFiles.push(files[i].path);
    } else {
      unprovenRechecks++;
      // The worker reported nothing (empty, or a throw) and the main thread found real
      // facts: a worker-local extraction defect, not an empty or unparseable file.
      const mainThreadFoundFacts = outcome.status === 'ok'
        && outcome.value !== undefined
        && !isEmptyResult(outcome.value);
      if (mainThreadFoundFacts) laneDefectFiles.push(files[i].path);
    }
    slots[i] = outcome;
  }

  return {
    outcomes: slots as Array<ExtractOutcome<T>>,
    disclosure: { lane: 'pooled', poolSize: started, workerFallbackFiles, laneDefectFiles, unprovenRechecks },
  };
}

/**
 * Send one file to a worker and await its reply, bounded by a deadline. The serial lane has
 * no such bound — but it also cannot go silent: a wedged worker emits neither a reply nor
 * an `exit`, so without a deadline the whole pass would wait on it forever while its
 * siblings finish and the process looks idle. On timeout the worker is retired and its file
 * falls to the main thread.
 */
function requestExtract<T>(
  worker: ExtractionWorkerHandle,
  index: number,
  file: ExtractionFile,
  arm: (pending: { id: number; resolve: (v: ExtractOutcome<T>) => void; reject: (e: Error) => void }) => void,
): Promise<ExtractOutcome<T>> {
  return new Promise<ExtractOutcome<T>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`extraction worker did not answer for ${file.path} within ${EXTRACTION_POOL_REQUEST_TIMEOUT_MS}ms`));
    }, EXTRACTION_POOL_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const settle = <R>(fn: (v: R) => void) => (v: R): void => { clearTimeout(timer); fn(v); };
    arm({ id: index, resolve: settle(resolve), reject: settle(reject) });
    worker.postMessage({ type: 'extract', id: index, file } satisfies ExtractionRequest);
  });
}

/**
 * Ask a worker to stop, and do not wait indefinitely for it to comply.
 *
 * `Worker.terminate()` resolves when the thread actually exits, and V8 can only interrupt a
 * thread at a JS boundary — so a thread blocked inside a synchronous native call (a hung
 * grammar `dlopen`, a pathological parse) may never exit. Awaiting that unbounded would
 * re-create the exact hang the startup and request deadlines exist to prevent, and would
 * strand this worker's process budget forever. So the wait is bounded; past the bound the
 * slot is returned even though the thread may still be resident. That is the honest trade:
 * a lingering thread is a leak the OS reclaims at exit, an unresolvable await is a hang.
 */
async function terminateQuietly(worker: ExtractionWorkerHandle): Promise<void> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, EXTRACTION_POOL_TERMINATE_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([Promise.resolve(worker.terminate()).then(() => undefined), bounded]);
    if (timer) clearTimeout(timer);
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
    const parts: string[] = [];
    // A worker that reported nothing (an empty result OR a throw) where the main thread
    // found facts is the one outcome meaning something was actually WRONG with a worker,
    // so it leads. Both outcomes are reported when both happened.
    if (d.laneDefectFiles.length > 0) {
      parts.push(
        `extraction worker reported no symbols for ${d.laneDefectFiles.length} file(s) that do contain symbols `
        + `(e.g. ${d.laneDefectFiles[0]}); the main-thread result was used. Set OPENLORE_NO_WORKERS=1 if this recurs`,
      );
    }
    if (d.workerFallbackFiles.length > 0) {
      parts.push(`${d.workerFallbackFiles.length} file(s) re-extracted on the main thread after a worker failed`);
    }
    return parts.length > 0 ? parts.join('; ') : undefined;
  }
  // A small build, a small machine, a caller opting out, or an explicit env opt-out are
  // ordinary choices, not degradations — warning about them would be noise on every run.
  if (
    d.serialReason === 'too-few-files' ||
    d.serialReason === 'insufficient-cores' ||
    d.serialReason === 'pool-saturated' ||
    d.serialReason === 'disabled-by-env'
  ) return undefined;
  return `extraction ran on the serial lane (${d.serialReason}) — analysis is complete but slower`;
}
