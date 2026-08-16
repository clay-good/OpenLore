/**
 * Tests for the `openlore serve` HTTP daemon: endpoints, enforced preset,
 * token gate, dup-daemon reuse, and serve.json discovery-file lifecycle.
 *
 * Served root is a throwaway temp dir (no analysis), so /tool/orient returns a
 * structured "no analysis" object (HTTP 200) without touching the repo's own
 * .openlore. We assert transport behaviour, not handler output.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, access, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startServe, readDescriptor, idleTimeoutMs, type ServeHandle } from './serve.js';
import { TOOL_PRESETS } from './mcp.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import * as analyzeApi from '../../api/analyze.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../constants.js';
import {
  _resetRepairServiceForTesting,
  requestRepairFromHost,
} from '../../core/services/cold-start-bootstrap.js';

let handle: ServeHandle | undefined;
let root = '';

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = '';
  }
  vi.restoreAllMocks();
  _resetRepairServiceForTesting();
});

describe('host-scoped cold-read repair', () => {
  it('accepts repair only while the exact serve root is hosted', async () => {
    const analyze = vi.spyOn(analyzeApi, 'openloreAnalyze').mockResolvedValue({} as never);
    const h = await boot();

    expect(requestRepairFromHost(root, ['src/payments.ts'])).toBe(true);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalled());

    await h.close();
    handle = undefined;
    expect(requestRepairFromHost(root, ['src/payments.ts'])).toBe(false);
  });
});

async function boot(opts: { token?: string; preset?: string } = {}): Promise<ServeHandle> {
  root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
  // watch:false — these are transport tests; the watcher has its own coverage.
  const h = await startServe({ directory: root, port: '0', watch: false, ...opts });
  if (!h) throw new Error('startServe returned no handle');
  handle = h;
  return h;
}

function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

// fetch().json() is typed `Promise<any>` but strict callers see `unknown`; cast
// to a loose record so the assertions below read cleanly.
async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Raw HTTP GET with arbitrary headers. `fetch` forbids overriding `Host`/`Origin`,
 * so the DNS-rebinding tests drop to node:http (setHost:false to keep our Host).
 */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false },
      (res) => {
        res.resume(); // drain
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('idleTimeoutMs', () => {
  it('defaults to 15 minutes when the option is absent or empty', () => {
    expect(idleTimeoutMs(undefined)).toBe(15 * 60_000);
    expect(idleTimeoutMs('')).toBe(15 * 60_000);
  });

  it('converts a positive minute value to milliseconds', () => {
    expect(idleTimeoutMs('5')).toBe(5 * 60_000);
    expect(idleTimeoutMs('0.5')).toBe(30_000);
  });

  it('treats 0 and negative values as disabled', () => {
    expect(idleTimeoutMs('0')).toBe(0);
    expect(idleTimeoutMs('-1')).toBe(0);
  });

  it('falls back to the default on non-numeric input', () => {
    expect(idleTimeoutMs('abc')).toBe(15 * 60_000);
  });
});

describe('idle self-shutdown', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  // The idle path ends in process.exit(0) (correct for the real detached daemon).
  // Stub it so teardown still runs but the test runner survives, then assert the
  // observable effects: the discovery file is removed and the port stops serving.
  it('tears down and removes serve.json after the idle timeout with no requests', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const dir = await mkdtemp(join(tmpdir(), 'openlore-idle-'));
    try {
      // 0.01 min = 600ms idle window.
      const h = await startServe({ directory: dir, port: '0', watch: false, idleTimeout: '0.01' });
      expect(h).toBeTruthy();
      expect((await fetch(`${h!.baseUrl}/health`)).status).toBe(200);

      // No further requests → timer (last reset by the /health above) fires.
      await sleep(1000);
      expect(exit).toHaveBeenCalled();
      expect(await readDescriptor(dir)).toBeNull(); // teardown unlinked serve.json
    } finally {
      exit.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the daemon alive while requests keep arriving (timer resets)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const dir = await mkdtemp(join(tmpdir(), 'openlore-idle-'));
    try {
      const h = await startServe({ directory: dir, port: '0', watch: false, idleTimeout: '0.02' }); // 1200ms
      // Ping every 400ms for ~1.6s — comfortably under the 1200ms window each
      // time, so the timer keeps resetting. Without resets it would die at 1200ms.
      for (let i = 0; i < 4; i++) {
        await sleep(400);
        expect((await fetch(`${h!.baseUrl}/health`)).status).toBe(200);
      }
      expect(exit).not.toHaveBeenCalled();
      await h!.close();
    } finally {
      exit.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let rejected hidden-tool requests postpone idle shutdown', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const dir = await mkdtemp(join(tmpdir(), 'openlore-idle-'));
    try {
      const h = await startServe({
        directory: dir,
        port: '0',
        watch: false,
        preset: 'navigation',
        idleTimeout: '0.01',
      });
      await sleep(350);
      const rejected = await fetch(`${h!.baseUrl}/tool/record_decision`, {
        method: 'POST',
        body: JSON.stringify({ args: { title: 'hidden', rationale: 'hidden' } }),
      });
      expect(rejected.status).toBe(403);

      // The original 600ms idle deadline still wins. Resetting it on the 403
      // would keep the daemon alive until roughly 950ms.
      await sleep(400);
      expect(exit).toHaveBeenCalled();
      expect(await readDescriptor(dir)).toBeNull();
    } finally {
      exit.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never arms the timer when disabled (--idle-timeout 0)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const dir = await mkdtemp(join(tmpdir(), 'openlore-idle-'));
    try {
      const h = await startServe({ directory: dir, port: '0', watch: false, idleTimeout: '0' });
      await sleep(700);
      expect(exit).not.toHaveBeenCalled();
      expect(await readDescriptor(dir)).not.toBeNull(); // still serving
      await h!.close();
    } finally {
      exit.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('openlore serve', () => {
  it('GET /health reports version, preset, and active tools', async () => {
    const h = await boot();
    const res = await fetch(`${h.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.presetDispatchEnforced).toBe(true);
    expect(body.root).toBe(await realpath(root));
    expect(body.pid).toBe(process.pid);
    expect(body.tokenProtected).toBe(false);
    expect(body.tokenAuthenticated).toBe(true);
    expect(typeof body.version).toBe('string');
    // serve shares the one default-preset source with `openlore mcp`
    // (LEAN_DEFAULT_PRESET = substrate; change fix-default-preset-claims). It no
    // longer diverges to the old navigation surface.
    expect(body.preset).toBe('substrate');
    expect(body.tools).toContain('orient');
    expect(body.tools).toContain('search_code');
    // A governance read that IS in substrate but NOT in navigation — proves the
    // default is the both-faces surface, not the navigate-only escape.
    expect(body.tools).toContain('recall');
  });

  it('writes serve.json on start and removes it on close', async () => {
    const h = await boot();
    const descPath = join(root, '.openlore', 'serve.json');
    expect(await fileExists(descPath)).toBe(true);
    const desc = JSON.parse(await readFile(descPath, 'utf-8'));
    expect(desc.port).toBe(h.port);
    expect(desc.pid).toBe(process.pid);

    await h.close();
    handle = undefined;
    expect(await fileExists(descPath)).toBe(false);
  });

  it('rejects a registered tool outside the active preset before dispatch', async () => {
    const h = await boot();
    const res = await fetch(`${h.baseUrl}/tool/get_env_vars`, {
      method: 'POST',
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/get_env_vars.*substrate.*full.*openlore install --preset <name>/i);
  });

  it('rejects hidden write tools without creating decision or memory state', async () => {
    const h = await boot({ preset: 'navigation' });
    const sentinels = new Map([
      [join(root, '.openlore', 'decisions', 'pending.json'), '{"version":"1","sessionId":"sentinel","updatedAt":"","decisions":[]}\n'],
      [join(root, '.openlore', 'decisions', 'ledger.jsonl'), '{"id":"aaaaaaaa","title":"sentinel","from":null,"to":"draft","actor":"agent","at":"2026-08-01T00:00:00.000Z"}\n'],
      [join(root, '.openlore', 'memory', 'notes.json'), '{"version":"1","updatedAt":"","memories":[]}\n'],
    ]);
    for (const [path, contents] of sentinels) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, contents);
    }
    const calls = [
      ['record_decision', { title: 'must not persist', rationale: 'outside preset' }],
      ['remember', { content: 'must not persist' }],
      ['approve_decision', { id: 'deadbeef' }],
    ] as const;

    for (const [name, args] of calls) {
      const res = await fetch(`${h.baseUrl}/tool/${name}`, {
        method: 'POST',
        body: JSON.stringify({ args }),
      });
      expect(res.status).toBe(403);
      expect((await jsonOf(res)).error).toMatch(new RegExp(`${name}.*navigation.*openlore install --preset <name>`, 'i'));
    }

    for (const [path, contents] of sentinels) {
      expect(await readFile(path, 'utf-8')).toBe(contents);
    }
  });

  it('404s a genuinely unknown tool', async () => {
    const h = await boot();
    const res = await fetch(`${h.baseUrl}/tool/not_a_real_tool`, {
      method: 'POST',
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(404);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/unknown tool/i);
  });

  it('dispatches an in-preset tool (orient → structured no-analysis result)', async () => {
    const h = await boot();
    const res = await fetch(`${h.baseUrl}/tool/orient`, {
      method: 'POST',
      body: JSON.stringify({ args: { task: 'anything' } }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // Temp root has no analysis → handler returns an { error } object, not a throw.
    expect(body.error).toMatch(/No analysis/i);
  });

  it('uses one canonical repository for handler data and boundary policy', async () => {
    const h = await boot({ preset: 'all' });
    const otherRoot = await mkdtemp(join(tmpdir(), 'openlore-serve-other-'));
    try {
      await writeFile(join(root, 'auth.ts'), 'export function auth() { return "served-root"; }\n');
      await writeFile(join(otherRoot, 'auth.ts'), `export function auth() { return "sk-${'v'.repeat(24)}"; }\n`);

      const res = await fetch(`${h.baseUrl}/tool/get_function_body`, {
        method: 'POST',
        body: JSON.stringify({
          directory: root,
          args: { directory: otherRoot, filePath: 'auth.ts', functionName: 'auth' },
        }),
      });
      const body = await jsonOf(res);

      expect(res.status).toBe(200);
      expect(body.body).toContain('served-root');
      expect(JSON.stringify(body)).not.toContain(`sk-${'v'.repeat(24)}`);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('preset "all" exposes non-navigation tools', async () => {
    const h = await boot({ preset: 'all' });
    const res = await fetch(`${h.baseUrl}/health`);
    const body = await jsonOf(res);
    expect(body.preset).toBe('all');
    expect(body.tools).toContain('get_env_vars');
  });

  // change: default-to-lean-tool-surface — serve accepts `full` as an alias of
  // `all` so its selector vocabulary matches `openlore mcp --preset full`.
  it('preset "full" is accepted as a full-surface alias of "all"', async () => {
    const h = await boot({ preset: 'full' });
    const res = await fetch(`${h.baseUrl}/health`);
    const body = await jsonOf(res);
    expect(body.preset).toBe('full');
    expect(body.tools).toContain('get_env_vars');
    expect(body.tools).toContain('record_decision'); // full surface incl. governance

    const call = await fetch(`${h.baseUrl}/tool/get_env_vars`, {
      method: 'POST',
      body: JSON.stringify({ args: {} }),
    });
    expect(call.status).toBe(200);
  });

  it('enforces the token gate on /tool but not /health', async () => {
    const h = await boot({ token: 'sekret' });

    // /health stays public for liveness but reports whether the candidate token
    // actually authenticated, so descriptor consumers can fail closed.
    const publicHealth = await jsonOf(await fetch(`${h.baseUrl}/health`));
    expect(publicHealth.tokenProtected).toBe(true);
    expect(publicHealth.tokenAuthenticated).toBe(false);
    const authenticatedHealth = await jsonOf(await fetch(`${h.baseUrl}/health`, {
      headers: { 'x-openlore-token': 'sekret' },
    }));
    expect(authenticatedHealth.tokenAuthenticated).toBe(true);

    // /tool without token → 401.
    const noTok = await fetch(`${h.baseUrl}/tool/orient`, {
      method: 'POST',
      body: JSON.stringify({ args: { task: 'x' } }),
    });
    expect(noTok.status).toBe(401);

    // /tool with token → dispatched (200).
    const withTok = await fetch(`${h.baseUrl}/tool/orient`, {
      method: 'POST',
      headers: { 'x-openlore-token': 'sekret' },
      body: JSON.stringify({ args: { task: 'x' } }),
    });
    expect(withTok.status).toBe(200);
  });

  it('--stop on a stale serve.json removes it without signalling a recycled PID', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
    const descPath = join(root, '.openlore', 'serve.json');
    await mkdir(join(root, '.openlore'), { recursive: true });
    // Point at a dead port + a PID that is almost certainly not an openlore daemon
    // (pid 1). The health probe must fail → file removed, no shutdown request.
    await writeFile(
      descPath,
      JSON.stringify({ port: 1, pid: 1, host: '127.0.0.1', version: 'x', startedAt: '' }),
      'utf-8',
    );
    const h = await startServe({ directory: root, stop: true });
    expect(h).toBeUndefined();
    expect(await fileExists(descPath)).toBe(false); // stale descriptor cleaned up
  });

  it('--stop asks the root-bound daemon to shut itself down without signalling descriptor PID data', async () => {
    const h = await boot();
    const kill = vi.spyOn(process, 'kill');
    await startServe({ directory: root, stop: true });
    for (let i = 0; i < 100 && await readDescriptor(root); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await readDescriptor(root)).toBeNull();
    expect(kill).not.toHaveBeenCalled();
    handle = undefined;
    await expect(fetch(`${h.baseUrl}/health`)).rejects.toThrow();
  });

  it('does not remove a replacement descriptor during slower shutdown teardown', async () => {
    const old = await boot();
    await startServe({ directory: root, stop: true });
    const replacement = await startServe({ directory: root, port: '0', watch: false });
    expect(replacement).toBeDefined();
    handle = replacement;
    await old.close();
    const descriptor = await readDescriptor(root);
    expect(descriptor?.port).toBe(replacement!.port);
    expect((await fetch(`${replacement!.baseUrl}/health`)).status).toBe(200);
  });

  it('rejects a poisoned serve.json (untrusted artifact) — fails closed', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
    const descPath = join(root, '.openlore', 'serve.json');
    await mkdir(join(root, '.openlore'), { recursive: true });
    const write = (o: unknown) => writeFile(descPath, JSON.stringify(o), 'utf-8');

    // A non-loopback host must be rejected, or the probe would fetch it
    // (arbitrary-host egress).
    await write({ port: 8080, pid: 99999, host: 'evil.example.com', version: 'x', startedAt: '' });
    expect(await readDescriptor(root)).toBeNull();

    // Shape violations fail closed too.
    for (const bad of [
      null, 42, '[]', [],
      { port: 'not-a-number', pid: 1, host: '127.0.0.1' },
      { port: 70000, pid: 1, host: '127.0.0.1' },        // out-of-range port
      { port: 8080, pid: -1, host: '127.0.0.1' },         // bad pid
      { port: 8080, pid: 1 },                              // missing host
      { port: 8080, pid: 1, host: '127.0.0.1', token: 5 },// non-string token
    ]) {
      await write(bad);
      expect(await readDescriptor(root), `should reject ${JSON.stringify(bad)}`).toBeNull();
    }

    // A well-formed loopback descriptor is accepted.
    await write({ port: 8080, pid: 1, host: '127.0.0.1', version: 'x', startedAt: '', token: 't' });
    const ok = await readDescriptor(root);
    expect(ok).not.toBeNull();
    expect(ok!.host).toBe('127.0.0.1');
    expect(ok!.token).toBe('t');
  });

  it('reuses a live daemon instead of starting a second one for the same root', async () => {
    const h1 = await boot();
    // Second start for the same root must detect the live daemon and return its
    // endpoint (same port), not bind a new server.
    const h2 = await startServe({ directory: root, port: '0', watch: false });
    expect(h2).toBeDefined();
    expect(h2!.port).toBe(h1.port);
    // close() on the reused handle is a no-op — must not tear down h1.
    await h2!.close();
    expect((await fetch(`${h1.baseUrl}/health`)).status).toBe(200);
  });

  it('treats all and full as the same security surface when reusing a daemon', async () => {
    const h1 = await boot({ preset: 'full' });
    const h2 = await startServe({ directory: root, port: '0', watch: false, preset: 'all' });
    expect(h2).toBeDefined();
    expect(h2!.port).toBe(h1.port);
  });

  it('refuses to reuse a daemon with a different preset or token', async () => {
    const h1 = await boot({ preset: 'full' });
    const previousExitCode = process.exitCode;
    try {
      const incompatible = await startServe({
        directory: root,
        port: '0',
        watch: false,
        preset: 'navigation',
        token: 'secret',
      });
      expect(incompatible).toBeUndefined();
      expect(process.exitCode).toBe(1);

      // The original daemon remains unchanged: full-surface and unauthenticated.
      const health = await jsonOf(await fetch(`${h1.baseUrl}/health`));
      expect(health.preset).toBe('full');
      expect((await fetch(`${h1.baseUrl}/tool/get_env_vars`, {
        method: 'POST',
        body: JSON.stringify({ args: {} }),
      })).status).toBe(200);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('does not trust a tampered descriptor token over live authentication state', async () => {
    await boot({ preset: 'full' });
    const descPath = join(root, '.openlore', 'serve.json');
    const desc = JSON.parse(await readFile(descPath, 'utf-8')) as Record<string, unknown>;
    await writeFile(descPath, JSON.stringify({ ...desc, token: 'forged-secret' }));
    const previousExitCode = process.exitCode;
    try {
      const reused = await startServe({
        directory: root,
        port: '0',
        watch: false,
        preset: 'full',
        token: 'forged-secret',
      });
      expect(reused).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('refuses a mismatched launch token before contacting a descriptor-selected listener', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-token-preflight-'));
    await mkdir(join(root, '.openlore'), { recursive: true });
    let requests = 0;
    const listener = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('token preflight listener did not bind');
    await writeFile(join(root, '.openlore', 'serve.json'), JSON.stringify({
      port: address.port,
      pid: process.pid,
      host: '127.0.0.1',
      token: 'descriptor-token',
      startedAt: '',
      version: 'test',
    }));
    const previousExitCode = process.exitCode;
    try {
      expect(await startServe({
        directory: root,
        port: '0',
        watch: false,
        token: 'new-operator-secret',
      })).toBeUndefined();
      expect(process.exitCode).toBe(1);
      expect(requests).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
    }
  });

  it('does not reuse a compatible-looking daemon from another repository root', async () => {
    await boot();
    const desc = await readFile(join(root, '.openlore', 'serve.json'), 'utf-8');
    const otherRoot = await mkdtemp(join(tmpdir(), 'openlore-serve-other-'));
    await mkdir(join(otherRoot, '.openlore'), { recursive: true });
    await writeFile(join(otherRoot, '.openlore', 'serve.json'), desc);
    const previousExitCode = process.exitCode;
    try {
      const reused = await startServe({
        directory: otherRoot,
        port: '0',
        watch: false,
      });
      expect(reused).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('refuses a legacy daemon whose matching preset was only advisory', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-legacy-'));
    const legacy = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(
        req.url === '/health'
          ? { ok: true, preset: 'navigation', tools: [...TOOL_PRESETS.navigation] }
          : { hiddenWriteWouldHaveExecuted: true },
      ));
    });
    await new Promise<void>((resolve) => legacy.listen(0, '127.0.0.1', resolve));
    const address = legacy.address();
    if (!address || typeof address === 'string') throw new Error('legacy daemon did not bind');
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'serve.json'), JSON.stringify({
      port: address.port,
      pid: process.pid,
      host: '127.0.0.1',
      startedAt: '',
      version: '2.1.6',
    }));
    const previousExitCode = process.exitCode;
    try {
      const reused = await startServe({
        directory: root,
        port: '0',
        watch: false,
        preset: 'navigation',
      });
      expect(reused).toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      await new Promise<void>((resolve) => legacy.close(() => resolve()));
    }
  });

  it('repopulates the graph after a schema-version reset instead of stalling', async () => {
    // Regression for the schema-reset auto-heal. A read no longer wipes-then-heals:
    // EdgeStore.open() reports the mismatch as not-ready and leaves the store intact
    // (change: harden-index-store-lifecycle), and the watcher only *schedules* a
    // rebuild. Serve must therefore kick `analyze --force` itself and re-stamp the
    // store at the current schema — otherwise every graph request polls a not-ready
    // store until the 60s timeout.
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-reset-'));
    await mkdir(join(root, OPENLORE_DIR), { recursive: true });
    await mkdir(join(root, 'openspec', 'specs'), { recursive: true });
    await writeFile(
      join(root, OPENLORE_DIR, 'config.json'),
      JSON.stringify({
        version: '1.0.0', projectType: 'unknown', openspecPath: './openspec',
        analysis: { maxFiles: 100000, includePatterns: [], excludePatterns: [] },
        generation: { model: 'claude-sonnet-4-6', domains: 'auto' },
        createdAt: new Date().toISOString(), lastRun: null,
      }, null, 2),
      'utf-8',
    );
    await writeFile(
      join(root, 'index.js'),
      'export function add(a, b) { return a + b; }\nexport function main() { return add(1, 2); }\n',
      'utf-8',
    );

    // Build a real, populated graph, then simulate a post-upgrade schema bump by
    // forcing the on-disk version stale so the next read reports not-ready.
    await analyzeApi.openloreAnalyze({ rootPath: root, force: true });
    const analysisDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    const dbFile = EdgeStore.dbPath(analysisDir);
    {
      const probe = EdgeStore.open(dbFile);
      expect(probe.countNodes()).toBeGreaterThan(0); // sanity: analyze populated it
      probe.close();
    }
    const raw = new DatabaseSync(dbFile);
    raw.exec('UPDATE schema_version SET version = 0');
    raw.close();

    // The mismatch is reported without destroying the store (a read never wipes).
    {
      const probe = EdgeStore.open(dbFile);
      expect(probe.notReady?.reason).toBe('schema-mismatch');
      probe.close();
    }

    // Hold the startup rebuild behind a deterministic gate. This proves close()
    // joins a rebuild that is definitely active instead of relying on analyze
    // being slow enough on the current machine.
    const realAnalyze = analyzeApi.openloreAnalyze;
    let releaseRebuild!: () => void;
    const rebuildGate = new Promise<void>((resolve) => { releaseRebuild = resolve; });
    const analyze = vi.spyOn(analyzeApi, 'openloreAnalyze').mockImplementationOnce(async (options) => {
      await rebuildGate;
      return realAnalyze(options);
    });

    let firstClose: Promise<void> | undefined;
    try {
      // Start serve (watch:false so the ONLY possible healer is serve's own trigger).
      handle = await startServe({ directory: root, port: '0', watch: false });
      expect(handle).toBeDefined();
      expect(analyze).toHaveBeenCalledTimes(1);

      // Close immediately while the startup rebuild is active. Every concurrent
      // close caller joins the same teardown, and teardown does not resolve until
      // the rebuild is quiescent. This is the exact race that previously let test
      // cleanup remove .openlore/analysis while analyze was still writing to it.
      firstClose = handle!.close();
      const secondClose = handle!.close();
      expect(secondClose).toBe(firstClose);
      let closeSettled = false;
      void firstClose.then(() => { closeSettled = true; });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
    } finally {
      releaseRebuild();
      if (firstClose) await firstClose;
      else if (handle) await handle.close();
      handle = undefined;
    }

    const es = EdgeStore.open(dbFile);
    expect(es.notReady).toBeNull();      // healed back to the current schema
    expect(es.countNodes()).toBeGreaterThan(0); // rebuilt, not left empty
    es.close();
  }, 30_000);

  it('rejects a spoofed (DNS-rebinding) Host header before dispatch', async () => {
    const h = await boot();
    // An attacker domain resolved to 127.0.0.1 still sends its name in Host.
    const spoofed = await rawGet(h.port, '/health', { Host: 'attacker.example.com' });
    expect(spoofed.status).toBe(403);
    // A loopback Host is accepted.
    const ok = await rawGet(h.port, '/health', { Host: `127.0.0.1:${h.port}` });
    expect(ok.status).toBe(200);
  });

  it('rejects a cross-site Origin', async () => {
    const h = await boot();
    const cross = await rawGet(h.port, '/health', {
      Host: `127.0.0.1:${h.port}`,
      Origin: 'https://evil.example.com',
    });
    expect(cross.status).toBe(403);
  });

  it('refuses a non-loopback bind without a token', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
    const prev = process.exitCode;
    const h = await startServe({ directory: root, port: '0', watch: false, host: '0.0.0.0' });
    expect(h).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = prev; // don't fail the suite
  });

  it('rejects an unknown preset at startup', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
    const prev = process.exitCode;
    const h = await startServe({ directory: root, port: '0', watch: false, preset: 'bogus' });
    expect(h).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = prev; // don't fail the suite
  });

  it('handles 20 concurrent tool calls without corruption or crash', async () => {
    handle = await boot();
    const calls = Array.from({ length: 20 }, () =>
      fetch(`${handle!.baseUrl}/tool/orient`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory: root, args: { task: 'concurrent test' } }),
      }).then(r => r.json())
    );
    const results = await Promise.all(calls);
    expect(results).toHaveLength(20);
    for (const r of results) {
      // No analysis in temp dir → handler returns { error } but HTTP 200.
      // Assert transport succeeded (no crash, no null, no 500).
      expect(r).toBeTruthy();
      expect(typeof r).toBe('object');
    }
  });

  it('does not spin a second watcher when a daemon is reusing the root (invariant)', async () => {
    // The fundamental invariant: daemon present → MCP must not start a second watcher.
    // Validated here at the serve layer: two startServe() calls on the same root →
    // second returns the reuse handle (no new server, no new watcher).
    const h1 = await boot();
    // Before reuse: verify there is exactly one server (h1 is it).
    const health1 = await jsonOf(await fetch(`${h1.baseUrl}/health`));
    expect(health1.ok).toBe(true);

    // Second startServe → reuse path, no second server bound.
    const h2 = await startServe({ directory: root, port: '0', watch: false });
    expect(h2!.port).toBe(h1.port); // same port = same server

    // Original server still alive after h2.close()
    await h2!.close();
    expect((await fetch(`${h1.baseUrl}/health`)).ok).toBe(true);
  });
});

describe('tool argument validation', () => {
  // The daemon /tool transport is used directly by HTTP clients (e.g. the Pi extension),
  // which don't enforce the MCP schema. A missing required arg must return a clear
  // validation error, not a raw handler TypeError leaked from inside the tool.
  it('returns 400 with a clear message when a required arg is missing', async () => {
    const h = await boot();
    const res = await fetch(`${h.baseUrl}/tool/analyze_impact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(String(body.error)).toContain('Invalid arguments');
    expect(String(body.error)).toContain('symbol');
    // Crucially, NOT a leaked internal error.
    expect(String(body.error)).not.toContain('Cannot read properties');
  });

  it('dispatches normally when required args are present', async () => {
    const h = await boot();
    // No analysis in the throwaway root, so the handler returns a structured
    // "not analyzed"/empty result — the point is it dispatches (200) past validation.
    const res = await fetch(`${h.baseUrl}/tool/analyze_impact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { symbol: 'someFn' } }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a misspelled write argument before persistence', async () => {
    const h = await boot({ preset: 'full' });
    const res = await fetch(`${h.baseUrl}/tool/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { content: 'must not persist', anchor: 'chargeCard' } }),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(String(body.error)).toMatch(/anchor.*did you mean.*anchors/i);
    expect(await fileExists(join(root, '.openlore', 'memory', 'notes.json'))).toBe(false);
    expect(await fileExists(join(root, '.openlore', 'analysis'))).toBe(false);
  });

  it.each([123, null, false, ''])('rejects explicit malformed args.directory %j instead of defaulting it', async (directory) => {
    const h = await boot({ preset: 'full' });
    const res = await fetch(`${h.baseUrl}/tool/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { directory, content: 'must not persist' } }),
    });
    expect(res.status).toBe(400);
    expect(await fileExists(join(root, '.openlore', 'memory', 'notes.json'))).toBe(false);
  });

  it.each([null, [], 42, 'text'])('rejects malformed outer JSON body %j', async (bodyValue) => {
    const h = await boot({ preset: 'full' });
    const res = await fetch(`${h.baseUrl}/tool/analyze_codebase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyValue),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(String(body.error)).toMatch(/expected a JSON object/i);
    expect(await fileExists(join(root, '.openlore', 'analysis'))).toBe(false);
  });

  it('rejects a misspelled envelope property before a defaulted write can run', async () => {
    const h = await boot({ preset: 'full' });
    const res = await fetch(`${h.baseUrl}/tool/analyze_codebase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agrs: { force: true } }),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(String(body.error)).toMatch(/agrs.*did you mean.*args/i);
    expect(await fileExists(join(root, '.openlore', 'analysis'))).toBe(false);
  });

  it('does not leak a TypeError when args is a non-object primitive', async () => {
    const h = await boot({ preset: 'full' });
    const res = await fetch(`${h.baseUrl}/tool/get_route_inventory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: 'notanobject' }),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(String(body.error)).toMatch(/expected type object/i);
    expect(String(body.error ?? '')).not.toContain('Cannot create property');
  });
});
