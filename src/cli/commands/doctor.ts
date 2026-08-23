/**
 * openlore doctor command
 *
 * Self-diagnostic tool that checks all prerequisites and surfaces actionable
 * fixes when something is misconfigured or missing.
 */

import { Command } from 'commander';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { withRelaxedTls } from '../../core/services/tls-scope.js';
import { access, stat, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger.js';
import { palette } from '../../utils/colors.js';
import {
  InvalidOpenLoreConfigError,
  readOpenLoreConfig,
  normalizeOpenLoreConfig,
  resolveOpenLoreConfigPath,
} from '../../core/services/config-manager.js';
import { validateOpenLoreConfig } from '../../core/services/config-schema.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { createLLMService, ProviderName } from '../../core/services/llm-service.js';
import { isSqliteAvailable } from '../node-version-guard.js';
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
import {
  refuseRepoConfiguredEndpoint,
  rejectRepoConfiguredTlsOptOut,
  resolveTrustedCompatBase,
  resolveTrustedSslVerify,
} from '../../core/services/repo-config-trust.js';
import { describeExclusions, totalExcluded, type ParseHealthReport } from '../../core/analyzer/parse-health.js';
import { describeMemoryDegradation } from '../../core/analyzer/memory-strategy.js';
import type { GovernanceFinding } from '../../core/services/mcp-handlers/enforcement-policy.js';
import { detectCorpusIntegrity } from '../../core/decisions/corpus-integrity.js';
import { detectInjectionShapes, INJECTION_SHAPE_LIMITS } from '../../core/services/served-content.js';
import { redactSecretTextWithKnownValues } from '../../core/services/secret-redaction.js';
import {
  hookManagerWarning,
  isResolvedGitRepository,
  resolveGitHookTarget,
} from '../git-hooks.js';

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

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
  remediation?: Remediation;
  findings?: GovernanceFinding[];
}

const DOCTOR_CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_COMPAT_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'EMBED_API_KEY',
] as const;

async function knownDoctorCredentials(rootPath: string): Promise<string[]> {
  const values = DOCTOR_CREDENTIAL_ENV_VARS.flatMap(name => process.env[name] ? [process.env[name]!] : []);
  try {
    const config = await readOpenLoreConfig(rootPath);
    if (config?.embedding?.apiKey) values.push(config.embedding.apiKey);
  } catch {
    // A malformed config is already reported by its check; environment credentials
    // still cross the redaction boundary below.
  }
  return values;
}

function redactDoctorResults(checks: CheckResult[], knownCredentials: readonly string[]): CheckResult[] {
  return checks.map(check => ({
    ...check,
    detail: redactSecretTextWithKnownValues(check.detail, knownCredentials).value,
    ...(check.fix === undefined
      ? {}
      : { fix: redactSecretTextWithKnownValues(check.fix, knownCredentials).value }),
  }));
}

// ============================================================================
// INDIVIDUAL CHECKS
// ============================================================================

async function checkNodeVersion(): Promise<CheckResult> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const min = `${MIN_NODE_MAJOR_VERSION}.${MIN_NODE_MINOR_VERSION}`;
  const versionOk =
    major > MIN_NODE_MAJOR_VERSION ||
    (major === MIN_NODE_MAJOR_VERSION && minor >= MIN_NODE_MINOR_VERSION);
  // Probe the capability itself, not just the version number: a Node whose version
  // satisfies the floor but on which `node:sqlite` is not loadable (e.g. 23.0–23.3,
  // or a stripped distro build) must not be blessed as `ok`.
  const sqliteOk = isSqliteAvailable();
  if (versionOk && sqliteOk) {
    return { name: 'Node.js version', status: 'ok', detail: `v${process.versions.node}` };
  }
  if (!sqliteOk) {
    return {
      name: 'Node.js version',
      status: 'fail',
      detail: `v${process.versions.node} — node:sqlite unavailable on this Node`,
      fix: `Switch to Node ${min}+ (\`nvm use ${MIN_NODE_MAJOR_VERSION}\`) or install from https://nodejs.org/ — node:sqlite must be available without runtime flags or the MCP server will crash at first import`,
    };
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

const OPENLORE_PRE_COMMIT_MARKER = /# openlore-(?:enforcement|decisions|drift|blast-radius|impact-certificate)-hook/;

/** Verify that an installed OpenLore gate is on Git's active, executable hook path. */
export async function checkHookReachability(rootPath: string): Promise<CheckResult> {
  const target = await resolveGitHookTarget(rootPath, 'pre-commit');
  if (!(await isResolvedGitRepository(rootPath, target))) {
    return { name: 'Git hook reachability', status: 'ok', detail: 'not a Git repository; no hook to check' };
  }

  let activeContent = '';
  try { activeContent = await readFile(target.hookPath, 'utf-8'); } catch { /* absent */ }
  if (OPENLORE_PRE_COMMIT_MARKER.test(activeContent)) {
    try {
      await access(target.executionPath, fsConstants.X_OK);
      return {
        name: 'Git hook reachability',
        status: 'ok',
        detail: target.executionPath === target.hookPath
          ? `OpenLore gate is installed and executable at ${target.hookPath}`
          : `OpenLore gate is installed at ${target.hookPath} and reachable through ${target.executionPath}`,
      };
    } catch {
      return {
        name: 'Git hook reachability',
        status: 'warn',
        detail: `OpenLore gate is installed at ${target.hookPath} but Git cannot execute ${target.executionPath}`,
        fix: target.manager
          ? hookManagerWarning(target, 'openlore enforce --hook')
          : `Run chmod +x ${JSON.stringify(target.executionPath)}`,
      };
    }
  }

  const legacyPath = join(rootPath, '.git', 'hooks', 'pre-commit');
  if (legacyPath !== target.hookPath) {
    try {
      const shadowed = await readFile(legacyPath, 'utf-8');
      if (OPENLORE_PRE_COMMIT_MARKER.test(shadowed)) {
        return {
          name: 'Git hook reachability',
          status: 'warn',
          detail: `OpenLore gate is installed but unreachable at ${legacyPath}; Git uses ${target.effectiveHooksDir}`,
          fix: target.canInstall
            ? 'Re-run the OpenLore hook installer so it writes to the effective hooks directory'
            : hookManagerWarning(target, 'openlore enforce --hook'),
        };
      }
    } catch { /* no shadowed legacy hook */ }
  }

  if (!target.canInstall) {
    return {
      name: 'Git hook reachability',
      status: 'warn',
      detail: `No reachable OpenLore gate is wired through ${target.manager}`,
      fix: hookManagerWarning(target, 'openlore enforce --hook'),
    };
  }
  return { name: 'Git hook reachability', status: 'ok', detail: 'No OpenLore Git gate installed (optional)' };
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
  } catch (error) {
    if (error instanceof InvalidOpenLoreConfigError) {
      return {
        name: 'openlore config',
        status: 'fail',
        detail: error.message,
        fix: `Correct the named keys in ${shown}, or re-run 'openlore init'`,
      };
    }
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
 * appear as one structured check. Clean/absent configs report ok; unusable configs also
 * make `checkConfig` fail through the same validator-backed read boundary.
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
  const normalized = normalizeOpenLoreConfig(parsed);
  const findings = [...normalized.findings, ...validateOpenLoreConfig(normalized.config)];
  if (findings.length === 0) {
    return { name: 'Config schema', status: 'ok', detail: 'all required fields present and all declared fields well-typed' };
  }
  const missing = findings.filter(f => f.kind === 'missing-required');
  const backfilled = findings.filter(f => f.kind === 'default-added');
  const other = findings.filter(f => f.kind !== 'missing-required' && f.kind !== 'default-added');
  const parts = [
    ...(missing.length > 0
      ? [`missing required keys: ${missing.map(f => f.key).join(', ')} — re-run 'openlore init'`]
      : []),
    ...(backfilled.length > 0
      ? [`using compatibility defaults: ${backfilled.map(f => f.message).join('; ')}`]
      : []),
    ...other.slice(0, 3).map(f => f.message),
  ];
  const undisclosed = Math.max(0, other.length - 3);
  const summary = parts.join('; ');
  const more = undisclosed > 0 ? ` (+${undisclosed} more)` : '';
  return {
    name: 'Config schema',
    status: 'warn',
    detail: `${findings.length} config finding(s): ${summary}${more}`,
    fix: missing.length > 0 || other.length > 0
      ? `Edit ${OPENLORE_CONFIG_REL_PATH} to correct the key(s), or re-run 'openlore init'`
      : `Add the listed default key(s) to ${OPENLORE_CONFIG_REL_PATH} to silence this compatibility warning`,
  };
}

/**
 * Diagnose instruction-shaped text at the human-review boundary. By default we
 * inspect locally recorded memory plus changed spec/decision files; already
 * reviewed corpus content is not re-litigated on every doctor run.
 */
export async function checkServedContentTrust(
  rootPath: string,
  explicitFiles?: string[],
): Promise<CheckResult> {
  const candidates = new Set<string>(explicitFiles ?? [
    join(OPENLORE_DIR, 'memory', 'notes.json'),
    join(OPENLORE_DIR, 'decisions', 'pending.json'),
  ]);
  if (!explicitFiles) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        { cwd: rootPath },
      );
      for (const record of stdout.split('\0')) {
        if (record.length < 4) continue;
        const path = record.slice(3);
        if (path.startsWith('openspec/') && path.endsWith('.md')) {
          candidates.add(path);
        }
      }
    } catch {
      // Non-git roots still get the local-memory check.
    }
  }

  const findings: GovernanceFinding[] = [];
  for (const candidate of [...candidates].sort()) {
    let content: string;
    try { content = await readFile(join(rootPath, candidate), 'utf8'); } catch { continue; }
    for (const text of servedContentStrings(candidate, content)) {
      for (const match of detectInjectionShapes(text)) {
        findings.push({
          code: 'injection-shaped-content',
          severity: 'warning',
          source: 'doctor',
          subject: candidate,
          message: `${match.shape}: ${JSON.stringify(match.excerpt)}. ${INJECTION_SHAPE_LIMITS}`,
        });
      }
    }
  }

  if (findings.length === 0) {
    return {
      name: 'Served content trust',
      status: 'ok',
      detail: `no lexical injection shapes found. ${INJECTION_SHAPE_LIMITS}`,
    };
  }
  return {
    name: 'Served content trust',
    status: 'warn',
    detail: `${findings.length} advisory finding(s). ${INJECTION_SHAPE_LIMITS}`,
    findings,
    fix: 'Review the named content and its provenance; do not rewrite it automatically.',
  };
}

/** Validate the governance corpus as a closed typed graph. Read-only and offline. */
export async function checkCorpusIntegrity(rootPath: string): Promise<CheckResult> {
  try {
    const config = await readOpenLoreConfig(rootPath);
    const findings = await detectCorpusIntegrity(rootPath, { openspecPath: config?.openspecPath });
    if (findings.length === 0) {
      return {
        name: 'Corpus integrity',
        status: 'ok',
        detail: 'all declared governance references resolve',
      };
    }
    const errors = findings.filter((finding) => finding.severity === 'error').length;
    return {
      name: 'Corpus integrity',
      status: errors > 0 ? 'fail' : 'warn',
      detail: `${findings.length} finding(s): ${errors} graph error(s), ${findings.length - errors} advisory`,
      findings,
      fix: 'Repair the named corpus references; OpenLore never rewrites governance edges automatically.',
    };
  } catch (error) {
    return {
      name: 'Corpus integrity',
      status: 'warn',
      detail: `check unavailable: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Restore readable OpenSpec and .openlore decision/memory stores, then rerun doctor.',
    };
  }
}

/** JSON stores serve their string values, not their serialized line layout. */
function servedContentStrings(candidate: string, content: string): string[] {
  if (!candidate.endsWith('.json')) return [content];
  try {
    const values: string[] = [];
    const visit = (value: unknown): void => {
      if (typeof value === 'string') values.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(JSON.parse(content));
    return values;
  } catch {
    return [content];
  }
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
 *
 * Exclusions are read from the SAME record `analyze` reports from (change:
 * fix-analyze-native-abort-and-file-cost-budget), and via the same `describeExclusions` helper, so
 * this check cannot bless a repository whose analysis excluded files — the contradiction the
 * `EveryExcludedFileIsRecordedWithAReason` requirement exists to prevent.
 */
/** Exported for test: the exclusion-vs-degradation verdict must be pinned behaviorally. */
export async function checkParseHealth(rootPath: string): Promise<CheckResult> {
  const path = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_PARSE_HEALTH);
  try {
    const report = JSON.parse(await readFile(path, 'utf-8')) as ParseHealthReport;
    const excluded = describeExclusions(report);
    const excludedCount = totalExcluded(report);
    // A file the analyzer NEVER PARSED (size cap, budget) must not be counted as one that "parsed
    // with errors" — it is a different cause with a different remedy, and the grammar-bump advice
    // below would send the reader after the wrong subsystem entirely.
    const degradedByParse = Math.max(0, (report.totalDegradedFiles ?? 0) - excludedCount);
    // A repo analyzed under memory pressure shed the CFG/def-use overlay (and possibly LLM
    // deep-analysis breadth) — its coverage is REDUCED even when no file parsed with errors and
    // nothing was excluded. Disclose it so doctor cannot bless a false-clean degraded index.
    const memoryReduction = describeMemoryDegradation(report.memoryDegradation);
    if (degradedByParse === 0 && !excluded && !memoryReduction) {
      return { name: 'Parse health', status: 'ok', detail: 'no files parsed with errors' };
    }
    const langs = (report.byLanguage ?? [])
      .slice(0, 3)
      .map(l => `${l.language} (${l.degradedFiles})`)
      .join(', ');
    const parts: string[] = [];
    if (degradedByParse > 0) {
      parts.push(`${degradedByParse} file(s) parsed with errors — symbols/edges there are a lower bound: ${langs}`);
    }
    if (excluded) parts.push(`${excluded} — those files were not analyzed at all`);
    if (memoryReduction) parts.push(memoryReduction);
    const fixes: string[] = [];
    if (memoryReduction) {
      fixes.push(
        'give analyze a larger heap: --max-old-space-size or OPENLORE_HEAP_MB, or OPENLORE_FORCE_MEMORY_TIER=full if it fits; then re-run analyze',
      );
    }
    if (degradedByParse > 0) {
      // Only a genuine parse degradation points at a grammar; an exclusion points at cost or size.
      fixes.push(
        'Inspect via get_language_support; if this spiked after a grammar bump, revert or re-pin the tree-sitter-* dep',
      );
    } else if (excluded) {
      fixes.push('Raise or disable the per-file bound with OPENLORE_PARSE_BUDGET_MS, or exclude the file from analysis');
    }
    return {
      name: 'Parse health',
      status: 'warn',
      detail: parts.join('; '),
      fix: fixes.join('; '),
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

const CLI_PROVIDERS: Record<string, () => string> = {
  'claude-code': () => 'claude',
  'codex-cli': () => process.env.CODEX_CLI ?? 'codex',
  'gemini-cli': () => process.env.GEMINI_CLI ?? 'gemini',
  'antigravity-cli': () => process.env.ANTIGRAVITY_CLI ?? 'agy',
  'cursor-agent': () => process.env.CURSOR_AGENT_CLI ?? 'cursor-agent',
  'mistral-vibe': () => process.env.MISTRAL_VIBE_CLI ?? 'vibe',
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
    'codex-cli': 'codex-cli',
    'mistral-vibe': 'mistral-vibe',
    'gemini-cli': 'gemini-cli',
    'antigravity-cli': 'antigravity-cli',
    'cursor-agent': 'cursor-agent',
  };
  const model = gen?.model ?? defaultModels[provider] ?? provider;

  // CLI-based providers: just check binary availability
  if (provider in CLI_PROVIDERS) {
    const bin = CLI_PROVIDERS[provider]();
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

  // A repo-supplied TLS opt-out is refused here as it is on every other LLM path:
  // `doctor` runs against a clone just like `generate` does.
  const sslVerify = resolveTrustedSslVerify(undefined, config?.llm?.sslVerify);
  rejectRepoConfiguredTlsOptOut('generation.skipSslVerify', gen?.skipSslVerify);

  const baseUrl = provider === 'openai-compat'
    ? resolveTrustedCompatBase(
        process.env.OPENAI_COMPAT_BASE_URL,
        gen?.openaiCompatBaseUrl,
      )
    : undefined;

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

  // Environment configuration is operator-authorized. A repository-selected remote
  // endpoint is refused here just as it is in the normal embedding path: `doctor`
  // must not become a credential-exfiltration side channel.
  const envBaseUrl = process.env.EMBED_BASE_URL;
  const baseUrl = envBaseUrl ?? refuseRepoConfiguredEndpoint(
    'embedding.baseUrl',
    emb?.baseUrl,
    'The doctor embedding check is skipped; search/orient still use BM25.',
  );
  if (!baseUrl) return null; // Embedding not configured — keyword default; skip

  // Refused, not honoured: this value comes from the analyzed repo's config.
  rejectRepoConfiguredTlsOptOut('embedding.skipSslVerify', emb?.skipSslVerify);

  const apiKey = emb?.apiKey ?? process.env.EMBED_API_KEY ?? 'none';
  const model = emb?.model ?? process.env.EMBED_MODEL ?? 'text-embedding-ada-002';
  const url = baseUrl.replace(/\/$/, '');

  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOCTOR_TIMEOUT_MS);
    const response = await withRelaxedTls(() => fetch(`${url}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: 'ping' }),
      signal: controller.signal,
    })).finally(() => clearTimeout(timeout));

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
  console.log(`  ${icon}  ${safe(r.name).padEnd(22)} ${c.dim(safe(r.detail))}`);
  for (const finding of r.findings ?? []) {
    console.log(`       ${' '.repeat(22)} ${c.yellow(`→ ${safe(finding.subject)}: ${safe(finding.message)}`)}`);
  }
  if (r.fix) {
    console.log(`       ${' '.repeat(22)} ${c.yellow(`→ ${safe(r.fix)}`)}`);
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
  • Governance corpus reference integrity
  • Injection-shaped unreviewed content (lexical advisory; never a guarantee)
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
        checkHookReachability(rootPath),
        checkConfig(rootPath),
        checkConfigSchema(rootPath),
        checkAnalysis(rootPath),
        checkGraphStore(rootPath),
        checkParseHealth(rootPath),
        checkOpenSpecDir(rootPath),
        checkCorpusIntegrity(rootPath),
        checkServedContentTrust(rootPath),
        checkDiskSpace(rootPath),
      ]),
      checkMcpWiring(rootPath),
      checkLLMConnection(rootPath),
      checkEmbeddingConnection(rootPath),
    ]);

    const unredactedChecks = [
      ...staticChecks,
      ...(mcpCheck ? [mcpCheck] : []),
      llmCheck,
      ...(embeddingCheck ? [embeddingCheck] : []),
    ];
    // One shared output boundary covers human and JSON rendering. Provider error
    // bodies are attacker-controlled and may reflect the exact credential they
    // received, including test/local keys that have no recognizable token shape.
    const checks = redactDoctorResults(unredactedChecks, await knownDoctorCredentials(rootPath));

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
      // `reExtract` too, so this runs exactly the `analyze --force` it printed. This is the
      // operator's repair path: if the graph is wrong BECAUSE the extraction cache is wrong,
      // a run that reuses that cache cannot fix it (change: optimize-hash-keyed-analyze).
      await openloreAnalyze({ rootPath, force: true, reExtract: true });
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
