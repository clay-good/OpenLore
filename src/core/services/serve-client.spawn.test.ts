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
 * The mocked spawn stands in for a daemon coming up by announcing a descriptor
 * backed by a stub /health listener — NOT by booting a real one. Booting the
 * real daemon made the first test pay a cold module load that blew the timeout
 * under CI's parallel file load; the stub resolves the health poll on its first
 * tick, so what is asserted stays the spawn contract rather than boot latency.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  canonicalServeRoot,
  SERVE_PROTOCOL_VERSION,
} from '../../cli/commands/serve-descriptor.js';
import { ensureServeDaemon } from './serve-client.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(spawn);

interface SpawnOptions {
  cwd?: string;
  stdio?: unknown;
  detached?: boolean;
  windowsHide?: boolean;
}

let stub: Server | undefined;
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
  if (stub) {
    await new Promise<void>((resolve) => stub!.close(() => resolve()));
    stub = undefined;
  }
  if (root) { await rm(root, { recursive: true, force: true }); root = ''; }
});

/**
 * Announce a daemon the health probe accepts: a loopback listener answering
 * /health, plus the `.openlore/serve.json` descriptor pointing at it. Every
 * field is what `validateServeHealth` demands of a live daemon — a mismatch on
 * any one of them is indistinguishable from no daemon at all.
 */
async function announceStubDaemon(directory: string): Promise<void> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      protocolVersion: SERVE_PROTOCOL_VERSION,
      presetDispatchEnforced: true,
      root: canonicalServeRoot(directory),
      pid: process.pid,
      preset: 'full',
      tools: [],
      tokenProtected: false,
      tokenAuthenticated: true,
      draining: false,
    }));
  });
  stub = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub daemon did not bind');
  await mkdir(join(directory, '.openlore'), { recursive: true });
  await writeFile(join(directory, '.openlore', 'serve.json'), JSON.stringify({
    port: address.port,
    pid: process.pid,
    host: '127.0.0.1',
    protocolVersion: SERVE_PROTOCOL_VERSION,
    startedAt: new Date().toISOString(),
    version: 'test',
  }));
}

/**
 * Make the mocked spawn behave like the daemon coming up. Returns a minimal
 * ChildProcess stand-in — ensureServeDaemon only uses `on` and `unref`.
 */
function spawnAnnouncesDaemon(): void {
  spawnMock.mockImplementation((() => {
    void announceStubDaemon(root);
    return { on: () => {}, unref: () => {} };
  }) as unknown as typeof spawn);
}

function spawnCall(): { command: string; args: string[]; opts: SpawnOptions } {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [command, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], SpawnOptions];
  return { command, args, opts };
}

describe('serve-client daemon spawn', () => {
  it('on Windows redirects the daemon to .openlore/serve.log and detaches it', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-spawn-win-'));
    stubPlatform('win32');
    spawnAnnouncesDaemon();

    const ep = await ensureServeDaemon(root);
    expect(ep).not.toBeNull();

    const { command, args, opts } = spawnCall();
    expect(command).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['serve', '--directory', root, '--preset', 'full']);
    expect(opts.cwd).toBe(root);

    // The daemon is shared, so it must outlive the agent that started it —
    // windows-smoke caught it dying with its spawner when this was false.
    expect(opts.detached).toBe(true);
    // Detaching on Windows means no inherited console, so the child's output
    // must land in a file: stdio:'ignore' (NUL) makes Win10 kill the daemon
    // before it writes its descriptor.
    expect(opts.windowsHide).toBe(true);
    expect(Array.isArray(opts.stdio)).toBe(true);
    const stdio = opts.stdio as [string, number, number];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    // stdout and stderr share ONE fd — two openSync calls would interleave writes.
    expect(stdio[2]).toBe(stdio[1]);

    expect(existsSync(join(root, '.openlore', 'serve.log'))).toBe(true);
  });

  it('on POSIX detaches with ignored stdio and writes no log file', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-spawn-posix-'));
    stubPlatform('linux');
    spawnAnnouncesDaemon();

    const ep = await ensureServeDaemon(root);
    expect(ep).not.toBeNull();

    const { opts } = spawnCall();
    expect(opts.detached).toBe(true);
    // POSIX needs no log file: a detached child with ignored stdio is safe there.
    expect(opts.stdio).toBe('ignore');
    expect(existsSync(join(root, '.openlore', 'serve.log'))).toBe(false);
  });

  it('falls back to in-process when the daemon cannot be spawned', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-spawn-fail-'));
    stubPlatform('win32');
    spawnMock.mockImplementation((() => { throw new Error('EPERM'); }) as unknown as typeof spawn);

    expect(await ensureServeDaemon(root)).toBeNull();
    // The log fd is opened before spawn; a throwing spawn must not leak it.
    expect(existsSync(join(root, '.openlore', 'serve.log'))).toBe(true);
  });
});
