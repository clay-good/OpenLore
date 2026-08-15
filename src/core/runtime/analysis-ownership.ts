/**
 * Repository-scoped full-analysis ownership.
 *
 * Only one full analysis may own a repository at a time. Duplicate analyses were
 * observed across distinct processes and frontends (CLI, MCP, daemon bootstrap,
 * Pi), so process-local promise deduplication cannot fix them — the guarantee has
 * to be cross-process (change `harden-spec-workflow-lifecycle`, decision 4da0a04f).
 *
 * This is one thin binding of the repository's single advisory-lock loop,
 * not a second locking mechanism. It supplies policy values and nothing else: a
 * structured JSON payload, a dead-PID-plus-stale-heartbeat staleness predicate,
 * `report` contention, `bestEffortAfterMaxWait: false`, and — under `--wait` — an
 * unbounded wait, since an attach ends when the owner finishes or dies.
 *
 * Ownership cannot simply reuse `acquireAnalysisLock`: it uses a different path,
 * reports its structured holder to attach-capable callers, and spans the whole
 * analysis run rather than only the publication write set. Both bindings fail
 * closed and wait indefinitely when their correctness guarantee requires it.
 *
 * Runtime lock and progress state deliberately live OUTSIDE the analysis
 * artifacts: heartbeat timestamps are not deterministic evidence and must never
 * enter an artifact digest.
 */

import { statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, readFile, rename, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

import {
  OWNERSHIP_HEARTBEAT_STALE_MS,
  OWNERSHIP_LOCK_FILE,
  acquireLockAt,
  isLockHeld,
  type LockHandle,
} from './advisory-lock.js';

/** Runtime state directory. Sibling of the analysis output, never inside it. */
export const RUNTIME_SUBDIR = 'runtime';
export const PROGRESS_FILE = 'analysis-progress.json';

/** Owner refresh cadence. The CLI heartbeat runs at twice this interval. */
export const PROGRESS_INTERVAL_MS = 15_000;
/** Maximum silence a user should see during an unchanged long phase. */
export const VISIBLE_HEARTBEAT_MS = 30_000;

export interface AnalysisOwnerPayload {
  /** Canonical repository path this ownership is scoped to. */
  repository: string;
  pid: number;
  /** ISO timestamp the analysis started. */
  startedAt: string;
  /** ISO timestamp of the owner's last refresh. */
  heartbeatAt: string;
  /** Coarse stage name, e.g. `parsing`, `call-graph`, `artifacts`. */
  stage: string;
  /** Absolute path of the progress sidecar this owner writes. */
  progressPath: string;
}

export interface AnalysisProgress {
  stage: string;
  /** 0–100 when known; `null` while a stage cannot estimate itself. */
  percent: number | null;
  detail?: string;
  updatedAt: string;
}

export type AnalysisOwnership =
  | {
      state: 'owned';
      payload: AnalysisOwnerPayload;
      /**
       * Milliseconds spent waiting on a PREVIOUS owner before acquiring (`--wait`
       * only; `0` otherwise). Non-zero means another process just finished a full
       * analysis, so the caller should re-check freshness before redoing the work
       * it was waiting for.
       */
      waitedMs: number;
      /** Publish a new stage/progress and refresh the heartbeat. */
      update: (stage: string, progress?: Omit<AnalysisProgress, 'stage' | 'updatedAt'>) => Promise<void>;
      /** Release ownership and remove the progress sidecar. */
      release: () => Promise<void>;
    }
  | {
      state: 'in-progress';
      /** The live owner, when its payload could be parsed. */
      owner: AnalysisOwnerPayload | null;
      /** Age of the owner's last heartbeat, in milliseconds. */
      heartbeatAgeMs: number;
      /** Milliseconds since the owner started, when its payload was readable. */
      elapsedMs: number | null;
      progressPath: string | null;
    };

export function runtimeDirOf(analysisDir: string): string {
  return join(dirname(analysisDir), RUNTIME_SUBDIR);
}

export function progressPathOf(analysisDir: string): string {
  return join(runtimeDirOf(analysisDir), PROGRESS_FILE);
}

/** Is a PID alive? `kill(pid, 0)` throws ESRCH for a dead process. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parsePayload(contents: string): AnalysisOwnerPayload | null {
  try {
    const parsed = JSON.parse(contents) as AnalysisOwnerPayload;
    return typeof parsed?.pid === 'number' && typeof parsed?.repository === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reclamation predicate: BOTH the owner PID must be dead AND its heartbeat stale.
 *
 * Elapsed time alone is never sufficient — a long analysis is not an abandoned
 * one — and a dead PID alone is not either, because PID reuse can make a live
 * unrelated process look like the owner. Requiring both, plus a repository match,
 * is what keeps reclamation from stealing a healthy run.
 *
 * PID reuse deliberately fails closed. A stale heartbeat does not prove that the
 * process currently carrying the PID is unrelated, so elapsed time alone never
 * authorizes a second full analysis. An ambiguous lock requires operator cleanup.
 */
export function isOwnershipStale(mtimeMs: number, contents: string, repository: string): boolean {
  const silentMs = Date.now() - mtimeMs;
  if (silentMs <= OWNERSHIP_HEARTBEAT_STALE_MS) return false;

  const payload = parsePayload(contents);
  // A refresh can be observed between truncate and write, and hand-edited lock
  // files exist. Ambiguous ownership fails closed rather than minting two owners.
  if (!payload) return false;
  // A lock naming a different repository is not ours to interpret; leave it.
  if (payload.repository !== repository) return false;
  return !isProcessAlive(payload.pid);
}

/** Atomically publish the progress sidecar (write-temp-then-rename). */
async function writeProgress(progressPath: string, progress: AnalysisProgress): Promise<void> {
  await mkdir(dirname(progressPath), { recursive: true });
  const tmp = `${progressPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, progressPath);
}

/** File the watchdog program is written to, beside the lock it maintains. */
export const WATCHDOG_FILE = '.analysis-watchdog.cjs';

/**
 * The watchdog thread's whole program.
 *
 * Written to a `.cjs` file at acquire time rather than run with `eval: true`.
 * The extension is load-bearing: an eval'd worker inherits the host's module
 * type, so under `--input-type=module` (how the test harness and some embedders
 * start Node) the same source is parsed as ESM and dies on `require is not
 * defined` — silently, since a watchdog failure must never fail the analysis.
 * A `.cjs` file is CommonJS no matter how the host was started, and needs no
 * build step or `dist/`-vs-`tsx` path resolution.
 *
 * It exists because timers are event-loop callbacks: a stage that is synchronous
 * and CPU-bound (artifact generation on a large repository) starves the main
 * thread's `setInterval` exactly as it starves a signal handler. Observed live —
 * a 405s analysis whose heartbeat never beat once. A separate thread has its own
 * event loop, so it keeps writing while the main thread is blocked.
 *
 * It writes only the heartbeat timestamp over a payload the main thread gave it.
 * The stage in that payload can go stale while the main thread is blocked (it
 * cannot post an update it never reaches), which is correct: the beat asserts
 * "this process is alive", never "the stage advanced".
 */
const WATCHDOG_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { statSync, writeFileSync, renameSync } = require('node:fs');
let { lockPath, progressPath, payload, progress, intervalMs, pid, stop, inode, writeMutex } = workerData;
const stopFlag = new Int32Array(stop);
const writeFlag = new Int32Array(writeMutex);
function beat() {
  // Checked synchronously on every beat. Releasing sets this BEFORE unlinking the
  // lock, so a beat already scheduled cannot land afterwards and recreate the file
  // this process just gave up — which would leave the repository falsely locked
  // until the abandonment window expired. A posted 'stop' message cannot close
  // that race: it is delivered on an event loop turn that may never come.
  if (Atomics.load(stopFlag, 0) !== 0) return;
  const now = new Date().toISOString();
  while (Atomics.compareExchange(writeFlag, 0, 0, 1) !== 0) Atomics.wait(writeFlag, 0, 1, 100);
  try {
    // Never write a lock this owner no longer holds. If ownership was reclaimed,
    // the path names a DIFFERENT file now, and beating onto it would overwrite the
    // new owner's heartbeat with a superseded one — reviving a dead owner on paper.
    if (statSync(lockPath).ino !== inode) return;
    writeFileSync(lockPath, JSON.stringify({ ...payload, heartbeatAt: now }));
  } catch { return; }
  finally { Atomics.store(writeFlag, 0, 0); Atomics.notify(writeFlag, 0); }
  try {
    const tmp = progressPath + '.' + pid + '.wd.tmp';
    writeFileSync(tmp, JSON.stringify({ ...progress, updatedAt: now }, null, 2));
    renameSync(tmp, progressPath);
  } catch { /* the sidecar is advisory; a lost write is not fatal */ }
}
const timer = setInterval(beat, intervalMs);
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'state') { payload = msg.payload; progress = msg.progress; return; }
  if (msg && msg.type === 'stop') { clearInterval(timer); process.exit(0); }
});
`;

/**
 * Try to become the sole owner of a full analysis for `repository`.
 *
 * Returns `owned` with a handle, or `in-progress` with the live owner's metadata.
 * `wait` mode polls until ownership is free instead of reporting — used only by
 * `analyze --wait`, which is attaching deliberately. An attach that waited reports
 * `waitedMs > 0`, which is how the caller knows the work may already be done.
 */
export async function acquireAnalysisOwnership(
  repository: string,
  analysisDir: string,
  options: { wait?: boolean; stage?: string; heartbeatIntervalMs?: number } = {},
): Promise<AnalysisOwnership> {
  const runtimeDir = runtimeDirOf(analysisDir);
  const progressPath = progressPathOf(analysisDir);
  const startedAt = new Date().toISOString();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? PROGRESS_INTERVAL_MS;
  let stage = options.stage ?? 'starting';

  const payloadOf = (): string => JSON.stringify({
    repository, pid: process.pid, startedAt,
    heartbeatAt: new Date().toISOString(), stage, progressPath,
  } satisfies AnalysisOwnerPayload);

  const result = await acquireLockAt(runtimeDir, OWNERSHIP_LOCK_FILE, {
    payload: payloadOf,
    isStale: (mtimeMs, contents) => isOwnershipStale(mtimeMs, contents, repository),
    onContended: options.wait ? 'wait' : 'report',
    // Proceeding unlocked would void the single-flight guarantee this exists for.
    bestEffortAfterMaxWait: false,
    // A full analysis has no bounded duration, so the default 3-minute cap would
    // turn an explicit `--wait` into a spurious "gave up" on any repository large
    // enough to need attaching. Waiting is safe here because the staleness
    // predicate reclaims a DEAD owner: an attach ends when the owner finishes or
    // when it dies, never on a clock. It stays interruptible with Ctrl-C.
    ...(options.wait ? { maxWaitMs: Number.POSITIVE_INFINITY } : {}),
  });

  if (isLockHeld(result)) {
    const owner = parsePayload(result.payload);
    return {
      state: 'in-progress',
      owner,
      heartbeatAgeMs: result.ageMs,
      elapsedMs: owner ? Date.now() - Date.parse(owner.startedAt) : null,
      progressPath: owner?.progressPath ?? null,
    };
  }

  const handle = result as LockHandle;
  const lockPath = join(runtimeDir, OWNERSHIP_LOCK_FILE);
  await writeProgress(progressPath, { stage, percent: null, updatedAt: new Date().toISOString() });

  let released = false;
  let lastProgress: Omit<AnalysisProgress, 'stage' | 'updatedAt'> = { percent: null };
  const writeMutex = new SharedArrayBuffer(4);
  const writeView = new Int32Array(writeMutex);
  const refreshOwnershipPayload = async (payload: string): Promise<void> => {
    while (Atomics.compareExchange(writeView, 0, 0, 1) !== 0) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    try { await handle.refresh(payload); }
    finally { Atomics.store(writeView, 0, 0); Atomics.notify(writeView, 0); }
  };

  /**
   * Refresh the heartbeat and re-stamp the sidecar with the CURRENT stage.
   *
   * Stage transitions alone are not enough. A single stage can run for minutes
   * (artifact generation on a large repository), and during it nothing called
   * `update`, so the heartbeat froze: `status` and a contending `analyze` reported
   * an owner whose last beat was minutes old, and the only thing standing between
   * that owner and reclamation was the liveness PID check. Observed live on a real
   * repository — 80s+ of a frozen heartbeat inside one `artifacts` stage.
   */
  const beat = async (): Promise<void> => {
    if (released) return;
    await refreshOwnershipPayload(payloadOf());
    await writeProgress(progressPath, {
      stage,
      percent: lastProgress.percent ?? null,
      ...(lastProgress.detail ? { detail: lastProgress.detail } : {}),
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
  };

  // Unref'd so a live heartbeat can never keep the process alive on its own: it
  // observes the analysis, it does not extend it. This in-thread ticker covers
  // every stage that leaves the event loop reachable; the watchdog below covers
  // the ones that do not.
  const ticker = setInterval(() => { void beat(); }, heartbeatIntervalMs);
  ticker.unref?.();

  const ownerPayload = (): AnalysisOwnerPayload => ({
    repository, pid: process.pid, startedAt, heartbeatAt: new Date().toISOString(), stage, progressPath,
  });

  /**
   * Start the out-of-loop watchdog. Failure is non-fatal: the in-thread ticker
   * still runs, so a host that forbids worker threads degrades to the previous
   * behavior rather than losing ownership.
   */
  let watchdog: Worker | null = null;
  const watchdogPath = join(runtimeDir, WATCHDOG_FILE);
  // Shared with the watchdog thread so a stop is visible to it IMMEDIATELY, with
  // no event-loop turn and no message round-trip in between.
  const stopFlag = new SharedArrayBuffer(4);
  const stopView = new Int32Array(stopFlag);
  try {
    writeFileSync(watchdogPath, WATCHDOG_SOURCE, 'utf8');
    watchdog = new Worker(watchdogPath, {
      // Inherit NO CLI flags. A worker copies the host's `execArgv` by default,
      // and a host started with `--input-type=module` (the test harness, some
      // embedders) hands the thread a flag that is illegal for a file-based
      // worker — it dies at startup with "--input-type can only be used with
      // string input". The watchdog is plain CommonJS needing no loader, no
      // transform, and no flags, so the empty list is both correct and the only
      // value that cannot be poisoned by how the host was launched.
      execArgv: [],
      workerData: {
        lockPath, progressPath, pid: process.pid, intervalMs: heartbeatIntervalMs, stop: stopFlag, writeMutex,
        inode: handle.inode,
        payload: ownerPayload(),
        progress: { stage, percent: null },
      },
    });
    watchdog.unref();
    // A watchdog that dies must not take the analysis with it — but a silent
    // failure is how this whole class of bug hid in the first place, so the
    // reason is available behind an env flag rather than discarded.
    watchdog.on('error', err => {
      watchdog = null;
      if (process.env.OPENLORE_DEBUG_WATCHDOG) {
        process.stderr.write(`[analysis-ownership] watchdog failed: ${(err as Error).message}\n`);
      }
    });
  } catch (err) {
    watchdog = null;
    if (process.env.OPENLORE_DEBUG_WATCHDOG) {
      process.stderr.write(`[analysis-ownership] watchdog could not start: ${(err as Error).message}\n`);
    }
  }

  /**
   * Synchronous release.
   *
   * A signal handler and an `exit` handler both run on a process that may be
   * about to die: an async unlink there is not guaranteed to complete, which
   * would leave the repository locked until the heartbeat went stale. Only
   * synchronous filesystem calls are reliable at that point.
   */
  /**
   * Stop the watchdog BEFORE removing the lock, in both release paths. A beat
   * that lands after the unlink would recreate the lock file this process just
   * gave up — silently re-locking the repository against everyone else.
   */
  const stopWatchdog = (): Promise<void> => {
    // Set FIRST and synchronously: from this point the watchdog cannot write,
    // whichever release path is running and whether or not the thread has died yet.
    Atomics.store(stopView, 0, 1);
    if (!watchdog) return Promise.resolve();
    const worker = watchdog;
    watchdog = null;
    try { worker.postMessage({ type: 'stop' }); } catch { /* already gone */ }
    const terminated = worker.terminate().then(() => undefined).catch(() => undefined);
    try { unlinkSync(watchdogPath); } catch { /* already gone */ }
    return terminated;
  };

  const releaseSync = (): void => {
    if (released) return;
    released = true;
    clearInterval(ticker);
    // Cannot await a thread from a signal/exit handler; the shared stop flag is
    // what makes this path safe, since the watchdog observes it before every write.
    void stopWatchdog();
    // Same identity rule as the async release: a superseded owner must not delete
    // the lock its successor now holds.
    try {
      // Same rule as the async release: abstain only when the path positively
      // names another file; unknown identity still cleans up our own lock.
      const current = statSync(lockPath).ino;
      if (!(typeof current === 'number' && handle.inode >= 0 && current !== handle.inode)) unlinkSync(lockPath);
    } catch { /* already gone */ }
    try { unlinkSync(progressPath); } catch { /* already gone */ }
  };

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(ticker);
    // Wait for the thread to actually be gone before removing the lock. The stop
    // flag already forbids a late write; awaiting termination also rules out a beat
    // that had passed the flag check and was mid-write.
    await stopWatchdog();
    await handle.release();
    await unlink(progressPath).catch(() => {});
  };

  // Signals must release ownership, or a Ctrl-C leaves the repository locked
  // until the heartbeat goes stale. Clean up synchronously, then restore the
  // signal's DEFAULT behavior by re-raising it: registering a listener suppresses
  // termination, and silently converting a SIGTERM into "keep running" would be a
  // worse bug than the one being fixed.
  const onSignal = (signal: NodeJS.Signals): void => {
    releaseSync();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', releaseSync);

  return {
    state: 'owned',
    payload: { repository, pid: process.pid, startedAt, heartbeatAt: startedAt, stage, progressPath },
    waitedMs: handle.waitedMs,
    update: async (nextStage, progress) => {
      stage = nextStage;
      // Remembered so the periodic beat re-stamps the real stage detail rather
      // than blanking it back to "no progress known".
      lastProgress = { percent: progress?.percent ?? null, ...(progress?.detail ? { detail: progress.detail } : {}) };
      // Hand the watchdog the new stage so its beats stop describing the old one.
      // Best-effort by construction: if the main thread is blocked it never gets
      // here, and the watchdog keeps asserting liveness under the previous stage.
      try { watchdog?.postMessage({ type: 'state', payload: ownerPayload(), progress: { stage: nextStage, ...lastProgress } }); } catch { /* watchdog gone */ }
      await refreshOwnershipPayload(payloadOf());
      await writeProgress(progressPath, {
        stage: nextStage,
        percent: progress?.percent ?? null,
        ...(progress?.detail ? { detail: progress.detail } : {}),
        updatedAt: new Date().toISOString(),
      });
    },
    release: async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('exit', releaseSync);
      await release();
    },
  };
}

/** Read the current progress sidecar, or `null` when no analysis is publishing. */
export async function readAnalysisProgress(analysisDir: string): Promise<AnalysisProgress | null> {
  try {
    return JSON.parse(await readFile(progressPathOf(analysisDir), 'utf8')) as AnalysisProgress;
  } catch {
    return null;
  }
}

/**
 * Non-blocking ownership read for status/preflight.
 *
 * Never acquires, steals, or waits. Returns `null` when no live analysis owns the
 * repository — including when a stale lock is present, since a crashed holder is
 * not an analysis in progress.
 */
export async function readAnalysisOwner(
  repository: string,
  analysisDir: string,
): Promise<{ owner: AnalysisOwnerPayload | null; heartbeatAgeMs: number; elapsedMs: number | null } | null> {
  const lockPath = join(runtimeDirOf(analysisDir), OWNERSHIP_LOCK_FILE);
  let contents: string;
  let mtimeMs: number;
  try {
    // ONE open handle for both the timestamp and the bytes. Resolving the path
    // twice can straddle a rewrite and pair one owner's heartbeat with another's
    // payload, which is exactly the kind of mixture this module refuses elsewhere.
    const handle = await open(lockPath, 'r');
    try {
      mtimeMs = (await handle.stat()).mtimeMs;
      contents = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  if (isOwnershipStale(mtimeMs, contents, repository)) return null;

  const owner = parsePayload(contents);
  return {
    owner,
    heartbeatAgeMs: Date.now() - mtimeMs,
    elapsedMs: owner ? Date.now() - Date.parse(owner.startedAt) : null,
  };
}
