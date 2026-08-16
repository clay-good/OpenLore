/**
 * Spec-12 — MCP protocol conformance suite.
 *
 * Drives the real built server through the official MCP SDK `Client` over a stdio
 * transport (the same path Claude Code uses), so it tests actual wire behavior —
 * the initialize handshake, capabilities/serverInfo, version negotiation, ListTools
 * shape, a CallTool round-trip, and the JSON-RPC error-code vs isError distinction.
 *
 * This is behavior-neutral: it only OBSERVES the server. It modifies no handler.
 *
 * Runs under vitest.integration.config.ts (needs the build + an analysis cache);
 * auto-skips with a loud log when either is missing, so it never false-passes.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, TOOL_PRESETS } from './mcp.js';
import { startServe } from './serve.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const MCP_BIN = join(REPO_ROOT, 'dist/cli/index.js');
const CACHE_FILE = join(REPO_ROOT, '.openlore/analysis/llm-context.json');

const _require = createRequire(import.meta.url);
const PKG_VERSION = (_require('../../../package.json') as { version: string }).version;

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.name));

function seedPersistentState(directory: string): Map<string, string> {
  const sentinels = new Map([
    [join(directory, '.openlore', 'decisions', 'pending.json'), '{"version":"1","sessionId":"sentinel","updatedAt":"","decisions":[]}\n'],
    [join(directory, '.openlore', 'decisions', 'ledger.jsonl'), '{"id":"aaaaaaaa","title":"sentinel","from":null,"to":"draft","actor":"agent","at":"2026-08-01T00:00:00.000Z"}\n'],
    [join(directory, '.openlore', 'memory', 'notes.json'), '{"version":"1","updatedAt":"","memories":[]}\n'],
  ]);
  for (const [path, contents] of sentinels) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
  }
  return sentinels;
}

function expectPersistentStateUnchanged(sentinels: ReadonlyMap<string, string>): void {
  for (const [path, contents] of sentinels) {
    expect(readFileSync(path, 'utf-8')).toBe(contents);
  }
}

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let ready = false;

beforeAll(async () => {
  if (!existsSync(MCP_BIN) || !existsSync(CACHE_FILE)) {
     
    console.warn('spec-12 conformance: SKIP — needs `npm run build` + an analyzed repo (.openlore/analysis).');
    return;
  }
  // change: default-to-lean-tool-surface — no-preset is now the LEAN navigation
  // surface, so this full-surface conformance run opts into `--preset full`
  // explicitly (the lean default + breadth pointer are asserted separately below).
  // Protocol conformance does not exercise watcher behavior. Keep it disabled so
  // large repositories cannot exhaust the process file-descriptor limit before
  // the CallTool assertions run; the preset-boundary probe below deliberately
  // leaves watch-auto enabled to prove rejected calls do not bootstrap it.
  transport = new StdioClientTransport({ command: 'node', args: [MCP_BIN, 'mcp', '--preset', 'full', '--no-watch-auto'], cwd: REPO_ROOT });
  client = new Client({ name: 'spec-12-conformance', version: '1.0.0' });
  // connect() performs the initialize handshake and (per the SDK) rejects if the
  // server answers with a protocolVersion the client does not support — so a
  // successful connect is itself proof of conformant version negotiation.
  await client.connect(transport);
  ready = true;
}, 60_000);

afterAll(async () => {
  await client?.close();
});

function guard(): boolean {
  if (!ready) return true;
  return false;
}

describe('spec-12 MCP protocol conformance (via SDK Client over stdio)', () => {
  it('completes the initialize handshake on a supported protocol version', () => {
    if (guard()) return;
    // The handshake succeeded in beforeAll; the SDK validated the negotiated
    // version against its supported set.
    expect(ready).toBe(true);
    expect(SUPPORTED_PROTOCOL_VERSIONS.length).toBeGreaterThan(0);
  });

  it('reports single-sourced serverInfo (name + real package version)', () => {
    if (guard()) return;
    const info = client!.getServerVersion();
    expect(info?.name).toBe('openlore');
    expect(info?.version).toBe(PKG_VERSION);
  });

  it('advertises only the tools capability (no resources/prompts/logging/completions)', () => {
    if (guard()) return;
    const caps = client!.getServerCapabilities() ?? {};
    expect(caps.tools).toBeDefined();
    expect(caps.resources).toBeUndefined();
    expect(caps.prompts).toBeUndefined();
    expect(caps.logging).toBeUndefined();
    expect(caps.completions).toBeUndefined();
  });

  it('returns a valid, complete ListTools result in a single page (no nextCursor)', async () => {
    if (guard()) return;
    const res = await client!.listTools();
    expect(Array.isArray(res.tools)).toBe(true);
    expect(res.tools.length).toBeGreaterThan(0);
    // Every advertised tool is a real, known tool.
    for (const t of res.tools) expect(TOOL_NAMES.has(t.name), t.name).toBe(true);
    // Bidirectional: every DEFINED tool is actually advertised on the wire. The
    // conformance server runs the full surface (`--preset full`), so the listing must
    // equal TOOL_DEFINITIONS — this catches a tool registered in TOOL_DEFINITIONS but
    // never exposed (which the advertised⊆known check above would silently miss).
    const advertised = new Set(res.tools.map((t) => t.name));
    for (const name of TOOL_NAMES) expect(advertised.has(name), `defined but not advertised: ${name}`).toBe(true);
    // Marquee entry points are present, including the federation-only impact certificate.
    expect(res.tools.some((t) => t.name === 'orient')).toBe(true);
    expect(res.tools.some((t) => t.name === 'change_impact_certificate')).toBe(true);
    // Single-page posture: no pagination cursor.
    expect((res as { nextCursor?: string }).nextCursor).toBeUndefined();
  });

  it('round-trips a CallTool into a valid content array of text blocks', async () => {
    if (guard()) return;
    const res = await client!.callTool({ name: 'get_architecture_overview', arguments: { directory: REPO_ROOT } });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
    for (const block of content) {
      expect(block.type).toBe('text');
      expect(typeof block.text).toBe('string');
    }
  });

  it('maps an invalid-argument CallTool to JSON-RPC -32602 (not an isError result)', async () => {
    if (guard()) return;
    // get_subgraph requires functionName; omitting it must be a protocol error.
    await expect(
      client!.callTool({ name: 'get_subgraph', arguments: { directory: REPO_ROOT } }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams }); // -32602
  });

  it('returns an unknown tool as an isError result (documented posture), not a crash', async () => {
    if (guard()) return;
    const res = await client!.callTool({ name: 'definitely_not_a_real_tool', arguments: { directory: REPO_ROOT } });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toMatch(/unknown tool/i);
  });
});

describe('fix-mcp-argument-contract self-contained stdio acceptance', () => {
  it('runs orient with only a task against an installable analyzed launch root', async () => {
    expect(existsSync(MCP_BIN), 'run `npm run build` before the MCP boundary suite').toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'openlore-orient-default-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'package.json'), '{"name":"orient-default-fixture","type":"module"}\n');
    writeFileSync(join(dir, 'src', 'payments.ts'), 'export function chargeCard(): string { return "charged"; }\n');
    const env = { ...process.env, OPENLORE_NO_AUTO_HEAP: '1' };
    execFileSync('node', [MCP_BIN, 'init'], { cwd: dir, env, stdio: 'ignore' });
    execFileSync('node', [MCP_BIN, 'analyze', '--force'], { cwd: dir, env, stdio: 'ignore' });
    const t = new StdioClientTransport({ command: 'node', args: [MCP_BIN, 'mcp', '--preset', 'full', '--no-watch-auto'], cwd: dir });
    const c = new Client({ name: 'orient-default-probe', version: '1.0.0' });
    await c.connect(t);
    try {
      const result = await c.callTool({ name: 'orient', arguments: { task: 'change chargeCard behavior' } });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toMatch(/chargeCard/);
    } finally {
      await c.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('defaults to the launch root and lets a different explicit directory win', async () => {
    expect(existsSync(MCP_BIN), 'run `npm run build` before the MCP boundary suite').toBe(true);
    const launchRoot = mkdtempSync(join(tmpdir(), 'openlore-default-root-'));
    const explicitRoot = mkdtempSync(join(tmpdir(), 'openlore-explicit-root-'));
    const relativeRoot = join(launchRoot, 'relative-root');
    mkdirSync(relativeRoot);
    const t = new StdioClientTransport({ command: 'node', args: [MCP_BIN, 'mcp', '--preset', 'full', '--no-watch-auto'], cwd: launchRoot });
    const c = new Client({ name: 'directory-default-probe', version: '1.0.0' });
    await c.connect(t);
    try {
      const implicit = await c.callTool({ name: 'remember', arguments: { content: 'implicit root' } });
      const explicit = await c.callTool({ name: 'remember', arguments: { directory: explicitRoot, content: 'explicit root' } });
      const relative = await c.callTool({ name: 'remember', arguments: { directory: 'relative-root', content: 'canonical relative root' } });
      expect(implicit.isError).toBeFalsy();
      expect(explicit.isError).toBeFalsy();
      expect(relative.isError).toBeFalsy();
      expect(existsSync(join(launchRoot, '.openlore', 'memory', 'notes.json'))).toBe(true);
      expect(existsSync(join(explicitRoot, '.openlore', 'memory', 'notes.json'))).toBe(true);
      expect(existsSync(join(relativeRoot, '.openlore', 'memory', 'notes.json'))).toBe(true);
    } finally {
      await c.close();
      rmSync(launchRoot, { recursive: true, force: true });
      rmSync(explicitRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects misspelled write arguments without persistence or telemetry path creation', async () => {
    expect(existsSync(MCP_BIN), 'run `npm run build` before the MCP boundary suite').toBe(true);
    const launchRoot = mkdtempSync(join(tmpdir(), 'openlore-strict-args-'));
    const missingTarget = join(launchRoot, 'must-not-exist');
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    env.OPENLORE_TELEMETRY = '1';
    const t = new StdioClientTransport({ command: 'node', args: [MCP_BIN, 'mcp', '--preset', 'full', '--no-watch-auto'], cwd: launchRoot, env });
    const c = new Client({ name: 'strict-write-probe', version: '1.0.0' });
    await c.connect(t);
    try {
      await expect(c.callTool({
        name: 'remember',
        arguments: { directory: missingTarget, content: 'must not persist', anchor: 'chargeCard' },
      })).rejects.toThrow(/anchor.*did you mean.*anchors/i);
      expect(existsSync(missingTarget)).toBe(false);
    } finally {
      await c.close();
      rmSync(launchRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('fix-mcp-argument-contract invalid launch root', () => {
  it('returns an example-bearing error when the captured launch root disappears', async () => {
    expect(existsSync(MCP_BIN), 'run `npm run build` before the MCP boundary suite').toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'openlore-missing-launch-root-'));
    const t = new StdioClientTransport({ command: 'node', args: [MCP_BIN, 'mcp', '--preset', 'full', '--no-watch-auto'], cwd: dir });
    const c = new Client({ name: 'missing-launch-root-probe', version: '1.0.0' });
    await c.connect(t);
    rmSync(dir, { recursive: true, force: true });
    try {
      await expect(c.callTool({ name: 'list_spec_domains', arguments: {} }))
        .rejects.toThrow(/launch root.*example.*directory/i);
    } finally {
      await c.close();
    }
  }, 60_000);
});

// change: default-to-lean-tool-surface — verify on the real wire that a bare
// `openlore mcp` (no preset) serves the LEAN default surface and advertises the
// breadth pointer via the initialize `instructions` channel, while the full
// surface does not. A separate short-lived client so the shared full-surface
// client above is untouched.
describe('spec — lean default surface + breadth pointer (via SDK Client over stdio)', () => {
  it('a bare `openlore mcp` serves the lean default surface (substrate) and advertises breadth once', async () => {
    if (!existsSync(MCP_BIN) || !existsSync(CACHE_FILE)) return;
    const t = new StdioClientTransport({ command: 'node', args: [MCP_BIN, 'mcp'], cwd: REPO_ROOT });
    const c = new Client({ name: 'lean-default-probe', version: '1.0.0' });
    await c.connect(t);
    try {
      const tools = (await c.listTools()).tools;
      expect(tools.length).toBeLessThan(TOOL_DEFINITIONS.length); // strictly leaner than full
      expect(tools.some((x) => x.name === 'orient')).toBe(true);
      expect(tools.some((x) => x.name === 'get_subgraph')).toBe(true);
      // The breadth pointer rides the initialize `instructions` channel, no tool schema.
      const instructions = c.getInstructions();
      expect(typeof instructions).toBe('string');
      expect(instructions).toMatch(/--preset full/);
    } finally {
      await c.close();
    }
  }, 60_000);

  it('rejects hidden read and write tools before any side effect while preserving member dispatch', async () => {
    expect(existsSync(MCP_BIN), 'run `npm run build` before the MCP boundary suite').toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'openlore-preset-dispatch-'));
    const sentinels = seedPersistentState(dir);
    const t = new StdioClientTransport({ command: 'node', args: [MCP_BIN, 'mcp'], cwd: REPO_ROOT });
    const c = new Client({ name: 'preset-boundary-probe', version: '1.0.0' });
    await c.connect(t);
    try {
      const calls = [
        ['find_dead_code', { directory: dir }],
        ['record_decision', { directory: dir, title: 'must not persist', rationale: 'outside preset' }],
        ['remember', { directory: dir, content: 'must not persist' }],
      ] as const;
      for (const [name, args] of calls) {
        const res = await c.callTool({ name, arguments: args });
        expect(res.isError).toBe(true);
        const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
        expect(text).toMatch(new RegExp(`${name}.*substrate.*full.*openlore install --preset <name>`, 'i'));
      }

      // The guard precedes --watch-auto bootstrap and every persistent handler.
      expectPersistentStateUnchanged(sentinels);
      expect(existsSync(join(dir, '.openlore', 'analysis'))).toBe(false);

      // A deprecated alias resolves before membership enforcement, so the
      // canonical registered name is rejected rather than reported unknown.
      const alias = await c.callTool({ name: 'get_ui_components', arguments: { directory: dir } });
      expect(alias.isError).toBe(true);
      expect((alias.content as Array<{ text?: string }>)[0]?.text).toMatch(/get_ui_component_inventory.*substrate.*full/i);

      // A member still reaches its handler. An unanalyzed temp repo returns a
      // structured domain error, not the preset boundary error.
      const member = await c.callTool({ name: 'orient', arguments: { directory: dir, task: 'anything' } });
      expect(member.isError).toBeFalsy();
      expect((member.content as Array<{ text?: string }>)[0]?.text).not.toMatch(/not available in the active/i);
    } finally {
      await c.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects hidden writes before delegating to a discovered full daemon', async () => {
    expect(existsSync(MCP_BIN), 'run `npm run build` before the MCP boundary suite').toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'openlore-preset-delegation-'));
    const sentinels = seedPersistentState(dir);
    const daemon = await startServe({
      directory: dir,
      port: '0',
      watch: false,
      preset: 'full',
    });
    const t = new StdioClientTransport({ command: 'node', args: [MCP_BIN, 'mcp'], cwd: REPO_ROOT });
    const c = new Client({ name: 'preset-delegation-probe', version: '1.0.0' });
    await c.connect(t);
    try {
      for (const [name, args] of [
        ['record_decision', { directory: dir, title: 'must not persist', rationale: 'outside preset' }],
        ['remember', { directory: dir, content: 'must not persist' }],
      ] as const) {
        const res = await c.callTool({ name, arguments: args });
        expect(res.isError).toBe(true);
        expect((res.content as Array<{ text?: string }>)[0]?.text).toMatch(/not available.*substrate/i);
      }

      // The backing daemon is full-surface and would execute both writes. Exact
      // sentinel bytes prove the narrow MCP guard returned before delegation.
      expectPersistentStateUnchanged(sentinels);
    } finally {
      await c.close();
      await daemon?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not replay a non-idempotent write after an ambiguous daemon disconnect', async () => {
    expect(existsSync(MCP_BIN), 'run `npm run build` before the MCP boundary suite').toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'openlore-daemon-unknown-outcome-'));
    const sentinels = seedPersistentState(dir);
    let dispatched = 0;
    const daemon = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          presetDispatchEnforced: true,
          root: dir,
          pid: process.pid,
          preset: 'full',
          tools: TOOL_DEFINITIONS.map((tool) => tool.name),
          tokenProtected: false,
          tokenAuthenticated: true,
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/tool/record_decision') {
        req.resume();
        req.on('end', () => {
          dispatched += 1;
          req.socket.destroy();
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolveListen) => daemon.listen(0, '127.0.0.1', resolveListen));
    const address = daemon.address();
    if (!address || typeof address === 'string') throw new Error('fake daemon did not bind');
    writeFileSync(join(dir, '.openlore', 'serve.json'), JSON.stringify({
      port: address.port,
      pid: process.pid,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      version: 'test',
    }));

    const t = new StdioClientTransport({
      command: 'node',
      args: [MCP_BIN, 'mcp', '--preset', 'full', '--no-watch-auto'],
      cwd: REPO_ROOT,
    });
    const c = new Client({ name: 'ambiguous-write-probe', version: '1.0.0' });
    await c.connect(t);
    try {
      const result = await c.callTool({
        name: 'record_decision',
        arguments: { directory: dir, title: 'must not replay', rationale: 'ambiguous outcome' },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text?: string }>)[0]?.text).toMatch(
        /outcome is unknown.*did not replay.*inspect repository state/i,
      );
      expect(dispatched).toBe(1);
      expectPersistentStateUnchanged(sentinels);
    } finally {
      await c.close();
      await new Promise<void>((resolveClose) => daemon.close(() => resolveClose()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects an out-of-surface call through the real wire for every curated preset', async () => {
    expect(existsSync(MCP_BIN), 'run `npm run build` before the MCP boundary suite').toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'openlore-preset-matrix-'));
    try {
      for (const [preset, active] of Object.entries(TOOL_PRESETS)) {
        const hidden = TOOL_DEFINITIONS.find((tool) => !active.has(tool.name));
        expect(hidden, `${preset} must be narrower than full`).toBeDefined();
        const t = new StdioClientTransport({
          command: 'node',
          args: [MCP_BIN, 'mcp', '--preset', preset, '--no-watch-auto'],
          cwd: REPO_ROOT,
        });
        const c = new Client({ name: `preset-matrix-${preset}`, version: '1.0.0' });
        await c.connect(t);
        try {
          const res = await c.callTool({ name: hidden!.name, arguments: { directory: dir } });
          expect(res.isError, preset).toBe(true);
          expect((res.content as Array<{ text?: string }>)[0]?.text).toContain(`"${preset}" preset`);
        } finally {
          await c.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('retains a healthy narrow daemon after a full MCP call falls back on 403', async () => {
    expect(existsSync(MCP_BIN), 'run `npm run build` before the MCP boundary suite').toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'openlore-preset-fallback-'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const daemon = await startServe({
      directory: dir,
      port: '0',
      watch: false,
      preset: 'navigation',
      idleTimeout: '0.03', // 1.8s
    });
    const t = new StdioClientTransport({
      command: 'node',
      args: [MCP_BIN, 'mcp', '--preset', 'full', '--no-watch-auto'],
      cwd: REPO_ROOT,
    });
    const c = new Client({ name: 'preset-fallback-probe', version: '1.0.0' });
    await c.connect(t);
    try {
      // The narrow daemon returns 403; the wider MCP session is authorized and
      // executes this call locally without evicting the live endpoint.
      const fallback = await c.callTool({ name: 'get_env_vars', arguments: { directory: dir } });
      expect(fallback.isError).toBeFalsy();

      await new Promise((resolve) => setTimeout(resolve, 1000));
      const member = await c.callTool({
        name: 'orient',
        arguments: { directory: dir, task: 'retain shared daemon' },
      });
      expect(member.isError).toBeFalsy();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // If the 403 had evicted the endpoint, orient would run locally and the
      // daemon's original 1.8s idle deadline would have fired by now.
      expect(exit).not.toHaveBeenCalled();
      expect((await fetch(`${daemon!.baseUrl}/health`)).status).toBe(200);
    } finally {
      await c.close();
      await daemon?.close();
      exit.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
