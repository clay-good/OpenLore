import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { modelsUrl, stripMarker, isUsableConfig, readConfig, formatToolResult, formatCallArgs, NAV_TOOLS, PI_DAEMON_PRESET, PI_EXCLUDED_CONCLUSION_TOOLS, ensureDaemon, callTool, isUsableDaemon, missingDaemonTools, PiDaemonConnectionError } from './extension.js';
import { TOOL_DEFINITIONS } from '../cli/commands/mcp.js';
import { startServe } from '../cli/commands/serve.js';
import { TOOL_OUTPUT_CLASS } from '../core/services/mcp-handlers/tool-contract.js';

it('spawns a full-surface daemon because Pi curates a wider native tool set itself', () => {
  expect(PI_DAEMON_PRESET).toBe('full');
});

it('frames every Pi before-agent corpus block with the shared provenance boundary', async () => {
  const source = await readFile(new URL('./extension.ts', import.meta.url), 'utf8');
  expect(source).toContain("frameServedContent(\n      '# Codebase architecture");
  expect(source).toContain("frameServedContent(specIndex, 'reviewed-corpus'");
  expect(source).toContain('renderInjectionBlock(result, cfg)');
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

it('reports a legacy daemon without tools immediately as incompatible', async () => {
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
    const result = await callTool(discovered!, 'orient', { task: 'x' }, dir) as { error?: string };
    expect(result.error).toMatch(/does not report an authenticated, enforced tool surface/);
    expect(result.error).toMatch(/stop the legacy or incompatible process manually/i);
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

describe('NAV_TOOLS surface', () => {
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
