/**
 * `openlore spec-store` — inspect a spec-store binding (change: add-spec-store-binding).
 *
 * A spec-store binding (.openlore/config.json "specStore") points OpenLore at an
 * external spec repository whose declared target/reference repositories are
 * resolved against the federation registry. `status` reports the binding's
 * health as conclusion-shaped findings with stable codes. Read-only; it never
 * blocks and always exits 0 (an unhealthy binding is reported, not fatal).
 */

import { Command } from 'commander';
import { writeStdout } from '../output.js';
import { handleSpecStoreStatus, type SpecStoreStatusReport, type SpecStoreFinding } from '../../core/services/mcp-handlers/spec-store.js';
import { configureLogger, logger } from '../../utils/logger.js';

const SEVERITY_MARK: Record<SpecStoreFinding['severity'], string> = {
  error: '✗',
  warn: '⚠',
  info: 'ℹ',
};

function renderHuman(report: SpecStoreStatusReport): string {
  const lines: string[] = [];
  lines.push(report.summary);
  if (report.bound && report.store) {
    lines.push(`  store: ${report.store.name} → ${report.store.path}`);
    if (report.targets.length) {
      const indexed = report.targets.filter(t => t.resolved && t.state === 'indexed').length;
      lines.push(`  targets: ${indexed}/${report.targets.length} indexed`);
    }
    if (report.references.length) {
      const present = report.references.filter(r => r.resolved).length;
      lines.push(`  references: ${present}/${report.references.length} present`);
    }
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

export interface SpecStoreStatusCliOptions {
  cwd?: string;
  json?: boolean;
}

/**
 * Run `spec-store status`. Read-only; returns the process exit code (always 0 —
 * the command reports binding health, it never fails the caller). Exported for
 * unit testing.
 */
export async function runSpecStoreStatusCli(opts: SpecStoreStatusCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  // Suppress the per-call "Successfully validated directory" chatter so --json
  // is the only thing on stdout.
  configureLogger({ quiet: true });
  let report: SpecStoreStatusReport;
  try {
    report = await handleSpecStoreStatus(cwd);
  } catch (err) {
    // Defensive: the handler is designed never to throw, but a surprise (e.g. a
    // corrupt federation manifest) must still surface cleanly and exit 0.
    configureLogger({ quiet: false });
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) await writeStdout(JSON.stringify({ status: 'unavailable', error: message }, null, 2) + '\n');
    else logger.warning(`spec-store: ${message}`);
    return 0;
  }
  configureLogger({ quiet: false });

  if (opts.json) await writeStdout(JSON.stringify(report, null, 2) + '\n');
  else await writeStdout(renderHuman(report) + '\n');
  return 0;
}

export const specStoreCommand = new Command('spec-store')
  .description('Inspect a spec-store binding: an external spec repository whose targets resolve via the federation registry')
  .addCommand(
    new Command('status')
      .description('Report the health of the configured spec-store binding (read-only, advisory)')
      .option('--json', 'Emit the report as JSON with stable finding codes', false)
      .action(async (opts: { json?: boolean }) => {
        const code = await runSpecStoreStatusCli({ json: opts.json });
        process.exit(code);
      }),
  );
