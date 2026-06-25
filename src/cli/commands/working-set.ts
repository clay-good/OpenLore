/**
 * `openlore working-set` — assemble the structural briefing a change needs
 * (change: add-working-set-context-briefing).
 *
 * `context --change <id>` assembles a single deterministic, token-budgeted
 * briefing spanning the change's target repositories in a configured spec-store
 * binding — `orient`, generalized from one repo to the change's targets. The
 * briefing is per-target attributed and conclusion-shaped. Read-only; it never
 * blocks and always exits 0 (an unbriefable change is reported, not fatal).
 */

import { Command } from 'commander';
import { writeStdout } from '../output.js';
import {
  handleWorkingSetContext,
  type WorkingSetContextReport,
  type WorkingSetFinding,
} from '../../core/services/mcp-handlers/working-set.js';
import { configureLogger, logger } from '../../utils/logger.js';

const SEVERITY_MARK: Record<WorkingSetFinding['severity'], string> = {
  error: '✗',
  warn: '⚠',
  info: 'ℹ',
};

function renderHuman(report: WorkingSetContextReport): string {
  const lines: string[] = [];
  lines.push(report.summary);
  if (report.bound && report.store) {
    lines.push(`  store: ${report.store.name} → ${report.store.path}`);
  }
  if (report.change?.declaredScope?.length) {
    lines.push(`  declared scope: ${report.change.declaredScope.join(', ')}`);
  }
  for (const t of report.targets) {
    if (t.briefed) {
      const intent = t.anchoredIntent.length ? `, ${t.anchoredIntent.length} anchored intent` : '';
      lines.push(`  ✓ ${t.target}: ${t.specDomains.length} spec domain(s)${intent}`);
    } else {
      lines.push(`  ⚠ ${t.target}: ${t.reason ?? 'not briefed'}`);
    }
  }
  if (report.items.length) {
    lines.push('');
    lines.push(`  briefing (${report.items.length} item(s), ranked):`);
    for (const it of report.items) {
      const callers = it.callers.length ? ` ← ${it.callers.slice(0, 3).join(', ')}` : '';
      lines.push(`    [${it.target}] ${it.name}  (${it.filePath})${callers}`);
    }
  }
  if (report.omissionNote) {
    lines.push(`  … ${report.omissionNote}`);
  }
  if (report.findings.length) {
    lines.push('');
    for (const f of report.findings) {
      lines.push(`  ${SEVERITY_MARK[f.severity]} [${f.code}] ${f.message}`);
      lines.push(`      → ${f.remediation}`);
    }
  }
  return lines.join('\n');
}

export interface WorkingSetContextCliOptions {
  cwd?: string;
  change?: string;
  tokenBudget?: number;
  json?: boolean;
}

/**
 * Run `working-set context`. Read-only; returns the process exit code (always 0 —
 * the command reports a briefing, it never fails the caller). Exported for testing.
 */
export async function runWorkingSetContextCli(opts: WorkingSetContextCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  // Suppress the per-call "Successfully validated directory" chatter so --json
  // is the only thing on stdout.
  configureLogger({ quiet: true });
  let report: WorkingSetContextReport;
  try {
    report = await handleWorkingSetContext(cwd, opts.change, opts.tokenBudget);
  } catch (err) {
    // Defensive: the handler is designed never to throw, but a surprise must still
    // surface cleanly and exit 0.
    configureLogger({ quiet: false });
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) await writeStdout(JSON.stringify({ status: 'unavailable', error: message }, null, 2) + '\n');
    else logger.warning(`working-set: ${message}`);
    return 0;
  }
  configureLogger({ quiet: false });

  if (opts.json) await writeStdout(JSON.stringify(report, null, 2) + '\n');
  else await writeStdout(renderHuman(report) + '\n');
  return 0;
}

export const workingSetCommand = new Command('working-set')
  .description('Assemble the working-set structural briefing for an active change in a spec-store binding')
  .addCommand(
    new Command('context')
      .description('Assemble the per-target briefing for a change (read-only, advisory)')
      .option('--change <id>', 'The active change to brief')
      .option('--token-budget <n>', 'Cap the merged briefing to ~this many tokens', v => parseInt(v, 10))
      .option('--json', 'Emit the briefing as JSON with stable finding codes', false)
      .action(async (opts: { change?: string; tokenBudget?: number; json?: boolean }) => {
        const code = await runWorkingSetContextCli({
          change: opts.change,
          tokenBudget: opts.tokenBudget,
          json: opts.json,
        });
        process.exit(code);
      }),
  );
