/**
 * Hook latency through the built CLI, as a harness runs it (change: hook-reliability, task 5.3;
 * design section 2). On the fixed fixture, each moment is spawned 5 times; the median whole-process
 * time must stay within target × multiplier (1.5 locally, 3 when `CI` is set,
 * `OPENLORE_LATENCY_MULTIPLIER` overrides). On Windows the times are printed, not asserted.
 *
 * Run with `npm run build && npm run test:integration`; part of `test:integration:ci`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fixtureFile, writeHookFixture } from './hook-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const CLI = join(REPO_ROOT, 'dist/cli/index.js');
const MULTIPLIER = Number(process.env.OPENLORE_LATENCY_MULTIPLIER ?? (process.env.CI ? 3 : 1.5));
const SPAWNS = 5;
const RECORD_ONLY = process.platform === 'win32';
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };

/** The confirmed whole-process p95 targets (design section 2). */
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

function cli(args: string[], input = ''): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: 'utf8', timeout: 120_000 });
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run \`npm run build\` first`);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'olhooklatencycli-')));
  writeHookFixture(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  expect(cli(['init']).status).toBe(0);
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root, env: GIT_ENV });
  const analyze = cli(['analyze', '--no-embed']);
  expect(analyze.status, String(analyze.stderr)).toBe(0);
  file = join(root, fixtureFile(0));
  appendFileSync(file, '\nexport function benchAdded(n: number): number {\n  return n + 1;\n}\n');
}, 300_000);

// A hook may leave a detached child (the background index build) still writing in the fixture, so
// removal can race it (ENOTEMPTY on CI). A leftover temp folder is not a test result: retry for up to
// 5 s, then leave it.
afterAll(() => {
  if (!root) return;
  try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* left in the temp dir */ }
});

function spawnMoment(moment: Moment, session: string): number {
  const base = { session_id: session, cwd: root };
  const [args, payload]: [string[], object] = (() => {
    switch (moment) {
      case 'prompt-submitted': return [['orient', '--inject'], { ...base, prompt: 'change how f0_3 computes its base value and update its callers' }];
      case 'before-edit': return [['hook', 'before-edit'], { ...base, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'export function f0_0', new_string: 'export function f0_0x' } }];
      case 'after-tools (edit)': return [['hook', 'after-tools'], { ...base, tool_name: 'Edit', tool_input: { file_path: file }, tool_response: {} }];
      case 'after-tools (shell)': return [['hook', 'after-tools'], { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } }];
      case 'before-stop': return [['hook', 'before-stop'], { ...base, stop_hook_active: false }];
    }
  })();
  const t = performance.now();
  const r = cli(args, JSON.stringify(payload));
  const ms = performance.now() - t;
  expect(r.status).toBe(0);
  return ms;
}

describe('hook latency through the built CLI (median of 5 spawns)', () => {
  for (const moment of Object.keys(TARGET_MS) as Moment[]) {
    it(`${moment} stays within its budget`, () => {
      const times = Array.from({ length: SPAWNS }, (_, k) => spawnMoment(moment, `latency-cli-${moment}-${k}`)).sort((a, b) => a - b);
      const median = times[Math.floor(SPAWNS / 2)];
      const budget = TARGET_MS[moment] * MULTIPLIER;
      if (RECORD_ONLY) {
        process.stdout.write(`[hook-latency] ${moment}: median ${median.toFixed(0)} ms (budget ${budget.toFixed(0)} ms, not asserted on Windows)\n`);
        return;
      }
      expect(median, `${moment} median ${median.toFixed(0)} ms, budget ${budget.toFixed(0)} ms`).toBeLessThanOrEqual(budget);
    }, 120_000);
  }
});
