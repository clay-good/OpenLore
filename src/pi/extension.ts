/**
 * openlore Pi extension — src/pi/extension.ts
 *
 * Compiled to dist/pi/extension.js and declared in package.json "pi" field so
 * `pi install npm:openlore` drops it into the Pi extension registry automatically.
 *
 * Two halves:
 *   C — context injection (before_agent_start): repository-wide architecture/spec context is
 *       opt-in (`pi.contextMode: "full"`). The default is on-demand; the agent calls
 *       openlore_orient when it has a task. Recognized OpenSpec proposal invocations receive a
 *       concise instruction to synthesize intent before orienting.
 *   B — native tools (registerTool): the substrate surface for on-demand structural
 *       queries — NAV_TOOLS spans navigate + change + remember + verify + governance,
 *       each round-tripping to the warm daemon via fetch. Every tool is registered, but a
 *       session starts with only the lean set active (the MCP `substrate` preset, the same
 *       default Claude Code gets); openlore_activate_tools turns on the task groups in
 *       PI_TOOL_GROUPS. If the user enables Pi's native `tool_search`, specialist tools become
 *       deferred and searchable; `pi.toolSurface: "all"` keeps every tool active.
 *       (change: add-pi-lean-tool-surface)
 *
 * Uses ctx.mode (0.78.1+): full injection in tui/rpc (interactive), none in
 * json/print (one-shot). rpc = headless interactive over stdin/stdout (IDE,
 * custom UI) — same injection needs as tui.
 *
 * Config onboarding: a non-blocking hint once per cwd in this extension instance;
 * the wizard is opt-in via /openlore configure or the openlore_configure tool.
 *
 * change: harden-pi-config-and-daemon-fidelity
 */

import type {
  AgentEndEvent,
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

import { execFile, spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// The shared serve.json validator. Dependency-light (node builtins + the loopback
// predicate) so it does not drag the analyzer into the Pi host, and it guarantees
// Pi trusts the untrusted descriptor exactly as the CLI and MCP server do
// (mcp-security: ServeDescriptorValidatedAtEveryReader).
import {
  readServeDescriptor,
  readServeDescriptorState,
  serveHttpBaseUrl,
  validateServeHealth,
  type ServeDescriptor,
  type ServeHealth,
} from '../cli/commands/serve-descriptor.js';
import { OPENLORE_PACKAGE_VERSION } from '../core/runtime/package-versions.js';
import type { ContextInjectionConfig } from '../types/index.js';
import {
  refuseRepoConfiguredEndpoint,
  resolveTrustedCompatBase,
} from '../core/services/repo-config-trust.js';
// Pi renders nothing written to stdout, and logger.warning (used by the trust boundary and
// by every library path this extension calls) is a console.log. Route those to stderr so a
// refusal is at least recoverable from the host's log instead of vanishing — the same
// discipline the MCP server applies for the same reason. Operator-facing messages still go
// through ctx.ui.notify.
import { redirectConsoleToStderr } from '../utils/quiet-stdout.js';
import {
  frameServedContent,
  readAnalysisContentProvenance,
  reviewedFileContentProvenance,
} from '../core/services/served-content.js';
import { safeJoin } from '../utils/path-confinement.js';
import { globalOpenLoreConfigPath, readConfigObject, readLayeredConfig, readLayeredConfigSync } from '../utils/config-layers.js';
// Functional readiness for the footer status. `health.ts` is kept dependency-light on purpose so
// importing it does not load the daemon's stack into the host; `extension-imports.test.ts` guards it.
import { openloreHealth, readWatcherState, type HealthResult } from '../api/health.js';
import { FULL_PRESET, FULL_PRESET_ALIAS, OPENLORE_ANALYSIS_REL_PATH } from '../constants.js';
import { proposalContextForPrompt } from '../cli/commands/proposal-context.js';
import { REQUIRED_ANALYSIS_ARTIFACTS } from '../core/runtime/analysis-generation.js';
import { runtimeDirOf } from '../core/runtime/analysis-ownership.js';
import { OWNERSHIP_LOCK_FILE } from '../core/runtime/advisory-lock.js';
import { countUnreviewedDecisions } from '../core/decisions/autopilot.js';

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
  } | null;
  /** Task-scoped context injection settings (gate + token budget + opt-out). */
  contextInjection?: ContextInjectionConfig;
  pi?: { contextMode?: PiContextMode; toolSurface?: PiToolSurface; spawnDaemon?: boolean };
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
    const raw = await readLayeredConfig(safeJoin(cwd, join(OPENLORE_DIR, 'config.json')));
    return isUsableConfig(raw) ? raw : null;
  } catch { return null; }
}

/**
 * Environment override for daemon spawn authority (change: extend-api-for-supervising-hosts).
 * Set by a supervising host that already runs one daemon per working tree, so an
 * extension-initiated spawn would produce a second, unsupervised process outliving the session.
 */
const PI_NO_SPAWN_ENV = 'OPENLORE_PI_NO_SPAWN';

/**
 * May this extension spawn a daemon of its own?
 *
 * Read directly and NOT through `readConfig`: the opt-out must work before an
 * LLM provider is configured, and `readConfig` returns null until `generation.provider` is set —
 * which would silently restore spawn authority the operator revoked. The environment variable wins
 * over the config key, because it is the host's per-process statement about who owns the process.
 * Only the exact `false` disables spawning; an absent or malformed key leaves today's default.
 */
export async function piMaySpawnDaemon(cwd: string): Promise<boolean> {
  const env = process.env[PI_NO_SPAWN_ENV]?.trim().toLowerCase();
  if (env !== undefined && env !== '' && env !== '0' && env !== 'false') return false;
  try {
    const raw = await readLayeredConfig(safeJoin(cwd, join(OPENLORE_DIR, 'config.json')));
    const pi = raw && typeof raw === 'object' ? (raw as { pi?: { spawnDaemon?: unknown } }).pi : undefined;
    return pi?.spawnDaemon !== false;
  } catch {
    return true; // no config, or unreadable — the default is unchanged
  }
}

export type PiToolSurface = 'lean' | 'all';
export type PiSessionToolSurface = PiToolSurface | 'search';

export type PiContextMode = 'on-demand' | 'full';

/** Default Pi context mode avoids repeating repository-wide summaries on every turn. */
export async function piContextMode(cwd: string): Promise<PiContextMode> {
  try {
    const raw = await readLayeredConfig(safeJoin(cwd, join(OPENLORE_DIR, 'config.json')));
    const pi = raw && typeof raw === 'object' ? (raw as { pi?: { contextMode?: unknown } | null }).pi : undefined;
    return pi?.contextMode === 'full' ? 'full' : 'on-demand';
  } catch {
    return 'on-demand';
  }
}

/**
 * Which OpenLore tools a Pi session starts with. Read like `piMaySpawnDaemon`, so it works before
 * a provider is configured. Only the exact string `"all"` widens the surface; an absent,
 * malformed, or unreadable value keeps the lean default.
 */
export async function piToolSurface(cwd: string): Promise<PiToolSurface> {
  try {
    const raw = await readLayeredConfig(safeJoin(cwd, join(OPENLORE_DIR, 'config.json')));
    const pi = raw && typeof raw === 'object' ? (raw as { pi?: { toolSurface?: unknown } | null }).pi : undefined;
    return pi?.toolSurface === 'all' ? 'all' : 'lean';
  } catch {
    return 'lean';
  }
}

/** Read the initial surface synchronously so registration-time exposure honors `all`. */
function piToolSurfaceAtLoad(cwd: string): PiToolSurface {
  try {
    const raw = readLayeredConfigSync(safeJoin(cwd, join(OPENLORE_DIR, 'config.json')));
    const pi = raw && typeof raw === 'object' ? (raw as { pi?: { toolSurface?: unknown } | null }).pi : undefined;
    return pi?.toolSurface === 'all' ? 'all' : 'lean';
  } catch {
    return 'lean';
  }
}

/** Resolve Pi's configured tool_search without calling runtime actions during extension loading. */
function piToolSearchEnabledAtLoad(cwd: string): boolean {
  const defaultTools = ['read', 'bash', 'edit', 'write'];
  let entries: string[] | undefined;
  const readDefaultTools = (path: string): string[] | undefined => {
    try {
      const settings = JSON.parse(readFileSync(path, 'utf-8')) as { defaultTools?: unknown };
      return Array.isArray(settings.defaultTools) && settings.defaultTools.every((entry) => typeof entry === 'string')
        ? settings.defaultTools
        : undefined;
    } catch {
      return undefined;
    }
  };
  const merge = (base: string[] | undefined, overrides: string[] | undefined): string[] | undefined => {
    if (!overrides) return base;
    return overrides.every((entry) => /^[+-][^*]+$/.test(entry))
      ? [...(base ?? []), ...overrides]
      : overrides;
  };
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? process.env.PI_CODING_AGENT_DIR.replace(/^~/, homedir())
    : join(homedir(), '.pi', 'agent');
  entries = merge(entries, readDefaultTools(join(agentDir, 'settings.json')));
  entries = merge(entries, readDefaultTools(safeJoin(cwd, join('.pi', 'settings.json'))));

  const args = process.argv;
  const noTools = args.some((arg) => arg === '--no-tools' || arg === '-nt' || arg === '--no-builtin-tools' || arg === '-nbt');
  const resolved = noTools ? [] : (() => {
    const configured = entries ?? defaultTools;
    const plain = configured.filter((entry) => !/^[+-][^*]+$/.test(entry));
    const selected = plain.length > 0 || configured.length === 0 ? plain : defaultTools;
    for (const entry of configured) {
      if (entry.startsWith('+') && !selected.includes(entry.slice(1))) selected.push(entry.slice(1));
      if (entry.startsWith('-')) {
        const index = selected.indexOf(entry.slice(1));
        if (index >= 0) selected.splice(index, 1);
      }
    }
    return selected;
  })();
  const readCliList = (flags: readonly string[]): string[] | undefined => {
    for (let i = 0; i < args.length; i += 1) {
      if (!flags.includes(args[i]) || !args[i + 1]) continue;
      return args[i + 1].split(',').map((name) => name.trim()).filter(Boolean);
    }
    return undefined;
  };
  const cliTools = readCliList(['--tools', '-t']);
  let selected = resolved;
  if (cliTools) {
    selected = cliTools.some((entry) => entry.startsWith('+') || entry.startsWith('-'))
      ? (() => {
          const next = [...resolved];
          for (const entry of cliTools) {
            const name = entry.slice(1);
            const index = next.indexOf(name);
            if (entry.startsWith('+') && index < 0) next.push(name);
            if (entry.startsWith('-') && index >= 0) next.splice(index, 1);
          }
          return next;
        })()
      : cliTools;
  }

  // Escape every regex metacharacter but `*` (a glob wildcard): an unescaped `?` in a
  // user-supplied pattern made `new RegExp` throw and took the whole extension load down.
  const matches = (pattern: string): boolean => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test('tool_search');
  };
  const excluded = readCliList(['--exclude-tools', '-xt']) ?? [];
  return selected.some(matches) && !excluded.some(matches);
}

async function writeConfig(cwd: string, config: OpenLoreConfig, global = false): Promise<void> {
  const configPath = global ? globalOpenLoreConfigPath() : safeJoin(cwd, join(OPENLORE_DIR, 'config.json'));
  await mkdir(dirname(configPath), { recursive: true });
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
      // Never follow a redirect. A cross-origin redirect strips only Authorization,
      // Cookie and Proxy-Authorization — so the one-hop redirect a loopback endpoint can
      // hand back would otherwise turn a "cannot exfiltrate" loopback base URL into a
      // probe of (or a credential delivery to) any host it names. Same rule as
      // serve-client.ts.
      redirect: 'error',
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


/**
 * `effective` (user defaults under the project file) answers "is OpenLore configured here?".
 * The wizard edits ONE file, so it loads `project` or `global` alone: a project save must
 * never copy user-wide settings (an API key) into a repository file.
 */
export async function loadExistingConfig(
  cwd: string,
  target: 'effective' | 'project' | 'global' = 'effective',
): Promise<ExistingConfigLoad> {
  try {
    const projectPath = safeJoin(cwd, join(OPENLORE_DIR, 'config.json'));
    const raw = target === 'global'
      ? await readConfigObject(globalOpenLoreConfigPath())
      : target === 'project' ? await readConfigObject(projectPath) : await readLayeredConfig(projectPath);
    return raw === null ? { state: 'absent' } : { state: 'valid', config: raw };
  } catch (error) {
    return { state: 'invalid', detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runConfigWizard(
  ctx: ExtensionContext,
  existing?: ExistingOpenLoreConfig | null,
  hooks: { afterAnalyze?: (ctx: ExtensionContext) => Promise<void>; global?: boolean } = {},
): Promise<void> {
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

  // A project wizard edits the project file only; a user-wide embedding is not shown as
  // the project's own, but it can be turned off here (written as `embedding: null`).
  const inheritedEmbedding = hooks.global
    ? undefined
    : (await readConfigObject(globalOpenLoreConfigPath()).catch(() => null))?.embedding;
  let disableInheritedEmbedding = false;

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
        // `generation` is seeded from the ANALYZED REPO's config, and fetchModels sends
        // `Authorization: Bearer <operator key>` to whatever it names — so on a hostile
        // repo, merely opening this row would hand over OPENAI_COMPAT_API_KEY. This is a
        // generation endpoint carrying an operator credential, so it takes the same
        // resolveTrustedCompatBase rule the generate/doctor paths take: a remote value is
        // used only when the OPERATOR set it (env), never because the clone committed it.
        // Disclosure is not enough here, and it is also invisible in Pi: logger.warning
        // writes to stdout, which the TUI never renders — hence ctx.ui.notify, the channel
        // every other warning in this wizard uses.
        const compatBase = resolveTrustedCompatBase(
          process.env.OPENAI_COMPAT_BASE_URL,
          generation.openaiCompatBaseUrl,
        );
        if (generation.openaiCompatBaseUrl && !compatBase) {
          ui.notify(
            `Ignoring generation.openaiCompatBaseUrl "${generation.openaiCompatBaseUrl}" from ` +
              'this repository: a repo may not choose where your API key is sent. ' +
              'Set OPENAI_COMPAT_BASE_URL to trust it deliberately.',
            'warning',
          );
        }
        const apiBase = generation.provider === 'openai' ? 'https://api.openai.com' : (compatBase ?? '');
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
        embedding = { ...embedding, baseUrl: input, model: embedding?.model ?? '' };
        if (!process.env['OPENLORE_EMBEDDING_API_KEY']) {
          ui.notify('Set OPENLORE_EMBEDDING_API_KEY in your shell (leave unset for Ollama/local endpoints)', 'info');
        }
      }
    });

    if (embedding?.baseUrl) {
      row('Model', embedding.model || '(none)', async () => {
        // Same repo-authored value the analyze path and `openlore doctor` refuse when it
        // is not loopback: probing it here would make the wizard an instance-metadata /
        // internal-host scanner on behalf of a clone. Refuse, and say so in the TUI —
        // the module's own logger.warning goes to stdout, which Pi never shows.
        const embedBase = refuseRepoConfiguredEndpoint(
          'embedding.baseUrl',
          embedding?.baseUrl,
          'Enter a model name instead.',
        );
        if (embedding?.baseUrl && !embedBase) {
          ui.notify(
            `Not listing models from "${embedding.baseUrl}": a repository's config may not ` +
              'choose where requests go. Type the model name instead.',
            'warning',
          );
        }
        const models = embedBase ? await fetchModels(embedBase) : null;
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
    } else if (isPlainObject(inheritedEmbedding) && existing?.embedding !== null && !disableInheritedEmbedding) {
      menu.push({ label: '✕ Disable inherited embedding', handler: async () => { disableInheritedEmbedding = true; } });
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
    // Keep inheriting a user embedding unless this project had its own entry (now removed).
    ...(embedding ? { embedding }
      : isPlainObject(inheritedEmbedding) && (disableInheritedEmbedding || Object.hasOwn(existing ?? {}, 'embedding'))
        ? { embedding: null } : {}),
    createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : new Date().toISOString(),
    lastRun: typeof existing?.lastRun === 'string' || existing?.lastRun === null ? existing.lastRun : null,
  };

  await writeConfig(ctx.cwd, config, hooks.global);
  ui.notify(hooks.global ? `Global configuration saved to ${globalOpenLoreConfigPath()}.` : 'Configuration saved.', 'info');

  const generationChanged = generation.provider !== prevProvider || generation.model !== prevModel;
  if (generationChanged && !hooks.global) {
    const runNow = await ui.confirm(
      'Run openlore analyze now?',
      'Builds the structural index required for navigation tools (~30s–2min depending on codebase size)',
    );
    if (runNow) {
      ui.notify('Running openlore analyze…', 'info');
      const [exitCode, errText] = await new Promise<[number, string]>((resolve) => {
        const trySpawn = (cmd: string, args: string[]) => new Promise<[number, string] | null>((res) => {
          const chunks: Buffer[] = [];
          // Pass env explicitly so the child honors the process's CURRENT environment
          // (e.g. a PATH the host adjusted) rather than a stale snapshot — identical to the
          // default inherited env in normal use, but it keeps resolution deterministic.
          const proc = process.platform === 'win32'
            ? spawn('cmd.exe', ['/c', cmd, ...args], { cwd: ctx.cwd, env: process.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
            // windowsHide is a documented no-op off Windows; set here too so the invariant is
            // uniform across both branches rather than a carve-out the guard has to know about.
            : spawn(cmd, args, { cwd: ctx.cwd, env: process.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
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
      await hooks.afterAnalyze?.(ctx);
    }
  }
}

// ── Daemon discovery + lifecycle ──────────────────────────────────────────────

interface Daemon {
  baseUrl: string;
  token?: string;
  incompatibility?: string;
  /** A repository-bound health response found a version mismatch or missing Pi tools. */
  autoRecoverable?: boolean;
  /** Preset reported by the authenticated daemon, reused for automatic recovery. */
  restartPreset?: string;
  /** Identity of the older daemon, re-checked immediately before automatic recovery stops it. */
  restartExpect?: { pid: number; version: string };
}

interface DaemonProbe {
  alive: boolean;
  health: ServeHealth | null;
}

const HEALTH_TIMEOUT_MS = 8000;
const HEALTH_POLL_MS = 150;
export const PI_SPEC_INDEX_MAX_DOMAINS = 50;
// Generous per-probe timeout: a cold Node HTTP server on Windows can be slow to
// answer the first /health. Too short a timeout misreads a live daemon as dead,
// so we spawn a fresh one and orphan the previous — orphans pile up in RAM.
const HEALTH_PROBE_TIMEOUT_MS = 2500;
// The CLI serializes stop behind startup (30s) and drains rebuilds (up to 65s).
const DAEMON_STOP_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);
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

/** Return true only when a parseable release version is strictly older. */
function isOlderPackageVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    const prerelease = match?.[4]?.split('.');
    if (prerelease?.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
    return match
      ? { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease }
      : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < a.core.length; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i];
  }
  if (!a.prerelease) return false;
  if (!b.prerelease) return true;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return true;
    if (right === undefined) return false;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return left.length === right.length ? left < right : left.length < right.length;
    if (leftNumeric !== rightNumeric) return leftNumeric;
    return left < right;
  }
  return false;
}

function daemonFromHealth(desc: ServeDescriptor, health: ServeHealth): Daemon {
  const missing = missingDaemonTools(health.tools, NAV_TOOLS.map((tool) => tool.name));
  const olderVersion = health.version !== undefined && isOlderPackageVersion(health.version, OPENLORE_PACKAGE_VERSION);
  // An older version alone is not an incompatibility: a tool-complete daemon stays usable when it
  // cannot be replaced (spawn opt-out, refused stop) rather than locking Pi out entirely.
  const autoRecoverable = olderVersion;
  return {
    baseUrl: serveHttpBaseUrl(desc.host, desc.port),
    token: desc.token,
    ...(autoRecoverable
      ? {
          autoRecoverable: true,
          restartPreset: health.preset,
          restartExpect: { pid: health.pid, version: health.version as string },
        }
      : {}),
    ...(missing.length > 0
      ? {
          incompatibility:
            (olderVersion
              ? `The running daemon version ${health.version} is older than the installed extension version ${OPENLORE_PACKAGE_VERSION}. `
              : '') +
            `It does not expose ${missing.length} Pi tool(s), including ${missing.slice(0, 3).join(', ')}. ` +
            (autoRecoverable
              ? 'Automatic recovery could not replace it; run /openlore restart in Pi to retry. '
              : 'The current preset omits Pi tools; run /openlore restart in Pi to switch to the full preset. ') +
            'If externally supervised, restart it through the supervising host instead.',
        }
      : {}),
  };
}

export type EnsureDaemonResult =
  | { daemon: Daemon; failure?: undefined }
  | {
      daemon: null;
      failure: string;
      failureKind: 'draining' | 'launch' | 'preparation' | 'early-exit' | 'health-timeout' | 'spawn-disabled' | 'stop' | 'unknown-preset';
    };

export function shouldNegativeCacheDaemonFailure(
  kind: Exclude<EnsureDaemonResult, { daemon: Daemon }>['failureKind'],
): boolean {
  // `spawn-disabled` joins the non-cached kinds: the host may start its daemon at any moment, and
  // a cooldown would make the extension keep reporting "absent" for 30s after it appeared.
  return kind !== 'draining' && kind !== 'health-timeout' && kind !== 'spawn-disabled';
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
  // Spawn authority is checked HERE, not at the `options.launch` seam, so the default path every
  // Pi tool call takes honours the opt-out — a seam only an explicit caller can reach would leave
  // the extension spawning exactly as before (spec: PiDaemonSpawnAuthorityIsOverridable).
  if (!(await piMaySpawnDaemon(cwd))) {
    return {
      daemon: null,
      failure:
        `No healthy openlore daemon was found for this working tree, and daemon spawning is ` +
        `disabled (${PI_NO_SPAWN_ENV} or "pi.spawnDaemon": false). Start the daemon from the ` +
        `supervising host, then retry.`,
      failureKind: 'spawn-disabled',
    };
  }
  try {
    // The daemon must outlive this process and write .openlore/serve.json.
    // Windows 10 kills a child whose stdout/stderr are NUL (stdio:'ignore') —
    // it dies before writing the descriptor (Win11 tolerates it). Give it a
    // real file handle (serve.log) instead; that's the fix validated on Win10.
    // `detached` applies on every platform: macOS/Linux need it (setsid) to
    // outlive us, and so does Windows — this once excluded Windows on the
    // belief that it "doesn't reap the child on parent exit anyway", which the
    // windows-smoke job disproved (the daemon died with its spawner, killed,
    // with no shutdown trace in serve.log). windowsHide keeps DETACHED_PROCESS
    // from surfacing a console. Caveat: libuv deliberately does not set
    // CREATE_BREAKAWAY_FROM_JOB, so this does not escape a parent Job Object.
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
          detached: true,
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

/** Whether the installed `serve` accepts this preset name (same rule as `runServe`). */
async function isKnownServePreset(preset: string): Promise<boolean> {
  if (preset === FULL_PRESET || preset === FULL_PRESET_ALIAS) return true;
  // Lazy: the MCP registry is heavy and only this recovery path needs it.
  const { TOOL_PRESETS } = await import('../cli/commands/mcp.js');
  return Object.hasOwn(TOOL_PRESETS, preset);
}

/** Explicit user recovery, never automatic takeover of a shared daemon. */
export async function restartPiDaemon(
  cwd: string,
  options: {
    /** Internal test seams; production always uses this package's CLI. */
    stop?: { command: string; args: string[] };
    launch?: { command: string; args: string[] };
    timeoutMs?: number;
    preset?: string;
    /** Stop only while the announced daemon is still this one (automatic recovery). */
    expect?: { pid: number; version: string };
  } = {},
): Promise<EnsureDaemonResult> {
  if (!(await piMaySpawnDaemon(cwd))) {
    return {
      daemon: null,
      failureKind: 'spawn-disabled',
      failure: 'OpenLore daemon restart is disabled by the host or pi.spawnDaemon. ' +
        'Restart or upgrade the daemon through the supervising host instead.',
    };
  }
  // The reported preset comes from the OLD daemon; this release may have removed or renamed it.
  // Stopping first would leave no daemon when the replacement then refuses the preset.
  if (options.preset !== undefined && !(await isKnownServePreset(options.preset))) {
    return {
      daemon: null,
      failureKind: 'unknown-preset',
      failure: `The running daemon's preset is not known to this OpenLore release, so it was not ` +
        'replaced automatically. Run /openlore restart in Pi to switch to the full preset.',
    };
  }
  const packaged = piDaemonSpawnCommand(cwd);
  const stop = options.stop ?? {
    command: packaged.command,
    args: [packaged.args[0], 'serve', '--directory', cwd, '--stop'],
  };
  const launch = options.launch ?? {
    command: packaged.command,
    args: [packaged.args[0], 'serve', '--directory', cwd, '--preset', options.preset ?? PI_DAEMON_PRESET],
  };
  if (options.expect) {
    // Re-check right before the stop: another Pi session on this repository may already have
    // replaced the older daemon, and stopping its current-version successor would interrupt it.
    // If the announcement changed, adopt (or start) whatever is there instead of stopping.
    // A window remains: the CLI stop re-reads serve.json after waiting on the startup lock and
    // cannot be told "stop only PID X", so a replacement published inside that wait can still be
    // stopped. Closing it fully needs a PID-bound stop in the CLI.
    const current = await readDescriptor(cwd);
    const probe = current ? await probeHealth(current, cwd) : null;
    if (probe?.health?.pid !== options.expect.pid || probe.health.version !== options.expect.version) {
      return ensureDaemonResult(cwd, { launch, timeoutMs: options.timeoutMs });
    }
  }
  try {
    // Reuse the CLI's startup lock, authenticated root/PID health proof, graceful
    // shutdown, and bounded drain. Never signal the repo-writable descriptor PID.
    await execFileAsync(stop.command, stop.args, {
      timeout: DAEMON_STOP_TIMEOUT_MS,
      windowsHide: true,
    });
    // Some CLI refusal paths log a warning without a nonzero exit. A draining
    // or still-announced instance must never be followed by a replacement spawn.
    const remaining = await readServeDescriptorState(
      safeJoin(cwd, join(OPENLORE_DIR, 'serve.json')), { includeDraining: true },
    );
    if (remaining.kind !== 'absent') throw new Error('daemon is still announced');
  } catch {
    return {
      daemon: null,
      failureKind: 'stop',
      failure: 'OpenLore could not safely stop the announced daemon. No replacement was started. ' +
        'A legacy or unverified daemon must be stopped by its owner; see .openlore/serve.log.',
    };
  }
  return ensureDaemonResult(cwd, { launch, timeoutMs: options.timeoutMs });
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

export function isUsableDaemon(daemon: Daemon): boolean {
  return daemon.incompatibility === undefined;
}

// ── Footer status (change: add-pi-openlore-status) ────────────────────────────

/** The Pi footer status key this extension owns. */
export const PI_STATUS_KEY = 'openlore';

/** What the extension last learned about the daemon for one working tree. */
export type PiDaemonView = 'connecting' | 'usable' | 'incompatible' | 'spawn-disabled' | 'unavailable';

/** Map a daemon resolution to the view the status reports. @internal */
export function piDaemonView(result: EnsureDaemonResult): PiDaemonView {
  if (result.daemon) return isUsableDaemon(result.daemon) ? 'usable' : 'incompatible';
  return result.failureKind === 'spawn-disabled' ? 'spawn-disabled' : 'unavailable';
}

export interface PiStatusFacts {
  daemon: PiDaemonView;
  /** Absent when the health read failed: readiness is then unknown, never assumed. */
  health?: Pick<HealthResult, 'index' | 'watcher'>;
  /** Auto-accepted decisions awaiting human review (change: default-decision-autopilot-with-visible-trace). */
  unreviewed?: number;
}

/**
 * Render the footer status (spec: PiStatusReportsFunctionalReadiness). Precedence: connecting, then
 * an index that is not ready — no daemon can serve an absent index, so that is the actionable
 * condition — then the daemon, then a watcher the daemon reported stopped. "ready" needs both a
 * ready index and a usable daemon. @internal
 */
export function formatPiStatus(facts: PiStatusFacts): string {
  const review = facts.unreviewed ? ` · ${facts.unreviewed} to review` : '';
  const say = (text: string) => `${PI_STATUS_KEY}: ${text}${review}`;
  if (facts.daemon === 'connecting') return say('connecting…');
  if (!facts.health) return say('status unknown');
  switch (facts.health.index) {
    case 'absent': return say('no index (run openlore analyze)');
    case 'building': return say('analyzing…');
    case 'degraded': return say('index degraded');
    case 'ready': break;
  }
  switch (facts.daemon) {
    case 'incompatible': return say('daemon incompatible');
    case 'spawn-disabled': return say('daemon not started (spawn disabled)');
    case 'unavailable': return say('daemon unavailable');
    case 'usable': break;
  }
  return facts.health.watcher === 'stopped' ? say('ready (watcher stopped)') : say('ready');
}

/**
 * The cache key for one health read: the stat of every required artifact, the ownership lock, and
 * the daemon view. The full read parses every artifact (tens of MB on a large repository), so it
 * reruns only when one of these moves. @internal
 */
export async function piHealthCacheKey(cwd: string, daemon: PiDaemonView): Promise<string> {
  const analysisDir = safeJoin(cwd, OPENLORE_ANALYSIS_REL_PATH);
  const stamp = async (path: string): Promise<string> => {
    try {
      const s = await stat(path);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '-';
    }
  };
  const parts = await Promise.all([
    ...REQUIRED_ANALYSIS_ARTIFACTS.map((artifact) => stamp(join(analysisDir, artifact))),
    stamp(join(runtimeDirOf(analysisDir), OWNERSHIP_LOCK_FILE)),
  ]);
  return [daemon, ...parts].join('|');
}

type PiHealthReader = (cwd: string) => Promise<HealthResult>;
const defaultHealthReader: PiHealthReader = (cwd) => openloreHealth({ rootPath: cwd });
type PiWatcherReader = (cwd: string) => Promise<HealthResult['watcher']>;

/** Set the status only where the host has a UI; a failing host call never escapes. */
function setPiStatus(ctx: ExtensionContext, text: string | undefined): void {
  try {
    if (!ctx.hasUI || typeof ctx.ui?.setStatus !== 'function') return;
    // The color follows the readiness label, not the trailing review count.
    const label = text?.slice(`${PI_STATUS_KEY}: `.length).split(' · ')[0];
    const color = label === 'ready'
      ? 'success'
      : label === 'connecting…' || label === 'analyzing…'
        ? 'accent'
        : label === 'index degraded' || label === 'daemon incompatible' || label === 'daemon unavailable'
          ? 'error'
          : label === 'ready (watcher stopped)' || label === 'no index (run openlore analyze)' ||
              label === 'daemon not started (spawn disabled)' || label === 'status unknown'
            ? 'warning'
            : undefined;
    const rendered = text && color && typeof ctx.ui.theme?.fg === 'function'
      ? ctx.ui.theme.fg(color, text)
      : text;
    ctx.ui.setStatus(PI_STATUS_KEY, rendered);
  } catch {
    // Advisory only (spec: PiStatusFollowsTheSessionLifecycle).
  }
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
    name: 'verify_change',
    label: 'openlore verify_change',
    description: 'Before landing a change, get ONE severity-ranked checklist of what it breaks and what to re-run: each item names its subject, the check that found it, a severity, and the single next action, plus the tests to run. Composes blast_radius and structural_diff; advisory, runs nothing and edits nothing.',
    guideline: 'Right before you commit or finish a change, call openlore_verify_change to get a single ordered action list — the breaks to fix and the tests to run — distilled from the diff. With no arguments it uses your uncommitted changes (diff vs HEAD). It is a grader, not an author: act on the list; it runs and edits nothing. Its sibling blast_radius returns the fuller structured briefing.',
    parameters: Type.Object({
      baseRef: Type.Optional(Type.String({ description: 'Git ref to diff the working tree against (e.g. "HEAD", "main"). Optional — defaults to HEAD (uncommitted changes).' })),
    }),
  },
  {
    name: 'certify_provenance',
    label: 'openlore certify_provenance',
    description: 'Emit a reproducible, content-addressed record of what a change does (blast radius, paths newly opened into a declared surface, drifted specs, tests to run, structural delta), for attachment to SLSA/in-toto provenance. OpenLore emits, it does not sign.',
    guideline: 'When a change needs a verifiable provenance record (a CI attestation or audit trail), call openlore_certify_provenance to emit a content-addressed certificate of what the change does — as an in-toto predicate (format "in-toto") or JSON. Any consumer recomputes it to verify the digest. A bad base is fatal; it signs nothing.',
    parameters: Type.Object({
      baseRef: Type.Optional(Type.String({ description: 'Git ref to diff against (default HEAD).' })),
      change: Type.Optional(Type.String({ description: 'Change id recorded on the certificate (default "working-tree").' })),
      format: Type.Optional(Type.String({ description: 'Output shape: "in-toto" predicate or "json" (default json).' })),
    }),
  },
  {
    name: 'certify_merge',
    label: 'openlore certify_merge',
    description: 'Before landing two branches that merge cleanly, check whether one side breaks what the other calls: build the call graph at the merge-base and each side, and report where one adds a call into a symbol the other changed incompatibly or removed. Advisory, a sound lower bound (never "safe").',
    guideline: 'Before merging two branches (or landing a PR onto its base), call openlore_certify_merge with `ours` and `theirs` (git refs) to catch the "merges cleanly but the combination is broken" failure textual merge misses. Verdicts are incompatible / potentially-incompatible, never "safe".',
    parameters: Type.Object({
      ours: Type.String({ description: 'One side to merge (a git ref).' }),
      theirs: Type.String({ description: 'The other side to merge (a git ref).' }),
      base: Type.Optional(Type.String({ description: 'Merge base (default: the git merge-base of ours and theirs).' })),
    }),
  },
  {
    name: 'fleet_status',
    label: 'openlore fleet_status',
    description: 'Coordinating parallel branches off a moving base: re-check each recorded coordination verdict (a clean blast radius, a stable surface, a passed merge check) against the current graph — still-valid / carried / invalidated / needs-reverification — and surface the coordination arc. A verdict is never served fresh once its base moved.',
    guideline: 'When coordinating several in-flight branches, call openlore_fleet_status to see which recorded verdicts still hold after the base moved, and the overall coordination picture (dispatch → in-flight → landing). Read-only and advisory.',
    parameters: Type.Object({
      branches: Type.Optional(Type.Array(Type.String(), { description: 'In-flight branches to compose the arc for.' })),
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
      kind: StringEnum(['calls', 'reaches', 'dead', 'impacts', 'safe-to-change', 'decision-current', 'decision-governed', 'endpoint-implemented', 'endpoint-consumed'] as const, { description: 'REQUIRED. The kind of claim to verify.' }),
      subject: Type.String({ description: 'REQUIRED. A symbol; a decision id for decision-current; "METHOD /path" for endpoint kinds.' }),
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
          span: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Exact text inside the symbol (optional); only edits to it drift the memory.' })),
        }),
        { description: 'Code this memory is about; each anchor names a symbol and/or file so the memory self-invalidates when that code changes.' },
      )),
      type: Type.Optional(StringEnum(['invariant', 'gotcha', 'rationale', 'convention', 'preference', 'todo', 'note'] as const, { description: 'Classification (default note); never inferred.' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Optional retrieval tags.' })),
      supersedes: Type.Optional(Type.String({ description: 'Id of a prior memory to retire (kept queryable via asOf).' })),
      trigger: Type.Optional(Type.Object({
        fileGlob: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'Glob over touched files, e.g. "src/routes/**" (* ? ** only).' })),
        symbolPattern: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'Glob over touched symbol names, e.g. "handle*".' })),
        specDomain: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'A spec domain the task touches.' })),
        withinHops: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Anchor is within N call hops of a touched symbol.' })),
      }, { additionalProperties: false, maxProperties: 1, description: 'Optional: give exactly one predicate; the memory is pushed into orient/blast_radius briefings when it matches what they touch.' })),
      pinned: Type.Optional(Type.Boolean({ description: 'Push this memory into every full (non-lean) orient briefing (at most 10 notes are pushed; the rest are counted).' })),
      claims: Type.Optional(Type.Array(
        Type.Object({
          kind: StringEnum(['calls', 'reaches', 'dead', 'impacts', 'safe-to-change', 'decision-current'] as const),
          subject: Type.String({ minLength: 1, maxLength: 256, description: 'Symbol name, or a decision id for decision-current.' }),
          object: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'Second symbol, for calls / reaches / impacts.' })),
        }, { additionalProperties: false }),
        { maxItems: 10, description: 'Optional: verify_claim claims the memory rests on. Each must hold now; recall checks them again and moves the memory out of the authoritative set when one no longer holds.' },
      )),
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

// One-line entries for Pi's "Available tools" prompt section. The full description
// already reaches the model with the tool schema; repeating it here doubled the
// standing context (spec: PiStandingContextIsBudgeted).
export const PI_TOOL_SNIPPETS: Record<string, string> = {
  orient: 'Start any new task here: relevant functions, files, specs, and where to add code.',
  search_code: 'Find code by concept or name, instead of grepping.',
  get_subgraph: 'Callers and callees of one function.',
  trace_execution_path: 'Every call path from one function to another.',
  find_path: 'Cheapest call route from A to B.',
  analyze_impact: 'Everything that depends on a function or type.',
  select_tests: 'Tests to run for given functions or your uncommitted changes.',
  get_test_coverage: 'Which code has tests and which does not.',
  blast_radius: 'Pre-commit briefing: callers, tests to run, specs and decisions at risk.',
  verify_change: 'Pre-commit checklist: what the diff breaks and the tests to run, severity-ranked.',
  certify_provenance: 'Reproducible, content-addressed record of what a change does, for SLSA/in-toto.',
  certify_merge: 'Two branches merge cleanly but break in combination — the semantic conflict check.',
  fleet_status: 'Which recorded coordination verdicts still hold after the base moved, plus the arc.',
  structural_diff: 'Functions, edges, and signatures changed between two states, plus stale callers.',
  verify_claim: 'Check a structural fact or a decision citation before you state it.',
  suggest_insertion_points: 'Ranked places to add new code.',
  get_function_skeleton: 'Signatures and control flow of a file, without bodies.',
  get_health_map: 'Riskiest code areas, ranked.',
  get_surprising_connections: 'Unexpected coupling between code regions.',
  get_architecture_overview: 'Domain clusters, dependencies, entry points, and hubs.',
  get_map: 'Region map of the codebase and how the regions connect.',
  get_landmarks: 'Hubs, chokepoints, entry points, and dead code, with evidence.',
  get_refactor_report: 'Refactoring targets ranked by priority.',
  get_critical_hubs: 'Most-called functions, the riskiest to change.',
  get_god_functions: 'Functions that call too many things.',
  find_clones: 'Existing near-duplicates of code you are about to write.',
  analyze_error_propagation: 'Errors that can escape a function, and the ones it handles.',
  analyze_env_impact: 'Read sites and blast radius of an environment variable.',
  certify_public_surface: 'Breaking-change check for exported code.',
  get_style_fingerprint: 'House coding style to match in your edit.',
  briefing_since: 'Changes since a ref that matter structurally, ranked.',
  search_specs: 'Find spec requirements by meaning.',
  search_unified: 'Search code and specs in one call.',
  get_spec: 'Full spec for one domain.',
  get_function_body: 'Source of one function, or a slice on one variable or callee.',
  get_file_dependencies: 'Imports of a file and the files that import it.',
  remember: 'Save a code-anchored fact for later sessions.',
  recall: 'Notes from earlier sessions about the code you touch.',
  check_spec_drift: 'Changed code that no longer matches its spec.',
  audit_spec_coverage: 'Code with no spec, and stale or orphan requirements.',
  list_spec_domains: 'Names of the spec domains.',
  record_decision: 'Record a design decision before you write the code.',
  list_decisions: 'Recorded decisions and their status.',
  approve_decision: 'Approve a decision, only after the user says yes.',
  reject_decision: 'Reject a pending decision.',
  sync_decisions: 'Write approved decisions into the specs.',
};

// Tools active when a Pi session starts (names without the `openlore_` prefix):
// the MCP `substrate` preset — the default `openlore install` wires for Claude
// Code — minus PI_ON_DEMAND_SUBSTRATE_TOOLS, plus the two Pi-only utilities.
// extension.test.ts derives this set from TOOL_PRESETS.substrate so the two
// surfaces cannot drift.
export const PI_LEAN_TOOLS: readonly string[] = [
  'orient', 'search_code', 'get_subgraph', 'trace_execution_path',
  'analyze_impact', 'suggest_insertion_points', 'get_function_skeleton',
  'get_landmarks', 'get_map', 'find_path',
  'recall', 'verify_claim', 'blast_radius',
  'configure', 'activate_tools',
];

/** Tools that stay directly visible when Pi's native tool_search is active. */
export const PI_SEARCH_TOOLS: readonly string[] = ['orient', 'search_code'];

// Substrate tools Pi keeps out of the lean set: an MCP host cannot turn a tool on
// mid-session, but Pi can, so task-specific spec authoring waits in the `specs`
// group instead of adding its descriptions to every prompt.
export const PI_ON_DEMAND_SUBSTRATE_TOOLS: readonly string[] = ['prepare_spec_generation', 'prepare_spec_repair'];

// Task groups openlore_activate_tools turns on. Every registered tool outside
// PI_LEAN_TOOLS belongs to exactly one group (guarded in extension.test.ts).
// Groups are task-shaped, not capability families: `navigate` alone holds most tools.
export const PI_TOOL_GROUPS: Record<string, readonly string[]> = {
  specs: [
    'search_specs', 'get_spec', 'list_spec_domains', 'search_unified', 'check_spec_drift', 'audit_spec_coverage',
    ...PI_ON_DEMAND_SUBSTRATE_TOOLS,
  ],
  memory: ['remember', 'record_decision', 'list_decisions', 'approve_decision', 'reject_decision', 'sync_decisions'],
  review: ['structural_diff', 'verify_change', 'certify_provenance', 'certify_merge', 'fleet_status', 'select_tests', 'get_test_coverage', 'briefing_since', 'certify_public_surface'],
  quality: [
    'get_refactor_report', 'get_health_map', 'get_critical_hubs', 'get_god_functions',
    'get_architecture_overview', 'get_surprising_connections', 'find_clones', 'get_style_fingerprint',
  ],
  inspect: ['get_function_body', 'get_file_dependencies', 'analyze_error_propagation', 'analyze_env_impact'],
};

const PI_TOOL_PREFIX = 'openlore_';
export const PI_ACTIVATOR_TOOL = `${PI_TOOL_PREFIX}activate_tools`;

/** Every tool name the extension registers, with the `openlore_` prefix. */
export function piRegisteredToolNames(): string[] {
  return [
    ...NAV_TOOLS.map((tool) => tool.name),
    'prepare_spec_generation', 'prepare_spec_repair', 'configure', 'activate_tools',
  ].map((name) => PI_TOOL_PREFIX + name);
}

/**
 * The active set a session starts with. Non-OpenLore tools keep their state; OpenLore
 * tools the host had already turned off (`hostExcluded`) stay off.
 */
export function piSessionActiveTools(
  surface: PiSessionToolSurface,
  active: readonly string[],
  hostExcluded: ReadonlySet<string>,
): string[] {
  const registered = new Set(piRegisteredToolNames());
  const wanted = surface === 'all'
    ? [...registered].filter((name) => name !== PI_ACTIVATOR_TOOL)
    : (surface === 'search' ? PI_SEARCH_TOOLS : PI_LEAN_TOOLS).map((name) => PI_TOOL_PREFIX + name);
  return [
    ...active.filter((name) => !registered.has(name)),
    ...wanted.filter((name) => !hostExcluded.has(name)),
  ];
}

export type PiActivationPlan =
  | { ok: false; error: string }
  | { ok: true; nextActive: string[]; activated: string[]; alreadyActive: string[]; hostExcluded: string[] };

/**
 * Resolve activator names (a group, or a tool with or without the `openlore_` prefix) into the
 * next active set. All-or-nothing: one unknown name activates nothing. A lean tool name is
 * valid and changes nothing, because it is already on.
 */
export function planPiToolActivation(
  names: readonly string[],
  active: readonly string[],
  hostExcluded: ReadonlySet<string>,
): PiActivationPlan {
  const groups = new Set<string>();
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/^openlore_/, '');
    if (Object.hasOwn(PI_TOOL_GROUPS, name)) { groups.add(name); continue; }
    const owner = Object.keys(PI_TOOL_GROUPS).find((group) => PI_TOOL_GROUPS[group].includes(name));
    if (owner) groups.add(owner);
    else if (!PI_LEAN_TOOLS.includes(name)) unknown.push(raw);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown openlore tool group or tool: ${unknown.join(', ')}. Nothing was activated. Valid groups: ${Object.keys(PI_TOOL_GROUPS).join(', ')}.`,
    };
  }
  const current = new Set(active);
  const activated: string[] = [];
  const alreadyActive: string[] = [];
  const excluded: string[] = [];
  for (const group of groups) {
    const tools = PI_TOOL_GROUPS[group].map((name) => PI_TOOL_PREFIX + name);
    const blocked = tools.filter((name) => hostExcluded.has(name));
    const added = tools.filter((name) => !hostExcluded.has(name) && !current.has(name));
    excluded.push(...blocked);
    if (added.length === 0) alreadyActive.push(group);
    for (const name of added) { current.add(name); activated.push(name); }
  }
  return { ok: true, nextActive: [...current], activated, alreadyActive, hostExcluded: excluded };
}

/** The activator description: every group with the tools it turns on. */
export function piActivatorDescription(): string {
  const lines = Object.entries(PI_TOOL_GROUPS)
    .map(([group, tools]) => `- ${group}: ${tools.map((name) => PI_TOOL_PREFIX + name).join(', ')}`);
  return [
    'Turn on more openlore tools for the rest of this session. Pass group names, or the name of any tool below.',
    'To create a spec from code or repair an existing spec, turn on the specs group.',
    ...lines,
  ].join('\n');
}

/**
 * Reviewed ceilings for the standing context OpenLore tools add to the Pi prompt, estimated by
 * `estimatePiStandingTokens`. Each entry records its measured baseline and bounded headroom, so
 * raising a budget changes both a number and its rationale (the STANDING_CONTEXT_BUDGETS pattern).
 */
export const PI_STANDING_CONTEXT_BUDGETS: Record<PiSessionToolSurface, { baselineTokens: number; maxTokens: number; rationale: string }> = {
  lean: { baselineTokens: 2_789, maxTokens: 2_980, rationale: 'Shrank when spec authoring moved to the specs group; measured baseline plus 6.8% headroom.' },
  search: { baselineTokens: 240, maxTokens: 300, rationale: 'Measured budget for orient and search_code; Pi tool_search loads specialized tools only when requested.' },
  all: { baselineTokens: 8_825, maxTokens: 9_400, rationale: 'Grew with verify_change, certify_provenance, certify_merge, and fleet_status (the moat/interop features); measured baseline plus 6.5% headroom.' },
};

/** Deterministic estimate (characters / 4) of what the given registered tools add to the prompt. */
export function estimatePiStandingTokens(tools: ReadonlyArray<{
  description: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  parameters: unknown;
}>): number {
  let chars = 0;
  for (const tool of tools) {
    chars += tool.description.length + (tool.promptSnippet?.length ?? 0);
    chars += (tool.promptGuidelines ?? []).reduce((sum, line) => sum + line.length, 0);
    chars += JSON.stringify(tool.parameters).length;
  }
  return Math.ceil(chars / 4);
}

// Conclusion tools deliberately NOT surfaced natively in Pi, each with a stated
// reason (project doctrine: "if parity is intentionally skipped, say why").
// The two-direction parity guard (extension.test.ts) requires every dispatchable
// conclusion tool to be either in NAV_TOOLS above or listed here — a new MCP
// conclusion tool fails CI until its author makes this decision explicitly, the
// same fails-until-you-classify discipline tool-contract.test.ts enforces.
export const PI_EXCLUDED_CONCLUSION_TOOLS: Record<string, string> = {
  declare_footprint: 'opt-in coordination preset write surface; `openlore footprint` serves it from the CLI.',
  certify_service_contract: 'opt-in full-preset API-contract check; `openlore certify-service-contract` serves it from the CLI.',
  get_handoff_briefing: 'Session succession reaches Pi through its compaction event (`session_before_compact`) in add-agent-loop-hooks-subagents-codex-pi; until then `openlore handoff` serves it from the CLI.',
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

/** Bounded runtime overrides for the extension. @internal */
export interface PiExtensionRuntime {
  /** Replaces the functional-readiness read behind the footer status. */
  readHealth?: PiHealthReader;
  /** Replaces the watcher-only probe used on a cached health read. */
  readWatcher?: PiWatcherReader;
  /** Replaces daemon discovery/spawn. */
  resolveDaemon?: (cwd: string) => Promise<EnsureDaemonResult>;
  /** Replaces explicit daemon restart. */
  restartDaemon?: (
    cwd: string,
    preset?: string,
    expect?: { pid: number; version: string },
  ) => Promise<EnsureDaemonResult>;
}

function registerOpenlore(
  pi: ExtensionAPI,
  runtime: PiExtensionRuntime = {},
): void {
  // Stdout belongs to the Pi host (rpc/json modes stream protocol on it, and the TUI
  // renders none of it), so a library-level logger.warning written with console.log is
  // both invisible and potentially corrupting. Redirect once at registration; not
  // restored, because the extension lives for the whole session.
  redirectConsoleToStderr();

  const daemons = new Map<string, Daemon>();
  const daemonFailures = new Map<string, string>();
  // Negative cache: when a daemon can't be reached, remember the failure for a
  // short window so we don't pay the full 8s spawn-and-poll on every call in a
  // repo that simply isn't analyzed yet. Transient failures recover after TTL.
  const failedUntil = new Map<string, number>();
  const DAEMON_RETRY_COOLDOWN_MS = 30_000;
  const configHinted = new Set<string>();
  // Footer status state (spec: PiStatusReportsFunctionalReadiness). Keyed by cwd like the daemon
  // cache. No ExtensionContext is ever stored: each update uses the ctx of the event it handles.
  const daemonViews = new Map<string, PiDaemonView>();
  const healthCache = new Map<string, { key: string; health: HealthResult }>();
  const readHealth = runtime.readHealth ?? defaultHealthReader;
  const readWatcher = runtime.readWatcher ?? readWatcherState;
  const resolveDaemon = runtime.resolveDaemon ?? ((cwd: string) => ensureDaemonResult(cwd));
  const restartDaemon = runtime.restartDaemon
    ?? ((cwd: string, preset?: string, expect?: { pid: number; version: string }) =>
      restartPiDaemon(cwd, { preset, expect }));
  // Background work may outlive the event that started it. A generation makes those continuations
  // harmless after shutdown or session replacement without retaining an ExtensionContext globally.
  let sessionGeneration = 0;
  let sessionActive = false;
  // Tool-surface state for the current session (spec: PiToolGroupsAreActivatable).
  // hostExcluded: OpenLore tools the host had turned off before the surface was applied.
  // suppressed: tools this extension turned off, so a later session_start does not
  // mistake them for host exclusions.
  let hostExcluded = new Set<string>();
  let suppressed = new Set<string>();
  const hostSupportsActiveTools = (): boolean =>
    typeof pi.getActiveTools === 'function' && typeof pi.setActiveTools === 'function';
  // Pi's tool_search is user-enabled. Read its settings/CLI selection here: runtime actions such
  // as getActiveTools() are unavailable while extensions load.
  const nativeToolSearchEnabled = hostSupportsActiveTools() && piToolSearchEnabledAtLoad(process.cwd());
  const deferSpecialistTools = nativeToolSearchEnabled && piToolSurfaceAtLoad(process.cwd()) !== 'all';
  const toolExposure = (name: string): 'direct' | 'deferred' =>
    deferSpecialistTools && !PI_SEARCH_TOOLS.includes(name) ? 'deferred' : 'direct';
  const isDirectOpenLoreTool = (name: string): boolean => {
    const unprefixed = name.startsWith(PI_TOOL_PREFIX) ? name.slice(PI_TOOL_PREFIX.length) : name;
    return !deferSpecialistTools || PI_SEARCH_TOOLS.includes(unprefixed);
  };
  async function applyToolSurface(cwd: string): Promise<void> {
    if (!hostSupportsActiveTools()) return; // older host: every tool stays active
    try {
      const active = pi.getActiveTools();
      const activeSet = new Set(active);
      const registered = piRegisteredToolNames();
      hostExcluded = new Set(registered.filter((name) => isDirectOpenLoreTool(name) && !activeSet.has(name) && !suppressed.has(name)));
      const configuredSurface = await piToolSurface(cwd);
      const surface: PiSessionToolSurface = nativeToolSearchEnabled && configuredSurface !== 'all'
        ? 'search'
        : configuredSurface;
      const next = piSessionActiveTools(surface, active, hostExcluded);
      const nextSet = new Set(next);
      suppressed = new Set(registered.filter((name) => !nextSet.has(name) && !hostExcluded.has(name)));
      pi.setActiveTools(next);
    } catch {
      // The host refused the change: every tool stays active, onboarding continues.
    }
  }
  // One in-flight resolution per cwd: the session-start warmup and any tool call that arrives
  // meanwhile share it instead of each spawning or probing the daemon.
  const pendingDaemons = new Map<string, Promise<Daemon | null>>();
  const automaticRecoveryAttempts = new Set<string>();
  const automaticRecoveryFailures = new Map<string, string>();
  async function getDaemon(cwd: string): Promise<Daemon | null> {
    const pending = pendingDaemons.get(cwd);
    if (pending) return pending;
    const cached = daemons.get(cwd);
    if (cached) return cached;
    if ((failedUntil.get(cwd) ?? 0) > Date.now()) return null;
    const resolving = resolveAndRecordDaemon(cwd).finally(() => pendingDaemons.delete(cwd));
    pendingDaemons.set(cwd, resolving);
    return resolving;
  }
  async function resolveAndRecordDaemon(cwd: string): Promise<Daemon | null> {
    const result = await resolveDaemon(cwd);
    if (result.daemon?.autoRecoverable && !automaticRecoveryAttempts.has(cwd)) {
      // A valid, repository-bound health response proves the daemon is older.
      // Replace it on first use after an update. The CLI stop refuses unverified
      // listeners, but /health carries no "supervised" marker, so it cannot tell a
      // host-supervised daemon from one Pi spawned: the host's spawn opt-out
      // (checked in restartPiDaemon) is the ONLY protection for a supervised daemon.
      automaticRecoveryAttempts.add(cwd);
      const recovered = await restartDaemon(cwd, result.daemon.restartPreset, result.daemon.restartExpect);
      if (recovered.daemon) {
        automaticRecoveryFailures.delete(cwd);
        return recordDaemonResult(cwd, recovered);
      }
      automaticRecoveryFailures.set(cwd, recovered.failure);
      // Nothing was launched: a spawn opt-out, unknown preset, or refused stop leaves the verified daemon in
      // place, so keep serving through it instead of reporting it absent.
      if (
        recovered.failureKind === 'spawn-disabled'
        || recovered.failureKind === 'stop'
        || recovered.failureKind === 'unknown-preset'
      ) {
        return recordDaemonResult(cwd, result);
      }
      return recordDaemonResult(cwd, recovered);
    }
    return recordDaemonResult(cwd, result);
  }
  function recordDaemonResult(cwd: string, result: EnsureDaemonResult): Daemon | null {
    daemonViews.set(cwd, piDaemonView(result));
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
  function dropDaemon(cwd: string): void {
    daemons.delete(cwd);
    daemonViews.set(cwd, 'unavailable');
  }
  function startKeepalive(): void {
    if (!sessionActive || keepalive || daemons.size === 0) return;
    keepalive = setInterval(() => {
      for (const [cwd, daemon] of daemons) {
        const headers = daemon.token ? { 'x-openlore-token': daemon.token } : undefined;
        void fetch(`${daemon.baseUrl}/health`, { headers, signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS), redirect: 'error' })
          .then((res) => { if (!res.ok) dropDaemon(cwd); })
          .catch(() => dropDaemon(cwd));
      }
    }, KEEPALIVE_MS);
    keepalive.unref?.(); // never keep the host process alive for the keepalive alone
  }

  /**
   * Recompute and show the footer status for this event's working tree (spec:
   * PiStatusFollowsTheSessionLifecycle). Never rejects: a status is advisory and must not fail the
   * event, the agent run, or a tool call.
   */
  async function refreshStatus(ctx: ExtensionContext): Promise<void> {
    try {
      if (!ctx.hasUI) return;
      const cwd = ctx.cwd;
      // No usable daemon cached (the cwd moved, or a daemon was dropped): resolve the same way a
      // tool call would, so the status reports this resolution, not a stale one. `getDaemon`
      // keeps its failure cooldown, so a failing daemon is not re-probed on every run.
      if (!daemons.has(cwd)) await getDaemon(cwd);
      const daemon = daemons.has(cwd) ? 'usable' : (daemonViews.get(cwd) ?? 'unavailable');
      let health: HealthResult | undefined;
      try {
        const key = await piHealthCacheKey(cwd, daemon);
        const cached = healthCache.get(cwd);
        if (cached && cached.key === key && cached.health.index !== 'building') {
          // The watcher can stop or restart without moving any artifact, so it is never cached.
          health = daemon === 'usable' ? { ...cached.health, watcher: await readWatcher(cwd) } : cached.health;
        } else {
          health = await readHealth(cwd);
          healthCache.set(cwd, { key, health });
        }
      } catch {
        healthCache.delete(cwd);
        health = undefined;
      }
      // Read fresh every time, like the watcher: a review moves no index artifact.
      const unreviewed = await countUnreviewedDecisions(cwd);
      setPiStatus(ctx, formatPiStatus({ daemon, ...(health ? { health } : {}), unreviewed }));
    } catch {
      // Advisory only.
    }
  }

  /**
   * A tool answered `notReady` (an index being rebuilt, a lost publish, …): the footer was last
   * computed at session start or the previous agent run and may still say "ready". Re-read
   * health now, bypassing the cache, so the footer does not contradict the tool result.
   * Advisory: never rejects, and costs nothing on the ordinary (ready) path.
   */
  async function refreshStatusIfNotReady(result: unknown, ctx: ExtensionContext): Promise<void> {
    if (!result || typeof result !== 'object' || (result as { notReady?: unknown }).notReady !== true) return;
    healthCache.delete(ctx.cwd);
    await refreshStatus(ctx);
  }

  // ── B: navigation tools ──
  for (const tool of NAV_TOOLS) {
    pi.registerTool({
      name: `openlore_${tool.name}`,
      label: tool.label,
      description: tool.description,
      exposure: toolExposure(tool.name),
      promptSnippet: PI_TOOL_SNIPPETS[tool.name],
      promptGuidelines: [tool.guideline],
      parameters: tool.parameters as TSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const daemon = await getDaemon(ctx.cwd);
        if (!daemon) return toolResult(daemonUnavailable(ctx.cwd));
        let result: unknown;
        try {
          result = await callTool(daemon, tool.name, params as Record<string, unknown>, ctx.cwd, signal ?? undefined);
        } catch (err) {
          dropDaemon(ctx.cwd);
          return toolResult(
            `openlore daemon connection changed — ${err instanceof Error ? err.message : String(err)}. Retry the tool.`,
          );
        }
        // content[].text is sent to the LLM verbatim — keep the FULL structured
        // result so the model loses no detail. The compact human view is produced
        // separately in renderResult (display only). `details` carries the parsed
        // object so renderResult need not re-parse the JSON text.
        await refreshStatusIfNotReady(result, ctx);
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
    exposure: toolExposure('prepare_spec_generation'),
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
        await refreshStatusIfNotReady(result, ctx);
        return compositeToolResult(result);
      } catch (err) {
        dropDaemon(ctx.cwd);
        return toolResult(`openlore daemon connection changed — ${err instanceof Error ? err.message : String(err)}. Retry the tool.`);
      }
    },
  });

  pi.registerTool({
    name: 'openlore_prepare_spec_repair',
    label: 'openlore prepare spec repair',
    exposure: toolExposure('prepare_spec_repair'),
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
        await refreshStatusIfNotReady(result, ctx);
        return compositeToolResult(result);
      } catch (err) {
        dropDaemon(ctx.cwd);
        return toolResult(`openlore daemon connection changed — ${err instanceof Error ? err.message : String(err)}. Retry the tool.`);
      }
    },
  });

  // ── Config tool ──
  pi.registerTool({
    name: 'openlore_configure',
    label: 'openlore configure',
    exposure: toolExposure('configure'),
    description: 'Open the openlore configuration wizard for project settings or user-wide defaults (global: true).',
    promptSnippet: 'Configure openlore settings (provider, model, API key, embedding).',
    promptGuidelines: ['Use openlore_configure to change the LLM provider, model, or embedding settings.'],
    parameters: Type.Object({
      global: Type.Optional(Type.Boolean({ description: 'Edit user-wide defaults instead of project configuration.' })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return toolResult('Config wizard requires an interactive session (tui or rpc mode).');
      const global = (params as { global?: boolean }).global === true;
      const loaded = await loadExistingConfig(ctx.cwd, global ? 'global' : 'project');
      if (loaded.state === 'invalid') {
        return toolResult(`Configuration not changed: ${loaded.detail}. Repair the indicated config file and retry.`);
      }
      await runConfigWizard(ctx, loaded.state === 'valid' ? loaded.config : null, { afterAnalyze: refreshStatus, global });
      return toolResult(`Configuration wizard closed. Target: ${global ? globalOpenLoreConfigPath() : '.openlore/config.json'}.`);
    },
  });

  // ── Tool-group activator ──
  pi.registerTool({
    name: PI_ACTIVATOR_TOOL,
    label: 'openlore activate tools',
    exposure: toolExposure('activate_tools'),
    description: piActivatorDescription(),
    promptSnippet: 'Turn on more openlore tools by group or by tool name.',
    promptGuidelines: [
      'When you need an openlore tool that is not in your tool list (including one named in an openlore result), call openlore_activate_tools with its group or tool name first.',
    ],
    parameters: Type.Object({
      names: Type.Array(Type.String(), {
        minItems: 1,
        description: `REQUIRED. Group names (${Object.keys(PI_TOOL_GROUPS).join(', ')}) or tool names, e.g. ["specs"] or ["check_spec_drift"].`,
      }),
    }),
    async execute(_id, params) {
      if (!hostSupportsActiveTools()) return toolResult('Every openlore tool is already active in this Pi version.');
      const { names } = params as { names: string[] };
      const plan = planPiToolActivation(names, pi.getActiveTools(), hostExcluded);
      if (!plan.ok) return toolResult(plan.error, plan);
      if (plan.activated.length > 0) pi.setActiveTools(plan.nextActive);
      for (const name of plan.activated) suppressed.delete(name);
      const summary = {
        activated: plan.activated,
        alreadyActive: plan.alreadyActive,
        hostExcluded: plan.hostExcluded,
        note: plan.activated.length > 0 ? 'Activated tools are available from your next step.' : 'No tool state changed.',
      };
      return toolResult(JSON.stringify(summary, null, 2), summary);
    },
  });

  // ── /configure slash command ──
  pi.registerCommand('openlore', {
    description: 'Configure OpenLore (configure [--global]) or restart its daemon (restart)',
    async handler(args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify('Config wizard requires an interactive session.', 'error');
        return;
      }
      if (args.trim() === 'restart') {
        if (!ctx.isIdle()) {
          ctx.ui.notify('Wait for the current agent turn to finish before restarting OpenLore.', 'warning');
          return;
        }
        const cwd = ctx.cwd;
        if (pendingDaemons.has(cwd)) {
          ctx.ui.notify('OpenLore daemon startup or restart is already in progress; retry shortly.', 'info');
          return;
        }
        dropDaemon(cwd);
        failedUntil.delete(cwd);
        healthCache.delete(cwd);
        automaticRecoveryAttempts.delete(cwd);
        automaticRecoveryFailures.delete(cwd);
        setPiStatus(ctx, formatPiStatus({ daemon: 'connecting' }));
        ctx.ui.notify('Restarting the OpenLore daemon for this project…', 'info');
        const restarting = restartDaemon(cwd)
          .then((result) => recordDaemonResult(cwd, result))
          .finally(() => pendingDaemons.delete(cwd));
        pendingDaemons.set(cwd, restarting);
        try {
          const daemon = await restarting;
          ctx.ui.notify(
            daemon?.incompatibility ?? (daemon ? 'OpenLore daemon restarted.' : daemonUnavailable(cwd)),
            daemon && isUsableDaemon(daemon) ? 'info' : 'error',
          );
        } catch {
          ctx.ui.notify('OpenLore daemon restart failed; inspect .openlore/serve.log and retry.', 'error');
        }
        await refreshStatus(ctx);
        return;
      }
      const global = args.trim() === 'configure --global';
      if (args.trim() && args.trim() !== 'configure' && !global) {
        ctx.ui.notify('Usage: /openlore configure [--global] | /openlore restart', 'error');
        return;
      }
      const loaded = await loadExistingConfig(ctx.cwd, global ? 'global' : 'project');
      if (loaded.state === 'invalid') {
        ctx.ui.notify(`Configuration not changed: ${loaded.detail}. Repair the indicated config file and retry.`, 'error');
        return;
      }
      await runConfigWizard(ctx, loaded.state === 'valid' ? loaded.config : null, { afterAnalyze: refreshStatus, global });
    },
  });

  // ── session_start: tool surface + onboarding + daemon warmup ──
  pi.on('session_start', async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const generation = ++sessionGeneration;
    sessionActive = true;
    // Lean tool surface first, in every mode (spec: PiDefaultToolSurfaceIsLean).
    await applyToolSurface(ctx.cwd);

    if (ctx.hasUI) {
      const loaded = await loadExistingConfig(ctx.cwd);
      if (loaded.state === 'absent' && !configHinted.has(ctx.cwd)) {
        configHinted.add(ctx.cwd);
        ctx.ui.notify('OpenLore is not configured for this project — run /openlore configure (or /openlore configure --global for user-wide defaults).', 'info');
      } else if (loaded.state === 'invalid') {
        ctx.ui.notify(`OpenLore config not changed: ${loaded.detail}. Repair the indicated config file to configure it.`, 'warning');
      }
    }

    if (ctx.mode !== 'json' && ctx.mode !== 'print') {
      setPiStatus(ctx, formatPiStatus({ daemon: 'connecting' }));
      // Not awaited: a cold daemon start takes seconds, and the host waits for this handler
      // before the session is usable. Tool calls await the same resolution (see getDaemon).
      void warmDaemon(ctx, generation);
    }
  });

  // Session-start daemon warmup, run off the session_start handler. Resolution failures surface
  // through the status and tool results, so nothing rejects here.
  async function warmDaemon(ctx: ExtensionContext, generation: number): Promise<void> {
    const daemon = await getDaemon(ctx.cwd).catch(() => null);
    if (!sessionActive || generation !== sessionGeneration) return;
    if (ctx.hasUI && daemon?.incompatibility) ctx.ui.notify(daemon.incompatibility, 'warning');
    const recoveryFailure = automaticRecoveryFailures.get(ctx.cwd);
    if (ctx.hasUI && recoveryFailure !== undefined) {
      automaticRecoveryFailures.delete(ctx.cwd);
      ctx.ui.notify(recoveryFailure, 'warning');
    }
    startKeepalive();
    await refreshStatus(ctx);
  }

  // Readiness can change during a run (an analysis finishes, the daemon dies), so each run ends
  // with a refresh. Cheap when nothing moved: a few stats against the cached key.
  pi.on('agent_end', async (_event: AgentEndEvent, ctx: ExtensionContext) => {
    await refreshStatus(ctx);
  });

  // Stop pinging when the session ends gracefully so the now-unused daemon can
  // idle out and free its RAM. (On a hard kill the interval dies with the host
  // process anyway — either way pings stop and the daemon reaps.)
  pi.on('session_shutdown', (_event: SessionShutdownEvent, ctx?: ExtensionContext) => {
    sessionActive = false;
    sessionGeneration += 1;
    if (keepalive) { clearInterval(keepalive); keepalive = undefined; }
    if (ctx) setPiStatus(ctx, undefined);
  });

  // ── C: context injection ──
  // Keep the repository-wide digest opt-in: it is repeated standing context, while the orient tool
  // provides task-specific evidence on demand. Proposal prompts get only a compact instruction.
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | void> => {
    if (ctx.mode === 'json' || ctx.mode === 'print') return;

    const blocks: string[] = [];
    if (await piContextMode(ctx.cwd) === 'full') {
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
      if (blocks.length === 0) {
        blocks.push('[openlore: no analysis found — run `openlore analyze` to enable structural context.]');
      }
    }

    const proposalPrompt = event.messageType === 'user' ? event.prompt : '';
    const proposalContext = proposalContextForPrompt(proposalPrompt, 'pi');
    if (proposalContext) blocks.push(proposalContext);

    if (blocks.length === 0) return;

    return { systemPrompt: event.systemPrompt + '\n\n' + blocks.join('\n\n') };
  });
}

/** Build an extension registration function with bounded runtime overrides. @internal */
export function createPiExtension(
  runtime: PiExtensionRuntime = {},
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
