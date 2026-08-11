/**
 * Repository-scoped full-analysis ownership.
 *
 * Only one full analysis may own a repository at a time. Duplicate analyses were
 * observed across distinct processes and frontends (CLI, MCP, daemon bootstrap,
 * Pi), so process-local promise deduplication cannot fix them — the guarantee has
 * to be cross-process (change `harden-spec-workflow-lifecycle`, decision 4da0a04f).
 *
 * This is the THIRD thin binding of the repository's single advisory-lock loop,
 * not a second locking mechanism. It supplies policy values and nothing else: a
 * structured JSON payload, a dead-PID-plus-stale-heartbeat staleness predicate,
 * `report` contention, `bestEffortAfterMaxWait: false`, and — under `--wait` — an
 * unbounded wait, since an attach ends when the owner finishes or dies.
 *
 * That last one is the reason ownership cannot simply reuse `acquireAnalysisLock`:
 * that binding proceeds WITHOUT the lock after the max wait, which is right for a
 * bounded artifact write and is exactly the duplicate full analysis this module
 * exists to prevent.
 *
 * Runtime lock and progress state deliberately live OUTSIDE the analysis
 * artifacts: heartbeat timestamps are not deterministic evidence and must never
 * enter an artifact digest.
 */

import { unlinkSync } from 'node:fs';
import { readFile, rename, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
 */
export function isOwnershipStale(mtimeMs: number, contents: string, repository: string): boolean {
  const heartbeatStale = Date.now() - mtimeMs > OWNERSHIP_HEARTBEAT_STALE_MS;
  if (!heartbeatStale) return false;

  const payload = parsePayload(contents);
  // An unparseable payload with a stale heartbeat is a crashed or truncated
  // writer: there is no owner to protect.
  if (!payload) return true;
  // A lock naming a different repository is not ours to interpret; leave it.
  if (payload.repository !== repository) return false;
  return !isProcessAlive(payload.pid);
}

/** Atomically publish the progress sidecar (write-temp-then-rename). */
async function writeProgress(progressPath: string, progress: AnalysisProgress): Promise<void> {
  await mkdir(dirname(progressPath), { recursive: true });
  const tmp = `${progressPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(tmp, progressPath);
}

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
  options: { wait?: boolean; stage?: string } = {},
): Promise<AnalysisOwnership> {
  const runtimeDir = runtimeDirOf(analysisDir);
  const progressPath = progressPathOf(analysisDir);
  const startedAt = new Date().toISOString();
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

  /**
   * Synchronous release.
   *
   * A signal handler and an `exit` handler both run on a process that may be
   * about to die: an async unlink there is not guaranteed to complete, which
   * would leave the repository locked until the heartbeat went stale. Only
   * synchronous filesystem calls are reliable at that point.
   */
  const releaseSync = (): void => {
    if (released) return;
    released = true;
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    try { unlinkSync(progressPath); } catch { /* already gone */ }
  };

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
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
      await handle.refresh(payloadOf());
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
    const { stat } = await import('node:fs/promises');
    const info = await stat(lockPath);
    mtimeMs = info.mtimeMs;
    contents = await readFile(lockPath, 'utf8');
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
