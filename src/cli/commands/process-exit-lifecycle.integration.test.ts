/**
 * Process-exit lifecycle — end-to-end reproducers (change: fix-process-exit-lifecycle)
 *
 * These assert the OBSERVABLE property the fix is about: a process whose work is
 * done actually EXITS. The failure mode is precisely that internal state looks
 * fine while the process refuses to die, so every assertion here is on process
 * exit within a bounded window — never on internal state.
 *
 * Two bugs, both only visible when you run the built CLI as a real subprocess:
 *   1. The MCP stdio server never exited on stdin EOF once its watcher started —
 *      every agent session leaked a zombie holding a watcher and caches.
 *   2. `generate` sat alive for the full request timeout after a fatal connection
 *      error — two minutes of billed CI time after a sub-second failure.
 *
 * Excluded from the CI unit job (`*.integration.test.ts`); the CI-gating guards
 * are the unit tests in `src/utils/shutdown.test.ts` and
 * `src/core/services/llm-service.test.ts`. Run this with:
 *   npm run build && npm run test:integration
 *
 * `OPENLORE_NO_AUTO_HEAP=1` is set on every spawn so the adaptive heap re-exec
 * (a blocking spawnSync supervisor) does not add a second process to reason about
 * — the fix works with or without it, but the assertion stays about one lifetime.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const CLI = join(REPO_ROOT, 'dist/cli/index.js');
const HAVE_BUILD = existsSync(CLI);

/** Spawn the built CLI with the heap re-exec disabled and stderr inherited. */
function spawnCli(args: string[], opts: { cwd: string; env?: Record<string, string> }): ChildProcess {
  return spawn('node', [CLI, ...args], {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, OPENLORE_NO_AUTO_HEAP: '1', ...opts.env },
  });
}

/** Resolve when the child exits; reject if it outlives `budgetMs` (the bug). */
function exitWithin(proc: ChildProcess, budgetMs: number): Promise<{ code: number | null; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`process did not exit within ${budgetMs}ms of stdin EOF`));
    }, budgetMs);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, ms: Date.now() - t0 });
    });
  });
}

const send = (proc: ChildProcess, msg: object): void => {
  proc.stdin!.write(JSON.stringify(msg) + '\n');
};
const initialize = (proc: ChildProcess): void => {
  send(proc, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lifecycle-e2e', version: '1' } },
  });
  send(proc, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The stdio server's shutdown grace window (2s) plus generous startup slack.
const EXIT_BUDGET_MS = 8_000;

describe('MCP stdio server exits on stdin EOF (no zombie)', () => {
  let watchDir: string;

  beforeAll(() => {
    watchDir = mkdtempSync(join(tmpdir(), 'openlore-lifecycle-'));
    mkdirSync(join(watchDir, 'src'), { recursive: true });
    writeFileSync(join(watchDir, 'src', 'a.ts'), 'export function a() { return 1; }\n');
  });
  afterAll(() => { try { rmSync(watchDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('exits after a watcher-starting session when the client closes stdin', async () => {
    if (!HAVE_BUILD) { console.warn('  ⚠ no dist build — run "npm run build"'); return; }
    // `--watch <dir>` starts the file watcher (the handle that kept the loop
    // alive before the fix) without depending on an analysis cache.
    const proc = spawnCli(['mcp', '--no-watch-auto', '--watch', watchDir, '--watch-no-embed', '--preset', 'full'], { cwd: watchDir });
    initialize(proc);
    await sleep(1500); // let the watcher reach 'ready'
    proc.stdin!.end(); // EOF
    const { code, ms } = await exitWithin(proc, EXIT_BUDGET_MS);
    expect(ms).toBeLessThan(EXIT_BUDGET_MS);
    expect(code).toBe(0);
  }, 20_000);

  it('exits on EOF even before any tool call (not watcher-specific)', async () => {
    if (!HAVE_BUILD) { console.warn('  ⚠ no dist build — run "npm run build"'); return; }
    const proc = spawnCli(['mcp', '--no-watch-auto', '--preset', 'full'], { cwd: watchDir });
    initialize(proc);
    await sleep(500);
    proc.stdin!.end();
    const { code, ms } = await exitWithin(proc, EXIT_BUDGET_MS);
    expect(ms).toBeLessThan(EXIT_BUDGET_MS);
    expect(code).toBe(0);
  }, 20_000);

  it('exits promptly on SIGTERM after a watcher-starting session (signals converge on the same teardown)', async () => {
    if (!HAVE_BUILD) { console.warn('  ⚠ no dist build — run "npm run build"'); return; }
    // The architecture requirement is that EOF, SIGINT, and SIGTERM all route
    // through one teardown. EOF is covered above; this covers the signal leg.
    const proc = spawnCli(['mcp', '--no-watch-auto', '--watch', watchDir, '--watch-no-embed', '--preset', 'full'], { cwd: watchDir });
    initialize(proc);
    await sleep(1500); // let the watcher reach 'ready'
    proc.kill('SIGTERM');
    const { code, ms } = await exitWithin(proc, EXIT_BUDGET_MS);
    expect(ms).toBeLessThan(EXIT_BUDGET_MS);
    expect(code).toBe(0); // shutdown(0) is the single path for every leg
  }, 20_000);
});

describe('generate exits promptly after a fatal connection error', () => {
  let projectDir: string;
  let analyzed = false;

  beforeAll(() => {
    if (!HAVE_BUILD) return;
    projectDir = mkdtempSync(join(tmpdir(), 'openlore-gen-'));
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'a.ts'), 'export function a() { return b(); }\nexport function b() { return 1; }\n');
    writeFileSync(join(projectDir, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
    try {
      const env = { ...process.env, OPENLORE_NO_AUTO_HEAP: '1' };
      execFileSync('node', [CLI, 'init'], { cwd: projectDir, env, stdio: 'ignore' });
      execFileSync('node', [CLI, 'analyze'], { cwd: projectDir, env, stdio: 'ignore' });
      analyzed = existsSync(join(projectDir, '.openlore/analysis/llm-context.json'));
    } catch { analyzed = false; }
  });
  afterAll(() => { try { if (projectDir) rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  // Point the provider at a dead local port so the connection fails within
  // milliseconds; the request timeout stays at its 120s default. The interval
  // between the failure and the exit must be bounded and unrelated to the timeout.
  function runGenerate(requestTimeoutSec: number): { code: number | null; ms: number } {
    const t0 = Date.now();
    let code: number | null = 0;
    try {
      execFileSync('node', [CLI, 'generate', '--timeout', String(requestTimeoutSec)], {
        cwd: projectDir,
        env: {
          ...process.env,
          OPENLORE_NO_AUTO_HEAP: '1',
          OPENAI_COMPAT_API_KEY: 'dummy',
          OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:1',
        },
        stdio: 'ignore',
        timeout: 60_000,
      });
    } catch (e) {
      code = (e as { status?: number | null }).status ?? null;
    }
    return { code, ms: Date.now() - t0 };
  }

  it('exits well before the request timeout after an unreachable provider', () => {
    if (!HAVE_BUILD || !analyzed) { console.warn('  ⚠ no build / analysis — skipping'); return; }
    const { ms } = runGenerate(120);
    // Pre-fix this sat for the full 120s. The fix makes it exit in seconds.
    expect(ms).toBeLessThan(30_000);
  }, 70_000);

  it('the exit delay does not track the configured request timeout', () => {
    if (!HAVE_BUILD || !analyzed) { console.warn('  ⚠ no build / analysis — skipping'); return; }
    const short = runGenerate(120);
    const long = runGenerate(240);
    // A leaked timer would make `long` run ~twice as long as `short`. With the
    // timer cleared, both are bounded by the fast connection failure, not the
    // configured timeout — so raising it by 120s must not move the exit time.
    expect(long.ms).toBeLessThan(30_000);
    expect(Math.abs(long.ms - short.ms)).toBeLessThan(20_000);
  }, 140_000);
});
