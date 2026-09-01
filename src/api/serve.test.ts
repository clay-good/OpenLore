/**
 * `openloreServe` — the daemon as a handle a supervising host holds and closes
 * (change: extend-api-for-supervising-hosts).
 *
 * These pin the two properties a wrapper over the CLI entry point could not have given:
 * every refusal throws instead of mutating the host process, and a handle never lies about
 * whether closing it stops a server.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openloreServe, ServeAlreadyRunningError } from './serve.js';
import { readDescriptor, type ServeHandle } from '../cli/commands/serve.js';
import { OpenLoreError, isOpenLoreError } from '../utils/errors.js';

const open: ServeHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close().catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openlore-serve-api-'));
  dirs.push(dir);
  return dir;
}

async function start(dir: string, options: Parameters<typeof openloreServe>[0] = {}): Promise<ServeHandle> {
  const handle = await openloreServe({ rootPath: dir, port: 0, watch: false, idleTimeoutMs: 0, ...options });
  open.push(handle);
  return handle;
}

/** Run `fn` while capturing anything it writes to the console or the process exit code. */
async function withProcessWitness<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; wrote: string[]; exitCode: typeof process.exitCode }> {
  const wrote: string[] = [];
  const before = process.exitCode;
  const originals = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a: unknown[]) => { wrote.push(String(a[0])); };
  console.error = (...a: unknown[]) => { wrote.push(String(a[0])); };
  console.warn = (...a: unknown[]) => { wrote.push(String(a[0])); };
  try {
    const result = await fn();
    return { result, wrote, exitCode: process.exitCode };
  } catch (error) {
    return { error, wrote, exitCode: process.exitCode };
  } finally {
    Object.assign(console, originals);
    process.exitCode = before;
  }
}

describe('openloreServe', () => {
  it('returns an owned handle carrying the actual bound port, and close() stops the server', async () => {
    const dir = await workspace();
    const handle = await start(dir);

    expect(handle.owned).toBe(true);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.baseUrl).toContain(String(handle.port));
    expect((await fetch(`${handle.baseUrl}/health`)).status).toBe(200);

    await handle.close();
    open.length = 0;

    // Stopped, and it stopped by closing the server — not by signalling a process.
    await expect(fetch(`${handle.baseUrl}/health`)).rejects.toThrow();
    expect(await readDescriptor(dir)).toBeNull();
  });

  it('throws a static refusal without touching the console or the exit code', async () => {
    const dir = await workspace();
    const witness = await withProcessWitness(() =>
      openloreServe({ rootPath: dir, port: 0, watch: false, preset: 'no-such-preset' }),
    );

    expect(witness.error).toBeInstanceOf(OpenLoreError);
    expect(isOpenLoreError(witness.error)).toBe(true);
    expect((witness.error as OpenLoreError).code).toBe('SERVE_REFUSED');
    expect((witness.error as Error).message).toContain('no-such-preset');
    expect(witness.wrote).toEqual([]);
    expect(witness.exitCode).toBeUndefined();
  });

  it('throws a RUNTIME refusal just as cleanly — the path a partial extraction would have missed', async () => {
    // A token-posture mismatch is only detected AFTER .openlore exists, the startup lock is taken
    // and the announced descriptor is read: one of the eleven exit paths that used to log and set
    // process.exitCode before returning, and that a "extract the three static refusals" split
    // would have left mutating the host process.
    const dir = await workspace();
    await start(dir, { token: 'first-secret' });

    const witness = await withProcessWitness(() =>
      openloreServe({ rootPath: dir, port: 0, watch: false, idleTimeoutMs: 0, token: 'a-different-secret' }),
    );

    expect(witness.error).toBeInstanceOf(OpenLoreError);
    expect((witness.error as OpenLoreError).code).toBe('SERVE_REFUSED');
    expect((witness.error as Error).message).toContain('token posture');
    expect(witness.wrote).toEqual([]);
    expect(witness.exitCode).toBeUndefined();
  });

  it('refuses an already-running daemon by default, naming its address and returning no handle', async () => {
    const dir = await workspace();
    const first = await start(dir);

    let thrown: unknown;
    try {
      await openloreServe({ rootPath: dir, port: 0, watch: false, idleTimeoutMs: 0 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ServeAlreadyRunningError);
    const already = thrown as ServeAlreadyRunningError;
    expect(already.code).toBe('SERVE_ALREADY_RUNNING');
    expect(already.port).toBe(first.port);
    expect(already.host).toBe(first.host);
    expect(already.baseUrl).toBe(first.baseUrl);

    // The daemon it named is untouched.
    expect((await fetch(`${first.baseUrl}/health`)).status).toBe(200);
  });

  it("adopts an existing daemon only on request, and says the handle does not own it", async () => {
    const dir = await workspace();
    const first = await start(dir);

    const adopted = await openloreServe({ rootPath: dir, port: 0, watch: false, ifRunning: 'adopt' });

    expect(adopted.owned).toBe(false);
    expect(adopted.baseUrl).toBe(first.baseUrl);

    // Closing a handle it does not own detaches; the daemon stays up and discoverable.
    await adopted.close();
    expect((await fetch(`${first.baseUrl}/health`)).status).toBe(200);
    expect(await readDescriptor(dir)).not.toBeNull();
  });

  it('reports watcher health on /health, and --no-watch reports it stopped', async () => {
    // /health redacts its identity fields for an UNAUTHENTICATED caller on a token-protected
    // daemon, so the watcher state has to be read the way a supervising host reads it.
    const authed = async (handle: ServeHandle): Promise<{ watcher?: string }> =>
      await (await fetch(`${handle.baseUrl}/health`, {
        headers: handle.token ? { 'x-openlore-token': handle.token } : {},
      })).json() as { watcher?: string };

    const watching = await workspace();
    const watched = await start(watching, { watch: true });
    expect((await authed(watched)).watcher).toBe('healthy');

    const quiet = await workspace();
    const unwatched = await start(quiet, { watch: false });
    expect((await authed(unwatched)).watcher).toBe('stopped');
  });

  it('never hands back a no-op close() that claims ownership', async () => {
    const dir = await workspace();
    await start(dir);
    const adopted = await openloreServe({ rootPath: dir, port: 0, watch: false, ifRunning: 'adopt' });
    // The reuse path's close() is deliberately a no-op. That is only safe while `owned` discloses it.
    expect(adopted.owned).toBe(false);
  });

  it('reports a bind failure as a typed refusal, not a raw system error', async () => {
    const dir = await workspace();
    // Any listener will do: what matters is that the port is taken by something else.
    const squatter = createServer(() => {});
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const address = squatter.address();
    if (!address || typeof address === 'string') throw new Error('squatter did not bind');

    try {
      const witness = await withProcessWitness(() => start(dir, { port: address.port }));

      // An occupied port is the most common startup failure there is; it must not escape the
      // outcome contract as a bare `EADDRINUSE` and it must not touch the host process.
      expect(isOpenLoreError(witness.error)).toBe(true);
      expect((witness.error as OpenLoreError).code).toBe('SERVE_REFUSED');
      expect((witness.error as Error).message).toContain('Could not bind');
      expect(witness.wrote).toEqual([]);
      expect(witness.exitCode).toBeUndefined();
    } finally {
      squatter.closeAllConnections();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});
