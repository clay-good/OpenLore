/**
 * `openlore certify-service-contract` — the CLI face of `certify_service_contract`
 * (change: add-service-contract-certification).
 *
 * No `--base`: the operations each OpenAPI / Swagger document declares, and parity against the
 * indexed route handlers. `--base <ref>`: the breaking-change verdict for each changed contract
 * element, with the client call sites in this repository that call it. Read-only; advisory.
 */

import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';

export interface CertifyServiceContractCliOptions {
  cwd?: string;
  base?: string;
  max?: number;
  allowBaseFallback?: boolean;
  json?: boolean;
}

interface Finding { code: string; severity: string; subject: string; message: string; enforcementClass?: string }
interface Change { address: string; rule: string; class: string; element?: string; detail: string; consumers: Array<{ file: string; line: number }> }

/** Every string in `v`, sanitized for one terminal line (control characters and line breaks removed). */
function clean(v: unknown): unknown {
  if (typeof v === 'string') return safe(v);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  return v;
}

/** Plain-text rendering of the result. Values are sanitized before they are placed in lines. */
export function renderServiceContract(result: Record<string, unknown>): string {
  const r = clean(result) as Record<string, unknown>;
  const lines: string[] = [];
  const specs = (r.specs as Array<{ file: string; format: string; operations: number }>) ?? [];
  if (!specs.length) lines.push('No OpenAPI or Swagger document found.');
  for (const s of specs) lines.push(`📄 ${s.file} (${s.format}): ${s.operations} operation(s)`);
  const parity = r.parity as { assessed: boolean; reason?: string; matched?: number; declaredUnimplemented?: number; implementedUndeclared?: number };
  if (parity?.assessed) {
    lines.push(`Parity: ${parity.matched} matched, ${parity.declaredUnimplemented} declared but not served, ${parity.implementedUndeclared} served but not declared`);
  } else if (parity?.reason) lines.push(`Parity not assessed: ${parity.reason}`);
  const changes = r.changes as { total: number; items: Change[]; omitted?: number; suggestedBump?: string | null; suggestedBumpWithheld?: string; baseRefFallback?: { requested: string; resolved: string } } | undefined;
  if (changes) {
    lines.push('', `Changes since the merge-base: ${changes.total}`);
    if (changes.baseRefFallback) lines.push(`⚠ base '${changes.baseRefFallback.requested}' did not resolve; compared with '${changes.baseRefFallback.resolved}'`);
    for (const c of changes.items) {
      lines.push(`  ${c.class.padEnd(20)} ${c.rule.padEnd(30)} ${c.address}${c.element ? ` ${c.element}` : ''}`);
      for (const w of c.consumers.slice(0, 5)) lines.push(`      called from ${w.file}:${w.line}`);
    }
    if (changes.omitted) lines.push(`  … ${changes.omitted} more`);
    lines.push(changes.suggestedBump ? `Suggested version bump: ${changes.suggestedBump}` : `Suggested version bump withheld: ${changes.suggestedBumpWithheld ?? 'not proven'}`);
  }
  const findings = (r.findings as Finding[]) ?? [];
  if (findings.length) {
    lines.push('', 'Findings:');
    for (const f of findings) lines.push(`  [${f.enforcementClass ?? 'advisory'}] ${f.code}: ${f.message}`);
  }
  for (const n of (r.notAssessed as Array<{ file: string; reason: string }>) ?? []) lines.push(`Not assessed: ${n.file} (${n.reason})`);
  for (const b of (r.boundaries as string[]) ?? []) lines.push(`Boundary: ${b}`);
  return lines.join('\n');
}

export async function runCertifyServiceContractCli(opts: CertifyServiceContractCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await dispatchTool('certify_service_contract', {
      directory: cwd, baseRef: opts.base, maxResults: opts.max, allowBaseFallback: opts.allowBaseFallback,
    }, cwd);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }
  if (result && typeof result === 'object' && 'error' in result) {
    const error = (result as { error: string }).error;
    if (opts.json) await writeStdout(JSON.stringify({ status: 'unavailable', error }, null, 2) + '\n');
    else logger.warning(`certify-service-contract: ${safe(error)}`);
    return 1;
  }
  if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
  else await writeStdout(renderServiceContract(result as Record<string, unknown>) + '\n');
  return 0;
}

export const certifyServiceContractCommand = new Command('certify-service-contract')
  .description('Certify OpenAPI/Swagger contracts against the code: declared operations and parity with the indexed route handlers (no --base), or the breaking-change verdict for each changed element with its in-repo callers (--base <ref>). Read-only, advisory.')
  .option('--base <ref>', 'Compare the specifications with this ref (its merge-base with HEAD)')
  .option('--max <n>', 'Cap on each listed item kind (default 100, max 1000)', (v) => parseInt(v, 10))
  .option('--allow-base-fallback', 'When --base does not resolve, compare with the default branch instead of erroring (disclosed)', false)
  .option('--json', 'Emit the result as JSON', false)
  .action(async (opts: { base?: string; max?: number; allowBaseFallback?: boolean; json?: boolean }) => {
    process.exit(await runCertifyServiceContractCli({ base: opts.base, max: opts.max, allowBaseFallback: opts.allowBaseFallback, json: opts.json }));
  });
