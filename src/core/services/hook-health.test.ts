import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookRunsPath, readHookHealth, recordHookRun } from './hook-health.js';

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
