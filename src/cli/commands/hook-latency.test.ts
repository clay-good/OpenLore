/**
 * Hook latency budget (change: hook-reliability, task 5.2; design section 2).
 *
 * On the fixed fixture (200 files, 2,000 functions, one index build), each moment's handler is
 * timed in-process: 3 warm-up runs, then 30 runs, each with a new session (no dedupe shortcut).
 * The p95 must stay within (target − 450 ms cold-start share) × multiplier. The multiplier is 1.5
 * locally and 3 when `CI` is set; `OPENLORE_LATENCY_MULTIPLIER` overrides it.
 *
 * Run by `npm run test:budgets` (no file parallelism) and excluded from `test:unit`. Skipped on
 * Windows, where the design records latency and does not assert it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fixtureFile, writeHookFixture } from './hook-fixture.js';
import { runHook } from './hook.js';
import { buildInjection } from './orient-inject.js';
import { withLoggerOptions } from '../../utils/logger.js';
import { openloreInit } from '../../api/init.js';
import { openloreAnalyze } from '../../api/analyze.js';

const COLD_START_MS = 450;
const MULTIPLIER = Number(process.env.OPENLORE_LATENCY_MULTIPLIER ?? (process.env.CI ? 3 : 1.5));
const WARMUP = 3;
const RUNS = 30;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };

/** The confirmed whole-process p95 targets (design section 2, measured 2026-11-14). */
const TARGET_MS = {
  'prompt-submitted': 1_000,
  'before-edit': 800,
  'after-tools (edit)': 1_500,
  'after-tools (shell)': 600,
  'before-stop': 5_000,
} as const;
type Moment = keyof typeof TARGET_MS;

let root = '';
let file = '';

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'olhooklatency-')));
  writeHookFixture(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  await openloreInit({ rootPath: root });
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root, env: GIT_ENV });
  await openloreAnalyze({ rootPath: root });
  // The session's change: one added function.
  file = join(root, fixtureFile(0));
  appendFileSync(file, '\nexport function benchAdded(n: number): number {\n  return n + 1;\n}\n');
}, 180_000);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

function run(moment: Moment, session: string): Promise<unknown> {
  const base = { session_id: session, cwd: root };
  switch (moment) {
    case 'prompt-submitted':
      return withLoggerOptions({ quiet: true }, () => buildInjection(root, 'change how f0_3 computes its base value and update its callers'));
    case 'before-edit':
      return runHook('before-edit', JSON.stringify({ ...base, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'export function f0_0', new_string: 'export function f0_0x' } }));
    case 'after-tools (edit)':
      return runHook('after-tools', JSON.stringify({ ...base, tool_name: 'Edit', tool_input: { file_path: file }, tool_response: {} }));
    case 'after-tools (shell)':
      return runHook('after-tools', JSON.stringify({ ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } }));
    case 'before-stop':
      return runHook('before-stop', JSON.stringify({ ...base, stop_hook_active: false }));
  }
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.95 * s.length) - 1];
}

describe.skipIf(process.platform === 'win32')('hook latency on the fixed fixture (p95, in-process)', () => {
  it('the fixture index is built and used (the budgets time real work)', async () => {
    const block = await run('prompt-submitted', 'latency-probe') as string;
    expect(block).toContain('f0_3');
  }, 60_000);

  for (const moment of Object.keys(TARGET_MS) as Moment[]) {
    it(`${moment} stays within its budget`, async () => {
      const times: number[] = [];
      for (let k = 0; k < WARMUP + RUNS; k++) {
        const t = performance.now();
        await run(moment, `latency-${moment}-${k}`);
        if (k >= WARMUP) times.push(performance.now() - t);
      }
      const budget = (TARGET_MS[moment] - COLD_START_MS) * MULTIPLIER;
      expect(p95(times), `${moment} p95 ${p95(times).toFixed(0)} ms, budget ${budget.toFixed(0)} ms`).toBeLessThanOrEqual(budget);
    }, 120_000);
  }
});
