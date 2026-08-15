import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OWNERSHIP_HEARTBEAT_STALE_MS, OWNERSHIP_LOCK_FILE } from './advisory-lock.js';
import {
  PROGRESS_INTERVAL_MS,
  acquireAnalysisOwnership,
  isOwnershipStale,
  isProcessAlive,
  progressPathOf,
  readAnalysisOwner,
  readAnalysisProgress,
  runtimeDirOf,
  type AnalysisOwnership,
} from './analysis-ownership.js';

const roots: string[] = [];
const opened: Array<AnalysisOwnership & { state: 'owned' }> = [];

afterEach(async () => {
  for (const held of opened.splice(0)) await held.release().catch(() => {});
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.useRealTimers();
});

async function fixture(): Promise<{ root: string; analysisDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-ownership-'));
  roots.push(root);
  const analysisDir = join(root, '.openlore', 'analysis');
  await mkdir(analysisDir, { recursive: true });
  return { root, analysisDir };
}

async function own(root: string, analysisDir: string, options?: { wait?: boolean }) {
  const result = await acquireAnalysisOwnership(root, analysisDir, options);
  if (result.state === 'owned') opened.push(result);
  return result;
}

/** Write a lock file by hand to simulate another process's ownership. */
async function plantOwner(
  analysisDir: string,
  payload: Record<string, unknown>,
  ageMs = 0,
): Promise<string> {
  const dir = runtimeDirOf(analysisDir);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, OWNERSHIP_LOCK_FILE);
  await writeFile(lockPath, JSON.stringify(payload), 'utf8');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    const { utimes } = await import('node:fs/promises');
    await utimes(lockPath, when, when);
  }
  return lockPath;
}

const livePayload = (repository: string, analysisDir: string, overrides: Record<string, unknown> = {}) => ({
  repository, pid: process.pid, startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(), stage: 'artifacts',
  progressPath: progressPathOf(analysisDir), ...overrides,
});

// ============================================================================
// SINGLE FLIGHT
// ============================================================================

describe('analysis ownership — single flight', () => {
  it('grants ownership to the first caller and reports the owner to the rest', async () => {
    const { root, analysisDir } = await fixture();
    const first = await own(root, analysisDir);
    expect(first.state).toBe('owned');

    // Five concurrent invocations: exactly one owns, four report — none analyzes.
    const contenders = await Promise.all(
      Array.from({ length: 5 }, () => acquireAnalysisOwnership(root, analysisDir)),
    );
    expect(contenders.every(result => result.state === 'in-progress')).toBe(true);
    for (const contender of contenders) {
      if (contender.state !== 'in-progress') throw new Error('unreachable');
      expect(contender.owner?.pid).toBe(process.pid);
      expect(contender.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('releases ownership so the next caller can take it', async () => {
    const { root, analysisDir } = await fixture();
    const first = await own(root, analysisDir);
    if (first.state !== 'owned') throw new Error('expected ownership');
    await first.release();

    const second = await own(root, analysisDir);
    expect(second.state).toBe('owned');
  });

  it('an attach reports how long it waited, so the caller can skip redundant work', async () => {
    const { root, analysisDir } = await fixture();
    const first = await own(root, analysisDir);
    if (first.state !== 'owned') throw new Error('expected ownership');
    expect(first.waitedMs).toBe(0);

    const attaching = acquireAnalysisOwnership(root, analysisDir, { wait: true });
    await new Promise(resolve => setTimeout(resolve, 400));
    await first.release();

    const attached = await attaching;
    if (attached.state !== 'owned') throw new Error('an attach must acquire once the owner releases');
    // Non-zero means a previous owner just finished: `analyze --wait` re-checks
    // freshness on this signal instead of running a second full analysis.
    expect(attached.waitedMs).toBeGreaterThan(0);
    await attached.release();
  }, 15_000);

  it('never proceeds unlocked: a live owner is reported, not bypassed', async () => {
    const { root, analysisDir } = await fixture();
    await plantOwner(analysisDir, livePayload(root, analysisDir));
    const contender = await acquireAnalysisOwnership(root, analysisDir);
    expect(contender.state).toBe('in-progress');
  });
});

// ============================================================================
// RECLAMATION
// ============================================================================

describe('analysis ownership — reclamation', () => {
  it('reclaims a lock whose owner is dead AND whose heartbeat is stale', async () => {
    const { root, analysisDir } = await fixture();
    // PID 2^22 is above every platform's default pid_max, so it cannot be alive.
    await plantOwner(analysisDir, livePayload(root, analysisDir, { pid: 4_194_303 }), 120_000);

    const result = await own(root, analysisDir);
    expect(result.state).toBe('owned');
  });

  it('does NOT reclaim a live owner merely because time has passed', () => {
    const stale = isOwnershipStale(
      Date.now() - 10 * 60_000,
      JSON.stringify(livePayload('/repo', '/repo/.openlore/analysis')),
      '/repo',
    );
    // The PID is this very process, so the owner is alive: a long analysis is not
    // an abandoned one.
    expect(stale).toBe(false);
  });

  it('does NOT reclaim a dead owner whose heartbeat is still fresh', () => {
    const stale = isOwnershipStale(
      Date.now(),
      JSON.stringify({ repository: '/repo', pid: 4_194_303, startedAt: new Date().toISOString() }),
      '/repo',
    );
    expect(stale).toBe(false);
  });

  it('fails closed after prolonged silence when the PID still looks alive', () => {
    // Silence cannot distinguish a recycled PID from a live but wedged owner.
    // Requiring manual cleanup is safer than authorizing a concurrent writer.
    const live = JSON.stringify(livePayload('/repo', '/repo/.openlore/analysis'));
    expect(isOwnershipStale(Date.now() - OWNERSHIP_HEARTBEAT_STALE_MS * 100, live, '/repo')).toBe(false);
    expect(isOwnershipStale(Date.now() - OWNERSHIP_HEARTBEAT_STALE_MS - 1_000, live, '/repo')).toBe(false);
  });

  it('never reclaims another repository, however long it has been silent', () => {
    const other = JSON.stringify(livePayload('/somewhere/else', '/somewhere/else/.openlore/analysis'));
    expect(isOwnershipStale(Date.now() - OWNERSHIP_HEARTBEAT_STALE_MS * 100, other, '/repo')).toBe(false);
  });

  it('defends against PID reuse by requiring a repository match', () => {
    // A stale heartbeat whose payload names a DIFFERENT repository is not ours to
    // reclaim, even though the pid may now belong to an unrelated live process.
    const stale = isOwnershipStale(
      Date.now() - 10 * 60_000,
      JSON.stringify({ repository: '/other-repo', pid: 4_194_303, startedAt: new Date().toISOString() }),
      '/repo',
    );
    expect(stale).toBe(false);
  });

  it('fails closed for a stale lock whose ownership payload is unparseable', () => {
    expect(isOwnershipStale(Date.now() - 10 * 60_000, 'not json at all', '/repo')).toBe(false);
  });

  it('treats an obviously invalid pid as not alive', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

// ============================================================================
// PROGRESS AND HEARTBEAT
// ============================================================================

describe('analysis ownership — progress sidecar', () => {
  it('publishes a progress sidecar on acquire and removes it on release', async () => {
    const { root, analysisDir } = await fixture();
    const held = await own(root, analysisDir);
    if (held.state !== 'owned') throw new Error('expected ownership');

    expect(await readAnalysisProgress(analysisDir)).toMatchObject({ stage: 'starting', percent: null });
    await held.release();
    expect(await readAnalysisProgress(analysisDir)).toBeNull();
  });

  it('advances the stage and refreshes the lock heartbeat together', async () => {
    const { root, analysisDir } = await fixture();
    const held = await own(root, analysisDir);
    if (held.state !== 'owned') throw new Error('expected ownership');

    const lockPath = join(runtimeDirOf(analysisDir), OWNERSHIP_LOCK_FILE);
    const before = (await stat(lockPath)).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 10));
    await held.update('artifacts', { percent: 75, detail: 'Generating analysis artifacts' });

    expect(await readAnalysisProgress(analysisDir)).toMatchObject({
      stage: 'artifacts', percent: 75, detail: 'Generating analysis artifacts',
    });
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(await readFile(lockPath, 'utf8')).stage).toBe('artifacts');
  });

  it('keeps runtime state OUT of the analysis artifact directory', async () => {
    const { root, analysisDir } = await fixture();
    await own(root, analysisDir);
    expect(runtimeDirOf(analysisDir).startsWith(analysisDir)).toBe(false);
    expect(progressPathOf(analysisDir).startsWith(analysisDir)).toBe(false);
  });

  it('refreshes the heartbeat inside a stage that never calls update', async () => {
    // The regression this pins: stages publish at their BOUNDARIES, so a single
    // long stage (artifact generation on a big repo) left the heartbeat frozen for
    // minutes. Observed live — 80s+ of an unchanged `heartbeatAt` while the owner
    // was healthily working, which makes `status` and a contending `analyze` report
    // an owner that looks abandoned. The test below drives NO update at all.
    vi.useFakeTimers();
    const { root, analysisDir } = await fixture();
    const held = await own(root, analysisDir);
    if (held.state !== 'owned') throw new Error('expected ownership');
    await held.update('artifacts', { percent: 75, detail: 'Generating analysis artifacts' });

    const lockPath = join(runtimeDirOf(analysisDir), OWNERSHIP_LOCK_FILE);
    const before = JSON.parse(await readFile(lockPath, 'utf8')).heartbeatAt as string;

    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS + 500);

    const after = JSON.parse(await readFile(lockPath, 'utf8')) as { heartbeatAt: string; stage: string };
    expect(Date.parse(after.heartbeatAt)).toBeGreaterThan(Date.parse(before));
    // The beat re-stamps the CURRENT stage and its detail — it must not blank the
    // sidecar back to "nothing known" just because no boundary was crossed.
    expect(after.stage).toBe('artifacts');
    expect(await readAnalysisProgress(analysisDir)).toMatchObject({
      stage: 'artifacts', percent: 75, detail: 'Generating analysis artifacts',
    });
  });

  it('stops beating once ownership is released', async () => {
    vi.useFakeTimers();
    const { root, analysisDir } = await fixture();
    const held = await own(root, analysisDir);
    if (held.state !== 'owned') throw new Error('expected ownership');
    await held.release();

    // A beat after release would recreate the lock file it just removed, silently
    // re-locking the repository against every other process.
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 3);
    await expect(stat(join(runtimeDirOf(analysisDir), OWNERSHIP_LOCK_FILE))).rejects.toThrow();
  });

  it('an 18-minute silent stage still refreshes on the caller cadence', async () => {
    const { root, analysisDir } = await fixture();
    const held = await own(root, analysisDir);
    if (held.state !== 'owned') throw new Error('expected ownership');

    // Simulate the owner's periodic refresh across a long unchanged phase: every
    // refresh must move the heartbeat, so the lock never looks abandoned.
    const lockPath = join(runtimeDirOf(analysisDir), OWNERSHIP_LOCK_FILE);
    for (let minute = 0; minute < 18; minute++) {
      await held.update('artifacts', { percent: 75, detail: `${minute}m elapsed` });
    }
    const contents = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(Date.now() - Date.parse(contents.heartbeatAt)).toBeLessThan(5_000);
    expect(await readAnalysisProgress(analysisDir)).toMatchObject({ detail: '17m elapsed' });
  });
});

// ============================================================================
// CROSS-PROCESS BEHAVIOR
// ============================================================================

/** Run a snippet in a real child process against this module. */
function runChild(source: string): ReturnType<typeof spawn> {
  const modulePath = new URL('./analysis-ownership.ts', import.meta.url).pathname;
  return spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source.replace('__MODULE__', modulePath)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

describe('analysis ownership — across processes', () => {
  it('a second PROCESS sees the first process as the owner', async () => {
    const { root, analysisDir } = await fixture();
    await own(root, analysisDir);

    const child = runChild(`
      const m = await import('__MODULE__');
      const result = await m.acquireAnalysisOwnership(${JSON.stringify(root)}, ${JSON.stringify(analysisDir)});
      process.stdout.write(JSON.stringify({ state: result.state, pid: result.owner?.pid ?? null }));
    `);
    const out = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      child.stdout?.on('data', chunk => { buffer += String(chunk); });
      child.on('error', reject);
      child.on('close', () => resolve(buffer));
    });

    expect(JSON.parse(out)).toEqual({ state: 'in-progress', pid: process.pid });
  }, 60_000);

  it('keeps beating while the owner blocks the event loop in a synchronous stage', async () => {
    // THE regression this whole watchdog exists for. Timers are event-loop
    // callbacks, so an in-thread `setInterval` cannot fire during a synchronous
    // CPU-bound stage — observed live as a 405s analysis whose heartbeat never
    // beat once. The child below acquires ownership and then busy-loops, never
    // yielding: only a beat from OUTSIDE that loop can move the timestamp.
    const { root, analysisDir } = await fixture();
    const child = runChild(`
      const m = await import('__MODULE__');
      await m.acquireAnalysisOwnership(${JSON.stringify(root)}, ${JSON.stringify(analysisDir)}, { heartbeatIntervalMs: 150 });
      process.stdout.write('owned');
      const until = Date.now() + 3000;
      while (Date.now() < until) { /* block the loop hard — no await, no I/O */ }
      process.exit(0);
    `);
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', chunk => { if (String(chunk).includes('owned')) resolve(); });
      child.on('error', reject);
      child.on('close', () => reject(new Error('child exited before taking ownership')));
    });

    const lockPath = join(runtimeDirOf(analysisDir), OWNERSHIP_LOCK_FILE);
    const first = JSON.parse(await readFile(lockPath, 'utf8')).heartbeatAt as string;
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const during = JSON.parse(await readFile(lockPath, 'utf8')).heartbeatAt as string;

    expect(Date.parse(during)).toBeGreaterThan(Date.parse(first));
    child.kill('SIGKILL');
  }, 60_000);

  it('a released lock is not resurrected by a beat that was already in flight', async () => {
    // Release used to fire-and-forget the worker stop and then unlink. A beat that
    // was already scheduled could land afterwards and RECREATE the lock file,
    // leaving the repository falsely owned by a process that had finished.
    const { root, analysisDir } = await fixture();
    const child = runChild(`
      const m = await import('__MODULE__');
      const held = await m.acquireAnalysisOwnership(${JSON.stringify(root)}, ${JSON.stringify(analysisDir)}, { heartbeatIntervalMs: 30 });
      await new Promise(r => setTimeout(r, 300));   // let several beats run
      await held.release();
      process.stdout.write('released');
      await new Promise(r => setTimeout(r, 600));   // any late beat would land here
      process.exit(0);
    `);
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', chunk => { if (String(chunk).includes('released')) resolve(); });
      child.on('error', reject);
      child.on('close', () => reject(new Error('child exited before releasing')));
    });

    const lockPath = join(runtimeDirOf(analysisDir), OWNERSHIP_LOCK_FILE);
    await new Promise(resolve => setTimeout(resolve, 500));
    await expect(stat(lockPath)).rejects.toThrow();
    child.kill('SIGKILL');
  }, 60_000);

  it('a killed owner releases ownership on SIGTERM rather than holding it', async () => {
    const { root, analysisDir } = await fixture();
    const child = runChild(`
      const m = await import('__MODULE__');
      const held = await m.acquireAnalysisOwnership(${JSON.stringify(root)}, ${JSON.stringify(analysisDir)});
      process.stdout.write('owned');
      // A real timer, not a never-settling promise: an ESM top-level await that
      // never settles lets Node exit immediately, which would make this test
      // measure process teardown rather than signal handling.
      setInterval(() => {}, 1000);
    `);
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', chunk => { if (String(chunk).includes('owned')) resolve(); });
      child.on('error', reject);
      child.on('close', () => resolve());
    });
    expect(await readAnalysisOwner(root, analysisDir)).not.toBeNull();

    child.kill('SIGTERM');
    await new Promise<void>(resolve => child.on('close', () => resolve()));

    // Signal cleanup means the next caller takes ownership immediately, without
    // waiting for the heartbeat-stale window.
    const next = await own(root, analysisDir);
    expect(next.state).toBe('owned');
  }, 60_000);
});

// ============================================================================
// STATUS READS
// ============================================================================

describe('readAnalysisOwner', () => {
  it('returns null when no analysis owns the repository', async () => {
    const { root, analysisDir } = await fixture();
    expect(await readAnalysisOwner(root, analysisDir)).toBeNull();
  });

  it('reports a live owner with its stage and elapsed time', async () => {
    const { root, analysisDir } = await fixture();
    await own(root, analysisDir);
    const active = await readAnalysisOwner(root, analysisDir);
    expect(active?.owner).toMatchObject({ pid: process.pid, stage: 'starting' });
    expect(active?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a crashed holder as no analysis in progress', async () => {
    const { root, analysisDir } = await fixture();
    await plantOwner(analysisDir, livePayload(root, analysisDir, { pid: 4_194_303 }), 120_000);
    expect(await readAnalysisOwner(root, analysisDir)).toBeNull();
  });

  it('never acquires or steals the lock while reading', async () => {
    const { root, analysisDir } = await fixture();
    const lockPath = await plantOwner(analysisDir, livePayload(root, analysisDir));
    await readAnalysisOwner(root, analysisDir);
    await expect(stat(lockPath)).resolves.toBeDefined();
  });
});
