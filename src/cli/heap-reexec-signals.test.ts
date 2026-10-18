/**
 * The heap-sizing supervisor forwards a directed SIGTERM to its re-executed child. A blocking
 * `spawnSync` supervisor could not: `kill <pid>` or `timeout` killed the supervisor and left the
 * child running at full CPU, reparented to init (found dogfooding a stalled analyze).
 *
 * Real processes, no dist: a tiny script calls `maybeReexecForHeap()` under `analyze` with an
 * explicit `OPENLORE_HEAP_MB`, so it re-executes itself once; the child reports its pid and idles.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const HEAP_SIZING = pathToFileURL(resolve(import.meta.dirname, 'heap-sizing.ts')).href;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const until = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return check();
};

let dir: string | undefined;
let parent: ChildProcess | undefined;
let childPid: number | undefined;

afterEach(() => {
  if (parent?.pid && alive(parent.pid)) process.kill(parent.pid, 'SIGKILL');
  if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = parent = childPid = undefined;
});

describe('heap re-exec supervisor', () => {
  const supervise = async (signal: NodeJS.Signals): Promise<void> => {
    dir = mkdtempSync(join(tmpdir(), 'heap-signals-'));
    const script = join(dir, 'supervised.mjs');
    writeFileSync(script, [
      `const { maybeReexecForHeap } = await import(${JSON.stringify(HEAP_SIZING)});`,
      'await maybeReexecForHeap();',
      // Only the re-executed child gets here: the supervisor exits with it.
      'process.stdout.write(`child ${process.pid}\\n`);',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const env: NodeJS.ProcessEnv = { ...process.env, OPENLORE_HEAP_MB: '65536' };
    delete env.OPENLORE_HEAP_REEXEC;
    delete env.OPENLORE_NO_AUTO_HEAP;
    delete env.NODE_OPTIONS;
    parent = spawn(process.execPath, ['--import', 'tsx', script, 'analyze'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    parent.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(res =>
      parent!.once('exit', (code, signal) => res({ code, signal })));

    expect(await until(() => /child (\d+)/.test(out), 30_000), 'the child started').toBe(true);
    childPid = Number(/child (\d+)/.exec(out)![1]);
    expect(childPid).not.toBe(parent.pid);

    process.kill(parent.pid!, signal);
    const result = await exited;
    expect(result.signal ?? result.code).toBeTruthy(); // died of (or reported) the signal
    expect(await until(() => !alive(childPid!), 15_000), 'the child exited with its supervisor').toBe(true);
  };

  it.skipIf(process.platform === 'win32')('takes its child down with it on a directed SIGTERM', () => supervise('SIGTERM'), 60_000);
  // A SIGINT sent to the supervisor alone (not the terminal's process group) is forwarded after a grace period.
  it.skipIf(process.platform === 'win32')('takes its child down with it on a directed SIGINT', () => supervise('SIGINT'), 60_000);
});
