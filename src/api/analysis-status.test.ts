/**
 * `openloreAnalysisStatus` (change: extend-api-for-supervising-hosts).
 *
 * Two facts carry this read. A LIVE foreign owner must be reported with its metadata without the
 * caller acquiring anything — the whole point is to learn "another process is analyzing" without
 * provoking the error that used to be the only way to learn it. A STALE lock must report the same
 * verdict `acquireAnalysisOwnership` reaches on the identical bytes: a crashed holder is not an
 * analysis in progress, and this read must not be the one place that disagrees.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { openloreAnalysisStatus } from './analysis-status.js';
import { OPENLORE_ANALYSIS_REL_PATH } from '../constants.js';
import {
  acquireAnalysisOwnership,
  isOwnershipStale,
  progressPathOf,
  runtimeDirOf,
  type AnalysisOwnerPayload,
} from '../core/runtime/analysis-ownership.js';

const OWNERSHIP_LOCK_FILE = '.analysis-owner.lock';
/** Older than `OWNERSHIP_HEARTBEAT_STALE_MS` (90s) by a margin no clock skew closes. */
const STALE_AGE_MS = 10 * 60_000;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<{ root: string; analysisDir: string; runtimeDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'openlore-analysis-status-'));
  dirs.push(dir);
  // Symlink-resolved, because the API resolves its root the same way (macOS /tmp → /private/tmp)
  // and the staleness predicate compares the payload's repository against it.
  const root = realpathSync(dir);
  const analysisDir = join(root, OPENLORE_ANALYSIS_REL_PATH);
  const runtimeDir = runtimeDirOf(analysisDir);
  await mkdir(runtimeDir, { recursive: true });
  return { root, analysisDir, runtimeDir };
}

/** Plant an ownership lock exactly as `acquireAnalysisOwnership` writes it. */
async function plantLock(
  runtimeDir: string,
  payload: AnalysisOwnerPayload,
  ageMs = 0,
): Promise<string> {
  const lockPath = join(runtimeDir, OWNERSHIP_LOCK_FILE);
  await writeFile(lockPath, JSON.stringify(payload), 'utf8');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(lockPath, when, when);
  }
  return lockPath;
}

/** A PID that has certainly exited — the honest way to simulate a crashed holder. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>(resolve => child.on('exit', () => resolve()));
  return pid;
}

describe('openloreAnalysisStatus', () => {
  it('reports no analysis in progress when nothing owns the repository', async () => {
    const { root } = await workspace();
    await expect(openloreAnalysisStatus({ rootPath: root })).resolves.toEqual({ inProgress: false });
  });

  it('reports a live foreign owner with its owner payload, elapsed time and heartbeat age', async () => {
    const { root, analysisDir, runtimeDir } = await workspace();
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const payload: AnalysisOwnerPayload = {
      repository: root,
      // A live PID this process does not own the lock for: `readAnalysisOwner` never checks who
      // asks, so the current process stands in for a foreign live holder.
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date().toISOString(),
      stage: 'call-graph',
      progressPath: progressPathOf(analysisDir),
    };
    await plantLock(runtimeDir, payload);

    const status = await openloreAnalysisStatus({ rootPath: root });

    expect(status.inProgress).toBe(true);
    expect(status.owner).toEqual(payload);
    expect(status.elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(status.heartbeatAgeMs).toBeGreaterThanOrEqual(0);
    expect(status.heartbeatAgeMs).toBeLessThan(60_000);
  });

  it('acquires, steals or awaits nothing — the lock and the runtime directory are untouched', async () => {
    const { root, analysisDir, runtimeDir } = await workspace();
    const payload: AnalysisOwnerPayload = {
      repository: root,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      stage: 'parsing',
      progressPath: progressPathOf(analysisDir),
    };
    const lockPath = await plantLock(runtimeDir, payload);
    const before = await readFile(lockPath, 'utf8');
    const entriesBefore = (await readdir(runtimeDir)).sort();

    // Two consecutive reads: a read that quietly reclaimed would change the second answer.
    const first = await openloreAnalysisStatus({ rootPath: root });
    const second = await openloreAnalysisStatus({ rootPath: root });

    expect(first.inProgress).toBe(true);
    expect(second.owner).toEqual(payload);
    expect(await readFile(lockPath, 'utf8')).toBe(before);
    expect((await readdir(runtimeDir)).sort()).toEqual(entriesBefore);
  });

  it('reports no analysis in progress for a stale lock, matching how ownership acquisition classifies it', async () => {
    const { root, analysisDir, runtimeDir } = await workspace();
    const pid = await deadPid();
    const payload: AnalysisOwnerPayload = {
      repository: root,
      pid,
      startedAt: new Date(Date.now() - STALE_AGE_MS).toISOString(),
      heartbeatAt: new Date(Date.now() - STALE_AGE_MS).toISOString(),
      stage: 'parsing',
      progressPath: progressPathOf(analysisDir),
    };
    const lockPath = await plantLock(runtimeDir, payload, STALE_AGE_MS);

    // The same predicate the acquisition path supplies to the advisory-lock loop.
    expect(isOwnershipStale(Date.now() - STALE_AGE_MS, await readFile(lockPath, 'utf8'), root)).toBe(true);
    await expect(openloreAnalysisStatus({ rootPath: root })).resolves.toEqual({ inProgress: false });

    // And the real acquisition agrees: it reclaims the same lock instead of reporting in-progress.
    const ownership = await acquireAnalysisOwnership(root, analysisDir, { stage: 'test' });
    expect(ownership.state).toBe('owned');
    if (ownership.state === 'owned') await ownership.release();
  });

  it('reports no analysis in progress for an unresolvable root instead of throwing', async () => {
    const { root } = await workspace();
    await expect(openloreAnalysisStatus({ rootPath: join(root, 'does-not-exist') }))
      .resolves.toEqual({ inProgress: false });
  });
});
