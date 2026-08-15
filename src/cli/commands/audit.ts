/**
 * openlore audit command
 *
 * Reports spec coverage gaps: uncovered functions, orphan requirements,
 * hub gaps, and stale domains. No LLM required.
 */

import { Command } from 'commander';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { join } from 'node:path';
import { writeStdout } from '../output.js';
import { formatDuration } from '../../utils/command-helpers.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_AUDIT_REPORT } from '../../constants.js';
import { openloreAudit } from '../../api/audit.js';
import type { AuditReport } from '../../types/index.js';

// ============================================================================
// FORMATTING
// ============================================================================

export function formatMappingCoverageStatus(report: AuditReport): string[] {
  if (report.mappingCoverage.state === 'available') {
    return [`Coverage:       ${report.summary.coveragePct}% (${report.summary.coveredFunctions}/${report.summary.totalFunctions} functions)`];
  }
  return [
    `Coverage:       unavailable (${report.mappingCoverage.reason ?? 'unknown'})`,
    ...(report.mappingCoverage.message ? [`Reason:         ${report.mappingCoverage.message}`] : []),
    ...(report.mappingCoverage.remediation ? [`Refresh:        ${report.mappingCoverage.remediation}`] : []),
  ];
}

/** Render a nullable metric: `null` is unknown evidence, never a zero count. */
const metric = (value: number | null): string => (value === null ? 'unknown' : String(value));

function printReport(report: AuditReport, rootPath: string): void {
  const { summary } = report;

  console.log('');
  console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('   Spec Coverage Audit');
  console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  for (const line of formatMappingCoverageStatus(report)) console.log(`   ${line}`);
  console.log(`   Uncovered:      ${metric(summary.uncoveredCount)} functions`);
  console.log(`   Hub gaps:       ${metric(summary.hubGapCount)} hub functions without spec`);
  console.log(`   Orphan reqs:    ${metric(summary.orphanRequirementCount)} requirements with no implementation found`);
  console.log(`   Stale domains:  ${summary.staleDomainCount} domains with source changes since last spec`);
  console.log('');

  if (report.hubGaps.length > 0) {
    console.log('   ── Hub Gaps (high fan-in, no spec) ──────────');
    for (const fn of report.hubGaps) {
      console.log(`   ✗ ${safe(fn.name)}  fanIn=${fn.fanIn}  ${safe(fn.file)}`);
    }
    console.log('');
  }

  if (report.staleDomains.length > 0) {
    console.log('   ── Stale Domains ────────────────────────────');
    for (const d of report.staleDomains) {
      console.log(`   ⚠ ${safe(d.name)}  spec=${d.specModifiedAt.slice(0, 10)}  src=${d.sourcesModifiedAt.slice(0, 10)}`);
    }
    console.log('');
  }

  if (report.orphanRequirements.length > 0) {
    console.log('   ── Orphan Requirements ──────────────────────');
    for (const r of report.orphanRequirements) {
      console.log(`   → [${safe(r.domain)}] ${safe(r.requirement)}`);
    }
    console.log('');
  }

  if (report.uncoveredFunctions.length > 0) {
    console.log('   ── Uncovered Functions (sample) ─────────────');
    for (const fn of report.uncoveredFunctions.slice(0, 20)) {
      const hub = fn.isHub ? ' [hub]' : '';
      console.log(`   · ${safe(fn.name)}${hub}  ${safe(fn.file)}`);
    }
    if (summary.uncoveredCount !== null && summary.uncoveredCount > 20) {
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
