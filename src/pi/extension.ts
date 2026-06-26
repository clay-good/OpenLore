/**
 * openlore Pi extension — src/pi/extension.ts
 *
 * Compiled to dist/pi/extension.js and declared in package.json "pi" field so
 * `pi install npm:openlore` drops it into the Pi extension registry automatically.
 *
 * Two halves:
 *   C — context injection (before_agent_start): model starts grounded with the
 *       architecture digest + spec index + task-grounded orient call, so weak
 *       tool-callers benefit even without calling a tool.
 *   B — native tools (registerTool): navigation surface for on-demand structural
 *       queries, each round-tripping to the warm daemon via fetch.
 *
 * Uses ctx.mode (0.78.1+): full injection in tui/rpc (interactive), none in
 * json/print (one-shot). rpc = headless interactive over stdin/stdout (IDE,
 * custom UI) — same injection needs as tui.
 *
 * Config onboarding: runs on first session when .openlore/config.json is absent;
 * also available anytime via the openlore_configure tool.
 */

import type {
  AgentToolResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown, Text } from '@earendil-works/pi-tui';
import { Type, type TObject, type TSchema } from 'typebox';

import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Task-scoped injection gate + render. This module is intentionally
// dependency-light (its only runtime import is estimateTokens) so importing it
// here does NOT drag the analyzer into the Pi host — orientation still comes
// from the warm daemon over RPC (decision abee8e3e).
import {
  resolveInjectionConfig,
  passesRelevanceGate,
  renderInjectionBlock,
  POINTER_LINE,
  type LeanOrientResult,
} from '../cli/commands/orient-inject-render.js';
import type { ContextInjectionConfig } from '../types/index.js';

// ── Config types & helpers ────────────────────────────────────────────────────

interface OpenLoreConfig {
  version: string;
  projectType: string;
  openspecPath: string;
  analysis: { maxFiles: number; includePatterns: string[]; excludePatterns: string[] };
  generation: {
    provider?: string;
    model?: string;
    openaiCompatBaseUrl?: string;
    skipSslVerify?: boolean;
  };
  embedding?: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    skipSslVerify?: boolean;
  };
  /** Task-scoped context injection settings (gate + token budget + opt-out). */
  contextInjection?: ContextInjectionConfig;
  createdAt: string;
  lastRun: string | null;
}

const OPENLORE_DIR = '.openlore';

/** Treat a config as absent unless it has the minimum viable fields. */
export function isUsableConfig(raw: unknown): raw is OpenLoreConfig {
  return !!raw && typeof raw === 'object' && typeof (raw as OpenLoreConfig).generation?.provider === 'string';
}

export async function readConfig(cwd: string): Promise<OpenLoreConfig | null> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, OPENLORE_DIR, 'config.json'), 'utf-8'));
    return isUsableConfig(raw) ? raw : null;
  } catch { return null; }
}

/**
 * Read just the `contextInjection` block, independent of `isUsableConfig`.
 * The injection opt-out must work even before an LLM provider is configured —
 * `readConfig` returns null until `generation.provider` is set (a headless/rpc
 * session may never run the wizard), which would silently drop `mode: "off"`.
 * Mirrors the CLI path, which reads config unconditionally.
 */
export async function readContextInjection(cwd: string): Promise<ContextInjectionConfig | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, OPENLORE_DIR, 'config.json'), 'utf-8')) as unknown;
    return raw && typeof raw === 'object'
      ? (raw as { contextInjection?: ContextInjectionConfig }).contextInjection
      : undefined;
  } catch { return undefined; }
}

async function writeConfig(cwd: string, config: OpenLoreConfig): Promise<void> {
  await mkdir(join(cwd, OPENLORE_DIR), { recursive: true });
  await writeFile(join(cwd, OPENLORE_DIR, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

const PROVIDERS = [
  'anthropic', 'openai', 'openai-compat', 'gemini',
  'copilot', 'claude-code', 'gemini-cli', 'mistral-vibe', 'cursor-agent',
];

const PROVIDER_MODEL_DEFAULTS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  'openai-compat': '',
  gemini: 'gemini-2.0-flash',
  copilot: 'gpt-4o',
  'claude-code': 'claude-sonnet-4-6',
  'gemini-cli': 'gemini-2.0-flash',
  'mistral-vibe': 'codestral-latest',
  'cursor-agent': '',
};

const SYSTEM_AUTH_PROVIDERS = new Set(['copilot', 'claude-code', 'gemini-cli', 'mistral-vibe', 'cursor-agent']);

const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compat': 'OPENAI_COMPAT_API_KEY',
  copilot: 'COPILOT_API_KEY',
};

/**
 * Build the `/v1/models` URL for a provider base URL, tolerating a trailing
 * slash and an already-present `/v1` segment (e.g. https://api.mistral.ai/v1/).
 */
export function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1/models`;
}

/** Strip the trailing " *" current-value marker added to select-list entries. */
export function stripMarker(label: string): string {
  return label.replace(/ \*$/, '');
}

async function fetchModels(baseUrl: string, apiKey?: string): Promise<string[] | null> {
  try {
    const res = await fetch(modelsUrl(baseUrl), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: { id: string }[] };
    return data.data?.map((m) => m.id).sort() ?? null;
  } catch { return null; }
}

// ── Config wizard ─────────────────────────────────────────────────────────────

const FIELD_PAD = 16; // must be >= longest label length ("Max files" = 9)
const SEP_WIDTH = 36;

function fmtField(label: string, value: string): string {
  return `${label.padEnd(FIELD_PAD)}${value}`;
}

function fmtSep(title?: string): string {
  if (!title) return '─'.repeat(SEP_WIDTH);
  const padded = ` ${title} `;
  const remaining = Math.max(4, SEP_WIDTH - padded.length);
  const left = Math.floor(remaining / 2);
  return '─'.repeat(left) + padded + '─'.repeat(remaining - left);
}

const SEP_GENERATION = fmtSep('Generation (LLM)');
const SEP_EMBEDDING  = fmtSep('Embedding (retrieval)');
const SEP_ANALYSIS   = fmtSep('Analysis');
const SEP_DIVIDER    = fmtSep();


async function runConfigWizard(ctx: ExtensionContext, existing?: OpenLoreConfig | null): Promise<void> {
  const { ui } = ctx;

  let generation: OpenLoreConfig['generation'] = existing?.generation ?? {};
  let embedding = existing?.embedding;
  let maxFiles = existing?.analysis?.maxFiles ?? 500;
  const prevProvider = existing?.generation?.provider;
  const prevModel = existing?.generation?.model;

  if (embedding?.apiKey) {
    embedding = { baseUrl: embedding.baseUrl, model: embedding.model, ...(embedding.skipSslVerify ? { skipSslVerify: true } : {}) };
    ui.notify('Removed stored embedding API key — set OPENLORE_EMBEDDING_API_KEY in your shell instead.', 'warning');
  }

  while (true) {
    // Build menu as parallel (label, handler) pairs so duplicate labels (Model,
    // Skip SSL appear in both sections) dispatch to the correct handler by index.
    type Handler = (() => Promise<void>) | undefined;
    const menu: Array<{ label: string; handler: Handler }> = [];
    const sep  = (s: string)  => menu.push({ label: s, handler: undefined });
    const row  = (label: string, value: string, handler: () => Promise<void>) =>
      menu.push({ label: fmtField(label, value), handler });

    sep(SEP_GENERATION);
    row('Provider', generation.provider ?? '—', async () => {
      const list = generation.provider
        ? [`${generation.provider} *`, ...PROVIDERS.filter((p) => p !== generation.provider)]
        : PROVIDERS;
      const sel = await ui.select('Provider', list);
      if (sel) {
        const next = stripMarker(sel);
        if (next !== generation.provider) {
          generation = { provider: next };
          if (!SYSTEM_AUTH_PROVIDERS.has(next) && PROVIDER_ENV_VARS[next] && !process.env[PROVIDER_ENV_VARS[next]]) {
            ui.notify(`Set ${PROVIDER_ENV_VARS[next]} in your shell environment`, 'warning');
          }
        }
      }
    });

    if (generation.provider) {
      row('Model', generation.model ?? '—', async () => {
        const apiBase = generation.provider === 'openai' ? 'https://api.openai.com' : (generation.openaiCompatBaseUrl ?? '');
        const apiKey = generation.provider ? process.env[PROVIDER_ENV_VARS[generation.provider] ?? ''] : undefined;
        const models = apiBase ? await fetchModels(apiBase, apiKey) : null;
        if (models && models.length > 0) {
          const modelList = generation.model && models.includes(generation.model)
            ? [`${generation.model} *`, ...models.filter((m) => m !== generation.model)]
            : models;
          const sel = await ui.select('Model', modelList);
          if (sel) generation = { ...generation, model: stripMarker(sel) };
        } else {
          const input = await ui.input(
            generation.model ? `Model (current: ${generation.model})` : 'Model',
            PROVIDER_MODEL_DEFAULTS[generation.provider ?? ''] ?? '',
          );
          if (input) generation = { ...generation, model: input };
        }
      });
    }

    if (generation.provider === 'openai-compat') {
      row('Base URL', generation.openaiCompatBaseUrl ?? '—', async () => {
        const input = await ui.input(
          generation.openaiCompatBaseUrl ? `Base URL (current: ${generation.openaiCompatBaseUrl})` : 'Base URL',
          'http://localhost:11434',
        );
        if (input) generation = { ...generation, openaiCompatBaseUrl: input };
      });
      row('Skip SSL', generation.skipSslVerify ? 'yes' : 'no', async () => {
        generation = { ...generation, skipSslVerify: await ui.confirm(
          'Skip SSL verification?',
          'Only enable for local servers with self-signed certificates (e.g. Ollama on localhost). Do NOT enable for remote/cloud endpoints.',
        ) };
      });
    }

    sep(SEP_EMBEDDING);
    row('URL', embedding?.baseUrl ?? '—', async () => {
      const input = await ui.input(
        embedding?.baseUrl ? `Embedding URL (current: ${embedding.baseUrl})` : 'Embedding URL (leave empty to skip)',
        embedding?.baseUrl ?? 'http://localhost:11434',
      );
      if (input) {
        embedding = { baseUrl: input, model: embedding?.model ?? '', ...(embedding?.skipSslVerify ? { skipSslVerify: true } : {}) };
        if (!process.env['OPENLORE_EMBEDDING_API_KEY']) {
          ui.notify('Set OPENLORE_EMBEDDING_API_KEY in your shell (leave unset for Ollama/local endpoints)', 'info');
        }
      }
    });

    if (embedding?.baseUrl) {
      row('Model', embedding.model || '(none)', async () => {
        const models = embedding?.baseUrl ? await fetchModels(embedding.baseUrl) : null;
        if (models && models.length > 0) {
          const cur = embedding?.model;
          const modelList = cur && models.includes(cur)
            ? [`${cur} *`, ...models.filter((m) => m !== cur)]
            : models;
          const sel = await ui.select('Embedding model', modelList);
          if (sel && embedding) embedding = { ...embedding, model: stripMarker(sel) };
        } else {
          const input = await ui.input(
            embedding?.model ? `Model (current: ${embedding.model})` : 'Model',
            '',
          );
          if (input && embedding) embedding = { ...embedding, model: input };
        }
      });
      row('Skip SSL', embedding.skipSslVerify ? 'yes' : 'no', async () => {
        if (embedding) embedding = { ...embedding, skipSslVerify: await ui.confirm(
          'Skip SSL for embedding?',
          'Only enable for local servers with self-signed certificates (e.g. Ollama on localhost). Do NOT enable for remote/cloud endpoints.',
        ) };
      });
      menu.push({ label: '✕ Remove embedding', handler: async () => { embedding = undefined; } });
    }

    sep(SEP_ANALYSIS);
    row('Max files', String(maxFiles), async () => {
      const raw = await ui.input(`Max files to analyze (current: ${maxFiles})`, String(maxFiles));
      maxFiles = parseInt(raw ?? '', 10) || maxFiles;
    });
    sep(SEP_DIVIDER);
    menu.push({ label: '✓ Save & close',    handler: undefined });
    menu.push({ label: '✕ Discard & close', handler: undefined });

    const labels = menu.map((m) => m.label);
    const choice = await ui.select('openlore config', labels);

    if (!choice || choice === '✕ Discard & close') return;
    if (choice === '✓ Save & close') break;

    const idx = labels.indexOf(choice);
    if (idx !== -1) await menu[idx].handler?.();
  }

  const config: OpenLoreConfig = {
    version: existing?.version ?? '1.0.0',
    projectType: existing?.projectType ?? 'unknown',
    openspecPath: existing?.openspecPath ?? 'openspec',
    analysis: {
      maxFiles,
      includePatterns: existing?.analysis?.includePatterns ?? [],
      excludePatterns: existing?.analysis?.excludePatterns ?? [],
    },
    generation,
    ...(embedding ? { embedding } : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastRun: existing?.lastRun ?? null,
  };

  await writeConfig(ctx.cwd, config);
  ui.notify('Configuration saved.', 'info');

  const generationChanged = generation.provider !== prevProvider || generation.model !== prevModel;
  if (generationChanged) {
    const runNow = await ui.confirm(
      'Run openlore analyze now?',
      'Builds the structural index required for navigation tools (~30s–2min depending on codebase size)',
    );
    if (runNow) {
      ui.notify('Running openlore analyze…', 'info');
      const [exitCode, errText] = await new Promise<[number, string]>((resolve) => {
        const trySpawn = (cmd: string, args: string[]) => new Promise<[number, string] | null>((res) => {
          const chunks: Buffer[] = [];
          const proc = process.platform === 'win32'
            ? spawn('cmd.exe', ['/c', cmd, ...args], { cwd: ctx.cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
            : spawn(cmd, args, { cwd: ctx.cwd, stdio: ['ignore', 'ignore', 'pipe'] });
          proc.stderr?.on('data', (d: Buffer) => chunks.push(d));
          proc.on('close', (code) => res([code ?? 1, Buffer.concat(chunks).toString().trim()]));
          proc.on('error', () => res(null));
        });
        trySpawn('openlore', ['analyze']).then((r) => {
          if (r !== null) return resolve(r);
          return trySpawn('npx', ['openlore', 'analyze']).then((r2) => resolve(r2 ?? [1, 'openlore not found in PATH']));
        });
      });
      if (exitCode === 0) {
        ui.notify('Analysis complete — openlore tools are ready.', 'info');
      } else {
        ui.notify(`openlore analyze failed — run it manually. ${errText ? '(' + errText.slice(0, 120) + ')' : ''}`.trim(), 'error');
      }
    }
  }
}

// ── Daemon discovery + lifecycle ──────────────────────────────────────────────

interface ServeDescriptor { port: number; pid: number; host: string; token?: string }
interface Daemon { baseUrl: string; token?: string }

const HEALTH_TIMEOUT_MS = 8000;
const HEALTH_POLL_MS = 150;
// Generous per-probe timeout: a cold Node HTTP server on Windows can be slow to
// answer the first /health. Too short a timeout misreads a live daemon as dead,
// so we spawn a fresh one and orphan the previous — orphans pile up in RAM.
const HEALTH_PROBE_TIMEOUT_MS = 2500;
// Keepalive: while a session is open, ping the daemon's /health on this interval
// so the in-use daemon never hits the serve idle-shutdown (default 15 min) mid-
// session. Must stay well below that window — at ~1/3 of it, two pings can be
// missed before a wrongful reap. Only daemons this extension knows are pinged —
// orphans get no ping and still reap, so this can't resurrect the RAM pileup.
const KEEPALIVE_MS = 5 * 60_000;
const RESULT_MAX = 50_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readDescriptor(cwd: string): Promise<ServeDescriptor | null> {
  try {
    return JSON.parse(await readFile(join(cwd, OPENLORE_DIR, 'serve.json'), 'utf-8')) as ServeDescriptor;
  } catch { return null; }
}

async function healthy(desc: ServeDescriptor): Promise<boolean> {
  try {
    const res = await fetch(`http://${desc.host}:${desc.port}/health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    if (!res.ok) return false;
    return ((await res.json().catch(() => null)) as { ok?: boolean } | null)?.ok === true;
  } catch { return false; }
}

async function ensureDaemon(cwd: string): Promise<Daemon | null> {
  const existing = await readDescriptor(cwd);
  if (existing && (await healthy(existing))) return { baseUrl: `http://${existing.host}:${existing.port}`, token: existing.token };
  try {
    // The daemon must outlive this process and write .openlore/serve.json.
    // Windows 10 kills a child whose stdout/stderr are NUL (stdio:'ignore') —
    // it dies before writing the descriptor (Win11 tolerates it). Give it a
    // real file handle (serve.log) instead; that's the fix validated on Win10.
    // On Windows we also drop `detached`: it allocates a console window that
    // windowsHide can't suppress, and Windows doesn't reap the child on parent
    // exit anyway. macOS/Linux need `detached` (setsid) to outlive us.
    const isWin = process.platform === 'win32';
    // shell:true joins args verbatim, so quote the cwd ourselves to survive
    // spaces / metacharacters in the project path. POSIX has no shell, so the
    // raw path is passed straight through (quoting would become part of it).
    const dirArg = isWin ? `"${cwd}"` : cwd;
    await mkdir(join(cwd, OPENLORE_DIR), { recursive: true });
    const logFd = openSync(join(cwd, OPENLORE_DIR, 'serve.log'), 'a');
    try {
      const child = spawn('openlore', ['serve', '--directory', dirArg], {
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        ...(isWin ? { shell: true } : { detached: true }),
      });
      child.on('error', () => { /* daemon not found — polling loop will time out cleanly */ });
      child.unref();
    } finally {
      closeSync(logFd);
    }
  } catch { return null; }
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_POLL_MS);
    const desc = await readDescriptor(cwd);
    if (desc && (await healthy(desc))) return { baseUrl: `http://${desc.host}:${desc.port}`, token: desc.token };
  }
  return null;
}

async function callTool(daemon: Daemon, name: string, args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (daemon.token) headers['x-openlore-token'] = daemon.token;
  try {
    const res = await fetch(`${daemon.baseUrl}/tool/${encodeURIComponent(name)}`, {
      method: 'POST', headers, body: JSON.stringify({ directory: cwd, args }), signal,
    });
    const body = await res.json().catch(() => ({ error: `non-JSON (${res.status})` }));
    if (!res.ok) return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
    return body;
  } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
}

// ── Context injection helpers ─────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n… (truncated, ${s.length - max} more chars)`;
}

async function readDigest(cwd: string): Promise<string> {
  try { return await readFile(join(cwd, OPENLORE_DIR, 'analysis', 'CODEBASE.md'), 'utf-8'); }
  catch { return ''; }
}

async function readSpecIndex(cwd: string): Promise<string> {
  try {
    const { readdir } = await import('node:fs/promises');
    const dirs = (await readdir(join(cwd, 'openspec', 'specs'), { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
    if (dirs.length === 0) return '';
    return ['## openlore spec domains', ...dirs.map((d) => `- ${d}`)].join('\n');
  } catch { return ''; }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

interface NavToolSpec { name: string; label: string; description: string; guideline: string; parameters: TObject }

// Descriptions and guidelines are written trigger-first and jargon-light: weak
// local tool-callers (e.g. codestral) pattern-match on "when the user asks X,
// call this" far better than on a capability statement full of graph jargon.
export const NAV_TOOLS: NavToolSpec[] = [
  {
    name: 'orient',
    label: 'openlore orient',
    description: 'START HERE on any new task. One call returns the functions, files, and specs relevant to the task, plus where to add code.',
    guideline: 'On any new task, call openlore_orient FIRST — before reading or grepping files.',
    parameters: Type.Object({ task: Type.String({ description: 'Natural-language task description' }), limit: Type.Optional(Type.Number()) }),
  },
  {
    name: 'search_code',
    label: 'openlore search_code',
    description: 'Find functions by what they do or by name (meaning + keyword search).',
    guideline: 'When you need to find where something lives in the code, call openlore_search_code with what you are looking for as `query`, instead of grepping.',
    parameters: Type.Object({
      query: Type.String({ description: 'REQUIRED. What to look for — a concept or a function/type name, e.g. "rate limiting" or "handleRequest".' }),
      limit: Type.Optional(Type.Number()),
      language: Type.Optional(Type.String()),
    }),
  },
  {
    name: 'get_subgraph',
    label: 'openlore get_subgraph',
    description: 'See what calls a function and what that function calls.',
    guideline: 'Before you change a function, call openlore_get_subgraph with that function\'s name (`functionName`) to see what might break. Always pass the function name.',
    parameters: Type.Object({
      functionName: Type.String({ description: 'REQUIRED. The exact name of the function to inspect, e.g. "handleRequest".' }),
      direction: Type.Optional(StringEnum(['downstream', 'upstream', 'both'] as const)),
      maxDepth: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'trace_execution_path',
    label: 'openlore trace_execution_path',
    description: 'Show how one function reaches another — the call path between them.',
    guideline: 'When the question is "how does X reach Y" or you need to trace a flow, call openlore_trace_execution_path with both function names (`entryFunction` = X, `targetFunction` = Y).',
    parameters: Type.Object({
      entryFunction: Type.String({ description: 'REQUIRED. The function the path starts FROM, e.g. "main".' }),
      targetFunction: Type.String({ description: 'REQUIRED. The function the path should reach, e.g. "handleOrient".' }),
      maxDepth: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'find_path',
    label: 'openlore find_path',
    description: 'Find the cheapest call path from one function to another — the route from A to B through the call graph, plus a few alternates.',
    guideline: 'When you need the route between two functions ("how does A reach B"), call openlore_find_path with `from` and `to` — function names, or selectors like role:entrypoint / file:<path>. For a step-by-step trace of an already-known path, use trace_execution_path instead.',
    parameters: Type.Object({
      from: Type.String({ description: 'REQUIRED. Start endpoint: a function name, or a selector — landmark:<id> / role:entrypoint|hub|sink / file:<path>.' }),
      to: Type.String({ description: 'REQUIRED. Goal endpoint: a function name, or a selector — landmark:<id> / role:entrypoint|hub|sink / file:<path>.' }),
      useCallDistance: Type.Optional(Type.Boolean({ description: 'Rank by confidence-weighted call-distance (default true); false ranks by fewest hops.' })),
      directResolvedOnly: Type.Optional(Type.Boolean({ description: 'Traverse only directly-resolved edges, ignoring synthesized dynamic-dispatch edges (default false).' })),
    }),
  },
  {
    name: 'analyze_impact',
    label: 'openlore analyze_impact',
    description: 'List everything that depends on a function or type (its blast radius).',
    guideline: 'Before editing a widely-used function or type, call openlore_analyze_impact with its name (`symbol`) to see what depends on it. Always pass the function/type name.',
    parameters: Type.Object({
      symbol: Type.String({ description: 'REQUIRED. The exact function or type name to analyze, e.g. "handleRequest".' }),
      depth: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'select_tests',
    label: 'openlore select_tests',
    description: 'Find the tests that exercise given functions or a set of changes, so you know exactly what to run. With no arguments, uses your current uncommitted changes.',
    guideline: 'When asked to test a function, or to verify/validate a change, call openlore_select_tests FIRST to find the tests that cover it — do not guess which tests to run. Pass changedSymbols for specific functions; with no arguments it defaults to your current working-tree changes.',
    parameters: Type.Object({
      changedSymbols: Type.Optional(Type.Array(Type.String(), { description: 'Function/type names you changed or want tested. Optional — omit to use your current uncommitted changes (diff vs HEAD).' })),
      diffRef: Type.Optional(Type.String({ description: 'Git ref to diff the working tree against (e.g. "HEAD", "main"). Optional — defaults to HEAD when no changedSymbols given.' })),
      maxDepth: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'get_test_coverage',
    label: 'openlore get_test_coverage',
    description: 'Show which parts of the code have tests and which do not.',
    guideline: 'To check whether code is tested before changing it or before a PR, call openlore_get_test_coverage.',
    parameters: Type.Object({
      domains: Type.Optional(Type.Array(Type.String(), { description: 'Limit to these spec domains' })),
      minCoverage: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'blast_radius',
    label: 'openlore blast_radius',
    description: 'Before committing a change, get one briefing of what it touches: affected callers, layers crossed, the tests to run, and the decisions/specs/memories it puts at risk.',
    guideline: 'Before you commit or finish a change, call openlore_blast_radius to see the blast radius — what your edits affect and which tests to run. With no arguments it uses your current uncommitted changes (diff vs HEAD).',
    parameters: Type.Object({
      baseRef: Type.Optional(Type.String({ description: 'Git ref to diff the working tree against (e.g. "HEAD", "main"). Optional — defaults to HEAD (uncommitted changes).' })),
      depth: Type.Optional(Type.Number({ description: 'Impact-analysis traversal depth (default 2).' })),
      maxSymbols: Type.Optional(Type.Number({ description: 'Cap on the highest-fan-in changed symbols analyzed (default 12).' })),
    }),
  },
  {
    name: 'structural_diff',
    label: 'openlore structural_diff',
    description: 'Show what changed structurally between two states (working tree vs a ref, or two refs): functions and call edges added/removed, signature changes, and the existing callers left STALE by a moved signature.',
    guideline: 'When reviewing or refactoring a change, call openlore_structural_diff to see the structural delta and whose callers are now stale — a complement to git diff. With no arguments it compares your working tree against HEAD.',
    parameters: Type.Object({
      baseRef: Type.Optional(Type.String({ description: 'Old state to diff against (e.g. "HEAD", "main"). Optional — defaults to HEAD.' })),
      headRef: Type.Optional(Type.String({ description: 'New state (a git ref). Optional — omit to use the working tree.' })),
      maxResults: Type.Optional(Type.Number({ description: 'Cap reported items per category (default 200).' })),
    }),
  },
  {
    name: 'verify_claim',
    label: 'openlore verify_claim',
    description: 'Verify a structural claim against the graph before asserting it — "X is dead", "Y calls Z", "Z is safe to change" — and get a deterministic verdict (confirmed / refuted / unverifiable) with a citation receipt.',
    guideline: 'Before you tell the user a structural fact ("X is dead", "Y calls Z", "this is safe to change"), call openlore_verify_claim with `kind` and `subject` (and `object` for relational kinds: calls, reaches, impacts). An "unverifiable" verdict means hedge or read the source rather than assert.',
    parameters: Type.Object({
      kind: StringEnum(['calls', 'reaches', 'dead', 'impacts', 'safe-to-change'] as const, { description: 'REQUIRED. The kind of structural claim to verify.' }),
      subject: Type.String({ description: 'REQUIRED. The symbol the claim is about (a function/method name).' }),
      object: Type.Optional(Type.String({ description: 'The second symbol — required for relational kinds (calls, reaches, impacts).' })),
    }),
  },
  {
    name: 'suggest_insertion_points',
    label: 'openlore suggest_insertion_points',
    description: 'Suggest where to add new code — ranked files and functions.',
    guideline: 'When planning where a new feature or function should go, call openlore_suggest_insertion_points with a short description of the new code.',
    parameters: Type.Object({
      description: Type.String({ description: 'REQUIRED. What the new code should do, e.g. "add rate limiting to the API".' }),
      limit: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'get_function_skeleton',
    label: 'openlore get_function_skeleton',
    description: "Show a file's structure — signatures and control flow — without the full bodies.",
    guideline: 'To understand a file cheaply before opening it, call openlore_get_function_skeleton with its path (`filePath`).',
    parameters: Type.Object({
      filePath: Type.String({ description: 'REQUIRED. Path to the file, relative to the repo root, e.g. "src/server.ts".' }),
    }),
  },
  {
    name: 'get_health_map',
    label: 'openlore get_health_map',
    description: 'Show the riskiest areas of the codebase, ranked: overloaded, tangled, and untested hotspots.',
    guideline: 'Before a refactor, call openlore_get_health_map to find the riskiest areas to focus on.',
    parameters: Type.Object({ limit: Type.Optional(Type.Number()) }),
  },
  {
    name: 'get_surprising_connections',
    label: 'openlore get_surprising_connections',
    description: "Find unexpected dependencies between parts of the code that usually don't interact.",
    guideline: 'Before a PR, call openlore_get_surprising_connections to spot accidental coupling.',
    parameters: Type.Object({ limit: Type.Optional(Type.Number()) }),
  },
  {
    name: 'get_architecture_overview',
    label: 'openlore get_architecture_overview',
    description: 'Get a bird\'s-eye view of the codebase — domain clusters, cross-cluster dependencies, entry points, and critical hubs.',
    guideline: 'Before planning a large feature or onboarding to an unknown area, call openlore_get_architecture_overview for a structural overview.',
    parameters: Type.Object({}),
  },
  {
    name: 'get_map',
    label: 'openlore get_map',
    description: 'The lay of the land — a coarse-to-fine map of the codebase: each region (community) as a super-node with its top files, plus how the regions connect. Drill into one region with its id.',
    guideline: 'To get oriented in an unfamiliar codebase or see where regions connect, call openlore_get_map. Pass a `communityId` from the region view to drill into one region at function granularity.',
    parameters: Type.Object({
      communityId: Type.Optional(Type.String({ description: 'Optional: drill into this region (a communityId from the region view) at function granularity.' })),
    }),
  },
  {
    name: 'get_landmarks',
    label: 'openlore get_landmarks',
    description: 'The structural anchors of the whole repo — hubs, orchestrators, chokepoints, volatile, entrypoint, and dead functions, each labeled with evidence.',
    guideline: 'To find the most structurally important functions before a change, call openlore_get_landmarks. Filter to one kind with `label` (hub | orchestrator | chokepoint | volatile | entrypoint | dead).',
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: 'Optional: return only landmarks carrying this label — hub | orchestrator | chokepoint | volatile | entrypoint | dead.' })),
      limit: Type.Optional(Type.Number({ description: 'Max landmarks to return, ordered by fan-in (default 20, max 200).' })),
    }),
  },
  {
    name: 'get_refactor_report',
    label: 'openlore get_refactor_report',
    description: 'List functions that need refactoring, ranked by priority: hub overload, god functions, SRP violations, cyclic dependencies.',
    guideline: 'Before starting a refactor, call openlore_get_refactor_report to find the highest-priority targets.',
    parameters: Type.Object({}),
  },
  {
    name: 'get_critical_hubs',
    label: 'openlore get_critical_hubs',
    description: 'Find the most-called functions — modifying them has the widest blast radius and requires the most careful refactoring.',
    guideline: 'Before touching widely-used code, call openlore_get_critical_hubs to see which functions are the most sensitive to change.',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      minFanIn: Type.Optional(Type.Number({ description: 'Minimum number of callers to be considered a hub (default: 3)' })),
    }),
  },
  {
    name: 'get_god_functions',
    label: 'openlore get_god_functions',
    description: 'Find god functions (high fan-out orchestrators) that call too many things and likely need to be split.',
    guideline: 'When a function feels too large or does too much, call openlore_get_god_functions to find orchestrator candidates for refactoring.',
    parameters: Type.Object({
      filePath: Type.Optional(Type.String({ description: 'Restrict search to this file (relative path)' })),
      fanOutThreshold: Type.Optional(Type.Number({ description: 'Minimum fan-out to be considered a god function (default: 8)' })),
    }),
  },
  {
    name: 'search_specs',
    label: 'openlore search_specs',
    description: 'Search OpenSpec specifications by meaning — find which requirement covers a concept.',
    guideline: 'Before writing code for a feature, call openlore_search_specs to find what the spec says about it.',
    parameters: Type.Object({
      query: Type.String({ description: 'REQUIRED. Natural language query, e.g. "email validation workflow"' }),
      limit: Type.Optional(Type.Number()),
      domain: Type.Optional(Type.String({ description: 'Filter by domain name (e.g. "auth", "analyzer")' })),
      section: Type.Optional(Type.String({ description: 'Filter by section type: "requirements", "purpose", "design"' })),
    }),
  },
  {
    name: 'search_unified',
    label: 'openlore search_unified',
    description: 'Search code and specs simultaneously — returns functions and requirements that match, cross-boosted when they are linked.',
    guideline: 'When you want to find where something is implemented AND what the spec says about it in one call, use openlore_search_unified.',
    parameters: Type.Object({
      query: Type.String({ description: 'REQUIRED. Natural language query, e.g. "validate user authentication"' }),
      limit: Type.Optional(Type.Number()),
      language: Type.Optional(Type.String({ description: 'Filter code results by language (e.g. "TypeScript")' })),
      domain: Type.Optional(Type.String({ description: 'Filter spec results by domain name' })),
      section: Type.Optional(Type.String({ description: 'Filter spec results by section type' })),
    }),
  },
  {
    name: 'get_spec',
    label: 'openlore get_spec',
    description: 'Read the full specification for a domain — all requirements, scenarios, and linked source files.',
    guideline: 'When you know which spec domain covers your task, call openlore_get_spec with the domain name to read its requirements before writing code.',
    parameters: Type.Object({
      domain: Type.String({ description: 'REQUIRED. Domain name (e.g. "auth", "analyzer") — use search_specs to discover domain names.' }),
    }),
  },
  {
    name: 'get_function_body',
    label: 'openlore get_function_body',
    description: 'Read the exact source code of a function by name and file.',
    guideline: 'After search_code or get_function_skeleton identifies a function, call openlore_get_function_body to read its full implementation instead of opening the file.',
    parameters: Type.Object({
      filePath: Type.String({ description: 'REQUIRED. File path relative to the project directory, e.g. "src/auth/jwt.ts"' }),
      functionName: Type.String({ description: 'REQUIRED. Name of the function to extract, e.g. "verifyToken"' }),
    }),
  },
  {
    name: 'get_file_dependencies',
    label: 'openlore get_file_dependencies',
    description: 'Show what a file imports and what files import it — the coupling picture for a single file.',
    guideline: 'Before moving, deleting, or refactoring a file, call openlore_get_file_dependencies to understand its coupling.',
    parameters: Type.Object({
      filePath: Type.String({ description: 'REQUIRED. File path relative to the project root, e.g. "src/core/analyzer/vector-index.ts"' }),
      direction: Type.Optional(StringEnum(['imports', 'importedBy', 'both'] as const)),
    }),
  },
  {
    name: 'remember',
    label: 'openlore remember',
    description: 'Persist a durable, code-anchored fact for a later session — an invariant, gotcha, or rationale. Anchor it to a symbol/file so it self-invalidates when that code changes.',
    guideline: 'When you learn something durable about the code that future sessions should know (an invariant, a gotcha, why something is the way it is), call openlore_remember with the `content` and `anchors` (the symbol/file it is about). For spec-synced architectural decisions, use record_decision instead.',
    parameters: Type.Object({
      content: Type.String({ description: 'REQUIRED. The memory to persist — one self-contained fact.' }),
      anchors: Type.Optional(Type.Array(
        Type.Object({
          symbol: Type.Optional(Type.String({ description: 'Function/method name (optional).' })),
          file: Type.Optional(Type.String({ description: 'Repo-relative file path (optional).' })),
        }),
        { description: 'Code this memory is about; each anchor names a symbol and/or file so the memory self-invalidates when that code changes.' },
      )),
      type: Type.Optional(StringEnum(['invariant', 'gotcha', 'rationale', 'convention', 'preference', 'todo', 'note'] as const, { description: 'Classification (default note); never inferred.' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Optional retrieval tags.' })),
      supersedes: Type.Optional(Type.String({ description: 'Id of a prior memory to retire (kept queryable via asOf).' })),
    }),
  },
  {
    name: 'recall',
    label: 'openlore recall',
    description: 'Recall code-anchored memories for what you are about to work on, each with a freshness verdict (fresh / drifted / orphaned).',
    guideline: 'When starting work on code, call openlore_recall with a short `task` to surface durable notes left by earlier sessions. Drifted memories need verifying; orphaned ones are never authoritative. A memory whose anchored symbol was renamed/moved is carried forward (re-pointed) at the next `openlore analyze` and recalls with a `carriedAcross` note; an orphaned memory may list `possiblyMovedTo` candidates to reconcile.',
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: 'What you are about to work on (optional) — scopes the recall; omit to scan all.' })),
      type: Type.Optional(Type.String({ description: 'Restrict notes to this type (decisions excluded when set).' })),
      limit: Type.Optional(Type.Number({ description: 'Max memories to return (default 10).' })),
      asOf: Type.Optional(Type.String({ description: 'Commit-ish: memory authoritative as of that commit.' })),
      changedSince: Type.Optional(Type.String({ description: 'Commit-ish: memory recorded/invalidated after it.' })),
    }),
  },
  {
    name: 'check_spec_drift',
    label: 'openlore check_spec_drift',
    description: 'Check whether your code changes have drifted from the specs — which changed files are no longer covered by their spec.',
    guideline: 'After modifying code, or before opening a PR, call openlore_check_spec_drift to see whether the specs are still in sync with what you changed. Requires `openlore generate` to have been run once.',
    parameters: Type.Object({
      base: Type.Optional(Type.String({ description: 'Git ref to compare against (default: auto-detect main/master).' })),
      domains: Type.Optional(Type.Array(Type.String(), { description: 'Only check these spec domains (default: all).' })),
      failOn: Type.Optional(StringEnum(['error', 'warning', 'info'] as const, { description: 'Minimum severity to report (default warning).' })),
    }),
  },
  {
    name: 'audit_spec_coverage',
    label: 'openlore audit_spec_coverage',
    description: 'Find spec coverage gaps — functions with no spec, hub gaps, orphan requirements, and stale domains.',
    guideline: 'Before starting a new feature, or to audit spec health, call openlore_audit_spec_coverage to see what needs specs.',
    parameters: Type.Object({
      hubThreshold: Type.Optional(Type.Number({ description: 'Minimum fanIn to flag a function as a hub gap (default 5).' })),
      maxUncovered: Type.Optional(Type.Number({ description: 'Maximum uncovered functions to return (default 50).' })),
    }),
  },
  {
    name: 'list_spec_domains',
    label: 'openlore list_spec_domains',
    description: 'List all spec domains in the project.',
    guideline: 'When you need to know which spec domains exist before a targeted search_specs or get_spec, call openlore_list_spec_domains.',
    parameters: Type.Object({}),
  },
  {
    name: 'record_decision',
    label: 'openlore record_decision',
    description: 'Record an architectural decision before writing the code — data structure, library, API contract, auth strategy, module boundary, schema, caching, or error-handling choice.',
    guideline: 'When you make a significant design choice, call openlore_record_decision BEFORE writing the code, with a `title` and `rationale` (plus `consequences`, `affectedFiles`, `supersedes` if relevant). Recording proactively keeps commits fast — the decisions gate reads the recorded store instead of running a slow extraction.',
    parameters: Type.Object({
      title: Type.String({ description: 'REQUIRED. Short imperative statement, e.g. "Use UUIDs for decision IDs".' }),
      rationale: Type.String({ description: 'REQUIRED. Why this decision was made.' }),
      consequences: Type.Optional(Type.String({ description: 'What changes as a result (optional).' })),
      affectedFiles: Type.Optional(Type.Array(Type.String(), { description: 'Source files most relevant to this decision (optional).' })),
      scope: Type.Optional(StringEnum(['local', 'component', 'cross-domain', 'system'] as const, { description: 'Decision scope (default component; cross-domain/system generate ADR files).' })),
      supersedes: Type.Optional(Type.String({ description: 'ID of a prior decision this one replaces (optional).' })),
    }),
  },
  {
    name: 'list_decisions',
    label: 'openlore list_decisions',
    description: 'List architectural decisions recorded this session and their status (draft, verified, approved, rejected, synced).',
    guideline: 'To review what decisions are pending — e.g. when a commit is blocked by the decisions gate — call openlore_list_decisions.',
    parameters: Type.Object({
      status: Type.Optional(StringEnum(['draft', 'consolidated', 'verified', 'phantom', 'approved', 'rejected', 'synced'] as const, { description: 'Filter by status (default: all).' })),
    }),
  },
  {
    name: 'approve_decision',
    label: 'openlore approve_decision',
    description: 'Approve a verified architectural decision for syncing into specs. Requires explicit human authorization.',
    guideline: 'ONLY after the user has explicitly said "yes" / "approve" to a specific decision, call openlore_approve_decision with its `id`. Never approve on the user\'s behalf or autonomously — present the decision and wait for the user\'s explicit approval first. Then call sync_decisions.',
    parameters: Type.Object({
      id: Type.String({ description: 'REQUIRED. 8-character decision ID from list_decisions.' }),
      note: Type.Optional(Type.String({ description: 'Optional review note.' })),
    }),
  },
  {
    name: 'reject_decision',
    label: 'openlore reject_decision',
    description: 'Reject a pending architectural decision so it is never synced to specs.',
    guideline: 'When the user rejects a decision, call openlore_reject_decision with its `id` and an optional `note` (the reason).',
    parameters: Type.Object({
      id: Type.String({ description: 'REQUIRED. 8-character decision ID from list_decisions.' }),
      note: Type.Optional(Type.String({ description: 'Optional reason for rejection.' })),
    }),
  },
  {
    name: 'sync_decisions',
    label: 'openlore sync_decisions',
    description: 'Write approved decisions into their target spec.md files and create ADR files. Append-only, never overwrites.',
    guideline: 'After decisions are approved, call openlore_sync_decisions to write them into the specs. Pass `dryRun: true` to preview without writing first.',
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ description: 'Preview without writing files (default false).' })),
      id: Type.Optional(Type.String({ description: 'Sync only this specific decision ID (default: all approved).' })),
    }),
  },
];

function toolResult(text: string, details: unknown = null): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details };
}

// ── Tool-result rendering ──────────────────────────────────────────────────
// Daemon handlers return structured JSON. Dumping it raw into the console is
// noise the user has to parse by eye. Render a compact, human-readable summary
// for display while the full object still rides along in `details` (the model
// reads that, so no structural fidelity is lost).

const MAX_LIST_ITEMS = 6;
const MAX_STR = 400;       // cap on a top-level string field
const MAX_EXTRA_STR = 60;  // cap on a string shown inline as a list-item extra
const MAX_EXTRAS = 2;      // notable fields appended after an item's title

// Keys that name an item, tried in order when summarising an object in a list.
const TITLE_KEYS = ['name', 'title', 'label', 'function', 'symbol', 'id', 'file', 'filePath', 'domain', 'path', 'to', 'from'];

// Top-level keys dropped from the console glance — all display-only; the full
// value always stays in content/`details` for the model.
//
// BASE_SKIP applies to every tool: input echoes (Pi already shows the call args)
// and verbose prose/meta.
const BASE_SKIP = new Set([
  // input echoes
  'task', 'query', 'description', 'symbol', 'functionName', 'direction',
  'maxDepth', 'depth', 'entryFunction', 'targetFunction', 'filePath', 'limit', 'domain',
  // prose / meta
  'guidance', 'note', 'graphIndexNote', 'searchMode', 'retrievalMode', 'count',
]);

// Per-tool extra skips. orient is auto-injected at the start of every task, so
// its glance must stay tight: drop the model-facing enrichment (deep graph/git/
// spec context, redundant call paths, 100+ rows). Deliberate analysis tools like
// analyze_impact keep their full structure — there the detail IS the deliverable.
const SKIP_BY_TOOL: Record<string, Set<string>> = {
  orient: new Set([
    'callPaths', 'suggestedTools', 'specLinkedFunctions', 'inlineSpecs',
    'matchingSpecs', 'provenance', 'changeCoupling', 'landmarks',
    'governingDecisions', 'staleDecisions', 'relevantFunctionsOmitted',
  ]),
  // analyze_impact stays rich (the detail is the deliverable), minus two low-value
  // bits: `language` (redundant scalar) and `criticalPathLeaves` (a long list of
  // leaf names, far less actionable than the up/downstream chains above it).
  analyze_impact: new Set(['language', 'criticalPathLeaves']),
  // sync_decisions: `modifiedSpecs` repeats the per-item `specs` already shown
  // under synced[]; drop it so the glance is just synced decisions + any errors.
  sync_decisions: new Set(['modifiedSpecs']),
};

/** Skip set for a tool: base skips plus any tool-specific extras. */
function skipKeysFor(toolName?: string): Set<string> {
  const extra = toolName ? SKIP_BY_TOOL[toolName] : undefined;
  return extra ? new Set([...BASE_SKIP, ...extra]) : BASE_SKIP;
}
// Per-item fields that are verbose handles/paths, not glance info.
const NOISE_EXTRA = new Set(['expand', 'signature', 'language', 'callerFile', 'calleeFile', 'toFile', 'fromFile']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Render a primitive (or a short summary of a container) on one line. */
function renderScalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v;
  if (Array.isArray(v)) return v.length === 0 ? '' : `[${v.length} items]`;
  if (isPlainObject(v)) return summarizeItem(v);
  return String(v);
}

/** One-line summary of an object: title (or `a → b` for edges) plus a couple of fields. */
function summarizeItem(obj: Record<string, unknown>): string {
  // Edge-like rows (call graph, surprising connections) read best as a → b.
  const caller = obj.caller ?? obj.from;
  const callee = obj.callee ?? obj.to;
  if (typeof caller === 'string' && typeof callee === 'string') return `${caller} → ${callee}`;

  const titleKey = TITLE_KEYS.find((k) => typeof obj[k] === 'string' || typeof obj[k] === 'number');
  const title = titleKey ? String(obj[titleKey]) : '';
  const extras: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === titleKey || NOISE_EXTRA.has(k)) continue;
    if (typeof v === 'number') extras.push(`${k}=${fmtNum(v)}`);
    else if (typeof v === 'string' && v.length > 0 && v.length <= MAX_EXTRA_STR) extras.push(`${k}=${v}`);
    if (extras.length >= MAX_EXTRAS) break;
  }
  const head = title || '(item)';
  return extras.length ? `${head} — ${extras.join(', ')}` : head;
}

/** Render a single list element: scalar verbatim, object as a summary line. */
function renderItem(item: unknown): string {
  if (isPlainObject(item)) return summarizeItem(item);
  return renderScalar(item);
}

/** Fallback for renderResult when `details` is absent (e.g. session reload): the
 *  joined content text, parsed back to an object if it is JSON. */
function resultText(result: AgentToolResult<unknown>): unknown {
  const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  try { return JSON.parse(text); } catch { return text; }
}

// The descriptive argument that names a tool call, tried in order.
const CALL_ARG_KEYS = ['task', 'query', 'symbol', 'functionName', 'description', 'filePath', 'domain'];
const MAX_CALL_ARG = 80;

/**
 * One-line summary of a tool call's arguments for renderCall — the descriptive
 * arg, quoted (e.g. orient "add rate limiting"). Pathfinding reads as `a → b`.
 * Returns '' when there's no descriptive arg (e.g. get_health_map) so the caller
 * shows the bare tool title.
 */
export function formatCallArgs(args: Record<string, unknown>): string {
  if (typeof args.entryFunction === 'string' && typeof args.targetFunction === 'string') {
    return `${args.entryFunction} → ${args.targetFunction}`;
  }
  // select_tests: a list of changed symbols, or a diff ref.
  if (Array.isArray(args.changedSymbols)) {
    const names = args.changedSymbols.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (names.length > 0) {
      const shown = names.slice(0, 3).join(', ');
      return names.length > 3 ? `${shown}, +${names.length - 3}` : shown;
    }
  }
  if (typeof args.diffRef === 'string' && args.diffRef.length > 0) return `diff ${args.diffRef}`;
  const key = CALL_ARG_KEYS.find((k) => typeof args[k] === 'string' && (args[k] as string).length > 0);
  if (!key) return '';
  const v = String(args[key]);
  return v.length > MAX_CALL_ARG ? `"${v.slice(0, MAX_CALL_ARG)}…"` : `"${v}"`;
}

/**
 * Turn a structured tool result into readable text. Strings pass through;
 * `{ error }` becomes a warning line; objects render as labelled sections with
 * arrays shown as bounded bullet lists. `toolName` selects per-tool skips so an
 * ambient tool (orient) can hide enrichment a deliberate one (analyze_impact)
 * keeps. Resilient to schema drift — unknown shapes degrade to key/value lines.
 */
export function formatToolResult(result: unknown, toolName?: string): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '(no result)';
  if (!isPlainObject(result) && !Array.isArray(result)) return String(result);
  if (isPlainObject(result) && typeof result.error === 'string') return `⚠ ${result.error}`;

  const skip = skipKeysFor(toolName);
  const entries: Array<[string, unknown]> = Array.isArray(result)
    ? [['result', result]]
    : Object.entries(result);

  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    if (skip.has(key)) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`**${key}** (${value.length})`);
      for (const item of value.slice(0, MAX_LIST_ITEMS)) lines.push(`  • ${renderItem(item)}`);
      if (value.length > MAX_LIST_ITEMS) lines.push(`  … ${value.length - MAX_LIST_ITEMS} more`);
    } else if (isPlainObject(value)) {
      lines.push(`**${key}**`);
      for (const [k, v] of Object.entries(value)) {
        const s = renderScalar(v);
        if (s) lines.push(`  ${k}: ${s}`);
      }
    } else {
      const s = renderScalar(value);
      if (s) lines.push(`**${key}**: ${s}`);
    }
  }

  return lines.length ? lines.join('\n') : '(empty result)';
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function openlore(pi: ExtensionAPI): void {
  const daemons = new Map<string, Daemon>();
  // Negative cache: when a daemon can't be reached, remember the failure for a
  // short window so we don't pay the full 8s spawn-and-poll on every call in a
  // repo that simply isn't analyzed yet. Transient failures recover after TTL.
  const failedUntil = new Map<string, number>();
  const DAEMON_RETRY_COOLDOWN_MS = 30_000;
  const primed = new Set<string>();
  let sessionCwd = process.cwd();
  let sessionMode: ExtensionContext['mode'] = 'tui';

  async function getDaemon(cwd: string): Promise<Daemon | null> {
    const cached = daemons.get(cwd);
    if (cached) return cached;
    if ((failedUntil.get(cwd) ?? 0) > Date.now()) return null;
    const d = await ensureDaemon(cwd);
    if (d) {
      daemons.set(cwd, d);
      failedUntil.delete(cwd);
    } else {
      failedUntil.set(cwd, Date.now() + DAEMON_RETRY_COOLDOWN_MS);
    }
    return d;
  }

  // Keepalive: ping every known daemon's /health so the in-use one survives the
  // serve idle-shutdown while this session is open. A daemon that no longer
  // answers (reaped/crashed) is dropped from the cache so the next tool call
  // re-spawns it. Fire-and-forget; failures are expected and ignored.
  let keepalive: ReturnType<typeof setInterval> | undefined;
  function startKeepalive(): void {
    if (keepalive || daemons.size === 0) return;
    keepalive = setInterval(() => {
      for (const [cwd, daemon] of daemons) {
        const headers = daemon.token ? { 'x-openlore-token': daemon.token } : undefined;
        void fetch(`${daemon.baseUrl}/health`, { headers, signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) })
          .then((res) => { if (!res.ok) daemons.delete(cwd); })
          .catch(() => daemons.delete(cwd));
      }
    }, KEEPALIVE_MS);
    keepalive.unref?.(); // never keep the host process alive for the keepalive alone
  }

  // ── B: navigation tools ──
  for (const tool of NAV_TOOLS) {
    pi.registerTool({
      name: `openlore_${tool.name}`,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.description,
      promptGuidelines: [tool.guideline],
      parameters: tool.parameters as TSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const daemon = await getDaemon(ctx.cwd);
        if (!daemon) return toolResult('openlore daemon unavailable — run `openlore analyze` then retry.');
        const result = await callTool(daemon, tool.name, params as Record<string, unknown>, ctx.cwd, signal ?? undefined);
        // content[].text is sent to the LLM verbatim — keep the FULL structured
        // result so the model loses no detail. The compact human view is produced
        // separately in renderResult (display only). `details` carries the parsed
        // object so renderResult need not re-parse the JSON text.
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return toolResult(truncate(text, RESULT_MAX), result);
      },
      // Display-only: a clean invocation header — `openlore orient "<task>"` —
      // instead of the default raw-args dump. Reuses the row's last component.
      renderCall(args, theme, context) {
        const text = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0);
        const title = theme.fg('toolTitle', tool.label);
        const argStr = formatCallArgs(args as Record<string, unknown>);
        text.setText(argStr ? `${title} ${theme.fg('dim', argStr)}` : title);
        return text;
      },
      // Display-only: render a tight, glanceable summary in the TUI. The LLM still
      // reads the full content above; this never touches what the model sees.
      renderResult(result) {
        const summary = formatToolResult(result.details ?? resultText(result), tool.name);
        return new Markdown(summary, 1, 0, getMarkdownTheme());
      },
    });
  }

  // ── Config tool ──
  pi.registerTool({
    name: 'openlore_configure',
    label: 'openlore configure',
    description: 'Open the openlore configuration wizard to set provider, model, embedding, and analysis settings.',
    promptSnippet: 'Configure openlore settings (provider, model, API key, embedding).',
    promptGuidelines: ['Use openlore_configure to change the LLM provider, model, or embedding settings.'],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return toolResult('Config wizard requires an interactive session (tui or rpc mode).');
      const existing = await readConfig(ctx.cwd);
      await runConfigWizard(ctx, existing);
      return toolResult('Configuration saved to .openlore/config.json.');
    },
  });

  // ── /configure slash command ──
  pi.registerCommand('openlore', {
    description: 'Open the openlore configuration wizard',
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify('Config wizard requires an interactive session.', 'error');
        return;
      }
      const existing = await readConfig(ctx.cwd);
      await runConfigWizard(ctx, existing);
    },
  });

  // ── session_start: onboarding + daemon warmup ──
  pi.on('session_start', async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    sessionCwd = ctx.cwd;
    sessionMode = ctx.mode;

    if (ctx.hasUI && !(await readConfig(ctx.cwd))) {
      await runConfigWizard(ctx, null);
    }

    if (ctx.mode !== 'json' && ctx.mode !== 'print') {
      await getDaemon(ctx.cwd);
      startKeepalive();
    }
  });

  // Stop pinging when the session ends gracefully so the now-unused daemon can
  // idle out and free its RAM. (On a hard kill the interval dies with the host
  // process anyway — either way pings stop and the daemon reaps.)
  pi.on('session_shutdown', (_event: SessionShutdownEvent) => {
    if (keepalive) { clearInterval(keepalive); keepalive = undefined; }
  });

  // ── C: context injection on the first turn ──
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, _ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | void> => {
    if (sessionMode === 'json' || sessionMode === 'print') return;
    if (primed.has(sessionCwd)) return;
    primed.add(sessionCwd);

    const blocks: string[] = [];
    const digest = await readDigest(sessionCwd);
    if (digest) blocks.push('# Codebase architecture (openlore)\n\n' + truncate(digest, 8000));
    const specIndex = await readSpecIndex(sessionCwd);
    if (specIndex) blocks.push(specIndex);

    // Task-scoped orientation: gate + token-budgeted render, the same pipeline
    // `openlore orient --inject` uses for the Claude Code hook (change
    // add-task-scoped-context-injection). The daemon does the orientation; the
    // host only gates and renders. `mode: "off"` opts out (digest/spec index,
    // Pi's own baseline grounding, are unaffected); a weak/absent match degrades
    // to the single ignorable pointer line instead of dumping raw orient JSON.
    const daemon = await getDaemon(sessionCwd);
    const cfg = resolveInjectionConfig(await readContextInjection(sessionCwd));
    if (daemon && event.prompt && cfg.mode !== 'off') {
      const oriented = await callTool(daemon, 'orient', { task: event.prompt }, sessionCwd);
      const result =
        oriented && typeof oriented === 'object' && !('error' in (oriented as object))
          ? (oriented as LeanOrientResult)
          : null;
      // Weak match → the single ignorable pointer line. A null result (daemon
      // error / no graph) pushes nothing, so the no-analysis baseline nudge in
      // the `suffix` fallback below can still surface.
      if (result) {
        blocks.push(passesRelevanceGate(result, cfg) ? renderInjectionBlock(result, cfg) : POINTER_LINE);
      }
    }

    const suffix = blocks.length > 0
      ? blocks.join('\n\n')
      : '[openlore: no analysis found — run `openlore analyze` to enable structural context.]';

    return { systemPrompt: event.systemPrompt + '\n\n' + suffix };
  });
}

export const installPaths = {
  project: (cwd: string) => join(cwd, '.pi', 'extensions', 'openlore.js'),
  global: () => join(homedir(), '.pi', 'agent', 'extensions', 'openlore.js'),
};
