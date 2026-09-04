/**
 * Tests for the daemon SPAWN branch of serve-client — the one path that differs
 * per platform and that CI never exercises on Windows (the `windows-smoke` job
 * runs install/analyze, and vitest only ever runs on ubuntu). Both branches are
 * asserted here on any host by stubbing `process.platform`, so a regression in
 * the Windows stdio/detach contract fails on a Linux runner.
 *
 * `node:child_process.spawn` is mocked, so this file is deliberately separate
 * from serve-client.test.ts: the module mock is file-scoped and must not reach
 * the transport tests (mcp-watcher also spawns).
 *
 * The mocked spawn stands in for the real daemon by booting one in-process, so
 * ensureServeDaemon's health poll resolves instead of burning its 30s deadline.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startServe, type ServeHandle } from '../../cli/commands/serve.js';
import { ensureServeDaemon } from './serve-client.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(spawn);

type SpawnOptions = {
  cwd?: string;
  stdio?: unknown;
  detached?: boolean;
  windowsHide?: boolean;
};

let handle: ServeHandle | undefined;
let root = '';
let platform: string | undefined;

/** Stub process.platform (a getter on the real process object). */
function stubPlatform(value: NodeJS.Platform): void {
  platform = process.platform;
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(async () => {
  if (platform !== undefined) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    platform = undefined;
  }
  spawnMock.mockReset();
  if (handle) { await handle.close(); handle = undefined; }
  if (root) { await rm(root, { recursive: true, force: true }); root = ''; }
});

/**
 * Make the mocked spawn behave like a real daemon coming up: boot one
 * in-process (it writes the descriptor ensureServeDaemon polls for). Returns a
 * minimal ChildProcess stand-in — ensureServeDaemon only uses `on` and `unref`.
 */
function spawnBootsRealDaemon(): void {
  spawnMock.mockImplementation(((..._args: unknown[]) => {
    void startServe({ directory: root, port: '0', watch: false }).then((h) => {
      if (h) handle = h; else void h;
    });
    return { on: () => {}, unref: () => {} };
  }) as unknown as typeof spawn);
}

function spawnCall(): { command: string; args: string[]; opts: SpawnOptions } {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [command, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], SpawnOptions];
  return { command, args, opts };
}

describe('serve-client daemon spawn', () => {
  it('on Windows redirects the daemon to .openlore/serve.log and does not detach', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-spawn-win-'));
    stubPlatform('win32');
    spawnBootsRealDaemon();

    const ep = await ensureServeDaemon(root);
    expect(ep).not.toBeNull();

    const { command, args, opts } = spawnCall();
    expect(command).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['serve', '--directory', root, '--preset', 'full']);
    expect(opts.cwd).toBe(root);

    // Windows has no detached-with-ignored-stdio equivalent: the child's output
    // must land in a file or the daemon blocks on a full pipe buffer.
    expect(opts.detached).toBe(false);
    expect(opts.windowsHide).toBe(true);
    expect(Array.isArray(opts.stdio)).toBe(true);
    const stdio = opts.stdio as [string, number, number];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    // stdout and stderr share ONE fd — two openSync calls would interleave writes.
    expect(stdio[2]).toBe(stdio[1]);

    expect(existsSync(join(root, '.openlore', 'serve.log'))).toBe(true);
  }, 20_000);

  it('on POSIX detaches with ignored stdio and writes no log file', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-spawn-posix-'));
    stubPlatform('linux');
    spawnBootsRealDaemon();

    const ep = await ensureServeDaemon(root);
    expect(ep).not.toBeNull();

    const { opts } = spawnCall();
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(existsSync(join(root, '.openlore', 'serve.log'))).toBe(false);
  }, 20_000);

  it('falls back to in-process when the daemon cannot be spawned', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-spawn-fail-'));
    stubPlatform('win32');
    spawnMock.mockImplementation((() => { throw new Error('EPERM'); }) as unknown as typeof spawn);

    expect(await ensureServeDaemon(root)).toBeNull();
    // The log fd is opened before spawn; a throwing spawn must not leak it.
    expect(existsSync(join(root, '.openlore', 'serve.log'))).toBe(true);
  }, 20_000);
});
