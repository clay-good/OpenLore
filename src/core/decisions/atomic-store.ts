/**
 * Durable, concurrency-safe persistence primitives for the JSON stores.
 * (change: harden-memory-integrity-invariant)
 *
 * OpenLore's promise — *never serve an unverified or stale fact as
 * authoritative* — is only as strong as the durability of the files behind it.
 * Both stores (`.openlore/memory/notes.json`, `.openlore/decisions/pending.json`)
 * are single JSON files rewritten in full. Without these primitives:
 *
 *   - a crash mid-write leaves a torn file that loads as a silent empty store
 *     (memory vanishes, nothing says so), and
 *   - two concurrent writers race: last-writer-wins silently drops the other.
 *
 * This module supplies three stdlib-only primitives (no new dependency, no LLM):
 *
 *   1. {@link atomicWriteFile} — write to a temp file, fsync, then POSIX-rename
 *      into place. A crash before the rename leaves the prior store intact.
 *   2. {@link casUpdate} — optimistic compare-and-swap on a monotonic `sequence`:
 *      load → mutate → commit only if the on-disk sequence is unchanged; on a
 *      conflict, re-read and re-apply the (append/supersede) merge rather than
 *      clobber. No concurrent write is lost.
 *   3. {@link quarantineCorrupt} — move a store that fails validation aside to
 *      `*.corrupt-<n>` and signal it, instead of silently substituting empty.
 */

import { open, rename, unlink, mkdir, access, link, stat } from 'node:fs/promises';
import { constants, linkSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { acquireLockAt, isLockHeld } from '../runtime/advisory-lock.js';

/** Any persisted store that carries the monotonic CAS counter. */
export interface SequencedStore {
  sequence?: number;
}

// Monotonic per-process counter so two concurrent writers to the SAME path never
// share a temp filename (which would let one truncate the other's temp before its
// rename). Combined with the pid it is unique per in-flight write.
let tmpCounter = 0;

/**
 * Backoff for a rename that lost a race with another handle on the destination.
 *
 * POSIX `rename(2)` replaces the destination unconditionally. Windows does not:
 * `MoveFileExW(REPLACE_EXISTING)` returns `EPERM`/`EACCES`/`EBUSY` while ANY other
 * handle is open on the target. The window is milliseconds wide and the operation is
 * idempotent (the temp file is still there, fully fsync'd), so the correct response
 * is to wait and try again.
 *
 * WHO holds it is usually US, not an antivirus — measured on Windows 11 / Node 26
 * while investigating issue #457, after an earlier version of this note guessed at a
 * scanner and sent the investigation the wrong way:
 *
 *   - every open shape blocks it, `O_RDONLY` included (so `readFileConfined`'s
 *     `O_NOFOLLOW` is not special), and
 *   - `FILE_SHARE_DELETE` does NOT rescue it. A reader that explicitly grants
 *     share-delete still blocks the replace, so there is no share mode a reader can
 *     adopt to make this go away.
 *
 * That second point is why this ladder is the ARCHITECTURE and not a workaround: with
 * nothing to fix on the read side, waiting for our own reader to close its descriptor
 * is the only way through. Any concurrent read of the artifact — a tool call serving
 * `llm-context.json` while the watcher publishes it — can cost a publish this way.
 *
 * Observed, not theorised: a Windows CI runner produced
 * `EPERM: operation not permitted, rename '….llm-context.json.tmp-…' -> '…llm-context.json'`
 * on the watcher's artifact write, which left the artifact at its previous
 * content — one of the two mechanisms behind issue #451.
 *
 * These codes essentially never occur for a same-directory rename on POSIX, so
 * this changes nothing there. The retries are bounded and the ORIGINAL error is
 * rethrown when they run out: a genuine permission problem still fails, loudly
 * and with its real message.
 *
 * The ~3.2s ceiling is dimensioned against the tail, not the median: a Defender
 * hold on a small just-written file is usually 10-100ms, but a first-touch scan
 * or a cloud-lookup can run far longer, and the machine that reported #451 was a
 * loaded one. It is deliberately far below the commit lock's own limits — 10s
 * before a lock is even a stale candidate, 30s before a waiter gives up — so a
 * writer that spends its whole budget still cannot cause a lock timeout or a
 * steal. (`graceful-fs` retries this same Windows class for 60s; that is sized
 * for arbitrary third-party writes, not for a section under our own lock.)
 */
const RENAME_CONTENTION_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800, 1600] as const;

const isRenameContention = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
};

/**
 * NOT unref'd — deliberately, and unlike the watcher's SQLite backoff.
 *
 * This sleep sits between a fsync'd temp file and its commit rename. An unref'd
 * timer does not hold the event loop open, so if this were the last handle the
 * process would drain and exit 0 with the promise never settling: the caller's
 * `await` never resumes, the `finally` that removes the temp never runs, and any
 * commit lock above is never released. That is a silently dropped write in the
 * one module whose stated contract is that no write is ever silently lost. The
 * watcher's backoff can afford to be unref'd because dropping it only defers a
 * batch; this cannot. The added liveness is bounded by the ladder above.
 */
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** {@link rename}, retried while the destination is briefly held by another handle. */
async function renameWithContentionRetry(tmp: string, path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const delay = RENAME_CONTENTION_DELAYS_MS[attempt];
      if (delay === undefined || !isRenameContention(err)) throw err;
      await sleepMs(delay);
    }
  }
}

/**
 * Write `data` to `path` atomically. The data goes to a sibling temp file, is
 * flushed to disk (`fsync`), and is moved into place with a single atomic
 * `rename`. A crash or interruption before the rename leaves the previously
 * committed file untouched — never a partially written (torn) file.
 *
 * The rename is retried while the destination is held by another handle: see
 * {@link RENAME_CONTENTION_DELAYS_MS}. Atomicity is unaffected — each attempt is
 * the same single atomic replace.
 */
export async function atomicWriteFile(path: string, data: string, newFileMode = 0o666): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // Unique temp name per in-flight write (pid + monotonic counter): concurrent
  // writers to the same path — even outside the commit lock — never collide on a
  // shared temp file.
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${tmpCounter++}`);
  let renamed = false;
  let mode = newFileMode;
  try { mode = (await stat(path)).mode & 0o777; } catch { /* new file: respect process umask */ }
  try {
    const fh = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
    try {
      await fh.writeFile(data, 'utf-8');
      await fh.sync(); // durability barrier: bytes are on disk before the rename
    } finally {
      await fh.close();
    }
    await renameWithContentionRetry(tmp, path); // atomic replace
    renamed = true;
  } finally {
    // If we never renamed (write/sync threw), remove the orphaned temp so a failed
    // write does not litter the store directory.
    if (!renamed) await unlink(tmp).catch(() => {});
  }
  // Best-effort: fsync the directory so the rename (a metadata op) is durable
  // across a crash. POSIX allows fsync on a directory fd; platforms that reject it
  // (e.g. Windows) simply skip — the data fsync above already bounds the loss.
  try {
    const dh = await open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* directory fsync unsupported — skip */ }
}

// ── shared advisory lock for the tiny compare-and-write commit section ───────

// STALE < MAX_WAIT by design: a crashed holder's lock always becomes stealable
// (10s) well before a waiter gives up (30s), so a wait timeout means genuine
// sustained contention — implausible for these tiny critical sections — never a
// dead holder. On timeout we fail loud rather than write unlocked: for a store
// whose promise is "no write is lost," a rare surfaced error the caller can retry
// beats a rare silent lost update.
const LOCK_STALE_MS = 10_000; // steal a lock older than this (crashed holder)
const LOCK_MAX_WAIT_MS = 30_000;

// Globally-unique-among-live-holders lock token: pid is unique across concurrent
// processes, the counter across concurrent in-process acquires.
let lockSeq = 0;

/**
 * Run `fn` while holding a per-file advisory lock (exclusive-create lockfile,
 * polled, with stale-steal for a confirmed-dead holder). The lock guards only the brief
 * compare-and-write commit, so contention is minimal. On a wait timeout it throws
 * rather than proceed unlocked. The lock carries an ownership token and is released
 * with one atomic unlink. A live holder is never stolen merely because its mtime
 * is old, so no cooperating successor can replace the path before that unlink.
 */
async function withCommitLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const token = `${process.pid}-${lockSeq++}`;
  const result = await acquireLockAt(dirname(lockPath), basename(lockPath), {
    payload: () => token,
    isStale: (mtimeMs, contents) => {
      if (Date.now() - mtimeMs <= LOCK_STALE_MS) return false;
      const ownerPid = Number.parseInt(contents.split('-', 1)[0] ?? '', 10);
      if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
      try {
        process.kill(ownerPid, 0);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code !== 'EPERM';
      }
    },
    bestEffortAfterMaxWait: false,
    maxWaitMs: LOCK_MAX_WAIT_MS,
  });
  if (isLockHeld(result)) {
    throw new Error(
      `store lock: timed out after ${LOCK_MAX_WAIT_MS}ms waiting for ${lockPath} ` +
        `(sustained write contention) — retry the operation`,
    );
  }
  try {
    return await fn();
  } finally {
    await result.release();
  }
}

/**
 * Atomically read-modify-write a sequenced JSON store. The load → mutate →
 * write happens entirely inside the per-store advisory lock, so the lock — not an
 * optimistic sequence guard — is the real serialization point: `mutate` always
 * runs against the freshest on-disk store, and a competing write cannot interleave
 * between the read and the write. The monotonic `sequence` is still bumped (it
 * orders writes, names quarantine files, and lets external readers detect change),
 * but correctness no longer depends on every writer honoring it.
 *
 * `mutate` MUST be a pure merge over the loaded store (append / id-keyed
 * upsert / supersede) so that applying it to the latest store is always correct.
 * ALL writers of a given store MUST go through this function (or a wrapper of it)
 * — a raw, lock-free write to the same path defeats the serialization.
 */
export async function casUpdate<T extends SequencedStore>(opts: {
  storePath: string;
  load: () => Promise<T>;
  mutate: (current: T) => T;
  serialize: (next: T) => string;
}): Promise<T> {
  const lockPath = `${opts.storePath}.lock`;
  return withCommitLock(lockPath, async () => {
    const current = await opts.load(); // fresh read inside the lock
    const next = { ...opts.mutate(current), sequence: (current.sequence ?? 0) + 1 } as T;
    await atomicWriteFile(opts.storePath, opts.serialize(next));
    return next;
  });
}

// ── corrupt-store quarantine ──────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/**
 * Move a store that failed validation aside to a deterministic quarantine path
 * `${path}.corrupt-<n>` and emit a recoverable signal, instead of silently
 * substituting an empty store (which would present absence as current fact).
 *
 * The suffix is the first free non-negative integer — derived from what is already
 * on disk, never wall-clock time — so recovery is reproducible. The claim is atomic
 * (a hard link that fails if the destination exists), so two concurrent loaders can
 * never overwrite each other's quarantine file and lose preserved bytes. Returns the
 * quarantine path, or `null` when the move was unnecessary or impossible (caller
 * still degrades to empty, but loudly).
 */
export async function quarantineCorrupt(path: string, reason: string): Promise<string | null> {
  try {
    for (let n = 0; ; n++) {
      const dest = `${path}.corrupt-${n}`;
      try {
        // Atomic claim: link succeeds only if `dest` does not yet exist, so a
        // racing loader that took this `n` is never overwritten.
        await link(path, dest);
        await unlink(path); // link + unlink = move-without-clobber
        logger.warning(
          `store quarantine: ${path} failed validation (${reason}) — moved to ${dest}. ` +
            `Persisted data was NOT silently dropped; inspect or restore the quarantined file.`,
        );
        return dest;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue; // a prior quarantine took this n — try the next
        if (code === 'ENOENT') {
          // `path` is already gone — a concurrent loader quarantined it first, so the
          // bytes are preserved under its own suffix. Not a loss.
          logger.warning(
            `store quarantine: ${path} was already moved aside by a concurrent loader (${reason}).`,
          );
          return null;
        }
        if (code === 'EPERM' || code === 'ENOSYS' || code === 'EXDEV' || code === 'EMLINK') {
          // Hard links unsupported on this filesystem — fall back to a plain rename
          // to the first free suffix (loses the atomic-claim guarantee, but such
          // filesystems are rare and concurrent corrupt-loads rarer still).
          let m = 0;
          while (await exists(`${path}.corrupt-${m}`)) m++;
          const dest2 = `${path}.corrupt-${m}`;
          await rename(path, dest2);
          logger.warning(
            `store quarantine: ${path} failed validation (${reason}) — moved to ${dest2}. ` +
              `Persisted data was NOT silently dropped; inspect or restore the quarantined file.`,
          );
          return dest2;
        }
        throw err;
      }
    }
  } catch (err) {
    logger.warning(
      `store quarantine: ${path} failed validation (${reason}) and could not be moved aside ` +
        `(${(err as Error).message}). Starting from an empty store.`,
    );
    return null;
  }
}

/**
 * Synchronous sibling of {@link quarantineCorrupt}, for callers whose store engine is
 * itself synchronous (the SQLite graph store opens via `node:sqlite`'s `DatabaseSync`,
 * so its open path cannot await). Same discipline, same on-disk shape: move the
 * unreadable file aside to `${path}.corrupt-<n>` (first free integer suffix, derived
 * from on-disk state — never wall-clock), claimed atomically via a hard link that
 * fails when the destination exists, so two concurrent loaders never overwrite each
 * other's quarantine and lose preserved bytes. Also moves the WAL/SHM siblings when
 * present. Returns the quarantine path, or `null` when the move was unnecessary or
 * impossible (caller still degrades honestly, never silently empty).
 */
export function quarantineCorruptSync(path: string, reason: string): string | null {
  try {
    for (let n = 0; ; n++) {
      const dest = `${path}.corrupt-${n}`;
      try {
        // Atomic claim: link succeeds only if `dest` does not yet exist, so a
        // racing loader that took this `n` is never overwritten.
        linkSync(path, dest);
        unlinkSync(path); // link + unlink = move-without-clobber
        moveSiblingsSync(path, dest);
        logger.warning(
          `store quarantine: ${path} failed to open (${reason}) — moved to ${dest}. ` +
            `Persisted data was NOT silently dropped; inspect or restore the quarantined file.`,
        );
        return dest;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue; // a prior quarantine took this n — try the next
        if (code === 'ENOENT') {
          // `path` is already gone — a concurrent loader quarantined it first, so the
          // bytes are preserved under its own suffix. Not a loss.
          logger.warning(
            `store quarantine: ${path} was already moved aside by a concurrent loader (${reason}).`,
          );
          return null;
        }
        if (code === 'EPERM' || code === 'ENOSYS' || code === 'EXDEV' || code === 'EMLINK') {
          // Hard links unsupported on this filesystem — fall back to a plain rename
          // to the first free suffix (loses the atomic-claim guarantee, but such
          // filesystems are rare and concurrent corrupt-loads rarer still).
          let m = 0;
          while (existsSync(`${path}.corrupt-${m}`)) m++;
          const dest2 = `${path}.corrupt-${m}`;
          renameSync(path, dest2);
          moveSiblingsSync(path, dest2);
          logger.warning(
            `store quarantine: ${path} failed to open (${reason}) — moved to ${dest2}. ` +
              `Persisted data was NOT silently dropped; inspect or restore the quarantined file.`,
          );
          return dest2;
        }
        throw err;
      }
    }
  } catch (err) {
    logger.warning(
      `store quarantine: ${path} failed to open (${reason}) and could not be moved aside ` +
        `(${(err as Error).message}). Starting from an empty store.`,
    );
    return null;
  }
}

/**
 * Best-effort move of a SQLite store's WAL/SHM sidecars alongside the quarantined main
 * file, so a later reopen of `path` cannot resurrect a torn write-ahead log against a
 * fresh database. Failures are swallowed — the sidecars are recoverable state, and the
 * main file is already safely aside.
 */
function moveSiblingsSync(path: string, dest: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try {
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${dest}${suffix}`);
    } catch {
      /* sidecar move is best-effort */
    }
  }
}
