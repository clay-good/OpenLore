/**
 * openlore drift command
 *
 * Detects spec drift: finds code changes not reflected in specs.
 * Can be used standalone or as a pre-commit hook.
 */

import { Command } from 'commander';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { basename, join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { resolveTrustedApiBase, resolveTrustedSslVerify } from '../../core/services/repo-config-trust.js';
import { redirectConsoleToStderr } from '../../utils/quiet-stdout.js';
import { fileExists, formatDuration, parseList, resolveLLMProvider } from '../../utils/command-helpers.js';
import {
  DEFAULT_DRIFT_MAX_FILES,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_LOGS_SUBDIR,
  OPENLORE_CONFIG_REL_PATH,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  ARTIFACT_REPO_STRUCTURE,
} from '../../constants.js';
import type { DriftOptions, DriftIssue, DriftResult, DriftSeverity } from '../../types/index.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import {
  getChangedFiles,
  resolveBaseRefDisclosed,
  isGitRepositoryRoot,
  buildSpecMap,
  buildADRMap,
  detectDrift,
} from '../../core/drift/index.js';
import { suggestTestsForDrift } from '../../core/drift/test-suggester.js';
import { createLLMService } from '../../core/services/llm-service.js';
import { isLlmLoggingEnabled } from '../../core/services/llm-logging-policy.js';
import type { LLMService } from '../../core/services/llm-service.js';
import { resolveOpenspecDir } from '../../utils/openspec-dir.js';
import {
  displayHookPath,
  hookManagerWarning,
  isResolvedGitRepository,
  resolveGitHookTarget,
  resolveTrustedHookLauncher,
  shellQuote,
  updateHookFile,
} from '../git-hooks.js';

// ============================================================================
// TYPES
// ============================================================================

// DriftOptions (extends GlobalOptions) already has all fields including verbose

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function severityLabel(severity: DriftSeverity): string {
  switch (severity) {
    case 'error': return 'ERROR';
    case 'warning': return 'WARNING';
    case 'info': return 'INFO';
  }
}

function severityIcon(severity: DriftSeverity): string {
  switch (severity) {
    case 'error': return '✗';
    case 'warning': return '⚠';
    case 'info': return '→';
  }
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case 'gap': return 'gap';
    case 'stale': return 'stale';
    case 'uncovered': return 'uncovered';
    case 'orphaned-spec': return 'orphaned';
    case 'adr-gap': return 'adr-gap';
    case 'adr-orphaned': return 'adr-orphaned';
    case 'memory-drifted': return 'memory-drifted';
    case 'memory-orphaned': return 'memory-orphaned';
    default: return kind;
  }
}

function displayIssue(issue: DriftIssue, verbose: boolean): void {
  const icon = severityIcon(issue.severity);
  const sev = severityLabel(issue.severity);

  console.log('');
  console.log(`   ${icon} [${sev}] ${kindLabel(issue.kind)}: ${safe(issue.filePath)}`);

  if (issue.domain) {
    console.log(`      Spec: ${safe(issue.specPath ?? issue.domain)}`);
  }

  if (verbose || issue.severity === 'error') {
    console.log(`      ${issue.message}`);
  }

  if (issue.changedLines) {
    console.log(`      +${issue.changedLines.added}/-${issue.changedLines.removed} lines`);
  }

  console.log(`      -> ${issue.suggestion}`);
}

export function displaySummary(result: DriftResult): void {
  console.log('');
  console.log('   ──────────────────────────────────────');
  console.log('');
  console.log('   Summary:');

  const parts: string[] = [];
  if (result.summary.gaps > 0) parts.push(`Gaps: ${result.summary.gaps}`);
  if (result.summary.stale > 0) parts.push(`Stale: ${result.summary.stale}`);
  if (result.summary.uncovered > 0) parts.push(`Uncovered: ${result.summary.uncovered}`);
  if (result.summary.orphanedSpecs > 0) parts.push(`Orphaned: ${result.summary.orphanedSpecs}`);
  if (result.summary.adrGaps > 0) parts.push(`ADR gaps: ${result.summary.adrGaps}`);
  if (result.summary.adrOrphaned > 0) parts.push(`ADR orphaned: ${result.summary.adrOrphaned}`);
  if (result.summary.memoryDrifted > 0) parts.push(`Memory drifted: ${result.summary.memoryDrifted}`);
  if (result.summary.memoryOrphaned > 0) parts.push(`Memory orphaned: ${result.summary.memoryOrphaned}`);
  // Counted, never listed: these anchors drifted outside the code under review.
  // Naming the switch keeps the omission auditable rather than silent
  // (change: scope-advisory-noise-to-touched-code).
  if (result.summary.memoryOutOfScope > 0) {
    parts.push(
      `Memory drifted outside this change: ${result.summary.memoryOutOfScope} ` +
      `(not listed; --memory-scope repository to enumerate)`
    );
  }

  if (parts.length === 0) {
    console.log('     No issues found');
  } else {
    for (const part of parts) {
      console.log(`     ${part}`);
    }
  }

  console.log('');
}

// ============================================================================
// HOOK MANAGEMENT
// ============================================================================

const HOOK_MARKER = '# openlore-drift-hook';
type HookBlockLocation = { start: number; end: number };

function findDriftHookBlock(content: string): HookBlockLocation | { error: string } | null {
  const starts = [...content.matchAll(/^# openlore-drift-hook\r?$/gm)];
  const ends = [...content.matchAll(/^# end-openlore-drift-hook\r?$/gm)];
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index === undefined || ends[0].index === undefined) {
    return { error: 'the existing OpenLore drift block has malformed or duplicate markers' };
  }
  const start = starts[0].index;
  const endStart = ends[0].index;
  if (endStart <= start) return { error: 'the existing OpenLore drift block markers are out of order' };
  return { start, end: endStart + ends[0][0].length };
}

function terminalHookCommand(content: string): 'exit' | 'exec' | null {
  const executableLines = content.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
  const last = executableLines.at(-1) ?? '';
  if (/^exit(?:\s+[^#\s]+)?(?:\s+#.*)?$/.test(last)) return 'exit';
  if (/^exec(?:\s|$)/.test(last)) return 'exec';
  return null;
}

const SHELL_INTERPRETERS = new Set(['sh', 'ash', 'bash', 'dash', 'ksh', 'yash', 'zsh']);

function usesShellInterpreter(shebang: string): boolean {
  if (!shebang.startsWith('#!')) return true;
  const parts = shebang.slice(2).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  let interpreter = basename(parts[0]);
  if (interpreter === 'env') {
    let index = 1;
    while (parts[index]?.startsWith('-')) index++;
    interpreter = basename(parts[index] ?? '');
  }
  return SHELL_INTERPRETERS.has(interpreter);
}

const renderHookContent = (nodePath: string, cliPath: string) => `
${HOOK_MARKER}
OPENLORE_DRIFT_PREVIOUS_EXIT=$?
# Automatically check for spec drift before committing
# Installed by: openlore drift --install-hook

# Bound both runtime and captured output. A broken/skewed launcher is an
# infrastructure failure, never evidence of drift and never an unbounded commit hang.
if OPENLORE_DRIFT_OUTPUT=$(${shellQuote(nodePath)} -e '
const { spawn, spawnSync } = require("node:child_process");
const requestedCommand = process.argv[1];
const command = process.execPath;
const args = [requestedCommand, "drift", "--fail-on", "warning", "--json"];
const cap = 1024 * 1024;
const stdoutChunks = [];
const stderrChunks = [];
let stdoutBytes = 0;
let stderrBytes = 0;
let forcedReason = "";
let launchError = null;
const child = spawn(command, args, {
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const killTree = signal => {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-child.pid, signal); } catch { /* process already exited */ }
  }
};
let killTimer;
const stop = reason => {
  if (forcedReason) return;
  forcedReason = reason;
  killTree("SIGTERM");
  killTimer = setTimeout(() => killTree("SIGKILL"), 1000);
};
const timeout = setTimeout(() => stop("timed out after 60 seconds"), 60000);
child.stdout.on("data", chunk => {
  const remaining = Math.max(0, cap - stdoutBytes);
  if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
  stdoutBytes += chunk.length;
  if (stdoutBytes > cap) stop("exceeded the 1 MiB stdout limit");
});
child.stderr.on("data", chunk => {
  const remaining = Math.max(0, cap - stderrBytes);
  if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
  stderrBytes += chunk.length;
  if (stderrBytes > cap) stop("exceeded the 1 MiB stderr limit");
});
child.on("error", error => { launchError = error; });
child.on("close", code => {
  clearTimeout(timeout);
  // On POSIX, keep the group SIGKILL escalation alive after the leader closes:
  // a descendant may have ignored SIGTERM and detached its stdio. Windows taskkill
  // already applies /t /f to the full tree on the first termination request.
  if (killTimer && (process.platform === "win32" || !forcedReason)) clearTimeout(killTimer);
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (stderr) {
    const safeStderr = stderr.split(/\\r?\\n/).slice(0, 50).map(line => Array.from(line)
      .map(ch => { const code = ch.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159) ? " " : ch; })
      .join("").replace(/ +/g, " ").slice(0, 500)).join("\\n");
    process.stderr.write(safeStderr + (safeStderr ? "\\n" : ""));
  }
  if (stdout) process.stdout.write(stdout);
  if (forcedReason) console.error("openlore: drift launcher " + forcedReason);
  if (launchError) console.error("openlore: drift launcher failed: " + launchError.message);
  process.exitCode = forcedReason || launchError ? 2 : (Number.isInteger(code) ? code : 2);
});
' ${shellQuote(cliPath)}); then
  OPENLORE_DRIFT_EXIT=0
else
  OPENLORE_DRIFT_EXIT=$?
fi

if OPENLORE_DRIFT_VERDICT=$(printf '%s\n' "$OPENLORE_DRIFT_OUTPUT" | ${shellQuote(nodePath)} -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const d = JSON.parse(input);
    if (d && d.hasDrift === true) process.stdout.write("drift");
    else if (d && d.hasDrift === false) {
      const counts = [d.totalChangedFiles, d.analyzedFiles, d.filesOmitted, d.specRelevantFiles];
      const valid = counts.every(n => Number.isSafeInteger(n) && n >= 0) &&
        d.totalChangedFiles === d.analyzedFiles + d.filesOmitted &&
        d.specRelevantFiles <= d.analyzedFiles;
      process.stdout.write(valid ? (d.filesOmitted > 0 ? "incomplete:" + d.filesOmitted : "clean") : "invalid");
    } else process.stdout.write("invalid");
  } catch { process.stdout.write("invalid"); }
});
'); then
  :
else
  OPENLORE_DRIFT_VERDICT=invalid
fi

if [ "$OPENLORE_DRIFT_EXIT" -eq 1 ] && [ "$OPENLORE_DRIFT_VERDICT" = "drift" ]; then
  echo ""
  echo "openlore: Spec drift detected! Commit blocked."
  echo ""
  # Node is guaranteed by OpenLore. Sanitize repository-controlled strings
  # before printing them to a terminal and keep the summary bounded.
  printf '%s\n' "$OPENLORE_DRIFT_OUTPUT" | ${shellQuote(nodePath)} -e '
let input = "";
const safe = value => Array.from(String(value ?? ""))
  .map(ch => { const code = ch.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159) ? " " : ch; })
  .join("").replace(/ +/g, " ").slice(0, 240);
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const d = JSON.parse(input);
    const s = d && typeof d.summary === "object" ? d.summary : {};
    const fields = [["gaps", "gap(s)"], ["stale", "stale"], ["uncovered", "uncovered"],
      ["orphanedSpecs", "orphaned"], ["adrGaps", "ADR gap(s)"], ["adrOrphaned", "ADR orphaned"],
      ["memoryDrifted", "memory drifted"], ["memoryOrphaned", "memory orphaned"]];
    const parts = fields.filter(([key]) => Number.isFinite(s[key]) && s[key] > 0)
      .map(([key, label]) => String(s[key]) + " " + label);
    console.log("  Issues: " + parts.join(", "));
    const issues = Array.isArray(d.issues) ? d.issues : [];
    for (const issue of issues.slice(0, 5)) {
      console.log("  [" + safe(issue && issue.severity).toUpperCase() + "] " +
        safe(issue && issue.kind) + ": " + safe(issue && issue.filePath));
    }
    if (issues.length > 5) console.log("  ... and " + (issues.length - 5) + " more");
  } catch { /* The verdict parser already classified malformed output. */ }
});
' 2>/dev/null
  echo ""
  echo "  Run 'openlore drift' for full details."
  echo "  To skip this check: git commit --no-verify"
  echo ""
  exit 1
elif [ "$OPENLORE_DRIFT_EXIT" -eq 0 ] && [ "\${OPENLORE_DRIFT_VERDICT%%:*}" = "incomplete" ]; then
  OPENLORE_DRIFT_OMITTED=\${OPENLORE_DRIFT_VERDICT#incomplete:}
  echo ""
  echo "openlore: Spec drift could not be fully checked ($OPENLORE_DRIFT_OMITTED changed file(s) omitted); the drift check will not block this commit."
  echo "  Re-run with a larger --max-files value before relying on a no-drift result."
  echo ""
elif [ "$OPENLORE_DRIFT_EXIT" -ne 0 ] || [ "$OPENLORE_DRIFT_VERDICT" != "clean" ]; then
  echo ""
  echo "openlore: Spec drift could not be checked (exit $OPENLORE_DRIFT_EXIT); the drift check will not block this commit."
  echo "  See the error output above for the reason."
  echo ""
fi

# Preserve a failure from hook content that ran before OpenLore was appended.
if [ "$OPENLORE_DRIFT_PREVIOUS_EXIT" -ne 0 ]; then
  exit "$OPENLORE_DRIFT_PREVIOUS_EXIT"
fi
unset OPENLORE_DRIFT_PREVIOUS_EXIT OPENLORE_DRIFT_COMMAND OPENLORE_DRIFT_OUTPUT
unset OPENLORE_DRIFT_EXIT OPENLORE_DRIFT_VERDICT OPENLORE_DRIFT_OMITTED
# end-openlore-drift-hook
`.trimStart();

export async function installPreCommitHook(rootPath: string): Promise<void> {
  const target = await resolveGitHookTarget(rootPath, 'pre-commit');
  const hookPath = target.hookPath;

  if (!(await isResolvedGitRepository(rootPath, target))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 2;
    return;
  }
  if (!target.canInstall) {
    logger.warning(hookManagerWarning(target, 'openlore drift --fail-on warning --quiet'));
    return;
  }
  const launcher = await resolveTrustedHookLauncher(rootPath);
  if (!launcher) { logger.error('Cannot pin an OpenLore installation outside this repository. Install OpenLore globally and retry.'); process.exitCode = 2; return; }
  const hookContent = renderHookContent(launcher.node, launcher.cli);

  let updated = false;
  let appended = false;
  let incompatibleReason: string | null = null;
  const result = await updateHookFile(hookPath, (existing) => {
    if (existing !== null) {
      const shebang = existing.split(/\r?\n/, 1)[0];
      if (!usesShellInterpreter(shebang)) {
        incompatibleReason = `the existing hook uses a non-shell interpreter (${shebang})`;
        return null;
      }
    }
    if (existing !== null) {
      const block = findDriftHookBlock(existing);
      if (block && 'error' in block) {
        incompatibleReason = block.error;
        return null;
      }
      if (block) {
        updated = true;
        return existing.slice(0, block.start) + hookContent.trimEnd() + existing.slice(block.end);
      }
    }
    appended = existing !== null;
    const terminal = existing ? terminalHookCommand(existing) : null;
    if (terminal) {
      incompatibleReason = `the existing hook ends with an unconditional ${terminal}, so appended checks would be unreachable`;
      return null;
    }
    return existing
      ? existing.trimEnd() + '\n\n' + hookContent
      : '#!/bin/sh\n\n' + hookContent;
  });
  if (result.status === 'unavailable') {
    logger.warning(`Cannot install the drift hook at ${displayHookPath(hookPath)}: ${result.reason}`);
    return;
  }
  if (incompatibleReason) {
    logger.warning(`Cannot install the drift hook automatically: ${incompatibleReason}. Add "openlore drift --fail-on warning" to the hook manager manually.`);
    return;
  }
  if (updated) {
    logger.success('Pre-commit hook updated.');
    return;
  }
  if (appended) logger.discovery('Existing pre-commit hook found. Appending openlore drift check.');
  logger.success(`Pre-commit hook installed at ${displayHookPath(hookPath)}`);
  logger.discovery('Drift will be checked before each commit. Use --no-verify to skip.');
}

export async function uninstallPreCommitHook(rootPath: string): Promise<void> {
  const { hookPath } = await resolveGitHookTarget(rootPath, 'pre-commit');
  let hookFound = false;
  let blockFound = false;
  let malformedReason: string | null = null;
  let deleted = false;
  const result = await updateHookFile(hookPath, (existing) => {
    if (existing === null) return null;
    hookFound = true;
    const block = findDriftHookBlock(existing);
    if (!block) return null;
    if ('error' in block) {
      malformedReason = block.error;
      return null;
    }
    blockFound = true;
    const cleaned = (existing.slice(0, block.start) + existing.slice(block.end)).trim();
    if (!cleaned || (cleaned.startsWith('#!') && !cleaned.includes('\n') && usesShellInterpreter(cleaned))) {
      deleted = true;
      return undefined;
    }
    return cleaned + '\n';
  });
  if (result.status === 'unavailable') {
    logger.warning(`Cannot uninstall the drift hook at ${displayHookPath(hookPath)}: ${result.reason}`);
  } else if (malformedReason) {
    logger.warning(`Cannot uninstall the drift hook automatically: ${malformedReason}. Remove the marked block manually.`);
  } else if (!hookFound) {
    logger.warning('No pre-commit hook found.');
  } else if (!blockFound) {
    logger.warning('Pre-commit hook does not contain openlore drift check.');
  } else if (deleted) {
    logger.success('Pre-commit hook removed (file deleted — was only openlore).');
  } else {
    logger.success('OpenLore drift check removed from pre-commit hook.');
  }
}

// ============================================================================
// COMMAND
// ============================================================================

export const driftCommand = new Command('drift')
  .description('Detect spec drift: find code changes not reflected in specs')
  .option(
    '--base <ref>',
    'Git ref to compare against (default: auto-detect main/master)',
    'auto'
  )
  .option(
    '--files <paths>',
    'Specific files to check (comma-separated)',
    parseList
  )
  .option(
    '--domains <list>',
    'Only check specific domains',
    parseList
  )
  .option(
    '--use-llm',
    'Use LLM for deeper semantic comparison (slower)',
    false
  )
  .option(
    '--json',
    'Output results as JSON only',
    false
  )
  .option(
    '--install-hook',
    'Install pre-commit hook for drift detection',
    false
  )
  .option(
    '--uninstall-hook',
    'Remove pre-commit hook',
    false
  )
  .option(
    '--fail-on <severity>',
    'Exit non-zero on issues at this severity or above (error, warning, info)',
    'warning'
  )
  .option(
    '--max-files <n>',
    'Maximum changed files to analyze',
    String(DEFAULT_DRIFT_MAX_FILES)
  )
  .option(
    '--verbose',
    'Show detailed issue information',
    false
  )
  .option(
    '--suggest-tests',
    'After detecting drift, list the test files that cover affected domains',
    false
  )
  .option(
    '--memory-scope <scope>',
    'Enumerate stale memories for the changed files only, or repository-wide (changed-files | repository)',
    'changed-files'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ openlore drift                    Check for drift against main branch
  $ openlore drift --base develop     Compare against develop branch
  $ openlore drift --json             Output JSON for CI integration
  $ openlore drift --fail-on error    Only fail on error-level drift
  $ openlore drift --use-llm          Use LLM for semantic analysis
  $ openlore drift --install-hook     Install as pre-commit hook
  $ openlore drift --uninstall-hook   Remove pre-commit hook

Drift categories:
  gap:           Code changed but spec not updated
  stale:         Spec references deleted/heavily modified code
  uncovered:     New files with no matching spec
  orphaned-spec: Spec references non-existent files

Pre-commit hook:
  Install with --install-hook to automatically check for drift
  before each commit. The hook runs in static mode (no LLM)
  for fast execution.

Exit codes:
  0: no drift at or above the configured threshold
  1: drift found
  2: drift could not be checked
`
  )
  .action(async function (this: Command, options: Partial<DriftOptions>) {
    const startTime = Date.now();
    const rootPath = process.cwd();

    // Inherit global options from parent command (--quiet, --verbose, --no-color, --config)
    const globalOpts = this.optsWithGlobals?.() ?? {};

    // Normalize options
    const opts: DriftOptions = {
      base: typeof options.base === 'string' ? options.base : 'auto',
      files: options.files ?? [],
      domains: options.domains ?? [],
      useLlm: options.useLlm ?? false,
      json: options.json ?? false,
      installHook: options.installHook ?? false,
      uninstallHook: options.uninstallHook ?? false,
      suggestTests: options.suggestTests ?? false,
      memoryScope: options.memoryScope === 'repository' ? 'repository' : 'changed-files',
      failOn: (options.failOn as DriftSeverity) ?? 'warning',
      maxFiles: (() => {
        // Commander routes --max-files to parent when both parent and subcommand define it.
        // Check globalOpts first for the user-provided value, fall back to subcommand default.
        const raw = globalOpts.maxFiles ?? options.maxFiles ?? String(DEFAULT_DRIFT_MAX_FILES);
        return typeof raw === 'string' ? Number(raw) : raw;
      })(),
      verbose: options.verbose ?? globalOpts.verbose ?? false,
      quiet: globalOpts.quiet ?? false,
      noColor: globalOpts.color === false,
      config: globalOpts.config ?? OPENLORE_CONFIG_REL_PATH,
    };

    if (!Number.isSafeInteger(opts.maxFiles) || opts.maxFiles < 1) {
      logger.error('--max-files must be a positive integer');
      process.exitCode = 2;
      return;
    }

    // Validate failOn
    if (!['error', 'warning', 'info'].includes(opts.failOn)) {
      logger.error('--fail-on must be one of: error, warning, info');
      process.exitCode = 2;
      return;
    }

    // --json: keep stdout pure (logs → stderr) by construction, matching
    // orient/verify, so a future logger call in this path can't corrupt the JSON.
    const restoreStdout = opts.json ? redirectConsoleToStderr() : null;

    try {
      // ========================================================================
      // PHASE 0: HOOK MANAGEMENT (early return)
      // ========================================================================
      if (opts.installHook) {
        await installPreCommitHook(rootPath);
        return;
      }
      if (opts.uninstallHook) {
        await uninstallPreCommitHook(rootPath);
        return;
      }

      // ========================================================================
      // PHASE 1: VALIDATION
      // ========================================================================

      if (!opts.json) {
        logger.section('Spec Drift Detection');
      }

      // Check git repo. Root-only (see api/drift.ts): drift joins repo-root-relative
      // git paths against the analyzed-root spec map, so it runs only at the repo root;
      // below-root it refuses rather than silently join mismatched path frames.
      if (!(await isGitRepositoryRoot(rootPath))) {
        logger.error('Not a git repository (or not at its root). Drift detection requires git and must run at the repository root.');
        process.exitCode = 2;
        return;
      }

      // Load openlore config
      const openloreConfig = await readOpenLoreConfig(rootPath);
      if (!openloreConfig) {
        logger.error('No openlore configuration found. Run "openlore init" first.');
        process.exitCode = 2;
        return;
      }

      // Create LLM service if --use-llm is specified
      let llm: LLMService | undefined;
      if (opts.useLlm) {
        const resolved = resolveLLMProvider(openloreConfig);
        if (!resolved) {
          logger.error('No LLM API key found. --use-llm requires an API key.');
          logger.discovery('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_API_KEY + OPENAI_COMPAT_BASE_URL.');
          process.exitCode = 2;
          return;
        }

        try {
          llm = createLLMService({
            provider: resolved.provider,
            model: openloreConfig.generation?.model,
            openaiCompatBaseUrl: resolved.openaiCompatBaseUrl,
            apiBase: resolveTrustedApiBase(globalOpts.apiBase, openloreConfig?.llm?.apiBase),
            sslVerify: resolveTrustedSslVerify(globalOpts.insecure, openloreConfig?.llm?.sslVerify),
            timeout: globalOpts.timeout ?? openloreConfig.generation?.timeout,
            enableLogging: isLlmLoggingEnabled(),
            logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
            logRoot: rootPath,
          });
          if (!opts.json) {
            logger.discovery(`LLM enabled (${resolved.provider}) — gap issues will be semantically analyzed`);
          }
        } catch (error) {
          logger.error(`Failed to create LLM service: ${(error as Error).message}`);
          process.exitCode = 2;
          return;
        }
      }

      // Determine openspec path
      const openspecPath = resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
      const specsPath = join(openspecPath, OPENSPEC_SPECS_SUBDIR);

      // Check if specs exist
      if (!(await fileExists(specsPath))) {
        logger.error('No specs found. Run "openlore generate" first.');
        process.exitCode = 2;
        return;
      }

      // ========================================================================
      // PHASE 2: GIT DELTA
      // ========================================================================
      if (!opts.json) {
        logger.discovery('Analyzing git changes...');
      }

      // Disclose a base-ref fallback instead of quietly diffing against something the
      // caller did not ask for. `resolveBaseRefDisclosed` is the shared home of this
      // verdict (fix-cli-conclusion-honesty); `blast-radius` already surfaces it and
      // `certify-public-surface` is fatal on it — `drift` was the one --base command
      // that silently substituted `main` for a typo'd ref and reported success.
      const baseDisclosure = await resolveBaseRefDisclosed(rootPath, opts.base);
      if (baseDisclosure.fellBack && !opts.json) {
        logger.warning(
          `Base ref "${baseDisclosure.requested}" did not resolve — comparing against ` +
            `"${baseDisclosure.resolved}" instead.`,
        );
      }

      const gitResult = await getChangedFiles({
        rootPath,
        baseRef: opts.base,
        pathFilter: opts.files.length > 0 ? opts.files : undefined,
        includeUnstaged: true,
      });

      if (!opts.json) {
        logger.info('Base ref', `${gitResult.resolvedBase}`);
        logger.info('Branch', gitResult.currentBranch);
        logger.info('Changed files', gitResult.files.length);
        logger.blank();
      }

      if (gitResult.files.length === 0) {
        if (opts.json) {
          const emptyResult: DriftResult = {
            timestamp: new Date().toISOString(),
            baseRef: gitResult.resolvedBase,
            totalChangedFiles: 0,
            analyzedFiles: 0,
            filesOmitted: 0,
            specRelevantFiles: 0,
            issues: [],
            summary: { gaps: 0, stale: 0, uncovered: 0, orphanedSpecs: 0, adrGaps: 0, adrOrphaned: 0, memoryDrifted: 0, memoryOrphaned: 0, memoryOutOfScope: 0, total: 0 },
            hasDrift: false,
            duration: Date.now() - startTime,
            mode: 'static',
          };
          // Straight to stdout so it bypasses the console→stderr redirect.
          process.stdout.write(JSON.stringify(emptyResult, null, 2) + '\n');
        } else {
          logger.success('No changes detected. Specs are up to date.');
        }
        return;
      }

      // Apply max-files limit
      const actualChangedFiles = gitResult.files.length;
      if (gitResult.files.length > opts.maxFiles) {
        if (!opts.json) {
          logger.warning(`Analyzing first ${opts.maxFiles} of ${gitResult.files.length} changed files. Use --max-files to increase.`);
        }
        gitResult.files = gitResult.files.slice(0, opts.maxFiles);
      }

      // ========================================================================
      // PHASE 3: SPEC MAPPING
      // ========================================================================
      if (!opts.json) {
        logger.discovery('Loading spec mappings...');
      }

      // Check for repo-structure.json for enhanced mapping
      const repoStructurePath = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_REPO_STRUCTURE);
      const hasRepoStructure = await fileExists(repoStructurePath);

      if (!hasRepoStructure && !opts.json) {
        logger.debug('No prior analysis found. Using spec headers only for file mapping. Run "openlore analyze" for better detection.');
      }

      const specMap = await buildSpecMap({
        rootPath,
        openspecPath,
        repoStructurePath: hasRepoStructure ? repoStructurePath : undefined,
      });

      // Build ADR map (if decisions directory exists)
      const adrMap = await buildADRMap({
        rootPath,
        openspecPath,
        repoStructurePath: hasRepoStructure ? repoStructurePath : undefined,
      });

      if (!opts.json) {
        logger.info('Spec domains', specMap.domainCount);
        logger.info('Mapped source files', specMap.totalMappedFiles);
        if (adrMap) {
          logger.info('ADRs tracked', adrMap.byId.size);
        }
        logger.blank();
      }

      // ========================================================================
      // PHASE 4: DRIFT DETECTION
      // ========================================================================
      if (!opts.json) {
        logger.analysis('Detecting drift...');
      }

      const result = await detectDrift({
        rootPath,
        specMap,
        changedFiles: gitResult.files,
        failOn: opts.failOn,
        domainFilter: opts.domains.length > 0 ? opts.domains : undefined,
        openspecRelPath: openloreConfig.openspecPath ?? OPENSPEC_DIR,
        llm,
        baseRef: gitResult.resolvedBase,
        adrMap: adrMap ?? undefined,
        memoryScope: opts.memoryScope,
      });

      // Fill in the base ref and actual total count (before --max-files truncation)
      result.baseRef = gitResult.resolvedBase;
      result.totalChangedFiles = actualChangedFiles;
      result.analyzedFiles = gitResult.files.length;
      result.filesOmitted = actualChangedFiles - gitResult.files.length;

      // ========================================================================
      // PHASE 5: DISPLAY RESULTS
      // ========================================================================
      if (opts.json) {
        // Straight to stdout so it bypasses the console→stderr redirect.
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (opts.quiet) {
        // Quiet mode: only show the final pass/fail line
        if (result.hasDrift) {
          const errorCount = result.issues.filter(i => i.severity === 'error').length;
          const warnCount = result.issues.filter(i => i.severity === 'warning').length;
          const infoCount = result.issues.filter(i => i.severity === 'info').length;
          const parts: string[] = [];
          if (errorCount > 0) parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
          if (warnCount > 0) parts.push(`${warnCount} warning${warnCount > 1 ? 's' : ''}`);
          if (infoCount > 0 && errorCount === 0 && warnCount === 0) parts.push(`${infoCount} info`);
          logger.error(`Drift detected: ${parts.join(', ')}`);
        } else if (result.filesOmitted > 0) {
          console.error(
            `openlore: Drift check incomplete: ${result.analyzedFiles} changed files analyzed, ` +
            `${result.filesOmitted} omitted.`,
          );
        }
      } else {
        if (result.issues.length === 0) {
          logger.blank();
          if (result.filesOmitted > 0) {
            logger.warning(
              `No drift detected in ${result.analyzedFiles} analyzed changed files; ` +
              `${result.filesOmitted} changed files were omitted, so the result is incomplete.`,
            );
          } else {
            logger.success('No spec drift detected. Specs are in sync with code changes.');
          }
          const duration = Date.now() - startTime;
          logger.info('Duration', formatDuration(duration));
        } else {
          console.log('');
          console.log(`   Issues Found: ${result.summary.total}`);

          for (const issue of result.issues) {
            displayIssue(issue, opts.verbose ?? false);
          }

          displaySummary(result);

          const duration = Date.now() - startTime;
          logger.info('Duration', formatDuration(duration));
          logger.blank();

          if (result.hasDrift) {
            const errorCount = result.issues.filter(i => i.severity === 'error').length;
            const warnCount = result.issues.filter(i => i.severity === 'warning').length;
            const infoCount = result.issues.filter(i => i.severity === 'info').length;
            const parts: string[] = [];
            if (errorCount > 0) parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
            if (warnCount > 0) parts.push(`${warnCount} warning${warnCount > 1 ? 's' : ''}`);
            if (infoCount > 0 && errorCount === 0 && warnCount === 0) parts.push(`${infoCount} info`);
            logger.error(`Drift detected: ${parts.join(', ')}`);
          } else {
            logger.success('No drift above threshold. Specs are acceptable.');
          }
        }
      }

      // Show LLM usage stats if applicable
      if (llm) {
        const usage = llm.getTokenUsage();
        if (!opts.json && usage.requests > 0) {
          logger.blank();
          logger.info('LLM calls', usage.requests);
          logger.info('Tokens used', `${usage.totalTokens} (in: ${usage.inputTokens}, out: ${usage.outputTokens})`);
        }
        try {
          await llm.saveLogs();
        } catch (logErr) {
          logger.debug(`LLM log save skipped: ${(logErr as Error).message}`);
        }
      }

      // Suggest tests for drifted domains
      if (opts.suggestTests && result.hasDrift && !opts.json) {
        const suggestion = await suggestTestsForDrift(result, rootPath);
        if (suggestion.omittedFiles > 0) {
          logger.warning(
            `${suggestion.omittedFiles} test-looking file${suggestion.omittedFiles === 1 ? ' was' : 's were'} ` +
            'unreadable or above the scan size limit; suggested tests may be incomplete.',
          );
        }
        if (suggestion.domains.length > 0) {
          logger.blank();
          console.log('   Suggested tests for affected domains:');
          console.log('');
          for (const d of suggestion.domains) {
            console.log(`   ${safe(d.domain)}  (${d.testFiles.length} file${d.testFiles.length !== 1 ? 's' : ''})`);
            for (const f of d.testFiles) {
              console.log(`     → ${safe(f)}`);
            }
          }
          console.log('');
          console.log('   Run the listed files with your project test runner.');
          logger.blank();
        } else {
          logger.blank();
          logger.info('Suggest tests', 'No openlore test files found for affected domains. Run "openlore test" to generate them.');
        }
      }

      // Set exit code based on drift detection
      if (result.hasDrift) {
        process.exitCode = 1;
      }

    } catch (error) {
      logger.error(`Drift detection failed: ${(error as Error).message}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exitCode = 2;
    } finally {
      restoreStdout?.();
    }
  });
