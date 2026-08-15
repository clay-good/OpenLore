/**
 * `openlore coverage-gaps` — the structural test-coverage gap report's CLI surface
 * (change: add-test-coverage-gap-report).
 *
 * Prints the conclusion-shaped ranked list of important code with NO reaching test
 * (the same report the `report_coverage_gaps` MCP tool returns) so a reviewer or CI
 * job can audit the untested surface without an MCP client. Read-only, deterministic,
 * offline. SOUND DIRECTION ONLY: it reports "no reaching test" and never claims a
 * symbol is tested. Not a hook and never blocks — it is a report.
 */

import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { handleReportCoverageGaps } from '../../core/services/mcp-handlers/coverage-gaps.js';

interface CoverageGapItem {
  name: string;
  file: string;
  language: string;
  fanIn: number;
  signals: Array<{ label: string; evidence: Record<string, number | string> }>;
  alsoFlaggedDead?: true;
  deadReason?: 'no-callers' | 'dead-via-unreachable-callers';
}

/** Live vs dead-flagged split of a gap list (change: demote-dead-flagged-coverage-gaps). */
interface GapComposition {
  live: number;
  deadFlagged: number;
}

interface CoverageGapsResult {
  scope: 'repo' | 'diff' | 'region';
  changed?: string[];
  filePattern?: string;
  analyzedSymbols: number;
  reachableFromTest: number;
  gapCount: number;
  coverageGaps: CoverageGapItem[];
  composition?: {
    returned: GapComposition;
    omittedRemainder?: GapComposition;
    total: GapComposition;
  };
  omitted?: number;
  note?: string;
  soundness: { posture: string; claim: string; caveats: string[] };
  coverage: { languages: string[]; testDetection: 'full' | 'partial' | 'none' };
  confidenceBoundary?: {
    staleness?: { detail?: string };
    integrity?: { verdict?: string; detail?: string };
  };
}

/** Compact human rendering of the gap report. */
function renderHuman(r: CoverageGapsResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('🧪 Structural test-coverage gaps (no reaching test)');
  lines.push(
    `   scope: ${r.scope} · ${r.gapCount} gap(s) of ${r.analyzedSymbols} analyzed ` +
    `(${r.reachableFromTest} reachable from a test) · test detection: ${r.coverage.testDetection}`,
  );
  if (r.coverage.testDetection === 'none') {
    lines.push('   ⚠ No tests detected — every symbol looks untested because detection found nothing, not because the code is genuinely untested.');
  }
  // A degraded/stale index manufactures false gaps — for a tool whose entire output is
  // NEGATIVE conclusions ("no reaching test"), the index-health caveat is the one a human
  // reviewer most needs, so surface it in the human view (not just --json).
  if (r.confidenceBoundary?.integrity?.detail) {
    lines.push(`   ⚠ index integrity ${r.confidenceBoundary.integrity.verdict ?? 'degraded'}: ${r.confidenceBoundary.integrity.detail}`);
  }
  if (r.confidenceBoundary?.staleness?.detail) {
    lines.push(`   ⚠ ${r.confidenceBoundary.staleness.detail}`);
  }
  // When test detection is partial, surface WHICH languages lack detected tests (the
  // precise over-report scope), not just the generic posture caveat below.
  if (r.coverage.testDetection === 'partial') {
    const partial = r.soundness.caveats.find(c => /no test files were detected/i.test(c));
    if (partial) lines.push(`   ⚠ ${partial}`);
  }
  if (r.note) {
    lines.push(`   ⚠ ${r.note}`);
  }
  if (r.coverageGaps.length === 0) {
    lines.push(r.note ? '   (nothing in scope to report)' : '   No gaps in scope.');
  } else {
    lines.push('   Top untested (live and load-bearing first; dead-flagged last):');
    for (const g of r.coverageGaps) {
      const labels = g.signals.map(s => s.label).join(',');
      // Name WHY it is dead-flagged: "has callers, still unreachable" is a resolution
      // limit of the analysis, not a claim the code is unused.
      const deadTag = g.deadReason === 'dead-via-unreachable-callers'
        ? '(dead-flagged: callers unreachable — undecidable)'
        : g.alsoFlaggedDead ? '(dead-flagged: no callers)' : '';
      const tags = [labels && `[${labels}]`, deadTag].filter(Boolean).join(' ');
      lines.push(`   • ${g.name}  ${g.file}  fanIn=${g.fanIn}${tags ? '  ' + tags : ''}`);
    }
    if (r.composition) {
      const { live, deadFlagged } = r.composition.returned;
      lines.push(`   composition: ${live} live · ${deadFlagged} dead-flagged (of ${r.composition.total.live} live / ${r.composition.total.deadFlagged} dead-flagged overall)`);
    }
    if (r.omitted && r.omitted > 0) {
      const rest = r.composition?.omittedRemainder;
      const detail = rest ? ` (${rest.live} live · ${rest.deadFlagged} dead-flagged)` : '';
      lines.push(`   … and ${r.omitted} more${detail} (raise --max to see them)`);
    }
  }
  const undecidable = r.soundness.caveats.find(c => /dead-via-unreachable-callers/.test(c));
  if (undecidable) lines.push(`   ⚠ ${undecidable}`);
  lines.push('   ' + r.soundness.caveats[0]);
  lines.push('');
  return lines.join('\n');
}

export interface CoverageGapsCliOptions {
  cwd?: string;
  max?: number;
  filePattern?: string;
  base?: string;
  symbols?: string[];
  json?: boolean;
}

export async function runCoverageGapsCli(opts: CoverageGapsCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();

  // Suppress the per-call "Successfully validated directory" chatter so the report
  // (and --json) is the only thing on stdout.
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await handleReportCoverageGaps({
      directory: cwd,
      maxResults: opts.max,
      filePattern: opts.filePattern,
      changedSymbols: opts.symbols,
      diffRef: opts.base,
    });
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }

  if (result && typeof result === 'object' && 'error' in result) {
    const error = (result as { error: string }).error;
    if (opts.json) await writeStdout(JSON.stringify({ status: 'unavailable', error }, null, 2) + '\n');
    else logger.warning(`coverage-gaps: ${error}`);
    return 1;
  }

  if (opts.json) {
    await writeStdout(JSON.stringify(result, null, 2) + '\n');
  } else {
    await writeStdout(renderHuman(result as CoverageGapsResult) + '\n');
  }
  return 0;
}

export const coverageGapsCommand = new Command('coverage-gaps')
  .description('Ranked structural test-coverage gaps for the repo (or a diff/region): important code with NO reaching test. Read-only, deterministic, never blocks.')
  .option('--max <n>', 'Limit reported gaps (default 100, capped 500)', (v) => parseInt(v, 10))
  .option('--file-pattern <substr>', 'Only report gaps whose file path contains this substring (region scope)')
  .option('--base <ref>', 'Diff scope: only report gaps among symbols changed vs this git ref (e.g. HEAD, main)')
  .option('--symbols <list>', 'Diff scope: comma-separated changed symbol names to restrict the report to', (v) => v.split(',').map(s => s.trim()).filter(Boolean))
  .option('--json', 'Emit the report as JSON', false)
  .action(async (opts: { max?: number; filePattern?: string; base?: string; symbols?: string[]; json?: boolean }) => {
    const code = await runCoverageGapsCli({
      max: opts.max,
      filePattern: opts.filePattern,
      base: opts.base,
      symbols: opts.symbols,
      json: opts.json,
    });
    process.exit(code);
  });
