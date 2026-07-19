/**
 * openlore doctor command
 *
 * Self-diagnostic tool that checks all prerequisites and surfaces actionable
 * fixes when something is misconfigured or missing.
 */

import { Command } from 'commander';
import { access, stat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger.js';
import { palette } from '../../utils/colors.js';
import { readOpenLoreConfig, resolveOpenLoreConfigPath } from '../../core/services/config-manager.js';
import { validateOpenLoreConfig } from '../../core/services/config-schema.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { createLLMService, ProviderName } from '../../core/services/llm-service.js';
import {
  MIN_NODE_MAJOR_VERSION,
  MIN_NODE_MINOR_VERSION,
  ANALYSIS_AGE_WARNING_HOURS,
  MIN_DISK_SPACE_FAIL_MB,
  MIN_DISK_SPACE_WARN_MB,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_CONFIG_REL_PATH,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  ARTIFACT_REPO_STRUCTURE,
  ARTIFACT_PARSE_HEALTH,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_COMPAT_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_COPILOT_MODEL,
} from '../../constants.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// TYPES
// ============================================================================

type CheckStatus = 'ok' | 'warn' | 'fail';

/**
 * A machine-readable remediation for a check `--fix` can execute (change:
 * make-index-self-healing). Present ONLY on checks whose printed `fix:` hint maps
 * to a safe, in-process action, so `--fix` runs exactly what a check surfaced and
 * nothing more. Internal — stripped from `--json` so the read-only output contract
 * is byte-compatible.
 */
type Remediation =
  | { kind: 'analyze'; label: string }
  | { kind: 'rewire-mcp'; label: string };

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
  remediation?: Remediation;
}

// ============================================================================
// INDIVIDUAL CHECKS
// ============================================================================

async function checkNodeVersion(): Promise<CheckResult> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const min = `${MIN_NODE_MAJOR_VERSION}.${MIN_NODE_MINOR_VERSION}`;
  const ok =
    major > MIN_NODE_MAJOR_VERSION ||
    (major === MIN_NODE_MAJOR_VERSION && minor >= MIN_NODE_MINOR_VERSION);
  if (ok) {
    return { name: 'Node.js version', status: 'ok', detail: `v${process.versions.node}` };
  }
  return {
    name: 'Node.js version',
    status: 'fail',
    detail: `v${process.versions.node} (requires >=${min} for node:sqlite)`,
    fix: `Switch to Node ${min}+ (\`nvm use ${MIN_NODE_MAJOR_VERSION}\`) or install from https://nodejs.org/ — a .nvmrc pinned to an older Node will crash the MCP server`,
  };
}

async function checkGit(rootPath: string): Promise<CheckResult> {
  const gitDir = join(rootPath, '.git');
  try {
    await access(gitDir);
  } catch {
    return {
      name: 'Git repository',
      status: 'warn',
      detail: 'No .git directory found',
      fix: "Run 'git init' — drift detection requires git",
    };
  }

  try {
    await execFileAsync('git', ['--version'], { cwd: rootPath });
    return { name: 'Git repository', status: 'ok', detail: 'Git repository detected' };
  } catch {
    return {
      name: 'Git repository',
      status: 'warn',
      detail: '.git found but git binary not on PATH',
      fix: 'Install git from https://git-scm.com/',
    };
  }
}

async function checkConfig(rootPath: string): Promise<CheckResult> {
  const configPath = resolveOpenLoreConfigPath(rootPath);
  // Report the path actually read: the relative form for the default in-repo
  // location, the real path when --config redirected it elsewhere (never a
  // hardcoded ".openlore/config.json" that would misname an explicit --config).
  const rel = relative(rootPath, configPath);
  const shown = rel && !rel.startsWith('..') ? rel : configPath;
  try {
    await access(configPath);
    const config = await readOpenLoreConfig(rootPath);
    if (!config) {
      return {
        name: 'openlore config',
        status: 'fail',
        detail: `${shown} exists but could not be parsed`,
        fix: `Delete ${shown} and run 'openlore init'`,
      };
    }
    return {
      name: 'openlore config',
      status: 'ok',
      detail: `${shown} (project: ${config.projectType})`,
    };
  } catch {
    return {
      name: 'openlore config',
      status: 'warn',
      detail: `${shown} not found`,
      fix: "Run 'openlore install' for one-command setup (wires your agent + builds the index), or 'openlore init' to configure manually",
    };
  }
}

/**
 * Config-schema check (change: add-config-schema-validation): surface unknown keys
 * (typo'd sections silently dropped today), type mismatches, and version skew in
 * `.openlore/config.json`. Reads the raw file and validates directly so the findings
 * appear as one structured check; advisory only (never fails), and clean/absent configs
 * report ok. Complements `checkConfig`, which only reports parse success.
 */
async function checkConfigSchema(rootPath: string): Promise<CheckResult> {
  const configPath = resolveOpenLoreConfigPath(rootPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf-8'));
  } catch {
    // No config, or unparseable JSON — checkConfig already reports both. Nothing to add.
    return { name: 'Config schema', status: 'ok', detail: 'no config to validate' };
  }
  const findings = validateOpenLoreConfig(parsed);
  if (findings.length === 0) {
    return { name: 'Config schema', status: 'ok', detail: 'all keys known and well-typed' };
  }
  const summary = findings.slice(0, 3).map(f => f.message).join('; ');
  const more = findings.length > 3 ? ` (+${findings.length - 3} more)` : '';
  return {
    name: 'Config schema',
    status: 'warn',
    detail: `${findings.length} config finding(s): ${summary}${more}`,
    fix: `Edit ${OPENLORE_CONFIG_REL_PATH} to correct the key(s), or re-run 'openlore init'`,
  };
}

async function checkAnalysis(rootPath: string): Promise<CheckResult> {
  const analysisPath = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_REPO_STRUCTURE);
  try {
    const s = await stat(analysisPath);
    const ageHours = (Date.now() - s.mtime.getTime()) / 3_600_000;
    const ageLabel = ageHours < 1 ? 'fresh' : `${ageHours.toFixed(1)}h old`;
    const status: CheckStatus = ageHours > ANALYSIS_AGE_WARNING_HOURS ? 'warn' : 'ok';
    return {
      name: 'Analysis artifacts',
      status,
      detail: `repo-structure.json exists (${ageLabel})`,
      fix: status === 'warn' ? "Run 'openlore analyze' to refresh stale analysis" : undefined,
      ...(status === 'warn'
        ? { remediation: { kind: 'analyze', label: 'openlore analyze --force' } as const }
        : {}),
    };
  } catch {
    return {
      name: 'Analysis artifacts',
      status: 'warn',
      detail: 'No analysis found — run openlore analyze first',
      fix: "Run 'openlore install' (one-command setup) or 'openlore analyze' to build the index",
      remediation: { kind: 'analyze', label: 'openlore analyze --force' },
    };
  }
}

/**
 * Graph-store lifecycle check (change: harden-index-store-lifecycle): a read never
 * destroys the index, so a schema-version mismatch or a quarantined (corrupt) store
 * persists until the next analyze. Surface it here with the recovery command instead of
 * leaving the user to wonder why graph tools return not-ready. Read-only: opens on the
 * non-destructive read path, which cannot mutate the store.
 */
async function checkGraphStore(rootPath: string): Promise<CheckResult> {
  const analysisDir = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  if (!EdgeStore.exists(analysisDir)) {
    return { name: 'Graph store', status: 'ok', detail: 'No graph index yet (build with openlore analyze)' };
  }
  const fixHint = "Run 'openlore analyze' to rebuild the graph index";
  const remediation = { kind: 'analyze', label: 'openlore analyze --force' } as const;
  let fault;
  try {
    const store = EdgeStore.open(EdgeStore.dbPath(analysisDir));
    fault = store.notReady;
    store.close();
  } catch (err) {
    return {
      name: 'Graph store',
      status: 'warn',
      detail: `graph index could not be opened (${err instanceof Error ? err.message : String(err)})`,
      fix: fixHint,
      remediation,
    };
  }
  if (fault) {
    return {
      name: 'Graph store',
      status: 'warn',
      detail:
        fault.reason === 'quarantined'
          ? `graph index was corrupt and quarantined${fault.quarantinePath ? ` to ${fault.quarantinePath}` : ''} — rebuild needed`
          : `graph index built by a different OpenLore (on-disk schema v${fault.onDiskVersion}) — rebuild needed`,
      fix: fixHint,
      remediation,
    };
  }
  return { name: 'Graph store', status: 'ok', detail: 'graph index opens cleanly at the current schema' };
}

/**
 * Parse-health check (change: add-parse-health-boundary-disclosure): surface files that parsed with
 * errors (grammar drift, syntax errors, lossy encoding) so a degraded index isn't mistaken for a
 * genuinely small one. Absent artifact → clean (ok). A spike after a `tree-sitter-*` bump is the
 * signal this check exists to catch.
 */
async function checkParseHealth(rootPath: string): Promise<CheckResult> {
  const path = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_PARSE_HEALTH);
  try {
    const report = JSON.parse(await readFile(path, 'utf-8')) as {
      totalDegradedFiles?: number;
      byLanguage?: Array<{ language: string; degradedFiles: number }>;
    };
    const n = report.totalDegradedFiles ?? 0;
    if (n === 0) return { name: 'Parse health', status: 'ok', detail: 'no files parsed with errors' };
    const langs = (report.byLanguage ?? [])
      .slice(0, 3)
      .map(l => `${l.language} (${l.degradedFiles})`)
      .join(', ');
    return {
      name: 'Parse health',
      status: 'warn',
      detail: `${n} file(s) parsed with errors — symbols/edges there are a lower bound: ${langs}`,
      fix: "Inspect via get_language_support; if this spiked after a grammar bump, revert or re-pin the tree-sitter-* dep",
    };
  } catch {
    // No artifact → nothing degraded (clean repos don't write it).
    return { name: 'Parse health', status: 'ok', detail: 'no files parsed with errors' };
  }
}

async function checkOpenSpecDir(rootPath: string): Promise<CheckResult> {
  // Read the *configured* openspecPath rather than assuming the default — a
  // project may point OpenLore at docs/specs/ or another root (Spec 26 B5).
  let configuredRoot = OPENSPEC_DIR;
  try {
    const config = await readOpenLoreConfig(rootPath);
    if (config?.openspecPath) configuredRoot = config.openspecPath;
  } catch {
    /* no config — fall back to the default */
  }
  const specsDir = join(rootPath, configuredRoot, OPENSPEC_SPECS_SUBDIR);
  const rel = `${configuredRoot.replace(/^\.\//, '').replace(/\/$/, '')}/${OPENSPEC_SPECS_SUBDIR}/`;
  try {
    await access(specsDir);
    return { name: 'OpenSpec directory', status: 'ok', detail: `${rel} exists` };
  } catch {
    return {
      name: 'OpenSpec directory',
      status: 'warn',
      detail: `${rel} not found`,
      fix: "Run 'openlore init' then 'openlore generate'",
    };
  }
}

/**
 * Claude Code loads MCP servers only from `.mcp.json` (project scope), never
 * from `.claude/settings.json`. A stale `mcpServers.openlore` in settings.json
 * (written by OpenLore <= 2.0.8) means the server silently never loads. Catch
 * that wrong-file wiring and point at the one-line fix. Returns null when there
 * is no Claude Code MCP wiring to check.
 */
async function checkMcpWiring(rootPath: string): Promise<CheckResult | null> {
  const readJson = async (rel: string): Promise<Record<string, unknown> | null> => {
    try {
      const parsed = JSON.parse(await readFile(join(rootPath, rel), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const hasOpenlore = (doc: Record<string, unknown> | null): boolean =>
    !!(doc?.mcpServers as Record<string, unknown> | undefined)?.openlore;

  const inSettings = hasOpenlore(await readJson('.claude/settings.json'));
  const inMcp = hasOpenlore(await readJson('.mcp.json'));

  if (inSettings && !inMcp) {
    return {
      name: 'MCP wiring',
      status: 'warn',
      detail: 'openlore MCP server is in .claude/settings.json, which Claude Code never reads for MCP',
      fix: "Run 'openlore install --agent claude-code --force' to move it to .mcp.json",
      remediation: { kind: 'rewire-mcp', label: 'openlore install --agent claude-code --force' },
    };
  }
  if (inSettings && inMcp) {
    return {
      name: 'MCP wiring',
      status: 'warn',
      detail: 'stale openlore entry still in .claude/settings.json (Claude Code reads .mcp.json)',
      fix: "Run 'openlore install --agent claude-code --force' to remove the stale entry",
      remediation: { kind: 'rewire-mcp', label: 'openlore install --agent claude-code --force' },
    };
  }
  if (inMcp) {
    return { name: 'MCP wiring', status: 'ok', detail: '.mcp.json registers the openlore MCP server' };
  }
  return null;
}

const CLI_PROVIDERS: Record<string, string> = {
  'claude-code': 'claude',
  'gemini-cli': 'gemini',
  'cursor-agent': 'cursor',
  'mistral-vibe': 'vibe',
};

const DOCTOR_TIMEOUT_MS = 10_000;

async function checkLLMConnection(rootPath: string): Promise<CheckResult> {
  let config;
  try { config = await readOpenLoreConfig(rootPath); } catch { /* no config */ }

  const gen = config?.generation;

  // Detect provider (mirrors generate.ts logic)
  const configuredProvider = gen?.provider;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const openaiCompatKey = process.env.OPENAI_COMPAT_API_KEY;
  const envDetectedProvider = anthropicKey ? 'anthropic'
    : geminiKey ? 'gemini'
    : openaiCompatKey ? 'openai-compat'
    : 'openai';
  const provider = configuredProvider ?? envDetectedProvider;

  const defaultModels: Record<string, string> = {
    anthropic: DEFAULT_ANTHROPIC_MODEL,
    gemini: DEFAULT_GEMINI_MODEL,
    'openai-compat': DEFAULT_OPENAI_COMPAT_MODEL,
    copilot: DEFAULT_COPILOT_MODEL,
    openai: DEFAULT_OPENAI_MODEL,
    'claude-code': 'claude-code',
    'mistral-vibe': 'mistral-vibe',
    'gemini-cli': 'gemini-cli',
    'cursor-agent': 'cursor-agent',
  };
  const model = gen?.model ?? defaultModels[provider] ?? provider;

  // CLI-based providers: just check binary availability
  if (provider in CLI_PROVIDERS) {
    const bin = CLI_PROVIDERS[provider];
    try {
      await execFileAsync(bin, ['--version']);
      return { name: 'LLM connection', status: 'ok', detail: `${provider} · ${bin} CLI detected` };
    } catch {
      return {
        name: 'LLM connection',
        status: 'warn',
        detail: `${provider} · '${bin}' not found on PATH`,
        fix: `Optional — only 'openlore generate' needs an LLM. Install the ${bin} CLI to enable it`,
      };
    }
  }

  // Apply SSL setting before creating provider
  const sslVerify = config?.llm?.sslVerify ?? true;
  if (!sslVerify || gen?.skipSslVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const baseUrl = gen?.openaiCompatBaseUrl ?? process.env.OPENAI_COMPAT_BASE_URL;

  let llm;
  try {
    llm = createLLMService({
      provider: provider as ProviderName,
      model,
      openaiCompatBaseUrl: baseUrl,
      sslVerify,
      timeout: DOCTOR_TIMEOUT_MS,
      disableResponseFormat: gen?.disableResponseFormat,
    });
  } catch (err) {
    return {
      name: 'LLM connection',
      status: 'warn',
      detail: `${provider} · ${(err as Error).message}`,
      fix: 'Optional — set the provider API key only if you use \'openlore generate\'',
    };
  }

  const t0 = Date.now();
  try {
    const result = await llm.complete({ systemPrompt: 'Reply with one word.', userPrompt: 'ping', maxTokens: 5 });
    const ms = Date.now() - t0;
    return {
      name: 'LLM connection',
      status: 'ok',
      detail: `${provider} · ${result.model ?? model} · ${ms}ms`,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = (err as Error).message ?? String(err);
    return {
      name: 'LLM connection',
      status: 'warn',
      detail: `${provider} · ${msg} (${ms}ms)`,
      fix: 'Optional — needed only for \'openlore generate\'. Check API key, base URL, and connectivity',
    };
  }
}

async function checkEmbeddingConnection(rootPath: string): Promise<CheckResult | null> {
  let config;
  try { config = await readOpenLoreConfig(rootPath); } catch { /* no config */ }

  const emb = config?.embedding;

  // Local provider: nothing to connect to. Confirm it's recognised (so a local
  // setup doesn't look like "no embeddings") rather than silently skipping.
  if (emb?.provider === 'local') {
    return {
      name: 'Embedding connection',
      status: 'ok',
      detail: `local on-device embedder · ${emb.model ?? 'default model'} · no endpoint/key (model cached under ~/.openlore/models)`,
    };
  }

  // Resolve base URL from config or env
  const baseUrl = emb?.baseUrl ?? process.env.EMBED_BASE_URL;
  if (!baseUrl) return null; // Embedding not configured — keyword default; skip

  if (emb?.skipSslVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const apiKey = emb?.apiKey ?? process.env.EMBED_API_KEY ?? 'none';
  const model = emb?.model ?? process.env.EMBED_MODEL ?? 'text-embedding-ada-002';
  const url = baseUrl.replace(/\/$/, '');

  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOCTOR_TIMEOUT_MS);
    const response = await fetch(`${url}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: 'ping' }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    const ms = Date.now() - t0;
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).trim() || '(empty)';
      return {
        name: 'Embedding connection',
        status: 'warn',
        detail: `HTTP ${response.status}: ${body} (${ms}ms)`,
        fix: 'Optional — search/orient fall back to BM25 without embeddings. Check the server URL, API key, and that it is running',
      };
    }
    const data = await response.json() as { data?: Array<{ embedding: number[] }> };
    const dims = data?.data?.[0]?.embedding?.length ?? '?';
    return {
      name: 'Embedding connection',
      status: 'ok',
      detail: `${url} · ${model} · ${dims} dims · ${ms}ms`,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = (err as Error).message ?? String(err);
    return {
      name: 'Embedding connection',
      status: 'warn',
      detail: `${url} · ${msg} (${ms}ms)`,
      fix: 'Optional — search/orient fall back to BM25. Start the embedding server (npm run embed:up) and check the URL',
    };
  }
}

async function checkDiskSpace(rootPath: string): Promise<CheckResult> {
  // Use df to check available space — best-effort, skip on unsupported platforms
  try {
    const { stdout } = await execFileAsync('df', ['-k', rootPath]);
    const lines = stdout.trim().split('\n');
    const dataLine = lines[lines.length - 1];
    const parts = dataLine.trim().split(/\s+/);
    // df -k: Filesystem  1K-blocks  Used  Available  Use%  Mounted-on
    const availableKB = Number(parts[3]);
    if (isNaN(availableKB)) {
      return { name: 'Disk space', status: 'ok', detail: 'Could not parse df output' };
    }
    const availableMB = Math.round(availableKB / 1024);
    if (availableMB < MIN_DISK_SPACE_FAIL_MB) {
      return {
        name: 'Disk space',
        status: 'fail',
        detail: `Only ${availableMB} MB available`,
        fix: `Free up disk space — analysis artifacts and vector index can use ${MIN_DISK_SPACE_FAIL_MB}–${MIN_DISK_SPACE_WARN_MB} MB`,
      };
    }
    if (availableMB < MIN_DISK_SPACE_WARN_MB) {
      return {
        name: 'Disk space',
        status: 'warn',
        detail: `${availableMB} MB available (low)`,
        fix: 'Consider freeing disk space before using --embed (vector index can be large)',
      };
    }
    return { name: 'Disk space', status: 'ok', detail: `${availableMB} MB available` };
  } catch {
    return { name: 'Disk space', status: 'ok', detail: 'Check skipped (df not available)' };
  }
}

// ============================================================================
// DISPLAY
// ============================================================================

function printResult(r: CheckResult, useColor: boolean): void {
  const c = palette(useColor);
  const paint: Record<CheckStatus, (s: string) => string> = {
    ok: (s) => c.green(s),
    warn: (s) => c.yellow(s),
    fail: (s) => c.red(s),
  };
  const glyph: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };

  const icon = paint[r.status](glyph[r.status]);
  console.log(`  ${icon}  ${r.name.padEnd(22)} ${c.dim(r.detail)}`);
  if (r.fix) {
    console.log(`       ${' '.repeat(22)} ${c.yellow(`→ ${r.fix}`)}`);
  }
}

// ============================================================================
// COMMAND
// ============================================================================

export const doctorCommand = new Command('doctor')
  .description('Check your environment and configuration for common issues')
  .addHelpText(
    'after',
    `
Examples:
  $ openlore doctor            Run all checks (read-only)
  $ openlore doctor --json     Output results as JSON
  $ openlore doctor --fix      Apply the printed remediations (confirms each in a TTY)
  $ openlore doctor --fix --yes  Apply every remediation non-interactively

Checks performed:
  • Node.js version (>=${MIN_NODE_MAJOR_VERSION}.${MIN_NODE_MINOR_VERSION} required for node:sqlite)
  • Git repository detection
  • openlore configuration (${OPENLORE_CONFIG_REL_PATH})
  • Config schema (unknown keys, type mismatches, version skew)
  • Analysis artifacts freshness
  • Graph store lifecycle (schema mismatch / quarantined index)
  • OpenSpec directory presence
  • MCP wiring (Claude Code reads .mcp.json, not .claude/settings.json)
  • LLM connection (live request with 10s timeout)
  • Embedding connection (if configured)
  • Available disk space
`
  )
  .option('--json', 'Output results as JSON', false)
  .option('--fix', 'Apply the remediations the checks printed (re-analyze, re-wire); TTY confirms each unless --yes', false)
  .option('--yes', 'With --fix, run every remediation non-interactively (no confirmation prompt)', false)
  .action(async (options: { json: boolean; fix: boolean; yes: boolean }) => {
    const rootPath = process.cwd();
    const useColor = process.stdout.isTTY && !options.json;

    if (!options.json) {
      logger.section('openlore doctor');
      console.log('');
    }

    const [staticChecks, mcpCheck, llmCheck, embeddingCheck] = await Promise.all([
      Promise.all([
        checkNodeVersion(),
        checkGit(rootPath),
        checkConfig(rootPath),
        checkConfigSchema(rootPath),
        checkAnalysis(rootPath),
        checkGraphStore(rootPath),
        checkParseHealth(rootPath),
        checkOpenSpecDir(rootPath),
        checkDiskSpace(rootPath),
      ]),
      checkMcpWiring(rootPath),
      checkLLMConnection(rootPath),
      checkEmbeddingConnection(rootPath),
    ]);

    const checks = [
      ...staticChecks,
      ...(mcpCheck ? [mcpCheck] : []),
      llmCheck,
      ...(embeddingCheck ? [embeddingCheck] : []),
    ];

    if (options.json) {
      // Strip the internal `remediation` field so the --json contract is
      // byte-compatible with pre-`--fix` output (bare doctor stays read-only).
      console.log(JSON.stringify(checks.map(({ remediation: _r, ...c }) => c), null, 2));
      return;
    }

    for (const result of checks) {
      printResult(result, useColor);
    }

    console.log('');

    const failures = checks.filter(c => c.status === 'fail');
    const warnings = checks.filter(c => c.status === 'warn');

    if (failures.length > 0) {
      const warnSuffix = warnings.length > 0 ? `, ${warnings.length} warning(s)` : '';
      logger.error(`${failures.length} check(s) failed${warnSuffix} — fix the failures above before proceeding`);
      process.exitCode = 1;
    } else if (warnings.length > 0) {
      // Summarize the checks that actually warned, not a hardcoded assumption
      // (a staleness warning must not read as "LLM/embeddings may be limited").
      const warned = warnings.map(w => w.name).join(', ');
      logger.warning(`${warnings.length} warning(s): ${warned} — see the details above`);
    } else {
      logger.success('All checks passed!');
    }
    console.log('');

    // --fix: execute exactly the remediations the read-only checks surfaced above,
    // nothing a check did not print (change: make-index-self-healing). Bare doctor
    // never reaches here, so its output is unchanged.
    if (options.fix) {
      await applyRemediations(rootPath, checks, options.yes);
    }
  });

/** Ask one yes/no question on a TTY. Resolves false when no TTY is attached. */
async function confirmTty(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Run the single in-process action a remediation maps to. Returns a status line. */
async function runRemediation(rootPath: string, r: Remediation): Promise<string> {
  switch (r.kind) {
    case 'analyze': {
      const { openloreAnalyze } = await import('../../api/analyze.js');
      await openloreAnalyze({ rootPath, force: true });
      return 'analysis rebuilt';
    }
    case 'rewire-mcp': {
      const { runInstall } = await import('../install/index.js');
      // Re-wire only — do NOT also re-analyze here (that is the 'analyze'
      // remediation's job, run separately if its own check surfaced it).
      await runInstall({ agent: 'claude-code', force: true, analyze: false, cwd: rootPath });
      return 'MCP wiring corrected (.mcp.json)';
    }
  }
}

/**
 * The deduped set of remediations `--fix` will run: only non-ok checks that
 * surfaced a machine-readable remediation, each action at most once (two checks
 * may both print "re-analyze"). Pure and exported so the "fixes exactly what it
 * printed, nothing else" contract is unit-testable without executing anything.
 */
export function planRemediations(
  checks: CheckResult[],
): Array<{ check: CheckResult; remediation: Remediation }> {
  const seen = new Set<string>();
  const queue: Array<{ check: CheckResult; remediation: Remediation }> = [];
  for (const c of checks) {
    if (c.status === 'ok' || !c.remediation) continue;
    if (seen.has(c.remediation.label)) continue;
    seen.add(c.remediation.label);
    queue.push({ check: c, remediation: c.remediation });
  }
  return queue;
}

/**
 * Execute the remediations attached to non-ok checks, one confirmation per mutating
 * action in a TTY (or all of them with --yes). Deduplicates repeated actions (two
 * checks may both print "re-analyze") so each runs at most once. Re-run bare doctor
 * afterward to confirm.
 */
async function applyRemediations(rootPath: string, checks: CheckResult[], yes: boolean): Promise<void> {
  const queue = planRemediations(checks);
  if (queue.length === 0) {
    logger.info('doctor --fix', 'Nothing to fix — no check surfaced an automatic remediation.');
    return;
  }

  logger.section('openlore doctor --fix');
  let applied = 0;
  let skipped = 0;
  for (const { check, remediation } of queue) {
    const proceed = yes
      ? true
      : await confirmTty(`Fix "${check.name}" — run \`${remediation.label}\`?`);
    if (!proceed) {
      skipped++;
      if (!process.stdin.isTTY && !yes) {
        logger.warning(`Skipped "${check.name}" — re-run with --yes to apply non-interactively.`);
      } else {
        logger.info('Skipped', check.name);
      }
      continue;
    }
    try {
      logger.discovery(`Applying: ${remediation.label}`);
      const outcome = await runRemediation(rootPath, remediation);
      logger.success(`Fixed "${check.name}" — ${outcome}.`);
      applied++;
    } catch (err) {
      logger.error(`Could not fix "${check.name}": ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
  console.log('');
  logger.info('doctor --fix', `${applied} applied, ${skipped} skipped. Re-run 'openlore doctor' to confirm.`);
}
