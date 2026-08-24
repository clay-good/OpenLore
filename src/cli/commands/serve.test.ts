/**
 * Tests for the `openlore serve` HTTP daemon: endpoints, enforced preset,
 * token gate, dup-daemon reuse, and serve.json discovery-file lifecycle.
 *
 * Served root is a throwaway temp dir (no analysis), so /tool/orient returns a
 * structured "no analysis" object (HTTP 200) without touching the repo's own
 * .openlore. We assert transport behaviour, not handler output.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, access, mkdir, writeFile, realpath, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { startServe, readDescriptor, idleTimeoutMs, drainServeRebuilds, type ServeHandle } from './serve.js';
import { SERVE_PROTOCOL_VERSION } from './serve-descriptor.js';
import { TOOL_PRESETS } from './mcp.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import * as analyzeApi from '../../api/analyze.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../constants.js';
import { _contextCacheSizeForTesting, readCachedContext } from '../../core/services/mcp-handlers/utils.js';
import { logger } from '../../utils/logger.js';
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

  it('closes and evicts the served root cache during teardown', async () => {
    const h = await boot();
    const analysisDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(analysisDir, { recursive: true });
    await writeFile(join(analysisDir, 'llm-context.json'), JSON.stringify({
      phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
      phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
      phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
    }));
    const created = EdgeStore.open(EdgeStore.dbPath(analysisDir));
    created.close();

    const cached = await readCachedContext(await realpath(root));
    expect(cached?.edgeStore).toBeDefined();
    expect(_contextCacheSizeForTesting()).toBe(1);
    cached!.edgeStore!.close();

    await h.close();
    handle = undefined;
    expect(_contextCacheSizeForTesting()).toBe(0);
    expect(() => cached!.edgeStore!.countNodes()).toThrow();
  });
});

async function boot(opts: { token?: string; preset?: string } = {}): Promise<ServeHandle> {
  root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
  // watch:false — these are transport tests; the watcher has its own coverage.
  const h = await startServe({
    directory: root,
    port: '0',
    watch: false,
    allowUnauthenticatedForTesting: opts.token === undefined,
    ...opts,
  });
  if (!h) throw new Error('startServe returned no handle');
  handle = h;
  return h;
}

function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5_000)),
  ]);
  if (timedOut && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
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

/** Raw JSON GET variant for asserting wildcard-Host response disclosure. */
function rawJsonGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>,
            });
          } catch (err) {
            reject(err);
          }
        });
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

describe('drainServeRebuilds', () => {
  it('reports a completed drain', async () => {
    await expect(drainServeRebuilds([Promise.resolve()], 50)).resolves.toBe(true);
  });

  it('bounds shutdown when a rebuild never settles', async () => {
    const never = new Promise<void>(() => {});
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    await expect(drainServeRebuilds([never], 5)).resolves.toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/proceeded after waiting 5ms/i));
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
        allowUnauthenticatedForTesting: true,
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
      const h = await startServe({ directory: dir, port: '0', watch: false, idleTimeout: '0', allowUnauthenticatedForTesting: true });
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

  it('protects a default daemon with a generated descriptor token', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-protected-default-'));
    const h = await startServe({ directory: root, port: '0', watch: false });
    expect(h?.token).toMatch(/^[0-9a-f]{48}$/);
    handle = h;
    expect(await jsonOf(await fetch(`${h!.baseUrl}/health`))).toEqual({ ok: true, tokenProtected: true });
    const authenticated = await jsonOf(await fetch(`${h!.baseUrl}/health`, {
      headers: { 'x-openlore-token': h!.token! },
    }));
    expect(authenticated).toMatchObject({ root: await realpath(root), tokenAuthenticated: true });
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

  it.skipIf(process.platform === 'win32')('writes the token-bearing descriptor owner-only', async () => {
    await boot({ token: 'owner-only' });
    const mode = (await stat(join(root, '.openlore', 'serve.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('closes an unannounced listener and releases its lock when descriptor publication fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-publish-fail-'));
    await mkdir(join(root, OPENLORE_DIR, 'serve.json'), { recursive: true });
    const previousExitCode = process.exitCode;
    try {
      const result = await startServe({ directory: root, port: '0', watch: false });
      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
      expect(await fileExists(join(root, OPENLORE_DIR, 'serve.lock'))).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
    }
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
      await mkdir(join(root, OPENLORE_DIR), { recursive: true });
      await mkdir(join(root, 'openspec', 'specs'), { recursive: true });
      await writeFile(join(root, OPENLORE_DIR, 'config.json'), JSON.stringify({
        version: '1.0.0', projectType: 'nodejs', openspecPath: './openspec',
        analysis: { maxFiles: 100000, includePatterns: [], excludePatterns: [] },
        generation: { model: 'claude-sonnet-4-6', domains: 'auto' },
        createdAt: new Date().toISOString(), lastRun: null,
      }));
      await writeFile(
        join(root, 'auth.ts'),
        'export function auth(input: string): string {\n  const token = input + "-served-root";\n  return token;\n}\n',
      );
      await writeFile(
        join(otherRoot, 'auth.ts'),
        `export function auth(input: string): string {\n  const token = "sk-${'v'.repeat(24)}";\n  return token;\n}\n`,
      );
      await analyzeApi.openloreAnalyze({ rootPath: root, force: true });

      const res = await fetch(`${h.baseUrl}/tool/get_function_body`, {
        method: 'POST',
        body: JSON.stringify({
          directory: root,
          args: {
            directory: otherRoot,
            filePath: 'auth.ts',
            functionName: 'auth',
            focus: 'token',
            focusKind: 'variable',
          },
        }),
      });
      const body = await jsonOf(res);

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        focus: 'token',
        focusKind: 'variable',
        sliceScope: 'stored-direct-def-use',
      });
      expect(JSON.stringify(body)).toContain('served-root');
      expect(JSON.stringify(body)).not.toContain(`sk-${'v'.repeat(24)}`);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('rejects foreign roots and subdirectories before opening their caches', async () => {
    const h = await boot({ preset: 'all' });
    const otherRoot = await mkdtemp(join(tmpdir(), 'openlore-serve-foreign-'));
    const subdirectory = join(root, 'packages', 'api');
    await mkdir(subdirectory, { recursive: true });
    try {
      for (const directory of [otherRoot, subdirectory]) {
        const res = await fetch(`${h.baseUrl}/tool/orient`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ directory, args: { task: 'must stay root-bound' } }),
        });
        expect(res.status).toBe(400);
        const body = await jsonOf(res);
        expect(String(body.error)).toContain(`serves only ${await realpath(root)}`);
        expect(String(body.error)).toMatch(/separate openlore serve daemon/i);
      }
      expect(await fileExists(join(otherRoot, OPENLORE_DIR))).toBe(false);
      expect(await fileExists(join(subdirectory, OPENLORE_DIR))).toBe(false);
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
    expect(publicHealth).toEqual({ ok: true, tokenProtected: true });
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
      JSON.stringify({ port: 1, pid: 1, host: '127.0.0.1', protocolVersion: SERVE_PROTOCOL_VERSION, version: 'x', startedAt: '' }),
      'utf-8',
    );
    const h = await startServe({ directory: root, stop: true });
    expect(h).toBeUndefined();
    expect(await fileExists(descPath)).toBe(false); // stale descriptor cleaned up
  });

  it('--stop in an untouched root does not create .openlore', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-empty-stop-'));
    await startServe({ directory: root, stop: true });
    expect(await fileExists(join(root, OPENLORE_DIR))).toBe(false);
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
    await write({ port: 8080, pid: 1, host: '127.0.0.1', protocolVersion: SERVE_PROTOCOL_VERSION, version: 'x', startedAt: '', token: 't' });
    const ok = await readDescriptor(root);
    expect(ok).not.toBeNull();
    expect(ok!.host).toBe('127.0.0.1');
    expect(ok!.token).toBe('t');
  });

  it('reuses a live daemon instead of starting a second one for the same root', async () => {
    const h1 = await boot();
    // Second start for the same root must detect the live daemon and return its
    // endpoint (same port), not bind a new server.
    const h2 = await startServe({ directory: root, port: '0', watch: false, allowUnauthenticatedForTesting: true });
    expect(h2).toBeDefined();
    expect(h2!.port).toBe(h1.port);
    // close() on the reused handle is a no-op — must not tear down h1.
    await h2!.close();
    expect((await fetch(`${h1.baseUrl}/health`)).status).toBe(200);
  });

  it('serializes concurrent starts so both callers resolve to one daemon', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-race-'));
    const [first, second] = await Promise.all([
      startServe({ directory: root, port: '0', watch: false }),
      startServe({ directory: root, port: '0', watch: false }),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.port).toBe(first!.port);
    expect((await readDescriptor(root))?.port).toBe(first!.port);
    expect(await fileExists(join(root, OPENLORE_DIR, 'serve.lock'))).toBe(false);
    expect((await fetch(`${first!.baseUrl}/health`)).status).toBe(200);
    await Promise.all([first!.close(), second!.close()]);
  });

  it('reuses an authenticated daemon bound on all interfaces through a loopback descriptor', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-nonloopback-race-'));
    const [first, second] = await Promise.all([
      startServe({ directory: root, host: '0.0.0.0', token: 'protected', port: '0', watch: false }),
      startServe({ directory: root, host: '0.0.0.0', token: 'protected', port: '0', watch: false }),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.port).toBe(first!.port);
    expect((await readDescriptor(root))?.host).toBe('127.0.0.1');
    await Promise.all([first!.close(), second!.close()]);
  });

  it('reuses an authenticated IPv6 wildcard daemon through a bracket-safe loopback descriptor', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-ipv6-race-'));
    const first = await startServe({ directory: root, host: '::', token: 'protected', port: '0', watch: false });
    expect(first).toBeDefined();
    const second = await startServe({ directory: root, host: '::', token: 'protected', port: '0', watch: false });
    expect(second?.port).toBe(first!.port);
    expect((await readDescriptor(root))?.host).toBe('::1');
    expect(second?.baseUrl).toBe(`http://[::1]:${first!.port}`);
    await Promise.all([first!.close(), second!.close()]);
  });

  it('recovers a healthy daemon from a stopper that stranded the draining marker', async () => {
    const first = await boot();
    const path = join(root, OPENLORE_DIR, 'serve.json');
    const descriptor = await readDescriptor(root);
    await writeFile(path, JSON.stringify({ ...descriptor!, state: 'draining' }));

    const reused = await startServe({ directory: root, port: '0', watch: false, allowUnauthenticatedForTesting: true });
    expect(reused?.port).toBe(first.port);
    expect((await readDescriptor(root))?.state).toBe('ready');
    await reused!.close();
  });

  it('lets a repeated --stop finish a healthy daemon with a stranded draining marker', async () => {
    const first = await boot();
    const path = join(root, OPENLORE_DIR, 'serve.json');
    const descriptor = await readDescriptor(root);
    await writeFile(path, JSON.stringify({ ...descriptor!, state: 'draining' }));

    await startServe({ directory: root, stop: true });
    expect(await readDescriptor(root)).toBeNull();
    await expect(fetch(`${first.baseUrl}/health`)).rejects.toThrow();
    handle = undefined;
  });

  it('announces shutdown before acknowledging a direct shutdown request', async () => {
    const h = await boot({ token: 'protected' });
    const response = await fetch(`${h.baseUrl}/shutdown`, {
      method: 'POST',
      headers: { 'x-openlore-token': 'protected' },
    });
    expect(response.status).toBe(202);
    const announced = await readDescriptor(root);
    expect(announced === null || announced.state === 'draining').toBe(true);
    await h.close();
    handle = undefined;
  });

  it('does not acknowledge shutdown when the draining descriptor cannot be published', async () => {
    const h = await boot({ token: 'protected' });
    const descriptorPath = join(root, OPENLORE_DIR, 'serve.json');
    await rm(descriptorPath);
    await mkdir(descriptorPath);

    const response = await fetch(`${h.baseUrl}/shutdown`, {
      method: 'POST',
      headers: { 'x-openlore-token': 'protected' },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('could not be published') });
    await h.close();
    handle = undefined;
  });

  it('rejects a concrete non-loopback bind that cannot publish a safe discovery endpoint', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-concrete-bind-'));
    const previousExitCode = process.exitCode;
    try {
      const result = await startServe({
        directory: root,
        host: '192.0.2.10',
        token: 'protected',
        port: '0',
        watch: false,
      });
      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
      expect(await fileExists(join(root, OPENLORE_DIR))).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('serializes real child-process starts and starts exactly one watcher', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-process-race-'));
    const children: ChildProcess[] = [];
    const output: string[] = [];
    const launch = (): ChildProcess => {
      const child = spawn(process.execPath, [
        '--import', 'tsx', join(process.cwd(), 'src', 'cli', 'index.ts'),
        'serve', '--directory', root, '--port', '0', '--idle-timeout', '0',
      ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk) => output.push(String(chunk)));
      child.stderr?.on('data', (chunk) => output.push(String(chunk)));
      children.push(child);
      return child;
    };

    launch();
    launch();
    try {
      let descriptor: Awaited<ReturnType<typeof readDescriptor>> = null;
      await vi.waitFor(async () => {
        descriptor = await readDescriptor(root);
        expect(descriptor).not.toBeNull();
      }, { timeout: 15_000, interval: 50 });
      await vi.waitFor(() => {
        expect(children.filter((child) => child.exitCode === null).length).toBe(1);
      }, { timeout: 15_000, interval: 50 });
      const winner = children.find((child) => child.exitCode === null)!;
      const loser = children.find((child) => child !== winner)!;
      expect(loser.exitCode).toBe(0);
      expect(descriptor!.pid).toBe(winner.pid);
      await vi.waitFor(() => {
        expect(output.join('').match(/\[serve\] watching /g) ?? []).toHaveLength(1);
        expect(output.join('')).toContain('already running');
        expect(output.join('')).toContain('reusing');
      }, { timeout: 15_000, interval: 50 });

      await fetch(`http://${descriptor!.host}:${descriptor!.port}/shutdown`, {
        method: 'POST',
        headers: { 'x-openlore-token': descriptor!.token! },
      });
      await vi.waitFor(() => expect(winner.exitCode).not.toBeNull(), { timeout: 15_000, interval: 50 });
    } finally {
      await Promise.all(children.map(terminateChild));
    }
  }, 30_000);

  it('handles a real SIGTERM and removes discovery only after clean process exit', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-sigterm-'));
    const child = spawn(process.execPath, [
      '--import', 'tsx', join(process.cwd(), 'src', 'cli', 'index.ts'),
      'serve', '--directory', root, '--port', '0', '--no-watch', '--idle-timeout', '0',
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await vi.waitFor(async () => {
        expect(await readDescriptor(root)).not.toBeNull();
      }, { timeout: 15_000, interval: 50 });

      child.kill('SIGTERM');
      await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 15_000, interval: 50 });
      expect(await readDescriptor(root)).toBeNull();
    } finally {
      await terminateChild(child);
    }
  }, 20_000);

  it('recovers a stale startup lock left by a crashed process', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-stale-lock-'));
    const lockPath = join(root, OPENLORE_DIR, 'serve.lock');
    await mkdir(join(root, OPENLORE_DIR), { recursive: true });
    await writeFile(lockPath, `2147483647 ${new Date(0).toISOString()}`);
    const old = new Date(Date.now() - 180_000);
    await utimes(lockPath, old, old);

    handle = await startServe({ directory: root, port: '0', watch: false });
    expect(handle).toBeDefined();
    expect((await fetch(`${handle!.baseUrl}/health`)).status).toBe(200);
    expect(await fileExists(lockPath)).toBe(false);
  });

  it.each([
    { suffix: '', contents: '' },
    { suffix: '.gate', contents: '2147483647' },
  ])('fails closed with actionable guidance for an ambiguous abandoned lock$suffix', async ({ suffix, contents }) => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-ambiguous-lock-'));
    const lockPath = join(root, OPENLORE_DIR, `serve.lock${suffix}`);
    await mkdir(join(root, OPENLORE_DIR), { recursive: true });
    await writeFile(lockPath, contents);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      const result = await startServe({
        directory: root,
        port: '0',
        watch: false,
        startupLockWaitMs: 20,
      });
      expect(result).toBeUndefined();
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/verify.*remove|verify.*before removing/i));
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('treats all and full as the same security surface when reusing a daemon', async () => {
    const h1 = await boot({ preset: 'full' });
    const h2 = await startServe({ directory: root, port: '0', watch: false, preset: 'all', allowUnauthenticatedForTesting: true });
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
      protocolVersion: SERVE_PROTOCOL_VERSION,
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
      protocolVersion: SERVE_PROTOCOL_VERSION,
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
        allowUnauthenticatedForTesting: true,
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
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      // Start serve (watch:false so the ONLY possible healer is serve's own trigger).
      handle = await startServe({ directory: root, port: '0', watch: false, idleTimeout: '0.001' });
      expect(handle).toBeDefined();
      expect(analyze).toHaveBeenCalledTimes(1);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(exit).not.toHaveBeenCalled();

      // Exercise the real signal path while the startup rebuild is active. A
      // concurrent close caller joins the same teardown, and process.exit must
      // remain behind that drain.
      const signalHandler = process.listeners('SIGTERM').at(-1) as () => void;
      signalHandler();
      firstClose = handle!.close();
      const secondClose = handle!.close();
      expect(secondClose).toBe(firstClose);
      let closeSettled = false;
      void firstClose.then(() => { closeSettled = true; });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      releaseRebuild();
      if (firstClose) await firstClose;
      else if (handle) await handle.close();
      handle = undefined;
      expect(exit).toHaveBeenCalledWith(0);
      exit.mockRestore();
    }
    expect(_contextCacheSizeForTesting()).toBe(0);

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
    const h = await startServe({
      directory: root,
      port: '0',
      watch: false,
      host: '0.0.0.0',
      allowUnauthenticatedForTesting: true,
    });
    expect(h).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(await fileExists(join(root, OPENLORE_DIR))).toBe(false);
    process.exitCode = prev; // don't fail the suite
  });

  it('limits unauthenticated wildcard-bind health to liveness while authenticated health proves identity', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-wildcard-health-'));
    const h = await startServe({
      directory: root,
      port: '0',
      watch: false,
      host: '0.0.0.0',
      token: 'protected-health',
    });
    expect(h).toBeDefined();
    handle = h;
    const hostHeader = `0.0.0.0:${h!.port}`;

    const unauthenticated = await rawJsonGet(h!.port, '/health', { Host: hostHeader });
    expect(unauthenticated.status).toBe(200);
    expect(unauthenticated.body).toEqual({ ok: true, tokenProtected: true });
    expect(unauthenticated.body).not.toHaveProperty('root');
    expect(unauthenticated.body).not.toHaveProperty('pid');
    expect(unauthenticated.body).not.toHaveProperty('preset');
    expect(unauthenticated.body).not.toHaveProperty('tools');
    expect(unauthenticated.body).not.toHaveProperty('version');

    const authenticated = await rawJsonGet(h!.port, '/health', {
      Host: hostHeader,
      'x-openlore-token': 'protected-health',
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.body).toMatchObject({
      ok: true,
      tokenProtected: true,
      tokenAuthenticated: true,
      root: await realpath(root),
      pid: process.pid,
      preset: 'substrate',
    });
    expect(authenticated.body.tools).toEqual(expect.arrayContaining(['orient', 'search_code']));
    expect(typeof authenticated.body.version).toBe('string');
  });

  it('rejects an unknown preset at startup', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
    const prev = process.exitCode;
    const h = await startServe({ directory: root, port: '0', watch: false, preset: 'bogus' });
    expect(h).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(await fileExists(join(root, OPENLORE_DIR))).toBe(false);
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
    const h2 = await startServe({ directory: root, port: '0', watch: false, allowUnauthenticatedForTesting: true });
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
