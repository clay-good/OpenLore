/**
 * The repository's ONE cross-process advisory-lock loop.
 *
 * Four callers share it — JSON-store commit sections, decision consolidation,
 * analysis-artifact writers, and full-analysis ownership. All are thin bindings of `acquireLockAt`; there
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
 * of this loop, not a second implementation.
 *
 * Ownership and the artifact lock are complementary: ownership spans a whole
 * analysis run, while `.artifacts.lock` fences only the artifact write-set and is
 * also taken by the incremental watcher, which never takes ownership. An owner
 * acquires ownership BEFORE the artifact lock and never the reverse — one fixed
 * order, so the two can never deadlock.
 *
 * WHAT THIS LOCK GUARANTEES, AND WHERE IT STOPS
 *
 * It is ADVISORY. It serializes cooperating writers that all take it; it does not
 * constrain a process that ignores it, and it is not a security boundary.
 *
 * Taking the lock (`open` with `wx`) and stealing a stale one (`rename`) are atomic
 * namespace operations. Acquire, steal, and release all pass through a short-lived
 * namespace gate. Release compares the path inode with the acquired inode while
 * holding that gate, then unlinks only its own file. A stale or misconfigured
 * holder therefore cannot delete a successor.
 *
 * Reclamation is therefore deliberately conservative: a lock is stolen only when
 * its holder is confirmed dead and old enough to exclude an acquire still writing
 * its payload. Ambiguous, malformed, and PID-reused locks fail closed. They may
 * require operator cleanup, but they never authorize two correctness-sensitive
 * writers at once.
 */
import { randomUUID } from 'node:crypto';
import { link, open, readFile, rename, stat, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OPENLORE_DECISIONS_SUBDIR, OPENLORE_DIR } from '../../constants.js';

const DECISIONS_LOCK_FILE = '.consolidate.lock';
const ANALYSIS_LOCK_FILE = '.artifacts.lock';
const OWNERSHIP_LOCK_FILE = '.analysis-owner.lock';
const STALE_MS = 120_000;     // steal a lock older than this (crashed/killed holder)
const POLL_MS = 150;
const MAX_WAIT_MS = 180_000;
// Namespace ownership is fail-closed, but a loaded process can pause a holder's
// event loop for several seconds. Match the serve/start bound before declaring a
// complete PID-bearing gate stranded; explicit test policies can use shorter waits.
const NAMESPACE_GATE_MAX_WAIT_MS = 30_000;
/**
 * Ownership heartbeat window. An owner refreshes its payload at least this often
 * (the progress sidecar runs at 15s, so a live owner refreshes well inside it);
 * a heartbeat older than this is a NECESSARY but not sufficient condition for
 * reclamation — the owner PID must also be dead.
 */
const OWNERSHIP_HEARTBEAT_STALE_MS = 90_000;
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
   * Default: mtime older than {@link STALE_MS} and payload PID confirmed dead.
   */
  isStale?: (mtimeMs: number, contents: string) => boolean;
  /** Behavior when the lock is held by a live holder. Default `wait`. */
  onContended?: LockContention;
  /**
   * Proceed WITHOUT the lock after {@link MAX_WAIT_MS} rather than block forever.
   * Default `false`: callers promising serialization must never continue unlocked.
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
  /** Bound for the internal namespace gate. A stranded gate fails closed. */
  namespaceGateMaxWaitMs?: number;
  /** Cancel a contended acquisition without ever proceeding unlocked. */
  signal?: AbortSignal;
}

export class NamespaceGateHeldError extends Error {
  constructor(public readonly gatePath: string) {
    super(`Lock namespace gate is still present at ${gatePath}; remove it only after verifying its owner is gone.`);
    this.name = 'NamespaceGateHeldError';
  }
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
  /**
   * Inode of the file this handle acquired. Any other writer of the same path —
   * a signal handler, a watchdog thread — must compare against it before writing
   * or deleting, so a superseded holder cannot damage its successor's lock.
   */
  inode: number;
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

/**
 * Run a file-handle operation, tolerating a handle that does not implement it.
 *
 * A `.catch()` alone is not enough: calling a method the handle lacks throws
 * SYNCHRONOUSLY, so the rejection handler never runs and the exception escapes
 * the acquire loop entirely. Identity and heartbeat writes are refinements — a
 * handle that cannot do them must degrade, never abort the lock.
 */
async function tryHandle<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch {
    return undefined;
  }
}

const defaultPayload = (): string => `${process.pid} ${new Date().toISOString()}`;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Lock acquisition was aborted', 'AbortError');
}

function decisionsDir(rootPath: string): string {
  return join(rootPath, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
}

function pidFromDefaultPayload(contents: string): number | null {
  const match = /^\s*(\d+)\b/.exec(contents);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const defaultIsStale = (mtimeMs: number, contents: string): boolean => {
  if (Date.now() - mtimeMs <= STALE_MS) return false;
  const pid = pidFromDefaultPayload(contents);
  return pid !== null && !isProcessAlive(pid);
};

/**
 * Serialize namespace changes for one lock path. Without this tiny gate, a stale
 * contender can read inode A, another contender can replace A with a fresh lock,
 * and the first contender's later rename moves that fresh lock. Every acquire and
 * steal attempt passes through the gate, closing that judged-inode/replaced-path
 * race. A stranded gate fails closed with a bounded recovery error: portable
 * filesystems do not provide compare-and-delete, so automatic deletion is unsafe.
 */
async function acquireNamespaceGate(
  lockPath: string,
  maxWaitMs = NAMESPACE_GATE_MAX_WAIT_MS,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const gatePath = `${lockPath}.gate`;
  const startedAt = Date.now();
  for (;;) {
    throwIfAborted(signal);
    // Prepare the payload under a unique name before atomically claiming the
    // fixed gate path. A crash can therefore leave either no gate or a complete
    // PID-bearing gate, never an empty gate that nobody can safely reclaim.
    const candidate = `${gatePath}.${process.pid}.${randomUUID()}.candidate`;
    try {
      const handle = await open(candidate, 'wx');
      try {
        await handle.writeFile(String(process.pid));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(candidate, gatePath); // fails rather than replacing a live gate
      await unlink(candidate).catch(() => {});
      const inode = (await stat(gatePath)).ino;
      return async () => {
        const current = await stat(gatePath).catch(() => null);
        if (current?.ino === inode) await unlink(gatePath).catch(() => {});
      };
    } catch (err) {
      await unlink(candidate).catch(() => {});
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // There is no portable compare-and-delete filesystem primitive. Deleting a
      // gate merely because its recorded PID is dead has an ABA race: another
      // contender can replace it between our read and unlink, after which we delete
      // the successor's live gate. Never reclaim automatically; a stranded gate is
      // an explicit, bounded, fail-closed operator-recovery condition.
      await readFile(gatePath, 'utf8').catch(() => '');
      if (Date.now() - startedAt >= maxWaitMs) throw new NamespaceGateHeldError(gatePath);
      await sleep(10);
    }
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
  const bestEffortAfterMaxWait = policy.bestEffortAfterMaxWait ?? false;
  const maxWaitMs = policy.maxWaitMs ?? MAX_WAIT_MS;
  const namespaceGateMaxWaitMs = policy.namespaceGateMaxWaitMs ?? NAMESPACE_GATE_MAX_WAIT_MS;
  const signal = policy.signal;

  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, lockFile);
  const start = Date.now();
  // Only a real collision counts as waiting: an uncontended acquire still costs a
  // millisecond of syscalls, and reporting that as a wait would make a caller
  // believe another holder just finished the work it is about to do.
  let contended = false;

  for (;;) {
    throwIfAborted(signal);
    const releaseGate = await acquireNamespaceGate(lockPath, namespaceGateMaxWaitMs, signal);
    try {
      throwIfAborted(signal);
      try {
        const fh = await open(lockPath, 'wx'); // exclusive create — fails if held
        try {
          await fh.writeFile(payloadOf());
        } catch (err) {
          await tryHandle(() => fh.close());
          // The gate excludes every successor, so this cleanup cannot delete a
          // different owner's lock.
          await unlink(lockPath).catch(() => {});
          throw err;
        }
        // The identity of the file we acquired. Everything this handle does later
        // is bound to it, because a holder whose lock was STOLEN keeps running: its
        // next refresh must not truncate, and its release must not delete, the lock
        // a new owner has since put at the same path. The path is not the lock; this
        // inode is. (The descriptor stays open for the handle's lifetime for the
        // same reason — see `refresh`.) `-1` means identity is unavailable.
        const inode = (await tryHandle(async () => (await fh.stat()).ino)) ?? -1;
        let released = false;
        let releaseInFlight: Promise<void> | null = null;
        let refreshTail = Promise.resolve();
        return {
          bestEffort: false,
          waitedMs: contended ? Date.now() - start : 0,
          inode,
          refresh: async (payload: string) => {
            if (released) return;
            // Serialize truncate+write pairs. Heartbeats and explicit stage updates
            // can overlap in one process; without this chain their writes splice
            // into malformed JSON and make a later crashed lock unreclaimable.
            const operation = refreshTail.then(async () => {
              if (released) return;
              await tryHandle(() => fh.truncate(0));
              await tryHandle(() => fh.write(payload, 0));
            });
            refreshTail = operation.catch(() => {});
            await operation;
          },
          release: async () => {
            if (released) return;
            try {
              if (!releaseInFlight) {
                releaseInFlight = (async () => {
                  await tryHandle(() => fh.close());
                  // The namespace gate makes this identity-check-plus-unlink one
                  // serialized operation relative to every acquire and steal. If a
                  // custom policy ever reclaimed this holder, its successor has a
                  // different inode and remains untouched.
                  await refreshTail;
                  const releaseNamespace = await acquireNamespaceGate(lockPath, namespaceGateMaxWaitMs);
                  try {
                    if (inode < 0) return; // unknown identity fails closed
                    const current = await stat(lockPath).catch(() => null);
                    if (current?.ino === inode) await unlink(lockPath).catch(() => {});
                  } finally {
                    await releaseNamespace();
                  }
                })();
              }
              await releaseInFlight;
              released = true;
            } catch (err) {
              // Closing the fd is irreversible, but namespace cleanup is safe to
              // retry because it remains bound to the acquired inode identity.
              releaseInFlight = null;
              throw err;
            }
          },
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        contended = true;
        // Held by someone else — steal if the policy says it is stale, else wait.
        let mtimeMs: number;
        let contents: string;
        let inode: number;
        try {
        // ONE open handle for both the timestamp and the bytes. Resolving the path
        // twice can straddle a rewrite and pair one holder's mtime with another's
        // payload — and that pair is exactly what the staleness policy judges, and
        // what the post-rename mtime comparison below re-checks. Reading them from
        // the same inode makes both decisions describe the same file.
        const handle = await open(lockPath, 'r');
        try {
          const info = await handle.stat();
          mtimeMs = info.mtimeMs;
          inode = info.ino;
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
        // The destination MUST be unique per attempt. `rename` overwrites silently,
        // so a name built only from pid+timestamp collides between two contenders
        // in the same process within the same millisecond — the shape of five
        // concurrent acquires. The second steal would then clobber the first's
        // stolen copy, and the first's identity check would compare against a file
        // that was never its own, restoring a lock belonging to neither. A random
        // suffix removes the collision instead of narrowing its window.
          const stolen = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
          try {
            await rename(lockPath, stolen);
          } catch {
            continue; // holder released between judgment and rename
          }
        // Confirm we moved the FILE WE JUDGED, not one the holder replaced in
        // between. This is the compensating control for the unavoidable gap
        // between judging a lock and acting on its path: a lock steal is
        // check-then-act by nature, so the check is re-proved after the act.
        // Identity is the inode, not the timestamp — a replacement written inside
        // the same millisecond carries a different inode but can carry the same
        // mtime. On a mismatch the holder was alive after all, so put it back:
        // `link` refuses when the path is occupied, which is the right answer,
        // since a contender that already took it must not be clobbered.
          try {
            const moved = await stat(stolen);
            if (moved.ino !== inode || moved.mtimeMs !== mtimeMs) {
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
          return { bestEffort: true, waitedMs: Date.now() - start, inode: -1, refresh: async () => {}, release: async () => {} };
        }
        // Never sleep while owning the namespace gate: doing so makes N waiters
        // hold it for N × POLL_MS and can starve the live holder's release.
      }
    } finally {
      await releaseGate();
    }
    await sleep(POLL_MS);
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
  const result = await acquireLockAt(decisionsDir(rootPath), DECISIONS_LOCK_FILE, {
    bestEffortAfterMaxWait: false,
    maxWaitMs: Number.POSITIVE_INFINITY,
  });
  if (isLockHeld(result)) throw new Error('decision lock acquisition ended without ownership');
  return result.release;
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
  const result = await acquireLockAt(analysisDir, ANALYSIS_LOCK_FILE, {
    bestEffortAfterMaxWait: false,
    maxWaitMs: Number.POSITIVE_INFINITY,
  });
  if (isLockHeld(result)) throw new Error('analysis lock acquisition ended without ownership');
  return result.release;
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
    const handle = await open(lockPath, 'r');
    try {
      const [s, contents] = await Promise.all([handle.stat(), handle.readFile('utf8')]);
      return !defaultIsStale(s.mtimeMs, contents);
    } finally {
      await handle.close();
    }
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
  OWNERSHIP_HEARTBEAT_STALE_MS,
  POLL_MS,
  STALE_MS,
};
