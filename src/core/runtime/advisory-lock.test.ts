/**
 * Spec 15 dogfood fix — the consolidation lock that stops concurrent
 * `decisions --consolidate` processes from clobbering pending.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readdir, writeFile, readFile, utimes, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDecisionsLock, acquireLockAt, isDecisionsLockHeld, isLockHeld, acquireAnalysisLock, withAnalysisLock, NamespaceGateHeldError } from './advisory-lock.js';
import { decisionsDir } from '../decisions/store.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-lock-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('acquireDecisionsLock', () => {
  it('serializes: a second acquire waits until the first releases', async () => {
    const release1 = await acquireDecisionsLock(root);
    let acquired2 = false;
    const p2 = acquireDecisionsLock(root).then((r) => { acquired2 = true; return r; });

    await sleep(450); // > poll interval (150ms): the second acquire must still be blocked
    expect(acquired2).toBe(false);

    await release1();
    const release2 = await p2;
    expect(acquired2).toBe(true);
    await release2();
  });

  it('release is idempotent (double release does not throw)', async () => {
    const release = await acquireDecisionsLock(root);
    await release();
    await expect(release()).resolves.toBeUndefined();
  });

  it('releasing frees the lock so the next acquire is immediate', async () => {
    const r1 = await acquireDecisionsLock(root);
    await r1();
    const t0 = Date.now();
    const r2 = await acquireDecisionsLock(root);
    expect(Date.now() - t0).toBeLessThan(300); // no waiting — lock was free
    await r2();
  });

  it('steals a stale lock left by a crashed holder', async () => {
    const dir = decisionsDir(root);
    await mkdir(dir, { recursive: true });
    const lockPath = join(dir, '.consolidate.lock');
    await writeFile(lockPath, '99999 crashed');
    const old = (Date.now() - 200_000) / 1000; // 200s ago > STALE_MS (120s)
    await utimes(lockPath, old, old);

    // Should steal the stale lock and return promptly, not hang.
    const release = await acquireDecisionsLock(root);
    await stat(lockPath); // lock exists again (ours)
    await release();
  }, 10_000);
});

describe('stale steal — exactly one winner', () => {
  it('gives ownership to ONE contender when several judge the same lock stale', async () => {
    // Stealing by unlink-on-path lets a second contender delete the FRESH lock the
    // first has already written, so both proceed as owner. The steal is a rename,
    // which only one contender can win.
    const dir = join(root, 'steal');
    await mkdir(dir, { recursive: true });
    const lockPath = join(dir, '.race.lock');
    for (let round = 0; round < 25; round++) {
      await writeFile(lockPath, '99999 crashed');
      const old = (Date.now() - 200_000) / 1000; // older than STALE_MS
      await utimes(lockPath, old, old);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => acquireLockAt(dir, '.race.lock', { onContended: 'report' })),
      );
      const handles = results.filter(result => !isLockHeld(result));
      expect(handles, `round ${round}`).toHaveLength(1);
      await (handles[0] as { release: () => Promise<void> }).release();

      // Neither stale-steal nor the namespace gate leaves debris that can alter
      // the next ownership decision.
      const leftovers = (await readdir(dir)).filter(name => name.endsWith('.stale') || name.endsWith('.gate'));
      expect(leftovers).toEqual([]);
    }
  }, 20_000);
});

describe('a live holder is never superseded', () => {
  it('refuses to steal a stale-looking lock while its PID is alive', async () => {
    const dir = join(root, 'live-holder');
    const first = await acquireLockAt(dir, '.x.lock');
    if (isLockHeld(first)) throw new Error('setup acquire must own the lock');

    const lockPath = join(dir, '.x.lock');
    const old = (Date.now() - 200_000) / 1000;
    await utimes(lockPath, old, old);

    const contender = await acquireLockAt(dir, '.x.lock', { onContended: 'report' });
    expect(isLockHeld(contender)).toBe(true);

    await first.release();
    const successor = await acquireLockAt(dir, '.x.lock');
    if (isLockHeld(successor)) throw new Error('successor must acquire after release');
    await successor.release();
    await expect(stat(lockPath)).rejects.toThrow();
  }, 15_000);
});

describe('superseded-holder safety', () => {
  it('serializes concurrent refreshes into one complete payload', async () => {
    const dir = join(root, 'refresh-race');
    const held = await acquireLockAt(dir, '.x.lock');
    if (isLockHeld(held)) throw new Error('setup acquire must own the lock');
    const payloads = Array.from({ length: 100 }, (_, i) => JSON.stringify({ i, detail: 'x'.repeat(i * 17) }));
    await Promise.all(payloads.map(payload => held.refresh(payload)));
    expect(payloads).toContain(await readFile(join(dir, '.x.lock'), 'utf8'));
    await held.release();
  });

  it('fails closed instead of deleting a stranded namespace gate', async () => {
    const dir = join(root, 'stranded-gate');
    await mkdir(dir, { recursive: true });
    const gate = join(dir, '.x.lock.gate');
    await writeFile(gate, '4194303');
    await expect(acquireLockAt(dir, '.x.lock', { namespaceGateMaxWaitMs: 20 }))
      .rejects.toBeInstanceOf(NamespaceGateHeldError);
    expect(await readFile(gate, 'utf8')).toBe('4194303');
  });

  it('cannot delete or refresh a successor even under an unsafe custom stale policy', async () => {
    const dir = join(root, 'superseded-holder');
    const lockPath = join(dir, '.x.lock');
    const first = await acquireLockAt(dir, '.x.lock', { payload: () => 'first' });
    if (isLockHeld(first)) throw new Error('first acquire must own the lock');

    const successor = await acquireLockAt(dir, '.x.lock', {
      payload: () => 'successor',
      isStale: () => true,
    });
    if (isLockHeld(successor)) throw new Error('unsafe policy should supersede first');

    await first.refresh('first-after-steal');
    await first.release();
    expect(await readFile(lockPath, 'utf8')).toBe('successor');

    await successor.release();
    await expect(access(lockPath)).rejects.toThrow();
  });
});

describe('wait policy — maxWaitMs and waitedMs', () => {
  it('reports zero wait for an uncontended acquire and a real wait after contention', async () => {
    const first = await acquireLockAt(root, '.wait.lock');
    if (isLockHeld(first)) throw new Error('first acquire must own the lock');
    expect(first.waitedMs).toBe(0);

    const second = acquireLockAt(root, '.wait.lock');
    await sleep(400);
    await first.release();
    const handle = await second;
    if (isLockHeld(handle)) throw new Error('second acquire must own the lock after release');
    // Non-zero is what tells a caller someone else just finished the work.
    expect(handle.waitedMs).toBeGreaterThan(0);
    await handle.release();
  }, 10_000);

  it('honors a caller-supplied wait bound instead of the default cap', async () => {
    const held = await acquireLockAt(root, '.bounded.lock');
    if (isLockHeld(held)) throw new Error('setup acquire must own the lock');
    const t0 = Date.now();
    const contender = await acquireLockAt(root, '.bounded.lock', {
      maxWaitMs: 300,
      bestEffortAfterMaxWait: false,
    });
    // Gave up on the caller's bound, not the module default (180s), and reported
    // the live holder rather than proceeding unlocked.
    expect(isLockHeld(contender)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3_000);
    await held.release();
  }, 10_000);
});

describe('isDecisionsLockHeld', () => {
  it('false when no lock file exists', async () => {
    expect(await isDecisionsLockHeld(root)).toBe(false);
  });

  it('true while the lock is genuinely held', async () => {
    const release = await acquireDecisionsLock(root);
    expect(await isDecisionsLockHeld(root)).toBe(true);
    await release();
    expect(await isDecisionsLockHeld(root)).toBe(false);
  });

  it('false for a stale lock left by a crashed holder (never blocks a fresh run)', async () => {
    const dir = decisionsDir(root);
    await mkdir(dir, { recursive: true });
    const lockPath = join(dir, '.consolidate.lock');
    await writeFile(lockPath, '99999 crashed');
    const old = (Date.now() - 200_000) / 1000; // 200s ago > STALE_MS (120s)
    await utimes(lockPath, old, old);

    expect(await isDecisionsLockHeld(root)).toBe(false);
  });

  it('true for an old lock while its owning PID is still alive', async () => {
    const release = await acquireDecisionsLock(root);
    const lockPath = join(decisionsDir(root), '.consolidate.lock');
    const old = (Date.now() - 200_000) / 1000;
    await utimes(lockPath, old, old);

    expect(await isDecisionsLockHeld(root)).toBe(true);
    await release();
  });

  it('never acquires or steals — a pure read leaves the lock untouched', async () => {
    const release = await acquireDecisionsLock(root);
    await isDecisionsLockHeld(root);
    await isDecisionsLockHeld(root);
    // The holder's lock survives the peeks: a second acquire still blocks.
    let acquired2 = false;
    const p2 = acquireDecisionsLock(root).then((r) => { acquired2 = true; return r; });
    await sleep(300);
    expect(acquired2).toBe(false);
    await release();
    // Drain the now-unblocked second acquire and release it. Leaving it pending
    // lets its next poll race afterEach's rm(root): open() then rejects with
    // ENOENT as an unhandled rejection that fails the whole run.
    const release2 = await p2;
    await release2();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// acquireAnalysisLock / withAnalysisLock — the analysis-artifact lock, same
// shape and constants as the decisions lock, keyed on the analysis output dir
// (change: harden-artifact-write-atomicity).
// ════════════════════════════════════════════════════════════════════════════
describe('acquireAnalysisLock', () => {
  it('places its lock file (.artifacts.lock) INSIDE the analysis directory it is given', async () => {
    const analysisDir = join(root, '.openlore', 'analysis');
    const release = await acquireAnalysisLock(analysisDir);
    await expect(access(join(analysisDir, '.artifacts.lock'))).resolves.toBeUndefined();
    await release();
    await expect(access(join(analysisDir, '.artifacts.lock'))).rejects.toThrow();
  });

  it('serializes: a second acquire on the same directory waits until the first releases', async () => {
    const analysisDir = join(root, 'analysis');
    const release1 = await acquireAnalysisLock(analysisDir);
    let acquired2 = false;
    const p2 = acquireAnalysisLock(analysisDir).then((r) => { acquired2 = true; return r; });

    await sleep(450); // > poll interval (150ms): the second acquire must still be blocked
    expect(acquired2).toBe(false);

    await release1();
    const release2 = await p2;
    expect(acquired2).toBe(true);
    await release2();
  });

  it('is independent from the decisions lock — holding one never blocks the other', async () => {
    // Different lock files (and directories), so a running consolidation and a
    // running analyze/persist do not contend.
    const analysisDir = join(root, 'analysis');
    const relDec = await acquireDecisionsLock(root);
    const t0 = Date.now();
    const relAna = await acquireAnalysisLock(analysisDir); // must NOT wait on the decisions lock
    expect(Date.now() - t0).toBeLessThan(300);
    await relAna();
    await relDec();
  });

  it('steals a stale analysis lock left by a crashed holder', async () => {
    const analysisDir = join(root, 'analysis');
    await mkdir(analysisDir, { recursive: true });
    const lockPath = join(analysisDir, '.artifacts.lock');
    await writeFile(lockPath, '99999 crashed');
    const old = (Date.now() - 200_000) / 1000; // 200s ago > STALE_MS (120s)
    await utimes(lockPath, old, old);

    const release = await acquireAnalysisLock(analysisDir); // steals, returns promptly
    await stat(lockPath); // ours now
    await release();
  }, 10_000);
});

describe('withAnalysisLock — set-level serialization', () => {
  it('never lets two set-writers of the same directory interleave', async () => {
    // Each "writer" persists a 3-file artifact set, yielding between files so an
    // unguarded pair WOULD interleave. Under the lock the critical sections run
    // strictly one-after-another, so the observed event log is never interleaved
    // and the final set is one writer's homogeneous output.
    const analysisDir = join(root, 'analysis');
    await mkdir(analysisDir, { recursive: true });
    const log: string[] = [];

    const writer = (id: string) => withAnalysisLock(analysisDir, async () => {
      log.push(`${id}:start`);
      for (const name of ['a.json', 'b.json', 'c.json']) {
        await writeFile(join(analysisDir, name), id);
        await sleep(15); // force a yield window an unguarded writer would exploit
      }
      log.push(`${id}:end`);
    });

    await Promise.all([writer('A'), writer('B')]);

    // No interleaving: every start is immediately followed by its own end.
    const first = log[0].split(':')[0];
    const second = first === 'A' ? 'B' : 'A';
    expect(log).toEqual([`${first}:start`, `${first}:end`, `${second}:start`, `${second}:end`]);

    // The set is homogeneous — the second writer fully overwrote the first, so no
    // file carries a different writer's id than its siblings.
    const contents = await Promise.all(
      ['a.json', 'b.json', 'c.json'].map((n) => readFile(join(analysisDir, n), 'utf-8')),
    );
    expect(new Set(contents).size).toBe(1);
  }, 10_000);
});
