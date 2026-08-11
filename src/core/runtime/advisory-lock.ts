/**
 * The repository's ONE cross-process advisory-lock loop.
 *
 * Three callers share it — the decision store, the analysis-artifact writers, and
 * full-analysis ownership. All three are thin bindings of `acquireLockAt`; there
 * is no second locking mechanism and no second stale-steal or release path.
 *
 * Decisions: `record_decision` spawns a detached `decisions --consolidate` per
 * call. Under rapid recording, several consolidations run at once; each does a
 * load → mutate → save of `pending.json`, and the later save clobbers the
 * earlier one — silently losing decisions (observed during the spec-15 dogfood:
 * 5 rapid records produced 3 stored decisions). Serializing consolidation behind
 * this lock — and reloading the store *inside* it — makes the read-modify-write
 * safe: whoever holds the lock sees every draft written so far, so nothing is lost.
 *
 * Analysis artifacts: a running watcher's read-patch-write of the JSON artifact
 * set and a full `analyze` (including the watcher's own self-heal spawn) can
 * overlap on the same files. The same lock shape — keyed on the analysis output
 * directory — serializes the two artifact-write critical sections so the final
 * on-disk set is one writer's complete output, never an interleaving.
 *
 * Analysis ownership (change `harden-spec-workflow-lifecycle`, decision 4da0a04f):
 * duplicate full analyses were observed across distinct processes and frontends,
 * so ownership needs the same primitive with a different POLICY — a structured
 * payload, a dead-PID-plus-stale-heartbeat staleness predicate, contention that
 * REPORTS instead of waiting, and no best-effort escape (proceeding unlocked
 * would void the single-flight guarantee). Those four differences are parameters
 * of this loop, not a second implementation; every one defaults to the behavior
 * the first two callers already had, so they are unchanged.
 *
 * Ownership and the artifact lock are complementary: ownership spans a whole
 * analysis run, while `.artifacts.lock` fences only the artifact write-set and is
 * also taken by the incremental watcher, which never takes ownership. An owner
 * acquires ownership BEFORE the artifact lock and never the reverse — one fixed
 * order, so the two can never deadlock.
 */
import { link, open, readFile, rename, stat, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decisionsDir } from '../decisions/store.js';

const DECISIONS_LOCK_FILE = '.consolidate.lock';
const ANALYSIS_LOCK_FILE = '.artifacts.lock';
const OWNERSHIP_LOCK_FILE = '.analysis-owner.lock';
const STALE_MS = 120_000;     // steal a lock older than this (crashed/killed holder)
const POLL_MS = 150;
const MAX_WAIT_MS = 180_000;  // give up waiting after this and proceed best-effort
/**
 * Ownership heartbeat window. An owner refreshes its payload at least this often
 * (the progress sidecar runs at 15s, so a live owner refreshes well inside it);
 * a heartbeat older than this is a NECESSARY but not sufficient condition for
 * reclamation — the owner PID must also be dead.
 */
const OWNERSHIP_HEARTBEAT_STALE_MS = 90_000;
/**
 * Silence after which an owner is abandoned NO MATTER WHAT ITS PID SAYS.
 *
 * Reclamation normally needs a dead PID as well, which leaves one permanent hole:
 * an owner that dies and whose PID is then recycled by an unrelated live process
 * looks alive forever, so its lock could never be reclaimed. This bound closes it
 * — but only because the heartbeat is written by a watchdog thread that keeps
 * beating while the main thread is blocked, so silence this long really does mean
 * the writer is gone. It is 120 consecutive missed beats; a real analysis that
 * still has a live watchdog cannot reach it.
 */
const OWNERSHIP_ABANDONED_MS = 30 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What a contender does when the lock is held by a live holder. */
export type LockContention =
  /** Poll until it is free (or the max wait elapses). The historical behavior. */
  | 'wait'
  /** Return immediately with the current holder's payload. */
  | 'report';

export interface LockPolicy {
  /** Bytes written into the lock file. Default: `<pid> <ISO timestamp>`. */
  payload?: () => string;
  /**
   * Is a held lock reclaimable? Receives the file's mtime and its raw contents.
   * Default: mtime older than {@link STALE_MS}.
   */
  isStale?: (mtimeMs: number, contents: string) => boolean;
  /** Behavior when the lock is held by a live holder. Default `wait`. */
  onContended?: LockContention;
  /**
   * Proceed WITHOUT the lock after {@link MAX_WAIT_MS} rather than block forever.
   * Default `true`, which is right for a bounded background write and wrong for
   * any caller whose guarantee is exclusivity.
   */
  bestEffortAfterMaxWait?: boolean;
  /**
   * How long `wait` contention polls before giving up. Default {@link MAX_WAIT_MS}
   * — the bound every existing caller already had. `Infinity` waits for as long as
   * the holder stays live, which is only correct for a caller whose critical
   * section has no bounded duration AND whose staleness predicate can reclaim a
   * dead holder (otherwise a crashed holder would block forever).
   */
  maxWaitMs?: number;
}

export interface LockHandle {
  /** Idempotent release. */
  release: () => Promise<void>;
  /** Rewrite the lock payload in place — the heartbeat an owner refreshes. */
  refresh: (payload: string) => Promise<void>;
  /**
   * True when the loop gave up waiting and proceeded WITHOUT the lock. Only ever
   * possible under `bestEffortAfterMaxWait`.
   */
  bestEffort: boolean;
  /**
   * Milliseconds spent waiting on a previous holder before acquiring. `0` means
   * the lock was free on the first attempt — the caller therefore knows whether
   * someone else just finished the work it is about to start.
   */
  waitedMs: number;
}

/** Returned instead of a handle when `onContended: 'report'` finds a live holder. */
export interface LockHeld {
  held: true;
  /** Raw payload of the current holder, or `''` if it could not be read. */
  payload: string;
  /** Age of the holder's last write, in milliseconds. */
  ageMs: number;
  lockPath: string;
}

const defaultPayload = (): string => `${process.pid} ${new Date().toISOString()}`;
const defaultIsStale = (mtimeMs: number): boolean => Date.now() - mtimeMs > STALE_MS;

async function writePayload(lockPath: string, payload: string): Promise<void> {
  const fh = await open(lockPath, 'w');
  try {
    await fh.writeFile(payload);
  } finally {
    await fh.close();
  }
}

/**
 * Acquire an exclusive-create advisory lock at `dir/lockFile`.
 *
 * Returns a handle, or — only under `onContended: 'report'` — a {@link LockHeld}
 * descriptor naming the live holder. Waits (polling) while another process holds
 * it and steals a lock its policy considers stale. This is the single lock loop
 * every binding below is a thin wrapper of.
 */
export async function acquireLockAt(
  dir: string,
  lockFile: string,
  policy: LockPolicy = {},
): Promise<LockHandle | LockHeld> {
  const payloadOf = policy.payload ?? defaultPayload;
  const isStale = policy.isStale ?? defaultIsStale;
  const onContended = policy.onContended ?? 'wait';
  const bestEffortAfterMaxWait = policy.bestEffortAfterMaxWait ?? true;
  const maxWaitMs = policy.maxWaitMs ?? MAX_WAIT_MS;

  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, lockFile);
  const start = Date.now();
  // Only a real collision counts as waiting: an uncontended acquire still costs a
  // millisecond of syscalls, and reporting that as a wait would make a caller
  // believe another holder just finished the work it is about to do.
  let contended = false;

  for (;;) {
    try {
      const fh = await open(lockPath, 'wx'); // exclusive create — fails if held
      await fh.writeFile(payloadOf());
      await fh.close();
      let released = false;
      return {
        bestEffort: false,
        waitedMs: contended ? Date.now() - start : 0,
        refresh: async (payload: string) => {
          if (!released) await writePayload(lockPath, payload).catch(() => {});
        },
        release: async () => {
          if (released) return;
          released = true;
          await unlink(lockPath).catch(() => {});
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      contended = true;
      // Held by someone else — steal if the policy says it is stale, else wait.
      let mtimeMs: number;
      let contents: string;
      try {
        // ONE open handle for both the timestamp and the bytes. Resolving the path
        // twice can straddle a rewrite and pair one holder's mtime with another's
        // payload — and that pair is exactly what the staleness policy judges, and
        // what the post-rename mtime comparison below re-checks. Reading them from
        // the same inode makes both decisions describe the same file.
        const handle = await open(lockPath, 'r');
        try {
          mtimeMs = (await handle.stat()).mtimeMs;
          contents = await handle.readFile('utf8');
        } finally {
          await handle.close();
        }
      } catch {
        continue; // lock vanished between open and stat — retry acquire
      }
      if (isStale(mtimeMs, contents)) {
        // Steal by RENAME, not by unlink-on-path. Two contenders can both judge the
        // same lock stale; with a path delete, the second one removes the FRESH
        // lock the first has already put there, and both then believe they own the
        // repository — the one outcome this loop exists to prevent. A rename is
        // atomic, so exactly one contender moves this file out of the way.
        const stolen = `${lockPath}.${process.pid}.${Date.now()}.stale`;
        try {
          await rename(lockPath, stolen);
        } catch {
          continue; // another contender won the steal — re-read and retry
        }
        // Confirm we moved the file we judged, not one the holder refreshed in
        // between. On a mismatch the holder was alive after all, so put it back —
        // unless a new lock already exists, which we must not clobber.
        try {
          const moved = await stat(stolen);
          if (moved.mtimeMs !== mtimeMs) {
            // The holder refreshed between our read and the steal, so it was alive:
            // put the file back. `link` is used rather than `rename` because rename
            // OVERWRITES — restoring that way clobbers a lock another contender may
            // already have taken, handing out two owners. `link` fails when the path
            // is occupied, which is the answer we want: someone else owns it now.
            await link(stolen, lockPath).catch(() => {});
            await unlink(stolen).catch(() => {});
            continue;
          }
        } catch { /* already gone — nothing to restore */ }
        await unlink(stolen).catch(() => {});
        continue; // retry acquire immediately
      }
      if (onContended === 'report') {
        return { held: true, payload: contents, ageMs: Date.now() - mtimeMs, lockPath };
      }
      if (Date.now() - start > maxWaitMs) {
        if (!bestEffortAfterMaxWait) {
          return { held: true, payload: contents, ageMs: Date.now() - mtimeMs, lockPath };
        }
        return { bestEffort: true, waitedMs: Date.now() - start, refresh: async () => {}, release: async () => {} };
      }
      await sleep(POLL_MS);
    }
  }
}

/** Narrowing helper: did the acquire return a live holder instead of a handle? */
export function isLockHeld(result: LockHandle | LockHeld): result is LockHeld {
  return (result as LockHeld).held === true;
}

/**
 * Acquire the decision-store consolidation lock (thin binding of {@link acquireLockAt}).
 * Returns an idempotent release function.
 */
export async function acquireDecisionsLock(rootPath: string): Promise<() => Promise<void>> {
  const result = await acquireLockAt(decisionsDir(rootPath), DECISIONS_LOCK_FILE);
  return isLockHeld(result) ? async () => {} : result.release;
}

/**
 * Acquire the analysis-artifact lock for a given analysis output directory (thin
 * binding of {@link acquireLockAt}). Serializes the artifact-write critical
 * sections of a full `analyze` and a running watcher's persist so their JSON
 * artifact sets never interleave. The lock file lives inside the analysis
 * directory, so two writers of the SAME directory contend and writers of
 * different directories do not.
 */
export async function acquireAnalysisLock(analysisDir: string): Promise<() => Promise<void>> {
  const result = await acquireLockAt(analysisDir, ANALYSIS_LOCK_FILE);
  return isLockHeld(result) ? async () => {} : result.release;
}

/** Run `fn` while holding the analysis-artifact lock for `analysisDir`; always releases. */
export async function withAnalysisLock<T>(analysisDir: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireAnalysisLock(analysisDir);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Non-blocking check: is a consolidation run currently in flight?
 *
 * True iff the lock file exists and is not stale (a stale lock is a crashed
 * holder, treated as not-in-flight so a fresh run can proceed). Never acquires,
 * steals, or waits on the lock — a pure read used to coalesce redundant
 * `record_decision` spawns against the run already underway.
 */
export async function isDecisionsLockHeld(rootPath: string): Promise<boolean> {
  const lockPath = join(decisionsDir(rootPath), DECISIONS_LOCK_FILE);
  try {
    const s = await stat(lockPath);
    return Date.now() - s.mtimeMs <= STALE_MS;
  } catch {
    return false; // no lock file → not held
  }
}

/** Run `fn` while holding the consolidation lock; always releases. */
export async function withDecisionsLock<T>(rootPath: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireDecisionsLock(rootPath);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export {
  ANALYSIS_LOCK_FILE,
  DECISIONS_LOCK_FILE,
  OWNERSHIP_LOCK_FILE,
  OWNERSHIP_ABANDONED_MS,
  OWNERSHIP_HEARTBEAT_STALE_MS,
  POLL_MS,
  STALE_MS,
};
