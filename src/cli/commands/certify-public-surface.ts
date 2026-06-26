/**
 * `openlore certify-public-surface` — the public API surface contract's CLI surface
 * (change: add-public-api-surface-contract).
 *
 * With no `--base` it prints the public surface (exported symbols + signatures); with
 * `--base <ref>` it prints the deterministic breaking-change verdict for the working
 * tree, each breaking change paired with the in-repo consumers it breaks. Read-only,
 * deterministic, offline. Advisory: it is a report, never a gate (it does not block).
 */

import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { handleCertifyPublicSurface } from '../../core/services/mcp-handlers/public-surface.js';

interface SurfaceChangeOut {
  changeKind: string;
  class: 'breaking' | 'non-breaking' | 'potentially-breaking';
  name: string;
  file: string;
  before?: string;
  after?: string;
  reasons: string[];
  rename?: { to: string; file: string };
  consumers?: Array<{ name: string; file: string }>;
  consumersTruncated?: number;
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
  overall: 'breaking' | 'non-breaking' | 'potentially-breaking';
  summary: { breaking: number; potentiallyBreaking: number; nonBreaking: number };
  changes: SurfaceChangeOut[];
  breaking: SurfaceChangeOut[];
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
  lines.push(`   ${r.summary.breaking} breaking · ${r.summary.potentiallyBreaking} potentially-breaking · ${r.summary.nonBreaking} non-breaking`);
  if (r.confidenceBoundary?.integrity?.detail) lines.push(`   ⚠ index integrity ${r.confidenceBoundary.integrity.verdict}: ${r.confidenceBoundary.integrity.detail}`);
  if (r.confidenceBoundary?.staleness?.detail) lines.push(`   ⚠ ${r.confidenceBoundary.staleness.detail}`);
  const ranked = [...r.changes].sort((a, b) => order(a.class) - order(b.class));
  for (const c of ranked) {
    lines.push(`   ${ICON[c.class]} ${c.class}  ${c.name}  (${c.changeKind})  ${c.file}`);
    for (const reason of c.reasons) lines.push(`        - ${reason}`);
    const breaking = r.breaking.find((b) => b.name === c.name && b.file === c.file && b.changeKind === c.changeKind);
    if (breaking?.consumers?.length) {
      lines.push(`        breaks ${breaking.consumers.length}${breaking.consumersTruncated ? `+${breaking.consumersTruncated}` : ''} in-repo consumer(s): ${breaking.consumers.slice(0, 5).map((x) => x.name).join(', ')}${breaking.consumers.length > 5 ? ' …' : ''}`);
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
}

export async function runCertifyPublicSurfaceCli(opts: CertifyPublicSurfaceCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await handleCertifyPublicSurface({ directory: cwd, baseRef: opts.base, maxResults: opts.max });
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

  if (opts.json) {
    await writeStdout(JSON.stringify(result, null, 2) + '\n');
  } else {
    const r = result as SurfaceResult | DiffResult;
    await writeStdout((r.mode === 'diff' ? renderDiff(r as DiffResult) : renderSurface(r as SurfaceResult)) + '\n');
  }
  return 0;
}

export const certifyPublicSurfaceCommand = new Command('certify-public-surface')
  .description('Certify the public API surface (no --base) or the breaking-change verdict for the working-tree diff (--base <ref>): removed/renamed exports, incompatible signatures, each breaking change with its in-repo consumers. Read-only, deterministic, never blocks.')
  .option('--base <ref>', 'Diff the working tree\'s public surface against this git ref (e.g. HEAD, main) for a breaking-change verdict')
  .option('--max <n>', 'Limit the surface listing in surface mode (default 200, capped 500)', (v) => parseInt(v, 10))
  .option('--json', 'Emit the result as JSON', false)
  .action(async (opts: { base?: string; max?: number; json?: boolean }) => {
    const code = await runCertifyPublicSurfaceCli({ base: opts.base, max: opts.max, json: opts.json });
    process.exit(code);
  });
