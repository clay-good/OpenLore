import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import openloreExtension, { createPiExtension, modelsUrl, stripMarker, isUsableConfig, readConfig, loadExistingConfig, runConfigWizard, readSpecIndex, formatToolResult, formatCallArgs, compositeToolResult, NAV_TOOLS, PI_DAEMON_PRESET, PI_EXCLUDED_CONCLUSION_TOOLS, PI_SPEC_WORKFLOW_OBSERVATIONS, PI_SPEC_WORKFLOW_EXCLUSIONS, ensureDaemon, ensureDaemonResult, callTool, isUsableDaemon, missingDaemonTools, piDaemonSpawnCommand, PiDaemonConnectionError, PI_SPEC_INDEX_MAX_DOMAINS, shouldNegativeCacheDaemonFailure, piMaySpawnDaemon } from './extension.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { TOOL_DEFINITIONS } from '../cli/commands/mcp.js';
import { startServe } from '../cli/commands/serve.js';
import { TOOL_OUTPUT_CLASS } from '../core/services/mcp-handlers/tool-contract.js';
import { pointerLineFor } from '../cli/commands/orient-inject-render.js';

type PiEventHandler = (...args: unknown[]) => unknown;

function registerPiHandlers(orientTimeoutMs?: number): Map<string, PiEventHandler> {
  const handlers = new Map<string, PiEventHandler>();
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: PiEventHandler) => { handlers.set(event, handler); }),
  } as unknown as ExtensionAPI;
  (orientTimeoutMs === undefined ? openloreExtension : createPiExtension({ orientTimeoutMs }))(pi);
  return handlers;
}

function registerPiCommands(): Map<string, PiEventHandler> {
  const commands = new Map<string, PiEventHandler>();
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: unknown) => {
      const handler = (command as { handler?: PiEventHandler }).handler;
      if (handler) commands.set(name, handler);
    }),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  openloreExtension(pi);
  return commands;
}

it('spawns a full-surface daemon because Pi curates a wider native tool set itself', () => {
  expect(PI_DAEMON_PRESET).toBe('full');
});

it('launches the Pi daemon without a shell and preserves hostile paths as one argument', async () => {
  const cwd = 'C:\\repos\\name & whoami | calc ^ test';
  const launch = piDaemonSpawnCommand(cwd);
  expect(launch.command).toBe(process.execPath);
  expect(launch.args).toEqual([
    expect.stringMatching(/cli[\\/]index\.js$/),
    'serve', '--directory', cwd, '--preset', 'full',
  ]);
  const source = await readFile(new URL('./extension.ts', import.meta.url), 'utf8');
  expect(source).toContain('spawn(launch.command, launch.args, {');
  expect(source).not.toMatch(/shell\s*:\s*true/);
});

it('does not create a Pi daemon log through an outbound .openlore symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openlore-pi-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'openlore-pi-outside-'));
  try {
    await symlink(outside, join(root, '.openlore'), 'dir');
    const result = await ensureDaemonResult(root);
    expect(result.daemon).toBeNull();
    expect(result.failure).toMatch(/startup preparation failed/);
    await expect(access(join(outside, 'serve.log'))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it('reports a packaged daemon that exits before health instead of mislabeling it as unanalyzed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openlore-pi-early-exit-'));
  try {
    const result = await ensureDaemonResult(root, {
      timeoutMs: 1_000,
      launch: { command: process.execPath, args: ['-e', 'process.exit(7)'] },
    });
    expect(result.daemon).toBeNull();
    expect(result.failure).toMatch(/exited before becoming healthy/);
    expect(result.failure).toContain('exit code 7');
    expect(result.failure).not.toMatch(/run `openlore analyze`/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('reports the packaged launch error code without waiting for a health timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openlore-pi-launch-error-'));
  try {
    const result = await ensureDaemonResult(root, {
      timeoutMs: 1_000,
      launch: { command: join(root, 'missing-openlore-runtime'), args: [] },
    });
    expect(result).toMatchObject({ daemon: null, failureKind: 'launch' });
    expect(result.failure).toContain('ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not hide draining or just-late daemons behind the long negative cache', () => {
  expect(shouldNegativeCacheDaemonFailure('draining')).toBe(false);
  expect(shouldNegativeCacheDaemonFailure('health-timeout')).toBe(false);
  expect(shouldNegativeCacheDaemonFailure('spawn-disabled')).toBe(false);
  expect(shouldNegativeCacheDaemonFailure('launch')).toBe(true);
  expect(shouldNegativeCacheDaemonFailure('preparation')).toBe(true);
  expect(shouldNegativeCacheDaemonFailure('early-exit')).toBe(true);
});

/**
 * Daemon spawn authority (change: extend-api-for-supervising-hosts, spec
 * `PiDaemonSpawnAuthorityIsOverridable`).
 *
 * A supervising host runs one daemon per working tree with its own restart bound and a handle it
 * releases at shutdown. An extension-initiated spawn there is a second, unsupervised process that
 * can outlive the session — so the opt-out must reach the DEFAULT acquisition path, and the "no
 * daemon" outcome must stay an honest, immediately retryable failure rather than a silent spawn.
 */
describe('Pi daemon spawn authority', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function root(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'openlore-pi-spawn-authority-'));
    roots.push(dir);
    return dir;
  }

  /** A launch that leaves a sentinel behind, so an unexpected spawn cannot go unnoticed. */
  function sentinelLaunch(path: string): { command: string; args: string[] } {
    return {
      command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path)}, 'spawned')`],
    };
  }

  it('reads the opt-out from the environment and from the pi config key', async () => {
    const dir = await root();
    expect(await piMaySpawnDaemon(dir)).toBe(true);

    vi.stubEnv('OPENLORE_PI_NO_SPAWN', '1');
    expect(await piMaySpawnDaemon(dir)).toBe(false);
    // An explicit negative is not an opt-out — the host said "spawning is fine".
    vi.stubEnv('OPENLORE_PI_NO_SPAWN', '0');
    expect(await piMaySpawnDaemon(dir)).toBe(true);
    vi.unstubAllEnvs();

    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'config.json'), JSON.stringify({ pi: { spawnDaemon: false } }));
    expect(await piMaySpawnDaemon(dir)).toBe(false);
  });

  it('honours the config key on a repository with no configured LLM provider', async () => {
    const dir = await root();
    await mkdir(join(dir, '.openlore'), { recursive: true });
    // No `generation.provider`, so `readConfig` returns null — the opt-out must survive that,
    // or a headless session that never ran the wizard silently regains spawn authority.
    await writeFile(join(dir, '.openlore', 'config.json'), JSON.stringify({
      version: '1.2.0', projectType: 'nodejs', pi: { spawnDaemon: false },
    }));
    expect(await readConfig(dir)).toBeNull();
    expect(await piMaySpawnDaemon(dir)).toBe(false);
  });

  it('survives the config wizard as an unknown-key-preserving round trip', async () => {
    const dir = await root();
    await mkdir(join(dir, '.openlore'), { recursive: true });
    const configPath = join(dir, '.openlore', 'config.json');
    const existing = {
      version: '1.2.0',
      projectType: 'nodejs',
      openspecPath: 'openspec',
      analysis: { maxFiles: 1, includePatterns: [], excludePatterns: [] },
      generation: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      createdAt: new Date().toISOString(),
      lastRun: null,
      pi: { spawnDaemon: false },
    };
    await writeFile(configPath, JSON.stringify(existing));
    const saveImmediately = {
      cwd: dir, mode: 'tui', hasUI: true,
      ui: {
        select: vi.fn(async () => '✓ Save & close'),
        input: vi.fn(),
        confirm: vi.fn(async () => false),
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;

    // The wizard owns only the fields it renders; `pi` is not one of them, so a configuration UI
    // from any release must carry it through rather than silently restoring spawn authority.
    await runConfigWizard(saveImmediately, existing);

    const written = JSON.parse(await readFile(configPath, 'utf8')) as { pi?: { spawnDaemon?: boolean } };
    expect(written.pi).toEqual({ spawnDaemon: false });
    expect(await piMaySpawnDaemon(dir)).toBe(false);
  });

  it('uses a healthy discovered daemon and launches nothing of its own', async () => {
    const dir = await root();
    const sentinel = join(dir, 'spawned.marker');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, protocolVersion: 1, presetDispatchEnforced: true, root: dir, pid: process.pid,
        preset: 'full', tools: NAV_TOOLS.map((tool) => tool.name),
        tokenProtected: false, tokenAuthenticated: true, draining: false, watcher: 'healthy',
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('supervised daemon did not bind');
    try {
      await mkdir(join(dir, '.openlore'), { recursive: true });
      await writeFile(join(dir, '.openlore', 'serve.json'), JSON.stringify({
        port: address.port, pid: process.pid, host: '127.0.0.1', protocolVersion: 1,
        startedAt: new Date().toISOString(), version: 'test',
      }));
      vi.stubEnv('OPENLORE_PI_NO_SPAWN', '1');

      const result = await ensureDaemonResult(dir, { timeoutMs: 500, launch: sentinelLaunch(sentinel) });

      expect(result.daemon).not.toBeNull();
      expect(result.daemon?.baseUrl).toBe(`http://127.0.0.1:${address.port}`);
      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports an absent daemon as an immediately retryable failure instead of spawning one', async () => {
    const dir = await root();
    const sentinel = join(dir, 'spawned.marker');
    vi.stubEnv('OPENLORE_PI_NO_SPAWN', '1');

    const result = await ensureDaemonResult(dir, { timeoutMs: 500, launch: sentinelLaunch(sentinel) });

    expect(result).toMatchObject({ daemon: null, failureKind: 'spawn-disabled' });
    expect(result.failure).toContain('OPENLORE_PI_NO_SPAWN');
    // The cause is the absent daemon, not an unanalyzed repository: a remediation pointing at
    // analysis would send the operator to fix something that is not broken.
    expect(result.failure).not.toMatch(/openlore analyze/);
    // Immediately retryable: the host may start its daemon a moment later.
    expect(shouldNegativeCacheDaemonFailure('spawn-disabled')).toBe(false);
    await expect(access(sentinel)).rejects.toThrow();
    // The default acquisition path, not only the result seam, honours the opt-out.
    expect(await ensureDaemon(dir)).toBeNull();
  });

  it('still launches a daemon when the opt-out is unset', async () => {
    const dir = await root();
    const sentinel = join(dir, 'spawned.marker');

    const result = await ensureDaemonResult(dir, { timeoutMs: 300, launch: sentinelLaunch(sentinel) });

    expect(result.daemon).toBeNull();
    // The sentinel process is the launch: it exits before health, which is the existing bounded
    // failure path, unchanged.
    expect(['early-exit', 'health-timeout']).toContain(result.daemon === null ? result.failureKind : undefined);
    await access(sentinel);
  });
});

it('arms keepalive immediately after a late daemon becomes usable', async () => {
  const source = await readFile(new URL('./extension.ts', import.meta.url), 'utf8');
  const getDaemon = source.slice(source.indexOf('async function getDaemon'), source.indexOf('let keepalive:'));
  expect(getDaemon.indexOf('daemons.set(cwd, d)')).toBeLessThan(getDaemon.indexOf('startKeepalive()'));
});

it('frames every Pi before-agent corpus block with the shared provenance boundary', async () => {
  const source = await readFile(new URL('./extension.ts', import.meta.url), 'utf8');
  expect(source).toContain("frameServedContent(\n      '# Codebase architecture");
  expect(source).toContain('frameServedContent(specIndex, specProvenance');
  expect(source).toContain('renderInjectionBlock(result, cfg)');
});

it('applies the Pi intent gate before daemon work and discloses every withheld path', async () => {
  const source = await readFile(new URL('./extension.ts', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf("pi.on('before_agent_start'"));
  expect(hook.indexOf('classifyTurnIntent(prompt)')).toBeLessThan(hook.indexOf('getDaemon(ctx.cwd)'));
  expect(hook).toContain('runtime.orientTimeoutMs ?? PI_ORIENT_TIMEOUT_MS');
  expect(hook).toContain("pointerLineFor('empty-prompt')");
  expect(hook).toContain("pointerLineFor('management-intent')");
  expect(hook).toContain("pointerLineFor('error')");
});

it('refuses a pre-existing narrow daemon with actionable remediation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlore-pi-daemon-'));
  let daemon = await startServe({
    directory: dir,
    port: '0',
    watch: false,
    preset: 'navigation',
  });
  try {
    const discovered = await ensureDaemon(dir);
    expect(discovered).not.toBeNull();
    expect(isUsableDaemon(discovered!)).toBe(false);
    const result = await callTool(discovered!, 'orient', { task: 'x' }, dir) as { error?: string };
    expect(result.error).toMatch(/does not expose \d+ Pi tool/);
    expect(result.error).toContain('openlore serve --stop');

    await daemon?.close();
    daemon = await startServe({
      directory: dir,
      port: '0',
      watch: false,
      preset: 'full',
    });
    const recovered = await ensureDaemon(dir);
    expect(recovered).not.toBeNull();
    expect(isUsableDaemon(recovered!)).toBe(true);
  } finally {
    await daemon?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('accepts a daemon only when it covers the full Pi surface', () => {
  const required = NAV_TOOLS.map((tool) => tool.name);
  expect(missingDaemonTools(required, required)).toEqual([]);
  expect(missingDaemonTools(['orient'], required)).toContain('record_decision');
});

it('rejects a legacy daemon without a compatible protocol immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlore-pi-legacy-'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('legacy test server did not bind');
  try {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'serve.json'), JSON.stringify({
      port: address.port,
      pid: process.pid,
      host: '127.0.0.1',
      startedAt: '',
      version: 'legacy',
    }));
    const startedAt = Date.now();
    const discovered = await ensureDaemon(dir);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(discovered).toBeNull();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects a tampered protected-daemon descriptor in Pi discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlore-pi-tampered-token-'));
  const daemon = await startServe({
    directory: dir,
    port: '0',
    watch: false,
    preset: 'full',
    token: 'real-token',
  });
  try {
    const path = join(dir, '.openlore', 'serve.json');
    const descriptor = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...descriptor, token: 'forged-token' }));
    const discovered = await ensureDaemon(dir);
    expect(discovered).not.toBeNull();
    expect(isUsableDaemon(discovered!)).toBe(false);
  } finally {
    await daemon?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('classifies rejected daemon credentials as a recoverable connection change', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid or missing x-openlore-token' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('auth test server did not bind');
  try {
    await expect(callTool(
      { baseUrl: `http://127.0.0.1:${address.port}`, token: 'stale' },
      'orient',
      { task: 'x' },
      '/tmp/project',
    )).rejects.toBeInstanceOf(PiDaemonConnectionError);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('preserves caller cancellation instead of classifying it as a daemon change', async () => {
  const server = createServer((_req, _res) => {
    // Deliberately wait for the caller to abort.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('abort test server did not bind');
  const controller = new AbortController();
  const pending = callTool(
    { baseUrl: `http://127.0.0.1:${address.port}` },
    'orient',
    { task: 'x' },
    '/tmp/project',
    controller.signal,
  );
  controller.abort();
  try {
    const error = await pending.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PiDaemonConnectionError);
    expect((error as Error).name).toBe('AbortError');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('modelsUrl', () => {
  it('appends /v1/models to a bare host', () => {
    expect(modelsUrl('http://localhost:11434')).toBe('http://localhost:11434/v1/models');
  });

  it('tolerates a trailing slash', () => {
    expect(modelsUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1/models');
  });

  it('does not double the /v1 segment', () => {
    expect(modelsUrl('https://api.mistral.ai/v1')).toBe('https://api.mistral.ai/v1/models');
    expect(modelsUrl('https://api.mistral.ai/v1/')).toBe('https://api.mistral.ai/v1/models');
  });
});

describe('stripMarker', () => {
  it('removes the trailing current-value marker', () => {
    expect(stripMarker('openai-compat *')).toBe('openai-compat');
    expect(stripMarker('codestral-latest *')).toBe('codestral-latest');
  });

  it('leaves unmarked labels untouched', () => {
    expect(stripMarker('anthropic')).toBe('anthropic');
  });

  it('only strips a trailing marker, not interior asterisks', () => {
    expect(stripMarker('gpt-4o*mini')).toBe('gpt-4o*mini');
  });
});

describe('isUsableConfig', () => {
  it('accepts a config with generation.provider', () => {
    expect(isUsableConfig({ generation: { provider: 'openai' } })).toBe(true);
  });

  it('rejects null, non-objects, and partial configs', () => {
    expect(isUsableConfig(null)).toBe(false);
    expect(isUsableConfig('nope')).toBe(false);
    expect(isUsableConfig({})).toBe(false);
    expect(isUsableConfig({ generation: {} })).toBe(false);
    expect(isUsableConfig({ generation: { provider: 42 } })).toBe(false);
  });
});

describe('formatToolResult', () => {
  it('passes strings through unchanged', () => {
    expect(formatToolResult('plain text')).toBe('plain text');
  });

  it('renders an error shape as a warning line', () => {
    expect(formatToolResult({ error: 'daemon down' })).toBe('⚠ daemon down');
  });

  it('handles null/undefined and primitives', () => {
    expect(formatToolResult(null)).toBe('(no result)');
    expect(formatToolResult(undefined)).toBe('(no result)');
    expect(formatToolResult(42)).toBe('42');
  });

  it('renders arrays as bounded bullet lists capped at 6 with a count', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ name: `fn${i}`, fanIn: i }));
    const out = formatToolResult({ relevantFunctions: items });
    expect(out).toContain('**relevantFunctions** (15)');
    expect(out).toContain('• fn0 — fanIn=0');
    expect(out).toContain('… 9 more'); // 15 - 6
    expect(out).not.toContain('fn6');
  });

  it('summarises objects with title + at most two extras, dropping handle noise', () => {
    const out = formatToolResult({ hits: [{ name: 'doThing', filePath: 'src/a.ts', score: 0.9, expand: 'doThing::src/a.ts', signature: 'function doThing()', language: 'TypeScript' }] });
    expect(out).toContain('• doThing — filePath=src/a.ts, score=0.9');
    expect(out).not.toContain('expand=');
    expect(out).not.toContain('signature=');
    expect(out).not.toContain('language=');
  });

  it('rounds non-integer numbers to two decimals', () => {
    const out = formatToolResult({ hits: [{ name: 'x', score: 7.5214544522383315 }] });
    expect(out).toContain('score=7.52');
    expect(out).not.toContain('7.5214');
  });

  it('renders edge-like rows as "a → b"', () => {
    const out = formatToolResult({ edges: [{ caller: 'handleOrient', callee: 'validateDirectory', callerFile: 'a.ts', calleeFile: 'b.ts' }] });
    expect(out).toContain('• handleOrient → validateDirectory');
    expect(out).not.toContain('callerFile');
  });

  it('truncates long top-level string fields', () => {
    const long = 'x'.repeat(1000);
    const out = formatToolResult({ skeleton: long });
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(600);
  });

  it('renders nested objects as labelled key/value sections', () => {
    const out = formatToolResult({ summary: { totalFunctions: 100, hubCount: 5 } });
    expect(out).toContain('**summary**');
    expect(out).toContain('  totalFunctions: 100');
    expect(out).toContain('  hubCount: 5');
  });

  it('presents degraded mapping coverage with its reason and remediation', () => {
    const out = formatToolResult({
      mappingCoverage: {
        state: 'missing',
        reason: 'mapping-not-generated',
        message: 'Coverage claims are unavailable.',
        remediation: 'Run `openlore generate` to create mapping.json.',
      },
    });
    expect(out).toContain('**mappingCoverage**');
    expect(out).toContain('state: missing');
    expect(out).toContain('reason: mapping-not-generated');
    expect(out).toContain('remediation: Run `openlore generate` to create mapping.json.');
  });

  it('skips input-echo / prose / meta keys and empty arrays', () => {
    const out = formatToolResult({
      task: 'add auth',
      searchMode: 'semantic',
      query: 'auth',
      guidance: 'some long prose',
      count: 3,
      relevantFiles: [],
      relevantFunctions: [{ name: 'login' }],
    });
    expect(out).not.toContain('task');
    expect(out).not.toContain('searchMode');
    expect(out).not.toContain('guidance');
    expect(out).not.toContain('count');
    expect(out).not.toContain('relevantFiles');
    expect(out).toContain('**relevantFunctions**'); // kept
  });

  it('drops orient enrichment from the glance when toolName is "orient"', () => {
    const payload = {
      relevantFunctions: [{ name: 'handleOrient', filePath: 'src/o.ts', score: 9.8 }],
      insertionPoints: [{ name: 'toStderr', rank: 1, filePath: 'src/o.ts' }],
      callPaths: [{ name: 'handleOrient', filePath: 'src/o.ts' }],
      suggestedTools: ['record_decision', 'get_subgraph'],
      governingDecisions: [{ id: 'abc', title: 'X', status: 'verified', governs: ['a'] }],
      changeCoupling: [{ file: 'src/o.ts', volatility: 'low', changes: 4 }],
      landmarks: [{ id: 'src/o.ts::avg', name: 'avg', file: 'src/o.ts' }],
      specLinkedFunctions: Array.from({ length: 130 }, (_, i) => ({ name: `f${i}` })),
      nextSteps: ['Run check_spec_drift'],
    };
    const out = formatToolResult(payload, 'orient');
    // kept — actionable at a glance
    expect(out).toContain('**relevantFunctions**');
    expect(out).toContain('**insertionPoints**');
    expect(out).toContain('**nextSteps**');
    // dropped — model-facing enrichment, noise for the human skim
    for (const k of ['callPaths', 'suggestedTools', 'governingDecisions', 'changeCoupling', 'landmarks', 'specLinkedFunctions']) {
      expect(out).not.toContain(k);
    }
  });

  it('keeps governingDecisions for deliberate analysis tools (per-tool skips)', () => {
    const payload = {
      blastRadius: { total: 68, upstream: 8, downstream: 60 },
      riskLevel: 'critical',
      governingDecisions: [{ id: 'abc', title: 'Some decision', status: 'verified' }],
    };
    // analyze_impact keeps its analytical structure…
    const impact = formatToolResult(payload, 'analyze_impact');
    expect(impact).toContain('**governingDecisions**');
    expect(impact).toContain('**blastRadius**');
    // …but orient would hide governingDecisions.
    expect(formatToolResult(payload, 'orient')).not.toContain('governingDecisions');
  });

  it('trims only language + criticalPathLeaves from analyze_impact', () => {
    const payload = {
      file: 'src/o.ts',
      language: 'TypeScript',
      blastRadius: { total: 68 },
      upstreamChain: [{ name: 'dispatchTool', file: 'src/d.ts', depth: 1 }],
      criticalPathLeaves: ['relMap', 'toRel', 'pathMatches'],
      recommendedStrategy: { approach: 'split responsibility (SRP)' },
    };
    const out = formatToolResult(payload, 'analyze_impact');
    expect(out).not.toContain('language');
    expect(out).not.toContain('criticalPathLeaves');
    // the analytical core stays
    expect(out).toContain('**blastRadius**');
    expect(out).toContain('**upstreamChain**');
    expect(out).toContain('**recommendedStrategy**');
  });

  it('does not emit raw JSON braces for a typical orient payload', () => {
    const out = formatToolResult({
      task: 'add rate limiting',
      relevantFunctions: [{ name: 'handleRequest', filePath: 'src/server.ts', fanIn: 3 }],
      specDomains: [{ domain: 'api', specPath: 'openspec/specs/api/spec.md' }],
      nextSteps: ['Call get_subgraph("handleRequest")'],
    });
    expect(out).not.toMatch(/[{}]/);
    expect(out).toContain('• handleRequest');
    expect(out).toContain('• Call get_subgraph("handleRequest")');
  });
});

describe('formatCallArgs', () => {
  it('quotes the primary descriptive arg', () => {
    expect(formatCallArgs({ task: 'add rate limiting' })).toBe('"add rate limiting"');
    expect(formatCallArgs({ query: 'orient' })).toBe('"orient"');
    expect(formatCallArgs({ symbol: 'handleOrient' })).toBe('"handleOrient"');
    expect(formatCallArgs({ filePath: 'src/o.ts' })).toBe('"src/o.ts"');
  });

  it('renders pathfinding as entry → target', () => {
    expect(formatCallArgs({ entryFunction: 'main', targetFunction: 'orient' })).toBe('main → orient');
  });

  it('returns empty when there is no descriptive arg', () => {
    expect(formatCallArgs({ limit: 5 })).toBe('');
    expect(formatCallArgs({})).toBe('');
  });

  it('truncates a long arg', () => {
    const out = formatCallArgs({ task: 'x'.repeat(200) });
    expect(out.endsWith('…"')).toBe(true);
    expect(out.length).toBeLessThan(90);
  });

  it('prefers task over other keys when several are present', () => {
    expect(formatCallArgs({ task: 'A', query: 'B' })).toBe('"A"');
  });

  it('renders select_tests changedSymbols as a name list (capped)', () => {
    expect(formatCallArgs({ changedSymbols: ['handleRequest'] })).toBe('handleRequest');
    expect(formatCallArgs({ changedSymbols: ['a', 'b', 'c', 'd', 'e'] })).toBe('a, b, c, +2');
  });

  it('renders select_tests diffRef as "diff <ref>"', () => {
    expect(formatCallArgs({ diffRef: 'HEAD' })).toBe('diff HEAD');
  });

  it('is empty for a bare select_tests call (no args) → bare title', () => {
    expect(formatCallArgs({ changedSymbols: [] })).toBe('');
    expect(formatCallArgs({ directory: '/p' })).toBe('');
  });
});

describe('readConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-pi-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (content: string) => {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'config.json'), content, 'utf-8');
  };

  it('returns null when the file is absent', async () => {
    expect(await readConfig(dir)).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    await write('{ not json');
    expect(await readConfig(dir)).toBeNull();
  });

  it('returns null when generation.provider is missing', async () => {
    await write(JSON.stringify({ generation: {} }));
    expect(await readConfig(dir)).toBeNull();
  });

  it('returns the parsed config when valid', async () => {
    await write(JSON.stringify({ generation: { provider: 'openai-compat', model: 'codestral' } }));
    const cfg = await readConfig(dir);
    expect(cfg?.generation.provider).toBe('openai-compat');
    expect(cfg?.generation.model).toBe('codestral');
  });
});

describe('Pi configuration fidelity', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-pi-config-fidelity-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('treats a provider-less config as present and reads it for merge-safe editing', async () => {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'config.json'), JSON.stringify({
      enforcement: { policy: { 'decision-stale': 'block' } },
      generation: { timeoutMs: 12_000 },
    }));

    expect(await loadExistingConfig(dir)).toMatchObject({
      state: 'valid',
      config: {
        enforcement: { policy: { 'decision-stale': 'block' } },
        generation: { timeoutMs: 12_000 },
      },
    });
  });

  it('does not auto-open the wizard when a provider-less config file exists', async () => {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'config.json'), JSON.stringify({ generation: {} }));
    const handlers = registerPiHandlers();
    const sessionStart = handlers.get('session_start');
    expect(sessionStart).toBeDefined();
    const select = vi.fn();
    const ctx = {
      cwd: dir,
      mode: 'json',
      hasUI: true,
      ui: { select, input: vi.fn(), confirm: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    await sessionStart?.({}, ctx);

    expect(select).not.toHaveBeenCalled();
  });

  it('preserves governance blocks and sibling settings when the provider changes', async () => {
    const existing = {
      version: '1.0.0',
      projectType: 'nodejs',
      openspecPath: 'openspec',
      analysis: { maxFiles: 100, includePatterns: ['src/**'], excludePatterns: [], futureBudget: 9 },
      generation: { provider: 'openai', model: 'gpt-4o', timeoutMs: 12_000 },
      enforcement: { policy: { 'decision-stale': 'block' } },
      impactCertificate: { surfaces: [{ name: 'public-api', symbols: ['serve'] }] },
      contextInjection: { mode: 'off' as const },
      createdAt: '2026-08-16T00:00:00.000Z',
      lastRun: null,
    };
    let menuVisits = 0;
    const select = vi.fn(async (title: string, choices: string[]) => {
      if (title === 'Provider') return 'anthropic';
      if (title === 'openlore config') {
        menuVisits += 1;
        return menuVisits === 1
          ? choices.find((choice) => choice.startsWith('Provider'))
          : '✓ Save & close';
      }
      return undefined;
    });
    const ctx = {
      cwd: dir,
      mode: 'tui',
      hasUI: true,
      ui: {
        select,
        input: vi.fn(),
        confirm: vi.fn(async () => false),
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;

    await runConfigWizard(ctx, existing);
    const saved = JSON.parse(await readFile(join(dir, '.openlore', 'config.json'), 'utf-8'));

    expect(saved.enforcement).toEqual(existing.enforcement);
    expect(saved.impactCertificate).toEqual(existing.impactCertificate);
    expect(saved.contextInjection).toEqual(existing.contextInjection);
    expect(saved.analysis.futureBudget).toBe(9);
    expect(saved.generation).toMatchObject({ provider: 'anthropic', timeoutMs: 12_000, domains: 'auto' });
    expect(saved.generation).not.toHaveProperty('model');
    expect(saved.generation).not.toHaveProperty('openaiCompatBaseUrl');
  });

  it('writes the compatibility default for a fresh config and preserves explicit domains', async () => {
    const saveImmediately = () => ({
      cwd: dir,
      mode: 'tui',
      hasUI: true,
      ui: {
        select: vi.fn(async () => '✓ Save & close'),
        input: vi.fn(),
        confirm: vi.fn(async () => false),
        notify: vi.fn(),
      },
    }) as unknown as ExtensionContext;

    await runConfigWizard(saveImmediately(), null);
    let saved = JSON.parse(await readFile(join(dir, '.openlore', 'config.json'), 'utf-8'));
    expect(saved.generation).toEqual({ domains: 'auto' });

    const explicit = {
      ...saved,
      generation: { provider: 'openai', model: 'gpt-4o', domains: ['auth', 'payments'] },
    };
    await runConfigWizard(saveImmediately(), explicit);
    saved = JSON.parse(await readFile(join(dir, '.openlore', 'config.json'), 'utf-8'));
    expect(saved.generation.domains).toEqual(['auth', 'payments']);
  });

  it('preserves embedding siblings when its URL changes and removes only an explicitly removed block', async () => {
    const existing = {
      version: '1.0.0', projectType: 'nodejs', openspecPath: 'openspec',
      analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
      generation: { provider: 'openai', model: 'gpt-4o' },
      embedding: { baseUrl: 'http://old.test', model: 'embed', dimensions: 768, timeoutMs: 9_000 },
      createdAt: '2026-08-16T00:00:00.000Z', lastRun: null,
    };
    let menuVisits = 0;
    const ctx = {
      cwd: dir, mode: 'tui', hasUI: true,
      ui: {
        select: vi.fn(async (title: string, choices: string[]) => {
          if (title !== 'openlore config') return undefined;
          menuVisits += 1;
          return menuVisits === 1 ? choices.find((choice) => choice.startsWith('URL')) : '✓ Save & close';
        }),
        input: vi.fn(async () => 'http://new.test'),
        confirm: vi.fn(async () => false),
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;

    await runConfigWizard(ctx, existing);
    let saved = JSON.parse(await readFile(join(dir, '.openlore', 'config.json'), 'utf-8'));
    expect(saved.embedding).toMatchObject({
      baseUrl: 'http://new.test', model: 'embed', dimensions: 768, timeoutMs: 9_000,
    });

    menuVisits = 0;
    const removeCtx = {
      ...ctx,
      ui: {
        ...ctx.ui,
        select: vi.fn(async (title: string) => {
          if (title !== 'openlore config') return undefined;
          menuVisits += 1;
          return menuVisits === 1 ? '✕ Remove embedding' : '✓ Save & close';
        }),
      },
    } as unknown as ExtensionContext;
    await runConfigWizard(removeCtx, saved);
    saved = JSON.parse(await readFile(join(dir, '.openlore', 'config.json'), 'utf-8'));
    expect(saved).not.toHaveProperty('embedding');
  });

  it('refuses to overwrite malformed config bytes from the explicit wizard command', async () => {
    const original = '{ malformed config\n';
    await mkdir(join(dir, '.openlore'), { recursive: true });
    const path = join(dir, '.openlore', 'config.json');
    await writeFile(path, original);
    const command = registerPiCommands().get('openlore');
    expect(command).toBeDefined();
    const select = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: dir, mode: 'tui', hasUI: true,
      ui: { select, input: vi.fn(), confirm: vi.fn(), notify },
    } as unknown as ExtensionContext;

    await command?.('', ctx);

    expect(select).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/malformed JSON.*Repair/), 'error');
    expect(await readFile(path, 'utf-8')).toBe(original);
  });
});

it('uses the current before-agent context root instead of the session-start root', async () => {
  const first = await mkdtemp(join(tmpdir(), 'openlore-pi-first-root-'));
  const current = await mkdtemp(join(tmpdir(), 'openlore-pi-current-root-'));
  try {
    await mkdir(join(first, '.openlore'), { recursive: true });
    await writeFile(join(first, '.openlore', 'config.json'), JSON.stringify({ contextInjection: { mode: 'off' } }));
    await mkdir(join(current, '.openlore', 'analysis'), { recursive: true });
    await writeFile(join(current, '.openlore', 'config.json'), JSON.stringify({ contextInjection: { mode: 'off' } }));
    await writeFile(join(current, '.openlore', 'analysis', 'CODEBASE.md'), 'CURRENT ROOT DIGEST');
    const handlers = registerPiHandlers();
    const sessionStart = handlers.get('session_start');
    const beforeAgentStart = handlers.get('before_agent_start');
    expect(sessionStart).toBeDefined();
    expect(beforeAgentStart).toBeDefined();
    const firstCtx = {
      cwd: first,
      mode: 'json',
      hasUI: false,
      ui: { select: vi.fn(), input: vi.fn(), confirm: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const ctx = {
      cwd: current,
      mode: 'tui',
      hasUI: false,
      ui: { select: vi.fn(), input: vi.fn(), confirm: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    await sessionStart?.({}, firstCtx);
    const result = await beforeAgentStart?.({ prompt: 'inspect code', systemPrompt: 'base' }, ctx) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toContain('CURRENT ROOT DIGEST');
    expect(result?.systemPrompt).not.toContain(first);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(current, { recursive: true, force: true });
  }
});

it('bounds and sorts the Pi spec-domain index with an explicit overflow receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlore-pi-spec-index-'));
  try {
    const root = join(dir, 'openspec', 'specs');
    await mkdir(root, { recursive: true });
    const count = PI_SPEC_INDEX_MAX_DOMAINS + 3;
    await Promise.all(Array.from({ length: count }, (_, i) => mkdir(join(root, `domain-${String(count - i).padStart(3, '0')}`))));
    const index = await readSpecIndex(dir);
    const entries = index.split('\n').filter((line) => line.startsWith('- domain-'));
    expect(entries).toHaveLength(PI_SPEC_INDEX_MAX_DOMAINS);
    expect(entries).toEqual([...entries].sort());
    expect(index).toContain('- … 3 more domains');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('degrades the real before-agent hook to its pointer line when orient wedges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlore-pi-hook-timeout-'));
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        presetDispatchEnforced: true,
        root: dir,
        pid: process.pid,
        preset: 'full',
        tools: NAV_TOOLS.map((tool) => tool.name),
        tokenProtected: false,
        tokenAuthenticated: true,
        draining: false,
      }));
    }
    // `/tool/orient` deliberately never responds; the hook owns the deadline.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('hook-timeout server did not bind');
  try {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'serve.json'), JSON.stringify({
      port: address.port,
      pid: process.pid,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      version: 'test',
    }));
    const timeoutMs = 50;
    const handlers = registerPiHandlers(timeoutMs);
    const beforeAgentStart = handlers.get('before_agent_start');
    const ctx = {
      cwd: dir, mode: 'tui', hasUI: false,
      ui: { select: vi.fn(), input: vi.fn(), confirm: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const startedAt = Date.now();

    const result = await beforeAgentStart?.({ prompt: 'inspect the parser', systemPrompt: 'base' }, ctx) as { systemPrompt?: string } | undefined;

    expect(Date.now() - startedAt).toBeLessThan(timeoutMs + 500);
    expect(result?.systemPrompt).toContain(pointerLineFor('error'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 2_000);

it('applies the same first-turn deadline while daemon discovery is wedged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openlore-pi-discovery-timeout-'));
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, presetDispatchEnforced: true, root: dir, pid: process.pid,
        preset: 'full', tools: NAV_TOOLS.map((tool) => tool.name),
        tokenProtected: false, tokenAuthenticated: true, draining: false,
      }));
    }, 200);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('discovery-timeout server did not bind');
  try {
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'serve.json'), JSON.stringify({
      port: address.port, pid: process.pid, host: '127.0.0.1', startedAt: '', version: 'test',
    }));
    const timeoutMs = 50;
    const beforeAgentStart = registerPiHandlers(timeoutMs).get('before_agent_start');
    const ctx = {
      cwd: dir, mode: 'tui', hasUI: false,
      ui: { select: vi.fn(), input: vi.fn(), confirm: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const startedAt = Date.now();

    const result = await beforeAgentStart?.({ prompt: 'inspect the parser', systemPrompt: 'base' }, ctx) as { systemPrompt?: string } | undefined;

    expect(Date.now() - startedAt).toBeLessThan(timeoutMs + 500);
    expect(result?.systemPrompt).toContain(pointerLineFor('error'));
    // Discovery is intentionally allowed to warm the daemon after the first-turn
    // deadline; let that useful background work settle before removing its root.
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 2_000);

/** The single text block a composite result carries. */
function compositeText(result: ReturnType<typeof compositeToolResult>): string {
  const block = result.content[0];
  if (block.type !== 'text') throw new Error('a composite envelope must be forwarded as text');
  return block.text;
}

describe('NAV_TOOLS surface', () => {
  it('has native generation and repair compositions over existing daemon observations', async () => {
    const source = await readFile(new URL('./extension.ts', import.meta.url), 'utf8');
    expect(source).toContain("name: 'openlore_prepare_spec_generation'");
    expect(source).toContain("name: 'openlore_prepare_spec_repair'");
    expect(source).toContain("'prepare_spec_generation',");
    expect(source).toContain("'prepare_spec_repair',");
    // Pi requests the daemon's byte budget and forwards the page without generic
    // clipping, so a within-budget completeness receipt stays trustworthy.
    expect(source).toContain('maxResponseBytes: PI_COMPOSITE_RESPONSE_BYTES');
    expect(source).toContain('return compositeToolResult(result);');
    expect(source).not.toContain("callTool(daemon, 'audit_spec_coverage'");
    expect(source).not.toContain("callTool(daemon, 'get_mapping'");
    expect(source).toContain('OpenLore makes no internal');
    expect(source).toContain('LLM call here. Pi\'s host agent');
  });

  it('forwards a page the daemon packed to its compact budget instead of rejecting it', () => {
    // The daemon budgets the COMPACT serialization (48 KiB). Measuring the indented
    // form against the host bound rejected every full page as a transport fault.
    const filler = 'x'.repeat(40_000);
    const page = { workflow: 'repair', receipt: { state: 'partial' }, evidence: [filler, filler.slice(0, 4_000)] };
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(48 * 1024);
    expect(Buffer.byteLength(JSON.stringify(page, null, 2), 'utf8')).toBeGreaterThan(0);

    const forwarded = compositeToolResult(page);
    expect(forwarded.details).toBe(page);
    expect(compositeText(forwarded)).not.toContain('response-too-large');
    expect(JSON.parse(compositeText(forwarded))).toEqual(page);
  });

  it('reports a genuinely oversized envelope as a typed transport fault, never clipped', () => {
    const oversized = { workflow: 'repair', evidence: 'y'.repeat(60_000) };
    const result = compositeToolResult(oversized);
    expect(JSON.parse(compositeText(result)).error.code).toBe('response-too-large');
    expect(result.details).toBe(oversized);
  });

  it('surfaces every Generate/Repair protocol observation or documents an exclusion', () => {
    const required = {
      generation: ['domainEvidence', 'domainBehavior', 'specValidation'],
      repair: [
        'domainEvidence',
        'existingSpec',
        'coveredFunction',
        'uncoveredFunction',
        'staleMapping',
        'orphanRequirement',
        'structuralChange',
        'mappingCoverage',
        'specValidation',
        'domainBehavior',
      ],
    } as const;
    for (const [workflow, observations] of Object.entries(required)) {
      const surfaced = PI_SPEC_WORKFLOW_OBSERVATIONS[workflow as keyof typeof PI_SPEC_WORKFLOW_OBSERVATIONS];
      for (const observation of observations) {
        const exclusion = PI_SPEC_WORKFLOW_EXCLUSIONS[`${workflow}.${observation}`];
        expect(
          observation in surfaced || Boolean(exclusion?.trim()),
          `${workflow}.${observation} must be surfaced or have a documented exclusion`,
        ).toBe(true);
      }
    }
  });

  it('has unique tool names', () => {
    const names = NAV_TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every entry is fully specified for registration', () => {
    for (const t of NAV_TOOLS) {
      expect(t.name, `name on ${JSON.stringify(t)}`).toMatch(/^[a-z][a-z_]*$/);
      expect(t.label, `label on ${t.name}`).toMatch(/^openlore /);
      expect(t.description.length, `description on ${t.name}`).toBeGreaterThan(0);
      expect(t.guideline.length, `guideline on ${t.name}`).toBeGreaterThan(0);
      // typebox object schema — what registerTool receives as the tool's params
      expect((t.parameters as { type?: string }).type, `parameters on ${t.name}`).toBe('object');
    }
  });

  it('describes every analyze_error_propagation model exposed by the daemon', () => {
    const tool = NAV_TOOLS.find(t => t.name === 'analyze_error_propagation')!;
    const contract = `${tool.description} ${tool.guideline}`;
    for (const language of ['TS', 'JS', 'Python', 'Java', 'C#', 'Go']) {
      expect(contract, `missing ${language} error-flow scope`).toContain(language);
    }
    expect(contract).toContain('errorModel: go-value');
    expect(contract).toMatch(/returned-error\/panic|returned errors and panics/);
    expect(contract).toMatch(/Other languages.*unsupported/);
  });

  // The load-bearing guard: every Pi-surfaced tool must be a real dispatchable
  // daemon tool. A renamed/removed tool (e.g. get_decisions, removed in #179)
  // would otherwise 404 silently at call time — this fails the build instead.
  it('only names tools the daemon can dispatch', () => {
    const dispatchable = new Set(TOOL_DEFINITIONS.map(t => t.name));
    const missing = NAV_TOOLS.map(t => t.name).filter(n => !dispatchable.has(n));
    expect(missing, `Pi NAV_TOOLS not in TOOL_DEFINITIONS: ${missing.join(', ')}`).toEqual([]);
  });

  it("each tool's declared params are a subset of the daemon tool's inputSchema", () => {
    const byName = new Map(TOOL_DEFINITIONS.map(t => [t.name, t]));
    for (const tool of NAV_TOOLS) {
      const def = byName.get(tool.name);
      if (!def) continue; // covered by the dispatchable test above
      const schemaProps = (def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      const allowed = new Set(Object.keys(schemaProps));
      // `directory` is injected by the daemon, never declared on the Pi side.
      const declared = Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {});
      const unknown = declared.filter(p => p !== 'directory' && !allowed.has(p));
      expect(unknown, `${tool.name} declares params absent from inputSchema: ${unknown.join(', ')}`).toEqual([]);
    }
  });

  it('keeps focus and focusKind schemas bidirectionally aligned across MCP and Pi', () => {
    const pi = NAV_TOOLS.find(tool => tool.name === 'get_function_body')!;
    const mcp = TOOL_DEFINITIONS.find(tool => tool.name === 'get_function_body')!;
    const piProps = (pi.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    const mcpProps = (mcp.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    for (const param of ['focus', 'focusKind']) {
      expect(piProps, `Pi is missing MCP parameter ${param}`).toHaveProperty(param);
      expect(mcpProps, `MCP is missing Pi parameter ${param}`).toHaveProperty(param);
    }

    expect(piProps.focus).toMatchObject({ type: 'string', maxLength: 200 });
    expect(mcpProps.focus).toMatchObject({ type: 'string', maxLength: 200 });
    const piKinds = ((piProps.focusKind as { anyOf?: Array<{ const?: string }> }).anyOf ?? [])
      .map(option => option.const).filter((value): value is string => typeof value === 'string').sort();
    const mcpKinds = [...((mcpProps.focusKind as { enum?: string[] }).enum ?? [])].sort();
    expect(piKinds).toEqual(['callee', 'variable']);
    expect(mcpKinds).toEqual(piKinds);
    expect(pi.parameters).toMatchObject({ dependentRequired: { focus: ['focusKind'], focusKind: ['focus'] } });
    expect(mcp.inputSchema).toMatchObject({ dependentRequired: { focus: ['focusKind'], focusKind: ['focus'] } });
  });

  // The load-bearing guard in the OTHER direction (spec: PiSurfaceParityIsGuarded).
  // Every dispatchable conclusion tool must be a deliberate Pi decision — either
  // surfaced in NAV_TOOLS or listed in PI_EXCLUDED_CONCLUSION_TOOLS with a reason.
  // A new MCP conclusion tool now fails CI until its author makes that call, the
  // same fails-until-you-decide discipline tool-contract.test.ts enforces for
  // output class and capability family.
  it('every dispatchable conclusion tool is either surfaced in Pi or excluded with a reason', () => {
    const dispatchable = new Set(TOOL_DEFINITIONS.map(t => t.name));
    const surfaced = new Set(NAV_TOOLS.map(t => t.name));
    const excluded = new Set(Object.keys(PI_EXCLUDED_CONCLUSION_TOOLS));
    const undecided = Object.entries(TOOL_OUTPUT_CLASS)
      .filter(([name, cls]) => cls === 'conclusion' && dispatchable.has(name))
      .map(([name]) => name)
      .filter(name => !surfaced.has(name) && !excluded.has(name));
    expect(
      undecided,
      `conclusion tools neither surfaced in NAV_TOOLS nor in PI_EXCLUDED_CONCLUSION_TOOLS: ${undecided.join(', ')} — surface each in Pi or add it to the exclusion list with a stated reason`,
    ).toEqual([]);
  });

  // The exclusion list stays honest: no stale entries (a tool that was surfaced
  // or removed), and every reason is a non-empty, auditable string.
  it('the Pi exclusion list has no stale entries and every reason is stated', () => {
    const dispatchable = new Set(TOOL_DEFINITIONS.map(t => t.name));
    const surfaced = new Set(NAV_TOOLS.map(t => t.name));
    for (const [name, reason] of Object.entries(PI_EXCLUDED_CONCLUSION_TOOLS)) {
      expect(TOOL_OUTPUT_CLASS[name], `excluded tool ${name} is not classified conclusion`).toBe('conclusion');
      expect(dispatchable.has(name), `excluded tool ${name} is not dispatchable (stale entry)`).toBe(true);
      expect(surfaced.has(name), `excluded tool ${name} is also surfaced in NAV_TOOLS (contradiction)`).toBe(false);
      expect(reason.trim().length, `excluded tool ${name} has an empty reason`).toBeGreaterThan(0);
    }
  });

  // Proof the guard actually fails on drift: simulate a newly-added conclusion
  // tool that is neither surfaced nor excluded — the guard predicate flags it.
  it('the parity guard flags a new conclusion tool that skips the Pi decision', () => {
    const surfaced = new Set(NAV_TOOLS.map(t => t.name));
    const excluded = new Set(Object.keys(PI_EXCLUDED_CONCLUSION_TOOLS));
    const simulatedNew = '__new_conclusion_tool__';
    const undecided = [simulatedNew].filter(name => !surfaced.has(name) && !excluded.has(name));
    expect(undecided).toEqual([simulatedNew]);
  });

  // decision-current — the claim kind the audit found inexpressible on Pi — is
  // now in the Pi verify_claim enum, matching the daemon's inputSchema.
  it('Pi verify_claim expresses every claim kind the daemon supports', () => {
    const piVerify = NAV_TOOLS.find(t => t.name === 'verify_claim');
    expect(piVerify, 'verify_claim missing from NAV_TOOLS').toBeDefined();
    const piKinds = new Set(
      ((piVerify!.parameters as { properties?: { kind?: { enum?: string[] } } }).properties?.kind?.enum) ?? [],
    );
    const daemonVerify = TOOL_DEFINITIONS.find(t => t.name === 'verify_claim');
    const daemonKinds =
      (daemonVerify?.inputSchema as { properties?: { kind?: { enum?: string[] } } }).properties?.kind?.enum ?? [];
    expect(daemonKinds.length, 'daemon verify_claim has no kind enum').toBeGreaterThan(0);
    const missing = daemonKinds.filter(k => !piKinds.has(k));
    expect(missing, `Pi verify_claim omits daemon kinds: ${missing.join(', ')}`).toEqual([]);
    expect(piKinds.has('decision-current'), 'Pi verify_claim must express decision-current').toBe(true);
  });
});
