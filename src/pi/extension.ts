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
 *   B — native tools (registerTool): the substrate surface for on-demand structural
 *       queries — NAV_TOOLS spans navigate + change + remember + verify + governance
 *       (it already supersets the MCP `substrate` preset; the family taxonomy and the
 *       preset/breadth selectors are MCP-wire concepts the native Pi host does not use),
 *       each round-tripping to the warm daemon via fetch.
 *
 * Uses ctx.mode (0.78.1+): full injection in tui/rpc (interactive), none in
 * json/print (one-shot). rpc = headless interactive over stdin/stdout (IDE,
 * custom UI) — same injection needs as tui.
 *
 * Config onboarding: runs on first session when .openlore/config.json is absent;
 * also available anytime via the openlore_configure tool.
 *
 * change: harden-pi-config-and-daemon-fidelity
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
import { fileURLToPath } from 'node:url';

// Task-scoped injection gate + render. This module is intentionally
// dependency-light (pure tokenization, framing, and token estimation) so importing it
// here does NOT drag the analyzer into the Pi host — orientation still comes
// from the warm daemon over RPC (decision abee8e3e).
import {
  resolveInjectionConfig,
  evaluateRelevanceGate,
  renderInjectionBlock,
  classifyTurnIntent,
  pointerLineFor,
  type LeanOrientResult,
} from '../cli/commands/orient-inject-render.js';
// The shared serve.json validator. Dependency-light (node builtins + the loopback
// predicate) so it does not drag the analyzer into the Pi host, and it guarantees
// Pi trusts the untrusted descriptor exactly as the CLI and MCP server do
// (mcp-security: ServeDescriptorValidatedAtEveryReader).
import {
  readServeDescriptor,
  serveHttpBaseUrl,
  validateServeHealth,
  type ServeDescriptor,
  type ServeHealth,
} from '../cli/commands/serve-descriptor.js';
import type { ContextInjectionConfig } from '../types/index.js';
import { discloseRepoConfiguredEndpoint } from '../core/services/repo-config-trust.js';
import {
  frameServedContent,
  readAnalysisContentProvenance,
  reviewedFileContentProvenance,
} from '../core/services/served-content.js';
import { safeJoin } from '../utils/path-confinement.js';

// ── Config types & helpers ────────────────────────────────────────────────────

interface OpenLoreConfig {
  [key: string]: unknown;
  version: string;
  projectType: string;
  openspecPath: string;
  analysis: { maxFiles: number; includePatterns: string[]; excludePatterns: string[] };
  generation: {
    [key: string]: unknown;
    provider?: string;
    model?: string;
    openaiCompatBaseUrl?: string;
    skipSslVerify?: boolean;
    domains?: string | string[];
  };
  embedding?: {
    [key: string]: unknown;
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

type ExistingOpenLoreConfig = Record<string, unknown>;
export type ExistingConfigLoad =
  | { state: 'absent' }
  | { state: 'invalid'; detail: string }
  | { state: 'valid'; config: ExistingOpenLoreConfig };

const OPENLORE_DIR = '.openlore';

/** Treat a config as absent unless it has the minimum viable fields. */
export function isUsableConfig(raw: unknown): raw is OpenLoreConfig {
  return !!raw && typeof raw === 'object' && typeof (raw as OpenLoreConfig).generation?.provider === 'string';
}

export async function readConfig(cwd: string): Promise<OpenLoreConfig | null> {
  try {
    const raw = JSON.parse(await readFile(safeJoin(cwd, join(OPENLORE_DIR, 'config.json')), 'utf-8'));
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
    const raw = JSON.parse(await readFile(safeJoin(cwd, join(OPENLORE_DIR, 'config.json')), 'utf-8')) as unknown;
    return raw && typeof raw === 'object'
      ? (raw as { contextInjection?: ContextInjectionConfig }).contextInjection
      : undefined;
  } catch { return undefined; }
}

async function writeConfig(cwd: string, config: OpenLoreConfig): Promise<void> {
  const configPath = safeJoin(cwd, join(OPENLORE_DIR, 'config.json'));
  await mkdir(safeJoin(cwd, OPENLORE_DIR), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

const PROVIDERS = [
  'anthropic', 'openai', 'openai-compat', 'gemini',
  'copilot', 'claude-code', 'codex-cli', 'gemini-cli', 'antigravity-cli', 'mistral-vibe', 'cursor-agent',
];

const PROVIDER_MODEL_DEFAULTS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  'openai-compat': '',
  gemini: 'gemini-2.0-flash',
  copilot: 'gpt-4o',
  'claude-code': 'claude-sonnet-4-6',
  'codex-cli': '',
  'gemini-cli': 'gemini-2.0-flash',
  'antigravity-cli': '',
  'mistral-vibe': 'codestral-latest',
  'cursor-agent': '',
};

const SYSTEM_AUTH_PROVIDERS = new Set(['copilot', 'claude-code', 'codex-cli', 'gemini-cli', 'antigravity-cli', 'mistral-vibe', 'cursor-agent']);

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


export async function loadExistingConfig(cwd: string): Promise<ExistingConfigLoad> {
  const path = safeJoin(cwd, join(OPENLORE_DIR, 'config.json'));
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'invalid', detail: 'the existing config could not be read' };
  }
  try {
    const raw = JSON.parse(text) as unknown;
    return isPlainObject(raw)
      ? { state: 'valid', config: raw }
      : { state: 'invalid', detail: 'the existing config root is not a JSON object' };
  } catch {
    return { state: 'invalid', detail: 'the existing config is malformed JSON' };
  }
}

export async function runConfigWizard(ctx: ExtensionContext, existing?: ExistingOpenLoreConfig | null): Promise<void> {
  const { ui } = ctx;

  const existingGeneration = isPlainObject(existing?.generation) ? existing.generation : {};
  const existingEmbedding = isPlainObject(existing?.embedding) ? existing.embedding : undefined;
  const existingAnalysis = isPlainObject(existing?.analysis) ? existing.analysis : {};
  let generation: OpenLoreConfig['generation'] = { domains: 'auto', ...existingGeneration };
  let embedding: OpenLoreConfig['embedding'] | undefined =
    existingEmbedding && typeof existingEmbedding.baseUrl === 'string' && typeof existingEmbedding.model === 'string'
      ? existingEmbedding as OpenLoreConfig['embedding']
      : undefined;
  let maxFiles = typeof existingAnalysis.maxFiles === 'number' ? existingAnalysis.maxFiles : 500;
  const prevProvider = typeof existingGeneration.provider === 'string' ? existingGeneration.provider : undefined;
  const prevModel = typeof existingGeneration.model === 'string' ? existingGeneration.model : undefined;

  if (embedding?.apiKey) {
    embedding = { ...embedding };
    delete embedding.apiKey;
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
          const unmanagedGeneration = { ...generation };
          delete unmanagedGeneration.model;
          delete unmanagedGeneration.openaiCompatBaseUrl;
          delete unmanagedGeneration.skipSslVerify;
          generation = { ...unmanagedGeneration, provider: next };
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
        // `generation` is seeded from the ANALYZED REPO's config, and fetchModels sends
        // `Authorization: Bearer <operator key>` to whatever it names — so opening this
        // row on a hostile repo would hand over the key. Say where it is going.
        discloseRepoConfiguredEndpoint('generation.openaiCompatBaseUrl', generation.openaiCompatBaseUrl);
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
        embedding = { ...embedding, baseUrl: input, model: embedding?.model ?? '' };
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

  // The wizard owns only the fields rendered above. Preserve every other block,
  // plus sibling settings inside partially-managed blocks, so a configuration
  // UI can never erase governance added by a newer OpenLore version.
  const existingWithoutEmbedding = { ...(existing ?? {}) };
  delete existingWithoutEmbedding.embedding;
  const config: OpenLoreConfig = {
    ...existingWithoutEmbedding,
    version: typeof existing?.version === 'string' ? existing.version : '1.0.0',
    projectType: typeof existing?.projectType === 'string' ? existing.projectType : 'unknown',
    openspecPath: typeof existing?.openspecPath === 'string' ? existing.openspecPath : 'openspec',
    analysis: {
      ...existingAnalysis,
      maxFiles,
      includePatterns: Array.isArray(existingAnalysis.includePatterns) ? existingAnalysis.includePatterns as string[] : [],
      excludePatterns: Array.isArray(existingAnalysis.excludePatterns) ? existingAnalysis.excludePatterns as string[] : [],
    },
    generation,
    ...(embedding ? { embedding } : {}),
    createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : new Date().toISOString(),
    lastRun: typeof existing?.lastRun === 'string' || existing?.lastRun === null ? existing.lastRun : null,
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

interface Daemon {
  baseUrl: string;
  token?: string;
  incompatibility?: string;
}

interface DaemonProbe {
  alive: boolean;
  health: ServeHealth | null;
}

const HEALTH_TIMEOUT_MS = 8000;
const HEALTH_POLL_MS = 150;
export const PI_ORIENT_TIMEOUT_MS = 4_000;
export const PI_SPEC_INDEX_MAX_DOMAINS = 50;
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
/**
 * Serialized budget Pi requests from the spec-workflow composites.
 *
 * The daemon packs a page to fit this, so a valid composite envelope is ALWAYS
 * within Pi's model-visible bound and must bypass the generic `RESULT_MAX`
 * clipping below — clipping a within-budget page would invalidate the very
 * completeness receipt the protocol exists to guarantee (change
 * `harden-spec-workflow-lifecycle`). Kept strictly under RESULT_MAX so the
 * adapter's own JSON framing still fits.
 */
const PI_COMPOSITE_RESPONSE_BYTES = 48 * 1024;
// Pi curates its own native surface, which intentionally supersets the MCP
// substrate preset. The daemon enforces its preset at dispatch, so Pi must
// spawn the full backing surface and keep curating what the model sees here.
export const PI_DAEMON_PRESET = 'full';

/**
 * Auditable mapping from the Generate/Repair protocol observations to the
 * existing daemon primitives used by Pi's task entry points. Keep this list
 * closed in tests: adding a protocol observation must either wire it here or
 * add a documented exclusion below.
 */
export const PI_SPEC_WORKFLOW_OBSERVATIONS = {
  generation: {
    domainEvidence: 'prepare_spec_generation',
    domainBehavior: 'prepare_spec_generation',
    specValidation: 'prepare_spec_generation',
  },
  repair: {
    domainEvidence: 'prepare_spec_repair',
    existingSpec: 'prepare_spec_repair',
    coveredFunction: 'prepare_spec_repair',
    uncoveredFunction: 'prepare_spec_repair',
    staleMapping: 'prepare_spec_repair',
    orphanRequirement: 'prepare_spec_repair',
    structuralChange: 'prepare_spec_repair',
    mappingCoverage: 'prepare_spec_repair',
    specValidation: 'prepare_spec_repair',
    domainBehavior: 'prepare_spec_repair',
  },
} as const;

export const PI_SPEC_WORKFLOW_EXCLUSIONS: Readonly<Record<string, string>> = {};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// `.openlore/serve.json` is an untrusted, repo-writable artifact; resolve it
// through the shared validator so a poisoned descriptor (non-loopback host, bad
// port/pid, non-string token) is treated exactly as absent and no field of it
// ever becomes a fetch target or request header.
async function readDescriptor(cwd: string): Promise<ServeDescriptor | null> {
  try {
    return readServeDescriptor(safeJoin(cwd, join(OPENLORE_DIR, 'serve.json')));
  } catch {
    return null;
  }
}

async function probeHealth(desc: ServeDescriptor, expectedRoot: string): Promise<DaemonProbe> {
  try {
    // `redirect: 'error'` — a daemon never redirects, and following one would take
    // this probe (and, at the call site below, the token) off the machine.
    const headers = desc.token ? { 'x-openlore-token': desc.token } : undefined;
    // INTENTIONAL EGRESS: validated descriptors are loopback-only and redirects are disabled.
    // codeql[js/file-access-to-http]
    const res = await fetch(`${serveHttpBaseUrl(desc.host, desc.port)}/health`, {
      headers,
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) return { alive: false, health: null };
    const body = await res.json().catch(() => null);
    return {
      alive: (body as { ok?: unknown } | null)?.ok === true,
      health: validateServeHealth(body, expectedRoot, desc),
    };
  } catch { return { alive: false, health: null }; }
}

export function missingDaemonTools(available: readonly string[], required: readonly string[]): string[] {
  const advertised = new Set(available);
  return required.filter((tool) => !advertised.has(tool));
}

/** Launch the packaged CLI without a command shell so repository paths stay data. */
export function piDaemonSpawnCommand(cwd: string): { command: string; args: string[] } {
  const cliEntry = fileURLToPath(new URL('../cli/index.js', import.meta.url));
  return {
    command: process.execPath,
    args: [cliEntry, 'serve', '--directory', cwd, '--preset', PI_DAEMON_PRESET],
  };
}

function incompatibleDaemon(desc: ServeDescriptor): Daemon {
  return {
    baseUrl: serveHttpBaseUrl(desc.host, desc.port),
    token: desc.token,
    incompatibility:
      'The running openlore daemon does not report an authenticated, enforced tool surface for ' +
      'this repository. Stop the legacy or incompatible process manually, upgrade OpenLore, ' +
      'then retry so Pi can start its required full daemon.',
  };
}

function daemonFromHealth(desc: ServeDescriptor, health: ServeHealth): Daemon {
  const missing = missingDaemonTools(health.tools, NAV_TOOLS.map((tool) => tool.name));
  return {
    baseUrl: serveHttpBaseUrl(desc.host, desc.port),
    token: desc.token,
    ...(missing.length > 0
      ? {
          incompatibility:
            `The running openlore daemon does not expose ${missing.length} Pi tool(s), including ` +
            `${missing.slice(0, 3).join(', ')}. Run \`openlore serve --stop\`, then retry so Pi ` +
            'can start its required full-preset daemon.',
        }
      : {}),
  };
}

export type EnsureDaemonResult =
  | { daemon: Daemon; failure?: undefined }
  | {
      daemon: null;
      failure: string;
      failureKind: 'draining' | 'launch' | 'preparation' | 'early-exit' | 'health-timeout';
    };

export function shouldNegativeCacheDaemonFailure(
  kind: Exclude<EnsureDaemonResult, { daemon: Daemon }>['failureKind'],
): boolean {
  return kind !== 'draining' && kind !== 'health-timeout';
}

export async function ensureDaemonResult(
  cwd: string,
  options: {
    timeoutMs?: number;
    launch?: { command: string; args: string[] };
  } = {},
): Promise<EnsureDaemonResult> {
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  let earlyExitFailure: string | undefined;
  const existing = await readDescriptor(cwd);
  if (existing) {
    const probe = await probeHealth(existing, cwd);
    if (probe.health?.draining) {
      return {
        daemon: null,
        failure: 'openlore daemon is draining; retry after shutdown completes.',
        failureKind: 'draining',
      };
    }
    if (probe.health) return { daemon: daemonFromHealth(existing, probe.health) };
    if (probe.alive) return { daemon: incompatibleDaemon(existing) };
  }
  try {
    // The daemon must outlive this process and write .openlore/serve.json.
    // Windows 10 kills a child whose stdout/stderr are NUL (stdio:'ignore') —
    // it dies before writing the descriptor (Win11 tolerates it). Give it a
    // real file handle (serve.log) instead; that's the fix validated on Win10.
    // On Windows we also drop `detached`: it allocates a console window that
    // windowsHide can't suppress, and Windows doesn't reap the child on parent
    // exit anyway. macOS/Linux need `detached` (setsid) to outlive us.
    const isWin = process.platform === 'win32';
    const openloreDir = safeJoin(cwd, OPENLORE_DIR);
    const logPath = safeJoin(cwd, join(OPENLORE_DIR, 'serve.log'));
    await mkdir(openloreDir, { recursive: true });
    const logFd = openSync(logPath, 'a');
    try {
      const launch = options.launch ?? piDaemonSpawnCommand(cwd);
      const spawned = await new Promise<
        { ok: true; child: ReturnType<typeof spawn> } | { ok: false; code: string }
      >((resolve) => {
        const child = spawn(launch.command, launch.args, {
          stdio: ['ignore', logFd, logFd],
          windowsHide: true,
          detached: !isWin,
        });
        child.once('spawn', () => resolve({ ok: true, child }));
        child.once('error', (error) => {
          const code = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
          resolve({ ok: false, code });
        });
      });
      if (!spawned.ok) {
        return {
          daemon: null,
          failure: `openlore packaged daemon could not be launched (${spawned.code}); reinstall OpenLore and retry.`,
          failureKind: 'launch',
        };
      }
      const noteEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        earlyExitFailure =
          `openlore daemon exited before becoming healthy ` +
          `(${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}); inspect \`.openlore/serve.log\` and retry.`;
      };
      spawned.child.once('exit', noteEarlyExit);
      if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
        noteEarlyExit(spawned.child.exitCode, spawned.child.signalCode);
      }
      spawned.child.unref();
    } finally {
      closeSync(logFd);
    }
  } catch {
    return {
      daemon: null,
      failure: 'openlore daemon startup preparation failed; inspect `.openlore/serve.log` and retry.',
      failureKind: 'preparation',
    };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(HEALTH_POLL_MS);
    if (earlyExitFailure) return { daemon: null, failure: earlyExitFailure, failureKind: 'early-exit' };
    const desc = await readDescriptor(cwd);
    if (desc) {
      const probe = await probeHealth(desc, cwd);
      if (probe.health?.draining) continue;
      if (probe.health) return { daemon: daemonFromHealth(desc, probe.health) };
      if (probe.alive) return { daemon: incompatibleDaemon(desc) };
    }
  }
  return {
    daemon: null,
    failure: `openlore daemon health check timed out after ${timeoutMs} ms; inspect \`.openlore/serve.log\` and retry.`,
    failureKind: 'health-timeout',
  };
}

export async function ensureDaemon(cwd: string): Promise<Daemon | null> {
  return (await ensureDaemonResult(cwd)).daemon;
}

export async function callTool(daemon: Daemon, name: string, args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<unknown> {
  if (daemon.incompatibility) return { error: daemon.incompatibility };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (daemon.token) headers['x-openlore-token'] = daemon.token;
  try {
    const res = await fetch(`${daemon.baseUrl}/tool/${encodeURIComponent(name)}`, {
      method: 'POST', headers, body: JSON.stringify({ directory: cwd, args }), signal,
      // Carries x-openlore-token; Node's fetch re-sends custom headers across a redirect.
      redirect: 'error',
    });
    const body = await res.json().catch(() => ({ error: `non-JSON (${res.status})` }));
    if (res.status === 401 || res.status === 403) {
      throw new PiDaemonConnectionError(
        (body as { error?: string }).error ?? `HTTP ${res.status}`,
      );
    }
    if (!res.ok) return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
    return body;
  } catch (err) {
    if (err instanceof PiDaemonConnectionError) throw err;
    // User cancellation is not evidence that the daemon changed. Preserve the
    // abort so callers do not evict a healthy endpoint or suggest a retry.
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
    throw new PiDaemonConnectionError(err instanceof Error ? err.message : String(err));
  }
}

export class PiDaemonConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiDaemonConnectionError';
  }
}

/** Bound a best-effort Pi operation without abandoning useful background work. */
export async function awaitWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void work.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

export function isUsableDaemon(daemon: Daemon): boolean {
  return daemon.incompatibility === undefined;
}

// ── Context injection helpers ─────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n… (truncated, ${s.length - max} more chars)`;
}

async function readDigest(cwd: string): Promise<string> {
  try { return await readFile(safeJoin(cwd, join(OPENLORE_DIR, 'analysis', 'CODEBASE.md')), 'utf-8'); }
  catch { return ''; }
}

export async function readSpecIndex(cwd: string): Promise<string> {
  try {
    const { readdir } = await import('node:fs/promises');
    const dirs = (await readdir(safeJoin(cwd, join('openspec', 'specs')), { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    if (dirs.length === 0) return '';
    const shown = dirs.slice(0, PI_SPEC_INDEX_MAX_DOMAINS);
    return [
      '## openlore spec domains',
      ...shown.map((d) => `- ${d}`),
      ...(dirs.length > shown.length ? [`- … ${dirs.length - shown.length} more domains`] : []),
    ].join('\n');
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
    description: 'Verify a structural claim against the graph before asserting it — "X is dead", "Y calls Z", "Z is safe to change" — or a decision-authority claim ("ADR abc12345 governs this") before citing it, and get a deterministic verdict (confirmed / refuted / unverifiable) with a citation receipt.',
    guideline: 'Before you tell the user a structural fact ("X is dead", "Y calls Z", "this is safe to change"), or cite a decision id to a human, call openlore_verify_claim with `kind` and `subject` (and `object` for relational kinds: calls, reaches, impacts). For `decision-current`, `subject` is the 8-character decision id — a "refuted" verdict names the live superseder to cite instead. An "unverifiable" verdict means hedge or read the source rather than assert.',
    parameters: Type.Object({
      kind: StringEnum(['calls', 'reaches', 'dead', 'impacts', 'safe-to-change', 'decision-current'] as const, { description: 'REQUIRED. The kind of claim to verify (structural, or decision-current for decision authority).' }),
      subject: Type.String({ description: 'REQUIRED. What the claim is about: a function/method name for structural kinds, or an 8-character decision id for decision-current.' }),
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
    name: 'find_clones',
    label: 'openlore find_clones',
    description: 'Before writing (or just after writing) a function, find whether a near-duplicate already exists that you should reuse instead of reinventing.',
    guideline: 'When you are about to add a function, call openlore_find_clones with `snippet` (the code you are about to write) — or `symbol` (an existing function name, or name::path) to find clones of one already in the index. Matches are ranked exact > structural > near; reuse the canonical one it names.',
    parameters: Type.Object({
      symbol: Type.Optional(Type.String({ description: 'An existing function to find clones of: its name, or name::path to disambiguate. Provide exactly one of symbol or snippet.' })),
      snippet: Type.Optional(Type.String({ description: 'Raw code to find clones of (need not be in the index) — answers the pre-write "does this already exist?".' })),
      minSimilarity: Type.Optional(Type.Number({ description: 'Near-clone Jaccard floor (default 0.7, clamped to [0.1, 1]).' })),
      maxResults: Type.Optional(Type.Number({ description: 'Cap on returned matches (default 25, max 200).' })),
    }),
  },
  {
    name: 'analyze_error_propagation',
    label: 'openlore analyze_error_propagation',
    description: 'See what exceptions (TS/JS/Python/Java/C#) or returned errors and panics (Go) can propagate OUT of a function, and which are handled inside it.',
    guideline: 'Before calling a function, or after changing its error behavior, call openlore_analyze_error_propagation with `symbol`. TS/JS/Python/Java/C# return exception-shaped entries; Go returns `errorModel: go-value` with `value`-shaped returned-error/panic entries and disclosed static-analysis boundaries. Other languages return an explicit unsupported result.',
    parameters: Type.Object({
      symbol: Type.String({ description: 'REQUIRED. The function to analyze: its name, or name::path to disambiguate.' }),
      maxDepth: Type.Optional(Type.Number({ description: 'Callee-traversal depth bound (default 10, clamped to [1, 30]).' })),
    }),
  },
  {
    name: 'analyze_env_impact',
    label: 'openlore analyze_env_impact',
    description: 'See what breaks if you remove or rename an environment variable — its read sites, the callers that reach them, and the tests to run.',
    guideline: 'Before removing or renaming an env var, call openlore_analyze_env_impact with its `name` (e.g. DATABASE_URL) to get the read sites, the blast radius, and per-site whether the read is a hard break. TypeScript/JavaScript/Python/Go/Ruby.',
    parameters: Type.Object({
      name: Type.String({ description: 'REQUIRED. The environment variable to analyze, e.g. DATABASE_URL.' }),
      maxDepth: Type.Optional(Type.Number({ description: 'Backward-reachability depth bound (default 12, clamped to [1, 30]).' })),
    }),
  },
  {
    name: 'certify_public_surface',
    label: 'openlore certify_public_surface',
    description: 'Before shipping a library/module change, check whether you broke your consumers\' contract — a removed/renamed export, an added required param, a narrowed type.',
    guideline: 'Before shipping a change to exported code, call openlore_certify_public_surface with `baseRef` (e.g. "main") for a breaking-change verdict; omit it to just list the public surface. A change it cannot prove compatible is reported potentially-breaking, never silently safe.',
    parameters: Type.Object({
      baseRef: Type.Optional(Type.String({ description: 'Git ref to diff the working tree\'s public surface against (e.g. "HEAD", "main"). Omit to return the surface itself.' })),
      maxResults: Type.Optional(Type.Number({ description: 'Limit the surface listing in surface mode (default 200, capped 500).' })),
    }),
  },
  {
    name: 'get_style_fingerprint',
    label: 'openlore get_style_fingerprint',
    description: 'Before writing or editing code, learn the codebase\'s house style — arrow vs. declared functions, const vs. let, ternary vs. if, and more — so your edit matches it.',
    guideline: 'Before writing code, call openlore_get_style_fingerprint to match the house style instead of your default. Pass `filePath` for one file or `communityId` (from get_map) for a region; omit both for the whole repo. It reports what the code IS, not a lint judgment.',
    parameters: Type.Object({
      communityId: Type.Optional(Type.String({ description: 'Profile one community/region by id (list ids with get_map).' })),
      filePath: Type.Optional(Type.String({ description: 'Profile a single file (exact path or a unique path suffix); wins over communityId if both are given.' })),
      language: Type.Optional(Type.String({ description: 'Restrict the returned languages to this one (e.g. "TypeScript").' })),
    }),
  },
  {
    name: 'briefing_since',
    label: 'openlore briefing_since',
    description: 'Catching up on a repo that changed a lot since you last looked — the changed functions that STRUCTURALLY MATTER (hubs, chokepoints), ranked, not a flat wall of diffs.',
    guideline: 'To review a large change set or catch up after time away, call openlore_briefing_since with `baseRef` (e.g. "main", a PR base). It ranks changed production symbols by tier (surprising > hub > chokepoint > ordinary) with the tests to run — unlike blast_radius, which briefs YOUR pending diff.',
    parameters: Type.Object({
      baseRef: Type.Optional(Type.String({ description: 'Git ref to brief changes SINCE (e.g. "main", a PR base, "HEAD~20"). Default resolves main → master → HEAD~1.' })),
      filePattern: Type.Optional(Type.String({ description: 'Region scope — only brief changes whose file path contains this substring.' })),
      maxResults: Type.Optional(Type.Number({ description: 'Bound on briefed symbols, highest-tier-first (default 50, max 200).' })),
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
    description: 'Read a function body, or a precision-tagged structural slice focused on one variable or callee.',
    guideline: 'After search_code identifies a function, use focus when you need only one variable or callee; omit it to read the full implementation.',
    parameters: Type.Object({
      filePath: Type.String({ description: 'REQUIRED. File path relative to the project directory, e.g. "src/auth/jwt.ts"' }),
      functionName: Type.String({ description: 'REQUIRED. Name of the function to extract, e.g. "verifyToken"' }),
      focus: Type.Optional(Type.String({ maxLength: 200, description: 'Variable or callee name to slice; requires focusKind.' })),
      focusKind: Type.Optional(Type.Union([Type.Literal('variable'), Type.Literal('callee')], { description: 'Required with focus; selects stored variable or callee evidence.' })),
    }, { dependentRequired: { focus: ['focusKind'], focusKind: ['focus'] } }),
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

// Conclusion tools deliberately NOT surfaced natively in Pi, each with a stated
// reason (project doctrine: "if parity is intentionally skipped, say why").
// The two-direction parity guard (extension.test.ts) requires every dispatchable
// conclusion tool to be either in NAV_TOOLS above or listed here — a new MCP
// conclusion tool fails CI until its author makes this decision explicitly, the
// same fails-until-you-classify discipline tool-contract.test.ts enforces.
export const PI_EXCLUDED_CONCLUSION_TOOLS: Record<string, string> = {
  explain_retrieval_miss: 'opt-in full-preset retrieval diagnostic; Pi exposes the primary search_code/search_specs paths',
  prepare_spec_generation: 'surfaced by the dedicated openlore_prepare_spec_generation entry point',
  prepare_spec_repair: 'surfaced by the dedicated openlore_prepare_spec_repair entry point',
  // Opt-in preset surfaces — federation/coordination tools ship behind
  // `--preset federation` / `--preset coordination`, not the native substrate
  // surface Pi mirrors; surface them if a Pi host adopts those workflows.
  change_impact_certificate: 'opt-in federation preset surface',
  federation_status: 'opt-in federation preset surface',
  spec_store_status: 'opt-in federation preset surface',
  working_set_context: 'opt-in federation preset surface',
  map_in_flight_conflicts: 'opt-in federation/coordination preset surface',
  plan_parallel_work: 'opt-in coordination preset surface',
  // Inventories — the before_agent_start context injection already grounds the
  // model with the architecture digest and spec index; per-domain inventories
  // are an on-demand CLI/full-preset concern, not the native nav surface.
  get_route_inventory: 'inventory — context injection covers grounding',
  get_middleware_inventory: 'inventory — context injection covers grounding',
  get_schema_inventory: 'inventory — context injection covers grounding',
  get_ui_component_inventory: 'inventory — context injection covers grounding',
  get_env_vars: 'inventory — context injection covers grounding (see analyze_env_impact for blast radius)',
  get_external_packages: 'inventory — context injection covers grounding',
  // Generation paths — LLM-backed authoring, not the deterministic navigate
  // surface Pi exposes; the Pi host drives generation through its own flows.
  generate_change_proposal: 'generation path — not the deterministic navigate surface',
  generate_tests: 'generation path — not the deterministic navigate surface',
  annotate_story: 'generation path — not the deterministic navigate surface',
  // Lifecycle/orchestration — the Pi host drives analysis via the warm daemon,
  // not an agent on-demand tool call.
  analyze_codebase: 'lifecycle — the host drives analyze via the warm daemon, not a tool call',
  detect_changes: 'lifecycle — the host drives incremental analysis, not a tool call',
  // Covered by a surfaced peer — the native surface already carries the
  // edit-time conclusion; these are the whole-repo/lower-level variants.
  get_duplicate_report: 'whole-repo audit — find_clones is the surfaced edit-time peer',
  get_low_risk_refactor_candidates: 'covered by the surfaced get_refactor_report',
  get_leaf_functions: 'covered by the surfaced get_landmarks structural anchors',
  check_architecture: 'covered by the surfaced get_refactor_report; full rule reports stay full preset',
  find_dead_code: 'covered by get_landmarks (dead label) + verify_claim kind "dead"',
  get_signatures: 'covered by the surfaced get_function_skeleton',
  get_mapping: 'covered by the surfaced orient / get_map',
  get_minimal_context: 'orient is the surfaced minimal-context entry',
  get_cluster: 'covered by the surfaced get_map / get_landmarks',
  // Opt-in full-preset / host-owned conclusions.
  report_coverage_gaps: 'opt-in full preset surface',
  get_language_support: 'opt-in full preset surface',
  locate_symbol_span: 'edit-span location is a host concern — the Pi host owns file editing',
  get_change_coupling: 'git co-change/churn conclusion — deferred from the native surface pending demand',
};

function toolResult(text: string, details: unknown = null): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details };
}

/**
 * Forward a spec-workflow composite envelope WITHOUT generic clipping.
 *
 * The daemon already packed the page to `PI_COMPOSITE_RESPONSE_BYTES`, so a
 * valid envelope fits by construction and its completeness receipt is
 * meaningful. Clipping it here would silently invalidate that receipt — the
 * exact failure this change removes. A page that is somehow still oversized is a
 * transport fault, so it returns a typed error instead of clipped JSON the model
 * would try to parse as evidence.
 */
export function compositeToolResult(result: unknown): AgentToolResult<unknown> {
  // The daemon budgeted the COMPACT serialization, so that is what the bound must
  // be measured against: indentation inflates the same evidence by well over the
  // headroom between the two limits, and measuring it would reject every full page
  // as a transport fault. Indented text is forwarded only when it also fits.
  const compact = JSON.stringify(result);
  const compactBytes = Buffer.byteLength(compact, 'utf8');
  if (compactBytes <= RESULT_MAX) {
    const indented = JSON.stringify(result, null, 2);
    return toolResult(Buffer.byteLength(indented, 'utf8') <= RESULT_MAX ? indented : compact, result);
  }
  return toolResult(
    JSON.stringify({
      error: {
        code: 'response-too-large',
        message:
          `The composite response is ${compactBytes} bytes, above this host's ${RESULT_MAX}-byte bound, ` +
          'despite a smaller requested budget. This is a transport fault, not partial evidence — retry with a smaller ' +
          'maxItems, or use the atomic tools. No evidence was clipped.',
      },
    }, null, 2),
    result,
  );
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

function registerOpenlore(
  pi: ExtensionAPI,
  runtime: { orientTimeoutMs?: number } = {},
): void {
  const daemons = new Map<string, Daemon>();
  const daemonFailures = new Map<string, string>();
  // Negative cache: when a daemon can't be reached, remember the failure for a
  // short window so we don't pay the full 8s spawn-and-poll on every call in a
  // repo that simply isn't analyzed yet. Transient failures recover after TTL.
  const failedUntil = new Map<string, number>();
  const DAEMON_RETRY_COOLDOWN_MS = 30_000;
  const primed = new Set<string>();
  async function getDaemon(cwd: string): Promise<Daemon | null> {
    const cached = daemons.get(cwd);
    if (cached) return cached;
    if ((failedUntil.get(cwd) ?? 0) > Date.now()) return null;
    const result = await ensureDaemonResult(cwd);
    const d = result.daemon;
    if (d) {
      failedUntil.delete(cwd);
      daemonFailures.delete(cwd);
      // Incompatible daemons carry remediation to the current call but never
      // enter the usable/keepalive cache. After the operator stops or upgrades
      // one, the very next tool call re-probes and can recover immediately.
      if (isUsableDaemon(d)) {
        daemons.set(cwd, d);
        startKeepalive();
      }
    } else {
      daemonFailures.set(cwd, result.failure);
      if (shouldNegativeCacheDaemonFailure(result.failureKind)) {
        failedUntil.set(cwd, Date.now() + DAEMON_RETRY_COOLDOWN_MS);
      } else {
        failedUntil.delete(cwd);
      }
    }
    return d;
  }

  const daemonUnavailable = (cwd: string): string =>
    daemonFailures.get(cwd) ?? 'openlore daemon is temporarily unavailable; retry the tool.';

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
        void fetch(`${daemon.baseUrl}/health`, { headers, signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS), redirect: 'error' })
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
        if (!daemon) return toolResult(daemonUnavailable(ctx.cwd));
        let result: unknown;
        try {
          result = await callTool(daemon, tool.name, params as Record<string, unknown>, ctx.cwd, signal ?? undefined);
        } catch (err) {
          daemons.delete(ctx.cwd);
          return toolResult(
            `openlore daemon connection changed — ${err instanceof Error ? err.message : String(err)}. Retry the tool.`,
          );
        }
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

  // Pi-native task entry points wrap the public MCP composites. They do not
  // rederive evidence or invoke a generator LLM: OpenLore makes no internal
  // LLM call here. Pi's host agent receives
  // deterministic evidence and remains responsible for authoring/reconciling
  // the OpenSpec text.
  pi.registerTool({
    name: 'openlore_prepare_spec_generation',
    label: 'openlore prepare spec generation',
    description: 'Prepare deterministic, domain-scoped code evidence for writing a new OpenSpec specification.',
    promptSnippet: 'Get deterministic evidence before writing a new specification.',
    promptGuidelines: ['When asked to create specs from existing code, call openlore_prepare_spec_generation first; write the specification yourself from its evidence.'],
    parameters: Type.Object({
      domain: Type.String({ description: 'REQUIRED. Reconciled domain name to prepare.' }),
      cursor: Type.Optional(Type.String({ description: 'Opaque continuation cursor returned by the preceding page.' })),
      maxItems: Type.Optional(Type.Number({ minimum: 10, maximum: 200, description: 'Maximum evidence items per deterministic page.' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const daemon = await getDaemon(ctx.cwd);
      if (!daemon) return toolResult(daemonUnavailable(ctx.cwd));
      try {
        const { domain, cursor, maxItems } = params as { domain: string; cursor?: string; maxItems?: number };
        const result = await callTool(
          daemon, 'prepare_spec_generation',
          { domain, cursor, maxItems, maxResponseBytes: PI_COMPOSITE_RESPONSE_BYTES }, ctx.cwd, signal ?? undefined,
        );
        return compositeToolResult(result);
      } catch (err) {
        daemons.delete(ctx.cwd);
        return toolResult(`openlore daemon connection changed — ${err instanceof Error ? err.message : String(err)}. Retry the tool.`);
      }
    },
  });

  pi.registerTool({
    name: 'openlore_prepare_spec_repair',
    label: 'openlore prepare spec repair',
    description: 'Prepare evidence for repairing one existing OpenSpec domain: code coverage observations, its spec, mapping provenance, and drift.',
    promptSnippet: 'Get deterministic repair evidence before editing an existing specification.',
    promptGuidelines: ['When asked to repair an existing spec, call openlore_prepare_spec_repair first; interpret observations and edit the specification yourself.'],
    parameters: Type.Object({
      domain: Type.String({ description: 'REQUIRED. Existing OpenSpec domain to repair.' }),
      baseRef: Type.Optional(Type.String({ description: 'Git ref used to identify structural changes (default: HEAD).' })),
      cursor: Type.Optional(Type.String({ description: 'Opaque continuation cursor returned by the preceding page.' })),
      maxItems: Type.Optional(Type.Number({ minimum: 10, maximum: 200, description: 'Maximum observations per bounded category.' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const daemon = await getDaemon(ctx.cwd);
      if (!daemon) return toolResult(daemonUnavailable(ctx.cwd));
      const { domain, baseRef, cursor, maxItems } = params as { domain: string; baseRef?: string; cursor?: string; maxItems?: number };
      try {
        const result = await callTool(
          daemon, 'prepare_spec_repair',
          { domain, baseRef: baseRef ?? 'HEAD', cursor, maxItems, maxResponseBytes: PI_COMPOSITE_RESPONSE_BYTES },
          ctx.cwd, signal ?? undefined,
        );
        return compositeToolResult(result);
      } catch (err) {
        daemons.delete(ctx.cwd);
        return toolResult(`openlore daemon connection changed — ${err instanceof Error ? err.message : String(err)}. Retry the tool.`);
      }
    },
  });

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
      const loaded = await loadExistingConfig(ctx.cwd);
      if (loaded.state === 'invalid') {
        return toolResult(`Configuration not changed: ${loaded.detail}. Repair \`.openlore/config.json\` and retry.`);
      }
      await runConfigWizard(ctx, loaded.state === 'valid' ? loaded.config : null);
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
      const loaded = await loadExistingConfig(ctx.cwd);
      if (loaded.state === 'invalid') {
        ctx.ui.notify(`Configuration not changed: ${loaded.detail}. Repair .openlore/config.json and retry.`, 'error');
        return;
      }
      await runConfigWizard(ctx, loaded.state === 'valid' ? loaded.config : null);
    },
  });

  // ── session_start: onboarding + daemon warmup ──
  pi.on('session_start', async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      const loaded = await loadExistingConfig(ctx.cwd);
      if (loaded.state === 'absent') {
        await runConfigWizard(ctx, null);
      } else if (loaded.state === 'invalid') {
        ctx.ui.notify(`OpenLore config not changed: ${loaded.detail}. Repair .openlore/config.json to configure it.`, 'warning');
      }
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
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | void> => {
    if (ctx.mode === 'json' || ctx.mode === 'print') return;
    if (primed.has(ctx.cwd)) return;
    primed.add(ctx.cwd);

    const blocks: string[] = [];
    const [analysisProvenance, specProvenance] = await Promise.all([
      readAnalysisContentProvenance(ctx.cwd),
      reviewedFileContentProvenance(ctx.cwd, 'openspec'),
    ]);
    const digest = await readDigest(ctx.cwd);
    if (digest) blocks.push(frameServedContent(
      '# Codebase architecture (openlore)\n\n' + truncate(digest, 8000),
      analysisProvenance,
      'codebase architecture digest',
    ));
    const specIndex = await readSpecIndex(ctx.cwd);
    if (specIndex) blocks.push(frameServedContent(specIndex, specProvenance, 'specification index'));

    // Task-scoped orientation: gate + token-budgeted render, the same pipeline
    // `openlore orient --inject` uses for the Claude Code hook (change
    // add-task-scoped-context-injection). The daemon does the orientation; the
    // host only gates and renders. `mode: "off"` opts out (digest/spec index,
    // Pi's own baseline grounding, are unaffected); a weak/absent match degrades
    // to the single ignorable pointer line instead of dumping raw orient JSON.
    const cfg = resolveInjectionConfig(await readContextInjection(ctx.cwd));
    // Turn-intent gate, ahead of the daemon round-trip: a repository-management
    // turn (push, open/merge a PR, cut a release) gets the reason-bearing
    // pointer line and no orientation at all — same classifier, same wording as
    // the CLI hook (change scope-advisory-noise-to-touched-code).
    const prompt = event.prompt?.trim() ?? '';
    if (cfg.mode !== 'off') {
      if (!prompt) {
        blocks.push(pointerLineFor('empty-prompt'));
      } else if (cfg.intentGate && classifyTurnIntent(prompt) === 'repository-management') {
        blocks.push(pointerLineFor('management-intent'));
      } else {
        // Resolve/contact the daemon only after the intent gate has admitted the
        // turn. Every failure remains visible as a reason-bearing pointer; a
        // digest already in `blocks` must not accidentally hide orientation loss.
        const injectionSignal = AbortSignal.timeout(runtime.orientTimeoutMs ?? PI_ORIENT_TIMEOUT_MS);
        try {
          const daemon = await awaitWithSignal(getDaemon(ctx.cwd), injectionSignal);
          if (!daemon) {
            blocks.push(pointerLineFor('error'));
          } else {
            const oriented = await callTool(
              daemon,
              'orient',
              { task: prompt },
              ctx.cwd,
              injectionSignal,
            );
            const result = oriented && typeof oriented === 'object'
              ? (oriented as LeanOrientResult)
              : { error: 'invalid orient response' };
            const evaluation = evaluateRelevanceGate(result, cfg);
            blocks.push(evaluation.passes
              ? renderInjectionBlock(result, cfg)
              : pointerLineFor(evaluation.reason ?? 'weak-relevance'));
          }
        } catch {
          // A first-turn deadline is not evidence that the daemon is unhealthy.
          // Discovery continues in the background and may warm the next call.
          if (!injectionSignal.aborted) daemons.delete(ctx.cwd);
          blocks.push(pointerLineFor('error'));
        }
      }
    }

    const suffix = blocks.length > 0
      ? blocks.join('\n\n')
      : '[openlore: no analysis found — run `openlore analyze` to enable structural context.]';

    return { systemPrompt: event.systemPrompt + '\n\n' + suffix };
  });
}

/** Build an extension registration function with bounded runtime overrides. @internal */
export function createPiExtension(
  runtime: { orientTimeoutMs?: number } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => registerOpenlore(pi, runtime);
}

/** Pi package entry point. */
export default function openlore(pi: ExtensionAPI): void {
  registerOpenlore(pi);
}

export const installPaths = {
  project: (cwd: string) => join(cwd, '.pi', 'extensions', 'openlore.js'),
  global: () => join(homedir(), '.pi', 'agent', 'extensions', 'openlore.js'),
};
