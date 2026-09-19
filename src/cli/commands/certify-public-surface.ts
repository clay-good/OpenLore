/**
 * `openlore certify-public-surface` — the public API surface contract's CLI surface
 * (change: add-public-api-surface-contract).
 *
 * With no `--base` it prints the public surface (exported symbols + signatures); with
 * `--base <ref>` it prints the deterministic breaking-change verdict for the working
 * tree, each breaking change paired with the in-repo consumers it breaks. Deterministic, offline.
 * Advisory: it is a report, never a gate (it does not block). Its one write is `--accept`, which
 * records the current breaking findings, with a required justification, in the checked-in
 * `.openlore/public-surface-baseline.jsonl` (change: add-public-surface-acceptance-baseline).
 */

import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';
import {
  isAcceptableFinding,
  justificationError,
  writeAcceptedBreakages,
} from '../../core/services/mcp-handlers/public-surface-baseline.js';
import { verifyDecisionCurrent } from '../../core/services/mcp-handlers/claim-verification.js';
import type { GovernanceFinding } from '../../core/services/mcp-handlers/enforcement-policy.js';

interface SurfaceChangeOut {
  changeKind: string;
  class: 'breaking' | 'non-breaking' | 'potentially-breaking';
  name: string;
  file: string;
  before?: string;
  after?: string;
  reasons: string[];
  ruleCodes?: string[];
  rename?: { to: string; file: string };
  consumers?: Array<{ name: string; file: string }>;
  consumersTruncated?: number;
  crossRepoConsumers?: Array<{ repo: string; name: string; file: string }>;
  consumerCount?: number;
  breakingClass?: 'breaking-consumed' | 'breaking-unconsumed-in-index';
}

interface AcceptedOut {
  code: string;
  subject: string;
  justification: string;
  decision?: string;
}

interface SurfaceResult {
  mode: 'surface';
  surface: Array<{ name: string; file: string; kind: string; signature?: string }>;
  total: number;
  truncated: { omitted: number } | null;
}

interface DiffResult {
  mode: 'diff';
  base: string;
  head: string;
  baseRefFallback?: { requested: string; resolved: string };
  overall: 'breaking' | 'non-breaking' | 'potentially-breaking';
  summary: { breaking: number; potentiallyBreaking: number; nonBreaking: number; breakingConsumed?: number; breakingUnconsumedInIndex?: number; accepted?: number };
  changes: SurfaceChangeOut[];
  breaking: SurfaceChangeOut[];
  suggestedBump?: 'major' | 'minor' | 'patch' | null;
  suggestedBumpWithheld?: string;
  findings?: GovernanceFinding[];
  consumerCensus?: { scope: 'in-repo' | 'federation'; reposConsulted?: string[]; reposSkipped?: Array<{ name: string }>; unknownRepos?: string[] };
  baseline?: {
    path: string;
    error?: string;
    entries?: number;
    accepted: AcceptedOut[];
    stale: Array<AcceptedOut & { reason: string; supersededBy?: string }>;
    unmatched: Array<{ code: string; subject: string }>;
  };
  soundness: { posture: string; languages: string };
  confidenceBoundary?: { knownUnknowable?: Array<{ detail: string }>; integrity?: { verdict?: string; detail?: string }; staleness?: { detail?: string } };
}

const ICON: Record<string, string> = { breaking: '🛑', 'potentially-breaking': '⚠️', 'non-breaking': '✅' };

function renderSurface(r: SurfaceResult): string {
  const lines: string[] = ['', `📦 Public API surface — ${r.total} exported symbol(s)`];
  for (const s of r.surface) {
    lines.push(`   • ${s.name}  [${s.kind}]  ${s.file}${s.signature ? `\n        ${s.signature}` : ''}`);
  }
  if (r.truncated) lines.push(`   … and ${r.truncated.omitted} more (raise --max to see them)`);
  lines.push('');
  return lines.join('\n');
}

function renderDiff(r: DiffResult): string {
  const lines: string[] = ['', `📐 Public API surface contract — verdict: ${ICON[r.overall]} ${r.overall.toUpperCase()}`];
  lines.push(`   base: ${r.base} → ${r.head}`);
  if (r.baseRefFallback) lines.push(`   ⚠ requested base "${r.baseRefFallback.requested}" did not resolve — certified against "${r.baseRefFallback.resolved}" (--allow-base-fallback)`);
  lines.push(`   ${r.summary.breaking} breaking · ${r.summary.potentiallyBreaking} potentially-breaking · ${r.summary.nonBreaking} non-breaking`);
  if (r.summary.breaking > 0 && r.summary.breakingConsumed !== undefined) {
    const scope = r.consumerCensus?.scope === 'federation' ? 'in this repo or a federated repo' : 'in this repo';
    lines.push(`   breaking: ${r.summary.breakingConsumed} consumed, ${r.summary.breakingUnconsumedInIndex ?? 0} with no indexed consumer ${scope} (not "safe")`);
  }
  if (r.consumerCensus?.scope === 'federation') {
    lines.push(`   federation: checked ${r.consumerCensus.reposConsulted?.length ? r.consumerCensus.reposConsulted.join(', ') : 'no repo'}${r.consumerCensus.reposSkipped?.length ? `; skipped ${r.consumerCensus.reposSkipped.map((x) => x.name).join(', ')}` : ''}${r.consumerCensus.unknownRepos?.length ? `; unknown ${r.consumerCensus.unknownRepos.join(', ')}` : ''}`);
  }
  if (r.baseline?.error) lines.push(`   ⚠ ${r.baseline.path}: ${r.baseline.error}`);
  else if (r.baseline) lines.push(`   accepted baseline ${r.baseline.path}: ${r.baseline.accepted.length} accepted · ${r.baseline.stale.length} stale · ${r.baseline.unmatched.length} unmatched`);
  if (r.suggestedBump) lines.push(`   suggested version bump: ${r.suggestedBump}`);
  else if (r.suggestedBump === null) lines.push(`   suggested version bump: withheld (${r.suggestedBumpWithheld ?? 'compatibility not proven'})`);
  if (r.confidenceBoundary?.integrity?.detail) lines.push(`   ⚠ index integrity ${r.confidenceBoundary.integrity.verdict}: ${r.confidenceBoundary.integrity.detail}`);
  if (r.confidenceBoundary?.staleness?.detail) lines.push(`   ⚠ ${r.confidenceBoundary.staleness.detail}`);
  const ranked = [...r.changes].sort((a, b) => order(a.class) - order(b.class));
  for (const c of ranked) {
    lines.push(`   ${ICON[c.class]} ${c.class}  ${c.name}  (${c.changeKind})  ${c.file}${c.ruleCodes?.length ? `  [${c.ruleCodes.join(', ')}]` : ''}`);
    for (const reason of c.reasons) lines.push(`        - ${reason}`);
    const breaking = r.breaking.find((b) => b.name === c.name && b.file === c.file && b.changeKind === c.changeKind);
    if (breaking?.breakingClass) lines.push(`        ${breaking.breakingClass}`);
    if (breaking?.consumers?.length) {
      lines.push(`        breaks ${breaking.consumers.length}${breaking.consumersTruncated ? `+${breaking.consumersTruncated}` : ''} in-repo consumer(s): ${breaking.consumers.slice(0, 5).map((x) => x.name).join(', ')}${breaking.consumers.length > 5 ? ' …' : ''}`);
    }
    if (breaking?.crossRepoConsumers?.length) {
      lines.push(`        breaks ${breaking.crossRepoConsumers.length} consumer(s) in federated repos: ${breaking.crossRepoConsumers.slice(0, 5).map((x) => `${x.repo}:${x.name}`).join(', ')}${breaking.crossRepoConsumers.length > 5 ? ' …' : ''}`);
    }
    const subject = `${c.file}::${c.name}`;
    for (const a of r.baseline?.accepted ?? []) {
      if (a.subject === subject) lines.push(`        accepted ${a.code}${a.decision ? ` (decision ${a.decision})` : ''}: ${a.justification}`);
    }
    for (const a of r.baseline?.stale ?? []) {
      if (a.subject === subject) lines.push(`        ⚠ stale acceptance of ${a.code}, still reported: ${a.reason}`);
    }
  }
  for (const ku of r.confidenceBoundary?.knownUnknowable ?? []) lines.push(`   ⚠ ${ku.detail}`);
  lines.push('');
  return lines.join('\n');
}

function order(cls: string): number {
  return cls === 'breaking' ? 0 : cls === 'potentially-breaking' ? 1 : 2;
}

export interface CertifyPublicSurfaceCliOptions {
  cwd?: string;
  base?: string;
  max?: number;
  json?: boolean;
  allowBaseFallback?: boolean;
  federation?: boolean;
  federationRepos?: string[];
  /** Record the current breaking findings as accepted (requires `base` and `justification`). */
  accept?: boolean;
  justification?: string;
  /** Anchor the acceptance to this decision id; it must be current. */
  decision?: string;
}

async function refuse(opts: CertifyPublicSurfaceCliOptions, error: string): Promise<number> {
  if (opts.json) await writeStdout(JSON.stringify({ status: 'refused', error }, null, 2) + '\n');
  else logger.warning(`certify-public-surface: ${error}`);
  return 1;
}

export async function runCertifyPublicSurfaceCli(opts: CertifyPublicSurfaceCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const decision = opts.decision?.trim().toLowerCase();
  if (!opts.accept && (opts.justification !== undefined || opts.decision !== undefined)) {
    return refuse(opts, '--justification and --decision only apply with --accept');
  }
  if (opts.accept) {
    // Refuse before any analysis runs: an acceptance without a reason is never written.
    if (!opts.base) return refuse(opts, '--accept needs --base <ref>: it accepts the breaking findings of that diff');
    const invalid = justificationError(opts.justification);
    if (invalid !== null) return refuse(opts, `refusing to accept: ${invalid}`);
    if (decision !== undefined) {
      const check = await verifyDecisionCurrent(cwd, decision) as { verdict?: string; reason?: string };
      if (check.verdict !== 'confirmed') return refuse(opts, `refusing to anchor to decision ${decision}: ${check.reason ?? 'it is not current'}`);
    }
  }
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await dispatchTool('certify_public_surface', {
      directory: cwd,
      baseRef: opts.base,
      maxResults: opts.max,
      allowBaseFallback: opts.allowBaseFallback,
      ...(opts.federation ? { federation: true } : {}),
      ...(opts.federationRepos?.length ? { federationRepos: opts.federationRepos } : {}),
    }, cwd);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }

  if (result && typeof result === 'object' && 'error' in result) {
    const error = (result as { error: string }).error;
    if (opts.json) await writeStdout(JSON.stringify({ status: 'unavailable', error }, null, 2) + '\n');
    else logger.warning(`certify-public-surface: ${error}`);
    return 1;
  }

  if (opts.accept) return acceptFindings(cwd, opts, result as DiffResult, decision);

  if (opts.json) {
    await writeStdout(JSON.stringify(result, null, 2) + '\n');
  } else {
    const r = result as SurfaceResult | DiffResult;
    await writeStdout((r.mode === 'diff' ? renderDiff(r as DiffResult) : renderSurface(r as SurfaceResult)) + '\n');
  }
  return 0;
}

/** Write the diff's unaccepted breaking findings to the baseline. */
async function acceptFindings(cwd: string, opts: CertifyPublicSurfaceCliOptions, r: DiffResult, decision: string | undefined): Promise<number> {
  // A baseline that could not be read is never overwritten: that would erase its entries.
  if (r.baseline?.error) return refuse(opts, `refusing to accept: ${r.baseline.error}`);
  const acceptable = (r.findings ?? []).filter(isAcceptableFinding);
  if (acceptable.length === 0) {
    const message = 'no unaccepted breaking finding in this diff; nothing to accept';
    if (opts.json) await writeStdout(JSON.stringify({ status: 'nothing-to-accept', message }, null, 2) + '\n');
    else await writeStdout(`\n${message}\n\n`);
    return 0;
  }
  let written;
  try {
    written = await writeAcceptedBreakages(cwd, acceptable, opts.justification ?? '', decision);
  } catch (error) {
    return refuse(opts, `could not write the baseline: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (opts.json) {
    await writeStdout(JSON.stringify({ status: 'accepted', ...written }, null, 2) + '\n');
  } else {
    const lines = ['', `✍️  Accepted ${written.added.length} breaking finding(s)${written.replaced ? `, re-accepted ${written.replaced}` : ''} in ${written.path}`];
    for (const entry of written.added) lines.push(`   • ${entry.code}  ${entry.subject}`);
    lines.push('   Commit this file so the acceptance is reviewed with the change.', '');
    await writeStdout(lines.join('\n') + '\n');
  }
  return 0;
}

export const certifyPublicSurfaceCommand = new Command('certify-public-surface')
  .description('Certify the public API surface (no --base) or the breaking-change verdict for the working-tree diff (--base <ref>): removed/renamed exports, incompatible signatures, each breaking change with its consumers. --accept records intended breakages with a justification. Deterministic, never blocks.')
  .option('--base <ref>', 'Diff the working tree\'s public surface against this git ref (e.g. HEAD, main) for a breaking-change verdict')
  .option('--max <n>', 'Limit the surface listing in surface mode (default 200, capped 500)', (v) => parseInt(v, 10))
  .option('--allow-base-fallback', 'Accept the disclosed main → master → HEAD~1 fallback when --base does not resolve, instead of erroring', false)
  .option('--federation', 'Also count consumers in indexed sibling repos (.openlore/federation.json)', false)
  .option('--federation-repos <names>', 'Limit --federation to these comma-separated registry repo names', (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .option('--accept', 'Record this diff\'s breaking findings as intentionally accepted in .openlore/public-surface-baseline.jsonl (requires --base and --justification)', false)
  .option('--justification <text>', 'Why the accepted breakage is intended (required with --accept)')
  .option('--decision <id>', 'Anchor the acceptance to a current decision id; it expires when that decision is superseded')
  .option('--json', 'Emit the result as JSON', false)
  .action(async (opts: {
    base?: string; max?: number; json?: boolean; allowBaseFallback?: boolean; federation?: boolean;
    federationRepos?: string[]; accept?: boolean; justification?: string; decision?: string;
  }) => {
    const code = await runCertifyPublicSurfaceCli({
      base: opts.base,
      max: opts.max,
      json: opts.json,
      allowBaseFallback: opts.allowBaseFallback,
      federation: opts.federation,
      federationRepos: opts.federationRepos,
      accept: opts.accept,
      justification: opts.justification,
      decision: opts.decision,
    });
    process.exit(code);
  });
