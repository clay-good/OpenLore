/**
 * openlore test command
 *
 * Reports spec test coverage across the project by scanning test files
 * for openlore annotation tags:
 *
 *   // openlore: {"domain":"auth","requirement":"UserLogin","scenario":"SuccessfulLogin",...}
 *   # openlore: ...  (Python)
 *
 * Options:
 *   --discover      Extend coverage via semantic test title matching (requires --use-llm)
 *   --min-coverage  Exit 1 if effective coverage is below N% (CI gate)
 *   --domains       Limit report to specific domains
 *   --test-dirs     Directories to scan (default: spec-tests,src)
 *   --json          Machine-readable output
 *
 * To write tests with real assertions, use the openlore-write-tests skill
 * (Vibe: /openlore-write-tests, Cline: openlore-write-tests workflow).
 */

import { Command } from 'commander';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { resolveTrustedApiBase, resolveTrustedSslVerify } from '../../core/services/repo-config-trust.js';
import { parseList, resolveLLMProvider } from '../../utils/command-helpers.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { createLLMService } from '../../core/services/llm-service.js';
import type { LLMService } from '../../core/services/llm-service.js';
import { analyzeTestCoverage } from '../../core/test-generator/index.js';
import type { TestCoverageReport } from '../../types/test-generator.js';
import {
  OPENLORE_DIR,
  OPENLORE_LOGS_SUBDIR,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
} from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';

// ============================================================================
// DISPLAY HELPERS
// ============================================================================

function displayCoverageReport(report: TestCoverageReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('');
  console.log('   Spec Test Coverage Report');
  console.log('   ─────────────────────────────────────────');
  console.log('');
  console.log(`   Total scenarios:    ${report.totalScenarios}`);
  console.log(`   Covered (tagged):   ${report.taggedScenarios}`);
  if (report.discoveredScenarios > 0) {
    console.log(`   Discovered:         ${report.discoveredScenarios}   (via semantic match)`);
  }
  console.log(`   Uncovered:          ${report.totalScenarios - report.coveredScenarios}`);

  const thresholdSuffix =
    report.minCoverage !== undefined
      ? `  (target: ${report.minCoverage}%) ${report.belowThreshold ? '✗ below threshold' : '✓'}`
      : '';
  console.log(`   Effective coverage: ${report.coveragePercent}%${thresholdSuffix}`);
  console.log('');
  console.log('   By domain:');

  for (const [domain, info] of Object.entries(report.byDomain).sort()) {
    const bar = `${info.covered}/${info.total}`;
    const pct = `(${info.percent}%)`;
    const drift = info.hasDrift ? ' ⚠ drift detected' : '';
    const status = info.percent >= 80 ? ' ✓' : '';
    console.log(`     ${domain.padEnd(20)} ${bar.padStart(6)}  ${pct.padEnd(8)}${status}${drift}`);
  }

  if (report.uncovered.length > 0) {
    console.log('');
    console.log('   Uncovered scenarios:');
    for (const s of report.uncovered.slice(0, 20)) {
      console.log(`     ${safe(s.domain)}/${safe(s.requirement)}/${safe(s.scenarioName)}`);
    }
    if (report.uncovered.length > 20) {
      console.log(`     ... and ${report.uncovered.length - 20} more`);
    }
  }

  console.log('');
}

// ============================================================================
// COMMAND
// ============================================================================

export const testCommand = new Command('test')
  .description('Report spec test coverage (scan test files for openlore annotation tags)')
  .option(
    '--discover',
    'Semantically match existing tests to uncovered scenarios (requires --use-llm)',
    false
  )
  .option('--use-llm', 'Enable LLM for semantic discovery (requires API key)', false)
  .option('--min-coverage <n>', 'Fail if effective coverage is below N% (for CI)')
  .option(
    '--domains <list>',
    'Only report on specific domains (comma-separated)',
    parseList
  )
  .option(
    '--test-dirs <list>',
    'Directories to scan for tests (default: spec-tests,src)',
    parseList
  )
  .option('--json', 'Output JSON (for CI / scripting)', false)
  .addHelpText(
    'after',
    `
Examples:
  $ openlore test                              Show spec test coverage
  $ openlore test --domains auth,tasks         Only for specific domains
  $ openlore test --min-coverage 80            Fail CI if coverage < 80%
  $ openlore test --discover --use-llm         Semantic discovery of existing tests
  $ openlore test --json                       Machine-readable output

Annotation tag format (add above each describe/class/suite block):
  // openlore: {"domain":"auth","requirement":"UserLogin","scenario":"SuccessfulLogin","specFile":"openspec/specs/auth/spec.md"}
  # openlore: ...  (Python)

To write tests, use the openlore-write-tests skill:
  Vibe:  /openlore-write-tests
  Cline: openlore-write-tests workflow (.clinerules/workflows/)
`
  )
  .action(async function (this: Command) {
    const rootPath = process.cwd();
    const opts = this.opts();
    const globalOpts = this.optsWithGlobals?.() ?? {};

    const isDiscover: boolean = opts.discover ?? false;
    const useLlm: boolean = opts.useLlm ?? false;
    const isJson: boolean = opts.json ?? false;
    const domains: string[] = opts.domains ?? [];
    const testDirs: string[] = opts.testDirs ?? ['spec-tests', 'src'];
    const minCoverage: number | undefined = opts.minCoverage
      ? parseFloat(opts.minCoverage)
      : undefined;

    if (!isJson) logger.section('Spec Test Coverage');

    const specsPath = join(rootPath, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR);
    if (!(await fileExists(specsPath))) {
      logger.error('No specs found. Run "openlore generate" first.');
      process.exitCode = 1;
      return;
    }

    // ── LLM Setup (only needed for --discover) ───────────────────────────
    let llm: LLMService | undefined;
    if (useLlm || isDiscover) {
      const config = await readOpenLoreConfig(rootPath);
      const resolved = resolveLLMProvider(config ?? undefined);

      if (!resolved) {
        logger.error('--use-llm and --discover require an API key or LLM configuration.');
        process.exitCode = 1;
        return;
      }

      try {
        llm = createLLMService({
          provider: resolved.provider,
          openaiCompatBaseUrl: resolved.openaiCompatBaseUrl,
          apiBase: resolveTrustedApiBase(globalOpts.apiBase, config?.llm?.apiBase),
          sslVerify: resolveTrustedSslVerify(globalOpts.insecure, config?.llm?.sslVerify),
          timeout: globalOpts.timeout ?? config?.generation?.timeout,
          enableLogging: true,
          logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
        });
      } catch (err) {
        logger.error(`LLM setup failed: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
    }

    try {
      if (!isJson) logger.discovery('Scanning test files for spec coverage...');

      const report = await analyzeTestCoverage({
        rootPath,
        testDirs,
        domains: domains.length > 0 ? domains : undefined,
        discover: isDiscover && !!llm,
        llm,
        minCoverage,
      });

      displayCoverageReport(report, isJson);

      if (llm) {
        const usage = llm.getTokenUsage();
        if (!isJson && usage.requests > 0) {
          logger.info('LLM calls', usage.requests);
          logger.info('Tokens used', `${usage.totalTokens}`);
        }
        await llm.saveLogs().catch(() => {});
      }

      if (report.belowThreshold) {
        if (!isJson) {
          logger.error(`Coverage ${report.coveragePercent}% is below required ${minCoverage}%`);
        }
        process.exitCode = 1;
      }
    } catch (err) {
      logger.error(`Coverage report failed: ${(err as Error).message}`);
      if (process.env.DEBUG) console.error(err);
      process.exitCode = 1;
    }
  });
