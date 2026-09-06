/**
 * Locked, crash-recoverable publication of an agent configuration file OpenLore
 * does NOT own.
 *
 * `confinedAtomicWriteFile`'s compare-and-swap branch is not a plain rename: it
 * moves the current target aside to a guarded sibling, verifies the captured
 * identity, then publishes with a no-replace hard link. That sequence is only safe
 * for a caller that (a) serializes against other OpenLore processes and (b) leaves
 * a recovery journal, so an interrupted publication can be completed instead of
 * leaving the target missing. The primitive's own contract says exactly that.
 *
 * `openlore setup` already did this correctly for Claude Code's hook settings.
 * `openlore install` needs the identical guarantee for the user-scope footprint —
 * `~/.claude.json` is Claude Code's live account state — so the machinery lives
 * here, shared, rather than being reimplemented (change:
 * unify-onboarding-entrypoint).
 */

import { createHash } from 'node:crypto';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireLockAt, isLockHeld } from '../../core/runtime/advisory-lock.js';
import { recoverConfinedAtomicWriteFile } from '../../utils/path-confinement.js';

const SETTINGS_RUNTIME_OVERRIDE = 'OPENLORE_SETTINGS_RUNTIME_DIR';

/**
 * A private, per-user, durable directory for lock and journal files.
 *
 * Deliberately not the shared OS temporary namespace: the journal is what makes an
 * interrupted publication recoverable, so it has to outlive a reboot and must not
 * be writable by another user. Every path component is verified to be a real,
 * user-owned, 0700 directory.
 */
export async function verifiedSettingsCoordinationDir(): Promise<string> {
  const override = process.env[SETTINGS_RUNTIME_OVERRIDE];
  if (override) {
    const requested = resolve(override);
    try { await mkdir(requested, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(requested);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${requested} is not a real directory`);
    const canonical = await realpath(requested);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new Error(`${requested} is not owned by the current user`);
    }
    if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700) {
      throw new Error(`${requested} must already have mode 0700`);
    }
    return canonical;
  }

  const canonicalHome = await realpath(homedir());
  let current = canonicalHome;
  for (const segment of ['.openlore', 'runtime', 'settings-writes']) {
    current = join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${current} is not a real directory`);
    if (await realpath(current) !== current) throw new Error(`${current} contains a symbolic-link path component`);
  }
  const info = await lstat(current);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`${current} is not owned by the current user`);
  }
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700) {
    throw new Error(`${current} must have mode 0700`);
  }
  return current;
}

export interface GuardedWriteFailure {
  /** Why the mutation did not run, in one sentence, for the caller to surface. */
  reason: string;
}

/**
 * Run `mutate` while holding this file's per-user lock, after completing any
 * interrupted publication of it.
 *
 * The lock is keyed by the target path, so two OpenLore processes writing the same
 * file serialize, and processes writing different files do not. Returns the
 * mutation's own result, or a {@link GuardedWriteFailure} when the lock or the
 * coordination directory was unavailable — never a silent success.
 */
export async function withGuardedConfigWrite<T>(
  root: string,
  targetPath: string,
  mutate: (recoveryJournalPath: string) => Promise<T>,
): Promise<T | GuardedWriteFailure> {
  const lockName = `.openlore-claude-settings-${createHash('sha256').update(targetPath).digest('hex').slice(0, 24)}.lock`;
  let coordinationDir: string;
  try {
    coordinationDir = await verifiedSettingsCoordinationDir();
  } catch (error) {
    return { reason: `OpenLore's private runtime directory is unavailable (${(error as Error).message})` };
  }
  const recoveryJournalPath = join(coordinationDir, `${lockName}.journal`);
  let lock: Awaited<ReturnType<typeof acquireLockAt>>;
  try {
    lock = await acquireLockAt(coordinationDir, lockName, { maxWaitMs: 5_000 });
  } catch (error) {
    return { reason: `its lock could not be acquired (${(error as Error).message})` };
  }
  if (isLockHeld(lock)) {
    return { reason: 'another OpenLore process is writing it' };
  }
  try {
    // Complete any publication a previous run was interrupted mid-way through,
    // BEFORE reading or writing. Without this, a crash in the guarded window
    // leaves the target missing and nothing ever puts it back.
    //
    // NOTE for callers: this can CHANGE the target — that is its whole job — so any
    // snapshot taken before the lock may be stale by the time `mutate` runs.
    // `mutate` must re-observe the file itself.
    await recoverConfinedAtomicWriteFile(root, targetPath, recoveryJournalPath);
    return await mutate(recoveryJournalPath);
  } finally {
    await lock.release();
  }
}

/** Type guard for the failure branch of {@link withGuardedConfigWrite}. */
export function isGuardedWriteFailure(value: unknown): value is GuardedWriteFailure {
  return typeof value === 'object' && value !== null && typeof (value as GuardedWriteFailure).reason === 'string'
    && Object.keys(value as object).length === 1;
}
