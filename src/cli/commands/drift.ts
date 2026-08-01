/**
 * openlore drift command
 *
 * Detects spec drift: finds code changes not reflected in specs.
 * Can be used standalone or as a pre-commit hook.
 */

import { Command } from 'commander';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
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
import type { LLMService } from '../../core/services/llm-service.js';
import { resolveOpenspecDir } from '../../utils/openspec-dir.js';

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

function kindLabel(kind: string): string {
  switch (kind) {
    case 'gap': return 'gap';
    case 'stale': return 'stale';
    case 'uncovered': return 'uncovered';
    case 'orphaned-spec': return 'orphaned';
    case 'adr-gap': return 'adr-gap';
    case 'adr-orphaned': return 'adr-orphaned';
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

function displaySummary(result: DriftResult): void {
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
const HOOK_CONTENT = `
${HOOK_MARKER}
# Automatically check for spec drift before committing
# Installed by: openlore drift --install-hook

# Run openlore drift in static mode (fast, no LLM)
# Use --json for machine-parseable output, suppress only npx banner noise
DRIFT_OUTPUT=$(npx --yes openlore drift --fail-on warning --json 2>/dev/null)
DRIFT_EXIT=$?

if [ $DRIFT_EXIT -ne 0 ]; then
  echo ""
  echo "openlore: Spec drift detected! Commit blocked."
  echo ""
  # Show concise summary from JSON output
  if command -v python3 > /dev/null 2>&1; then
    echo "$DRIFT_OUTPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    s = d.get('summary', {})
    parts = []
    if s.get('gaps', 0): parts.append(str(s['gaps']) + ' gap(s)')
    if s.get('stale', 0): parts.append(str(s['stale']) + ' stale')
    if s.get('uncovered', 0): parts.append(str(s['uncovered']) + ' uncovered')
    if s.get('orphanedSpecs', 0): parts.append(str(s['orphanedSpecs']) + ' orphaned')
    print('  Issues: ' + ', '.join(parts))
    for i in d.get('issues', [])[:5]:
        sev = i['severity'].upper()
        print('  [' + sev + '] ' + i['kind'] + ': ' + i['filePath'])
    if len(d.get('issues', [])) > 5:
        print('  ... and ' + str(len(d['issues']) - 5) + ' more')
except: pass
" 2>/dev/null
  else
    echo "  (Install python3 for detailed issue summary in hook output)"
  fi
  echo ""
  echo "  Run 'openlore drift' for full details."
  echo "  To skip this check: git commit --no-verify"
  echo ""
  exit 1
fi
# end-openlore-drift-hook
`.trimStart();

async function installPreCommitHook(rootPath: string): Promise<void> {
  const hooksDir = join(rootPath, '.git', 'hooks');
  const hookPath = join(hooksDir, 'pre-commit');

  if (!(await fileExists(join(rootPath, '.git')))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 1;
    return;
  }

  // Ensure hooks directory exists (may not in bare clones or some CI setups)
  await mkdir(hooksDir, { recursive: true });

  // Check if hook already exists
  let existingContent: string;
  if (await fileExists(hookPath)) {
    existingContent = await readFile(hookPath, 'utf-8');

    if (existingContent.includes(HOOK_MARKER)) {
      logger.success('Pre-commit hook is already installed.');
      return;
    }

    // Append to existing hook
    logger.discovery('Existing pre-commit hook found. Appending openlore drift check.');
    const newContent = existingContent.trimEnd() + '\n\n' + HOOK_CONTENT;
    await writeFile(hookPath, newContent, 'utf-8');
  } else {
    // Create new hook
    const newContent = '#!/bin/sh\n\n' + HOOK_CONTENT;
    await writeFile(hookPath, newContent, 'utf-8');
  }

  await chmod(hookPath, 0o755);
  logger.success('Pre-commit hook installed at .git/hooks/pre-commit');
  logger.discovery('Drift will be checked before each commit. Use --no-verify to skip.');
}

async function uninstallPreCommitHook(rootPath: string): Promise<void> {
  const hookPath = join(rootPath, '.git', 'hooks', 'pre-commit');

  if (!(await fileExists(hookPath))) {
    logger.warning('No pre-commit hook found.');
    return;
  }

  const content = await readFile(hookPath, 'utf-8');
  if (!content.includes(HOOK_MARKER)) {
    logger.warning('Pre-commit hook does not contain openlore drift check.');
    return;
  }

  // Remove the openlore block
  const newContent = content
    .replace(/\n*# openlore-drift-hook[\s\S]*?# end-openlore-drift-hook\n*/g, '')
    .trim();

  if (!newContent || newContent === '#!/bin/sh') {
    // Hook file is now empty — remove the shebang-only file
    const { unlink } = await import('node:fs/promises');
    await unlink(hookPath);
    logger.success('Pre-commit hook removed (file deleted — was only openlore).');
  } else {
    await writeFile(hookPath, newContent + '\n', 'utf-8');
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
      failOn: (options.failOn as DriftSeverity) ?? 'warning',
      maxFiles: (() => {
        // Commander routes --max-files to parent when both parent and subcommand define it.
        // Check globalOpts first for the user-provided value, fall back to subcommand default.
        const raw = globalOpts.maxFiles ?? options.maxFiles ?? String(DEFAULT_DRIFT_MAX_FILES);
        return typeof raw === 'string' ? parseInt(raw, 10) : raw;
      })(),
      verbose: options.verbose ?? globalOpts.verbose ?? false,
      quiet: globalOpts.quiet ?? false,
      noColor: globalOpts.color === false,
      config: globalOpts.config ?? OPENLORE_CONFIG_REL_PATH,
    };

    if (isNaN(opts.maxFiles) || opts.maxFiles < 1) {
      logger.error('--max-files must be a positive integer');
      process.exitCode = 1;
      return;
    }

    // Validate failOn
    if (!['error', 'warning', 'info'].includes(opts.failOn)) {
      logger.error('--fail-on must be one of: error, warning, info');
      process.exitCode = 1;
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
        process.exitCode = 1;
        return;
      }

      // Load openlore config
      const openloreConfig = await readOpenLoreConfig(rootPath);
      if (!openloreConfig) {
        logger.error('No openlore configuration found. Run "openlore init" first.');
        process.exitCode = 1;
        return;
      }

      // Create LLM service if --use-llm is specified
      let llm: LLMService | undefined;
      if (opts.useLlm) {
        const resolved = resolveLLMProvider(openloreConfig);
        if (!resolved) {
          logger.error('No LLM API key found. --use-llm requires an API key.');
          logger.discovery('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_API_KEY + OPENAI_COMPAT_BASE_URL.');
          process.exitCode = 1;
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
            enableLogging: true,
            logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
          });
          if (!opts.json) {
            logger.discovery(`LLM enabled (${resolved.provider}) — gap issues will be semantically analyzed`);
          }
        } catch (error) {
          logger.error(`Failed to create LLM service: ${(error as Error).message}`);
          process.exitCode = 1;
          return;
        }
      }

      // Determine openspec path
      const openspecPath = resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
      const specsPath = join(openspecPath, OPENSPEC_SPECS_SUBDIR);

      // Check if specs exist
      if (!(await fileExists(specsPath))) {
        logger.error('No specs found. Run "openlore generate" first.');
        process.exitCode = 1;
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
            specRelevantFiles: 0,
            issues: [],
            summary: { gaps: 0, stale: 0, uncovered: 0, orphanedSpecs: 0, adrGaps: 0, adrOrphaned: 0, memoryDrifted: 0, memoryOrphaned: 0, total: 0 },
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
      });

      // Fill in the base ref and actual total count (before --max-files truncation)
      result.baseRef = gitResult.resolvedBase;
      result.totalChangedFiles = actualChangedFiles;

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
        }
      } else {
        if (result.issues.length === 0) {
          logger.blank();
          logger.success('No spec drift detected. Specs are in sync with code changes.');
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
        if (suggestion.domains.length > 0) {
          logger.blank();
          console.log('   Suggested tests for affected domains:');
          console.log('');
          for (const d of suggestion.domains) {
            console.log(`   ${safe(d.domain)}  (${d.testFiles.length} file${d.testFiles.length !== 1 ? 's' : ''})`);
            for (const f of d.testFiles) {
              console.log(`     → ${f}`);
            }
          }
          console.log('');
          console.log(`   Run: npx vitest ${suggestion.allFiles.join(' ')}`);
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
      process.exitCode = 1;
    } finally {
      restoreStdout?.();
    }
  });
