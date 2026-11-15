import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorReason, hookRunsPath, readFindingOutcomes, readHookHealth, recordHookRun } from './hook-health.js';

const dirs: string[] = [];
const readOnly: string[] = [];
const fresh = (withStore = true) => {
  const d = mkdtempSync(join(tmpdir(), 'olhookhealth-'));
  dirs.push(d);
  if (withStore) mkdirSync(join(d, '.openlore'));
  return d;
};
afterEach(() => {
  for (const d of readOnly.splice(0)) { try { chmodSync(d, 0o755); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NOW = Date.parse('2026-11-14T12:00:00Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('recordHookRun', () => {
  it('20 parallel appends give 20 readable lines', async () => {
    const root = fresh();
    await Promise.all(Array.from({ length: 20 }, (_, i) => recordHookRun(root, { moment: 'after-tools', ms: i, outcome: 'ok', shown: 0 })));
    const lines = readFileSync(hookRunsPath(root), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(20);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('writes nothing into a repository without .openlore/', async () => {
    const root = fresh(false);
    await recordHookRun(root, { moment: 'before-edit', ms: 1, outcome: 'ok', shown: 0 });
    expect(existsSync(join(root, '.openlore'))).toBe(false);
  });

  it('never throws on an unwritable store', async () => {
    const root = fresh();
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(join(root, '.openlore'), 0o555);
      readOnly.push(join(root, '.openlore'));
    }
    writeFileSync(join(root, 'blocker'), 'x');
    await expect(recordHookRun(root, { moment: 'before-edit', ms: 1, outcome: 'ok', shown: 0 })).resolves.toBeUndefined();
    await expect(recordHookRun(join(root, 'blocker'), { moment: 'before-edit', ms: 1, outcome: 'ok', shown: 0 })).resolves.toBeUndefined();
  });

  it('cuts the file to its newest half past 1 MB', async () => {
    const root = fresh();
    mkdirSync(join(root, '.openlore', 'session-ledger'));
    const old = `${JSON.stringify({ t: at(0), moment: 'old', ms: 1, outcome: 'ok', shown: 0, pad: 'x'.repeat(1000) })}\n`;
    writeFileSync(hookRunsPath(root), old.repeat(1100));
    await recordHookRun(root, { moment: 'after-tools', ms: 2, outcome: 'ok', shown: 0 });
    const lines = readFileSync(hookRunsPath(root), 'utf8').trim().split('\n');
    expect(statSync(hookRunsPath(root)).size).toBeLessThan(1024 * 1024);
    expect(lines.length).toBe(Math.ceil(1101 / 2));
    expect(JSON.parse(lines.at(-1)!).moment).toBe('after-tools');
  });
});

describe('readHookHealth', () => {
  const write = (root: string, runs: object[], extra = '') => {
    mkdirSync(join(root, '.openlore', 'session-ledger'), { recursive: true });
    writeFileSync(hookRunsPath(root), runs.map(r => JSON.stringify(r)).join('\n') + '\n' + extra);
  };

  it('is empty when no hook ran', () => {
    expect(readHookHealth(fresh(), NOW)).toEqual([]);
  });

  it('per moment over 7 days: runs, last run, p95, errors, overruns, shown; in loop order', () => {
    const root = fresh();
    const runs = [
      ...Array.from({ length: 19 }, (_, i) => ({ t: at(60_000 * (i + 1)), moment: 'after-tools', ms: 100, outcome: 'ok', shown: 1 })),
      { t: at(30_000), moment: 'after-tools', ms: 900, outcome: 'overrun', shown: 0 },
      { t: at(10_000), moment: 'prompt-submitted', ms: 400, outcome: 'error', shown: 0 },
      { t: at(8 * 24 * 3600 * 1000), moment: 'before-stop', ms: 5, outcome: 'ok', shown: 0 },
    ];
    write(root, runs, 'not json\n{"t": 1}\n');
    expect(readHookHealth(root, NOW)).toEqual([
      { moment: 'prompt-submitted', runs: 1, lastRun: at(10_000), p95Ms: 400, errors: 1, overruns: 0, shown: 0 },
      { moment: 'after-tools', runs: 20, lastRun: at(30_000), p95Ms: 100, errors: 0, overruns: 1, shown: 19 },
    ]);
  });
});

describe('hook run error reasons', () => {
  it('records why a run failed, as one bounded line, and reports the newest per moment', async () => {
    const root = fresh();
    await recordHookRun(root, { moment: 'prompt-submitted', ms: 10, outcome: 'error', shown: 0, reason: errorReason(new TypeError('x is not a function\n    at f (a.ts:1)')), t: at(20_000) });
    await recordHookRun(root, { moment: 'prompt-submitted', ms: 10, outcome: 'error', shown: 0, reason: `Error: \u001b[31m${'y'.repeat(500)}`, t: at(10_000) });
    // Only an error carries a reason: an ok run's reason is not written.
    await recordHookRun(root, { moment: 'after-tools', ms: 10, outcome: 'ok', shown: 0, reason: 'ignored', t: at(5_000) });
    const lines = readFileSync(hookRunsPath(root), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { reason?: string });
    expect(lines[0].reason).toBe('TypeError: x is not a function');
    expect(lines[1].reason).toMatch(/^Error: \S*y+$/);
    expect(lines[1].reason!.length).toBeLessThanOrEqual(160);
    expect(lines[1].reason).not.toContain('\u001b');
    expect(lines[2].reason).toBeUndefined();
    const health = readHookHealth(root, NOW);
    expect(health.find(h => h.moment === 'prompt-submitted')!.lastError).toEqual({ t: at(10_000), reason: lines[1].reason });
    expect(health.find(h => h.moment === 'after-tools')!.lastError).toBeUndefined();
  });
});

describe('readFindingOutcomes (task 7.2)', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'].map(ch => ch.repeat(64));
  const writeRecord = (root: string, name: string, findings: Record<string, object>) => {
    mkdirSync(join(root, '.openlore', 'session-ledger', 'hook-delivered'), { recursive: true });
    writeFileSync(join(root, '.openlore', 'session-ledger', 'hook-delivered', `${name}.json`), JSON.stringify({ keys: [], findings }));
  };
  const f = (state?: string) => ({ code: 'c', subject: 's', moment: 'after-tools', shownAt: '', audiences: ['agent'], ...(state ? { state } : {}) });

  it('counts each distinct finding once; the four counts sum to the total', async () => {
    const root = fresh();
    writeRecord(root, 'one', { [ids[0]]: f('fixed'), [ids[1]]: f('open'), [ids[2]]: f(), [ids[3]]: f('open') });
    writeRecord(root, 'two', { [ids[2]]: f('open'), [ids[4]]: f() });
    const { saveDecisionStore } = await import('../decisions/store.js');
    await saveDecisionStore(root, {
      version: '1', sessionId: 's', updatedAt: new Date().toISOString(),
      decisions: [{ id: 'dec00001', status: 'approved', title: 'Keep the skip', rationale: `Flaky upstream; accepted as f:${ids[3].slice(0, 8)}.`, consequences: '', proposedRequirement: null, affectedDomains: [], affectedFiles: [] } as never],
    });
    const o = await readFindingOutcomes(root);
    expect(o).toEqual({ total: 5, fixed: 1, decided: 1, open: 2, notAssessed: 1 });
    expect(o.fixed + o.decided + o.open + o.notAssessed).toBe(o.total);
  });

  it('with no records, all zero; a corrupt record counts nothing', async () => {
    const root = fresh();
    expect(await readFindingOutcomes(root)).toEqual({ total: 0, fixed: 0, decided: 0, open: 0, notAssessed: 0 });
    mkdirSync(join(root, '.openlore', 'session-ledger', 'hook-delivered'), { recursive: true });
    writeFileSync(join(root, '.openlore', 'session-ledger', 'hook-delivered', 'bad.json'), '{"findings": {');
    expect((await readFindingOutcomes(root)).total).toBe(0);
  });
});
