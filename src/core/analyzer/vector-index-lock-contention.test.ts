/**
 * Contention on the index mutation lock (change: make-index-self-state-honest).
 *
 * The behavior under test is what 2026-09-20 produced: a second `analyze --force`
 * collided with a running build, wrote a keyword-only index and exited 0. Contention
 * must be a typed, named outcome — and a lock whose owner is gone must be reclaimed,
 * out loud, instead of refusing writes for weeks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VectorIndexLockContendedError,
  _withVectorIndexMutationForTesting as withMutation,
} from './vector-index.js';

const LOCK_FILE = '.vector-index.lock';
// Above every platform's pid ceiling, so it names a process that cannot be running.
const DEAD_PID = 4_000_000;

describe('vector index mutation lock — contention is never a silent downgrade', () => {
  let dir: string;
  // The lock loop resolves its directory, and on macOS the temp root is a symlink
  // (/var -> /private/var). Compare against the resolved path the lock actually uses.
  let resolvedDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-index-lock-'));
    resolvedDir = realpathSync.native(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeLock = async (payload: string, ageMs = 0): Promise<string> => {
    const lockPath = join(dir, LOCK_FILE);
    await writeFile(lockPath, payload, { mode: 0o600 });
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      await utimes(lockPath, when, when);
    }
    return lockPath;
  };

  it('fails with the holder pid and the lock age instead of degrading', async () => {
    // The current process is alive by construction, so this is a live holder.
    const lockPath = await writeLock(`${process.pid} ${new Date(Date.now() - 45_000).toISOString()}`, 45_000);
    let ran = false;

    const error = await withMutation(dir, async () => { ran = true; }).catch((e: unknown) => e);

    expect(ran).toBe(false);
    expect(error).toBeInstanceOf(VectorIndexLockContendedError);
    const contended = error as VectorIndexLockContendedError;
    expect(contended.holderPid).toBe(process.pid);
    expect(contended.ageMs).toBeGreaterThanOrEqual(40_000);
    expect(contended.lockPath).toBe(join(resolvedDir, LOCK_FILE));
    expect(lockPath.endsWith(LOCK_FILE)).toBe(true);
    expect(contended.message).toContain(`pid ${process.pid}`);
    expect(contended.message).toMatch(/held for 4\ds/);
  });

  it('discloses a lock that names no process at all', async () => {
    await writeLock('committed-by-accident', 5_000);

    const error = await withMutation(dir, async () => undefined).catch((e: unknown) => e) as VectorIndexLockContendedError;

    expect(error).toBeInstanceOf(VectorIndexLockContendedError);
    expect(error.holderPid).toBeNull();
    expect(error.disclosure).toBeDefined();
    expect(error.message).toContain('does not name');
  });

  it('reclaims a lock whose owner is dead, and says so', async () => {
    // Old enough to clear the staleness window AND naming a pid that cannot be running:
    // both conditions are required before the shared loop will steal a lock.
    await writeLock(`${DEAD_PID} ${new Date(Date.now() - 300_000).toISOString()}`, 300_000);
    const reclaimed: string[] = [];

    const result = await withMutation(dir, async () => 'built', {
      onReclaimed: lockPath => { reclaimed.push(lockPath); },
    });

    expect(result).toBe('built');
    expect(reclaimed).toEqual([join(resolvedDir, LOCK_FILE)]);
  });

  it('waits for a live holder when the caller asked to wait', async () => {
    const lockPath = await writeLock(`${process.pid} ${new Date().toISOString()}`);
    // Release the lock shortly after the waiter starts polling.
    const release = setTimeout(() => { void rm(lockPath, { force: true }); }, 250);

    try {
      const result = await withMutation(dir, async () => 'built', { contention: 'wait', maxWaitMs: 10_000 });
      expect(result).toBe('built');
    } finally {
      clearTimeout(release);
    }
  });

  it('does not reclaim silently: an uncontended acquire reports no reclamation', async () => {
    const reclaimed: string[] = [];

    await withMutation(dir, async () => undefined, { onReclaimed: lockPath => { reclaimed.push(lockPath); } });

    expect(reclaimed).toEqual([]);
  });
});
