/**
 * openlore audit command
 *
 * Reports spec coverage gaps: uncovered functions, orphan requirements,
 * hub gaps, and stale domains. No LLM required.
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { writeStdout } from '../output.js';
import { formatDuration } from '../../utils/command-helpers.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_AUDIT_REPORT } from '../../constants.js';
import { openloreAudit } from '../../api/audit.js';
import type { AuditReport } from '../../types/index.js';

// ============================================================================
// FORMATTING
// ============================================================================

function printReport(report: AuditReport, rootPath: string): void {
  const { summary } = report;

  console.log('');
  console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   Spec Coverage Audit');
  console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(`   Coverage:       ${summary.coveragePct}% (${summary.coveredFunctions}/${summary.totalFunctions} functions)`);
  console.log(`   Uncovered:      ${summary.uncoveredCount} functions`);
  console.log(`   Hub gaps:       ${summary.hubGapCount} hub functions without spec`);
  console.log(`   Orphan reqs:    ${summary.orphanRequirementCount} requirements with no implementation found`);
  console.log(`   Stale domains:  ${summary.staleDomainCount} domains with source changes since last spec`);
  console.log('');

  if (report.hubGaps.length > 0) {
    console.log('   ── Hub Gaps (high fan-in, no spec) ──────────');
    for (const fn of report.hubGaps) {
      console.log(`   ✗ ${fn.name}  fanIn=${fn.fanIn}  ${fn.file}`);
    }
    console.log('');
  }

  if (report.staleDomains.length > 0) {
    console.log('   ── Stale Domains ────────────────────────────');
    for (const d of report.staleDomains) {
      console.log(`   ⚠ ${d.name}  spec=${d.specModifiedAt.slice(0, 10)}  src=${d.sourcesModifiedAt.slice(0, 10)}`);
    }
    console.log('');
  }

  if (report.orphanRequirements.length > 0) {
    console.log('   ── Orphan Requirements ──────────────────────');
    for (const r of report.orphanRequirements) {
      console.log(`   → [${r.domain}] ${r.requirement}`);
    }
    console.log('');
  }

  if (report.uncoveredFunctions.length > 0) {
    console.log('   ── Uncovered Functions (sample) ─────────────');
    for (const fn of report.uncoveredFunctions.slice(0, 20)) {
      const hub = fn.isHub ? ' [hub]' : '';
      console.log(`   · ${fn.name}${hub}  ${fn.file}`);
    }
    if (summary.uncoveredCount > 20) {
      console.log(`   … and ${summary.uncoveredCount - 20} more`);
    }
    console.log('');
  }

  const reportPath = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_AUDIT_REPORT);
  console.log(`   Report saved to: ${reportPath}`);
  console.log('');
}

// ============================================================================
// COMMAND
// ============================================================================

export const auditCommand = new Command('audit')
  .description('Report spec coverage gaps: uncovered functions, orphan requirements, hub gaps, stale domains')
  .argument('[directory]', 'Project directory to audit', '.')
  .option('--max-uncovered <n>', 'Maximum uncovered functions to list', '50')
  .option('--hub-threshold <n>', 'Minimum fanIn to flag as a hub gap', '5')
  .option('--json', 'Output raw JSON report')
  .action(async (directory: string, opts: {
    maxUncovered: string;
    hubThreshold: string;
    json: boolean;
  }) => {
    const rootPath = join(process.cwd(), directory === '.' ? '' : directory);
    const startTime = Date.now();

    try {
      if (!opts.json) {
        console.log('Running spec coverage audit…');
      }

      const report = await openloreAudit({
        rootPath,
        maxUncovered: parseInt(opts.maxUncovered, 10),
        hubThreshold: parseInt(opts.hubThreshold, 10),
        save: true,
      });

      if (opts.json) {
        await writeStdout(JSON.stringify(report, null, 2) + '\n');
        return;
      }

      printReport(report, rootPath);
      console.log(`   Done in ${formatDuration(Date.now() - startTime)}`);

    } catch (err) {
      console.error(`Audit failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });
