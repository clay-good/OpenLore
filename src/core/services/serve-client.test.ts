/**
 * Tests for serve-client — the helper the MCP server uses to discover and call
 * a shared `openlore serve` daemon. Drives a real daemon (startServe) on a
 * temp root; no analysis there, so tools return structured { error } objects —
 * we assert the transport (discover / call / unknown-tool / no-daemon), not the
 * handler output.
 *
 * spawn is never exercised here (it would launch a detached process); we test
 * discover-only paths against a daemon we start in-process.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveCommand, startServe, type ServeHandle } from '../../cli/commands/serve.js';
import { ensureServeDaemon, callServeTool, serveSpawnArgs } from './serve-client.js';

let handle: ServeHandle | undefined;
let root = '';

afterEach(async () => {
  if (handle) { await handle.close(); handle = undefined; }
  if (root) { await rm(root, { recursive: true, force: true }); root = ''; }
});

async function bootDaemon(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'openlore-client-'));
  const h = await startServe({ directory: root, port: '0', watch: false });
  if (!h) throw new Error('daemon did not start');
  handle = h;
}

describe('serve-client', () => {
  it('spawn args are accepted by the serve command (no rejected flags)', () => {
    const args = serveSpawnArgs('/some/dir');
    expect(args).toEqual(['serve', '--directory', '/some/dir', '--preset', 'full']);
    // Regression guard: the daemon must accept exactly these. `serve` exposes
    // `--no-watch`, not `--watch`; commander rejects unknown options, which would
    // silently kill the spawned daemon. Parse the flags (minus the leading
    // 'serve') against the real command and assert none are unknown.
    const known = new Set(serveCommand.options.flatMap((o) => [o.short, o.long].filter(Boolean)));
    for (const a of args.slice(1)) {
      if (a.startsWith('-')) {
        expect(known.has(a), `serve rejects ${a}`).toBe(true);
      }
    }
  });


  it('discovers a running daemon (spawn disabled)', async () => {
    await bootDaemon();
    const ep = await ensureServeDaemon(root, { spawn: false });
    expect(ep).not.toBeNull();
    expect(ep!.baseUrl).toBe(handle!.baseUrl);
  });

  it('returns null when no daemon is announced and spawn is disabled', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'openlore-client-'));
    try {
      const ep = await ensureServeDaemon(empty, { spawn: false });
      expect(ep).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('calls a tool and returns its body (handler error object on a bare root)', async () => {
    await bootDaemon();
    const ep = await ensureServeDaemon(root, { spawn: false });
    const result = await callServeTool(ep!, 'orient', { task: 'x' }, root) as { error?: string };
    expect(result.error).toMatch(/No analysis/i);
  });

  it('throws on an unknown tool so the caller can fall back', async () => {
    await bootDaemon();
    const ep = await ensureServeDaemon(root, { spawn: false });
    await expect(callServeTool(ep!, 'not_a_real_tool', {}, root)).rejects.toThrow();
  });

  it('throws when the daemon is unreachable (stale endpoint)', async () => {
    const ep = { baseUrl: 'http://127.0.0.1:1' }; // nothing listening
    await expect(callServeTool(ep, 'orient', { task: 'x' }, '/tmp')).rejects.toThrow();
  });

  it('treats a poisoned serve.json as absent and issues no fetch (SSRF guard)', async () => {
    // A hostile repo ships a serve.json naming an attacker-controlled host. The
    // shared validator rejects the non-loopback host, so the descriptor is
    // treated as absent — no liveness probe is ever fetched at the poisoned
    // endpoint (mcp-security: ServeDescriptorValidatedAtEveryReader).
    const dir = await mkdtemp(join(tmpdir(), 'openlore-poison-'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, '.openlore'), { recursive: true });
      await writeFile(
        join(dir, '.openlore', 'serve.json'),
        JSON.stringify({ port: 8080, pid: 99999, host: '169.254.169.254', token: 'x' }),
        'utf-8',
      );
      // spawn:false → with the descriptor rejected as absent, ensureServeDaemon
      // returns null without probing or spawning.
      const ep = await ensureServeDaemon(dir, { spawn: false });
      expect(ep).toBeNull();
      expect(fetchSpy, 'no fetch may be issued for a poisoned descriptor').not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a malformed-field serve.json (bad port/pid/token) as absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openlore-malformed-'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, '.openlore'), { recursive: true });
      // Loopback host, but an out-of-range port and a non-string token.
      await writeFile(
        join(dir, '.openlore', 'serve.json'),
        JSON.stringify({ port: 70000, pid: -1, host: '127.0.0.1', token: 5 }),
        'utf-8',
      );
      const ep = await ensureServeDaemon(dir, { spawn: false });
      expect(ep).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a stale serve.json pointing at a dead port (kill -9 simulation)', async () => {
    // Simulate kill -9: serve.json left on disk but nothing at that port.
    const dir = await mkdtemp(join(tmpdir(), 'openlore-stale-'));
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, '.openlore'), { recursive: true });
      await writeFile(
        join(dir, '.openlore', 'serve.json'),
        JSON.stringify({ port: 1, pid: 99999, host: '127.0.0.1', version: 'x' }),
        'utf-8',
      );
      // spawn:false so we don't try to start a new daemon — just discovery.
      const ep = await ensureServeDaemon(dir, { spawn: false });
      // Stale descriptor → health check fails → null (caller falls back to in-process).
      expect(ep).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
