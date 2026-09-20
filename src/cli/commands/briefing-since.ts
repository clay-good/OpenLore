/**
 * `openlore briefing-since` — the change significance briefing's CLI surface
 * (change: add-change-significance-briefing).
 *
 * Prints the conclusion-shaped, tier-ranked briefing of what changed since a base
 * ref (the same report the `briefing_since` MCP tool returns) so a reviewer, a
 * returning engineer, or a CI job can see which changes structurally matter without
 * an MCP client. Read-only, deterministic, offline. Not a hook and never blocks — it
 * is a report. The cursor is the base ref, never wall-clock time.
 */

import { Command } from 'commander';
import { isChangedSetCaveat } from '../../core/services/symbol-changed-set.js';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';

interface BriefingItem {
  name: string;
  file: string;
  community?: string;
  tier: string;
  labels: string[];
  evidence: { fanIn: number; fanOut: number; priorChurn: number; volatility: string };
}

interface BriefingResult {
  baseRef: string;
  baseRefFallback?: { requested: string; resolved: string };
  scope: 'repo' | 'region';
  filePattern?: string;
  changedFiles: number;
  changedSymbols: number;
  tierCounts: Record<string, number>;
  briefing: BriefingItem[];
  truncation: { bounded: boolean; returned: number; omitted: number; lowestTierReached: string | null; omittedByTier?: Record<string, number> };
  regions: Array<{ community: string; count: number }>;
  testsToRun: {
    count: number;
    files: string[];
    note?: string;
    truncatedAtDepth?: number;
    soundness?: { caveats?: string[] };
  };
  surprisingChange: { available: boolean; reason?: string; historyCommitsScanned: number };
  note?: string;
  caveats: string[];
  /** Renames and moves whose body did not change (change: add-symbol-content-hashes). */
  carried?: Array<{ from: string; to: string; reason: string; basis: string }>;
  confidenceBoundary?: {
    staleness?: { detail?: string };
    integrity?: { verdict?: string; detail?: string };
  };
}

const TIER_ICON: Record<string, string> = {
  'surprising-change': '🔥',
  'hub-change': '🎯',
  'chokepoint-change': '⛓',
  'ordinary-change': '·',
};

/** Compact human rendering of the briefing. */
/** Caveats that qualify WHAT is in the ranked list, rather than how to read a single entry. */
function isGranularityCaveat(caveat: string): boolean {
  return isChangedSetCaveat(caveat);
}

function renderHuman(r: BriefingResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`📋 Change significance briefing since ${r.baseRef}`);
  const tierSummary = Object.entries(r.tierCounts)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${n} ${t}`)
    .join(' · ') || 'no significant tiers';
  lines.push(
    `   scope: ${r.scope}${r.filePattern ? ` (${r.filePattern})` : ''} · ` +
    `${r.changedSymbols} changed symbol(s) in ${r.changedFiles} file(s) · ${tierSummary}`,
  );
  if (r.baseRefFallback) {
    lines.push(`   ⚠ requested base "${r.baseRefFallback.requested}" not found — briefed against "${r.baseRefFallback.resolved}" instead`);
  }
  if (!r.surprisingChange.available) {
    lines.push(`   ⚠ surprising-change withheld: ${r.surprisingChange.reason ?? 'shallow history'}`);
  }
  if (r.confidenceBoundary?.integrity?.detail) {
    lines.push(`   ⚠ index integrity ${r.confidenceBoundary.integrity.verdict ?? 'degraded'}: ${r.confidenceBoundary.integrity.detail}`);
  }
  if (r.confidenceBoundary?.staleness?.detail) {
    lines.push(`   ⚠ ${r.confidenceBoundary.staleness.detail}`);
  }
  if (r.note) lines.push(`   ⚠ ${r.note}`);
  // A caveat that qualifies the ranked list must appear ABOVE it: "these files were kept whole, so
  // every symbol in them is briefed" is exactly what a reader needs before reading the tiers.
  for (const caveat of r.caveats) {
    if (isGranularityCaveat(caveat)) lines.push(`   ⚠ ${caveat}`);
  }

  if (r.briefing.length === 0) {
    lines.push(r.note ? '   (nothing in scope to brief)' : '   No changed symbols in scope.');
  } else {
    lines.push('   What changed, most significant first:');
    for (const b of r.briefing) {
      const icon = TIER_ICON[b.tier] ?? '·';
      const labels = b.labels.length ? ` [${b.labels.join(',')}]` : '';
      const region = b.community ? `  {${b.community}}` : '';
      lines.push(
        `   ${icon} ${b.name}  ${b.file}  fanIn=${b.evidence.fanIn} fanOut=${b.evidence.fanOut} ` +
        `churn=${b.evidence.priorChurn}${labels}${region}`,
      );
    }
    if (r.truncation.bounded) {
      const byTier = r.truncation.omittedByTier
        ? ' (' + Object.entries(r.truncation.omittedByTier).map(([t, n]) => `${n} ${t}`).join(', ') + ')'
        : '';
      lines.push(`   … and ${r.truncation.omitted} more omitted${byTier}; lowest tier shown: ${r.truncation.lowestTierReached} (raise --max to see them)`);
    }
  }

  lines.push(`   Tests to run for this change set: ${r.testsToRun.count}${r.testsToRun.files.length ? ` across ${r.testsToRun.files.length} file(s)` : ''}`);
  if (r.testsToRun.truncatedAtDepth !== undefined) {
    lines.push(`   ⚠ Test reachability was truncated at depth ${r.testsToRun.truncatedAtDepth}; deeper tests may exist.`);
  }
  for (const caveat of r.testsToRun.soundness?.caveats ?? []) {
    if (/substring fallback|may have widened/i.test(caveat)) lines.push(`   ⚠ ${caveat}`);
  }
  // Every standing caveat, not the one that happens to sit at index 0: this list grows (the
  // changed-set granularity note now leads it), and selecting by position silently drops whichever
  // disclosure a later change prepends.
  for (const caveat of r.caveats) {
    if (!isGranularityCaveat(caveat)) lines.push('   ' + caveat);
  }
  if (r.carried && r.carried.length > 0) {
    for (const c of r.carried.slice(0, 5)) lines.push(`   ↔ ${c.reason}: ${c.from} → ${c.to} (${c.basis})`);
    if (r.carried.length > 5) lines.push(`   … and ${r.carried.length - 5} more carried rename(s)/move(s)`);
  }
  lines.push('');
  return lines.join('\n');
}

export interface BriefingSinceCliOptions {
  cwd?: string;
  base?: string;
  filePattern?: string;
  max?: number;
  json?: boolean;
}

export async function runBriefingSinceCli(opts: BriefingSinceCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();

  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await dispatchTool('briefing_since', {
      directory: cwd,
      baseRef: opts.base,
      filePattern: opts.filePattern,
      maxResults: opts.max,
    }, cwd);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }

  if (result && typeof result === 'object' && 'error' in result) {
    const error = (result as { error: string }).error;
    if (opts.json) await writeStdout(JSON.stringify({ status: 'unavailable', error }, null, 2) + '\n');
    else logger.warning(`briefing-since: ${error}`);
    return 1;
  }

  if (opts.json) {
    await writeStdout(JSON.stringify(result, null, 2) + '\n');
  } else {
    await writeStdout(renderHuman(result as BriefingResult) + '\n');
  }
  return 0;
}

export const briefingSinceCommand = new Command('briefing-since')
  .description('Ranked, labeled briefing of what changed since a base ref — which changes structurally matter (surprising/hub/chokepoint/ordinary). Read-only, deterministic, never blocks.')
  .option('--base <ref>', 'Git ref to brief changes SINCE (e.g. main, HEAD~20). Default: auto (main → master → HEAD~1).')
  .option('--file-pattern <substr>', 'Region scope — only brief changes whose file path contains this substring')
  .option('--max <n>', 'Bound on briefed symbols, highest-tier-first (default 50, capped 200)', (v) => parseInt(v, 10))
  .option('--json', 'Emit the briefing as JSON', false)
  .action(async (opts: { base?: string; filePattern?: string; max?: number; json?: boolean }) => {
    const code = await runBriefingSinceCli({
      base: opts.base,
      filePattern: opts.filePattern,
      max: opts.max,
      json: opts.json,
    });
    process.exit(code);
  });
