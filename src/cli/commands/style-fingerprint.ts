/**
 * `openlore style-fingerprint` — the codebase style fingerprint's CLI surface
 * (change: add-codebase-style-fingerprint).
 *
 * Prints the DESCRIPTIVE, deterministic idiom profile (the same conclusion the
 * `get_style_fingerprint` MCP tool returns) so a developer or reviewer can read the house style
 * without an MCP client. Repository profile by default; `--community <id>` for a region, `--file
 * <path>` for one file. Read-only, offline, never blocks. Descriptive, not prescriptive — it
 * measures what the code IS, not what it should be.
 */

import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { handleGetStyleFingerprint } from '../../core/services/mcp-handlers/style-fingerprint.js';
import { IDIOM_KEYS, type LanguageProfile, type IdiomSignal } from '../../core/analyzer/style-fingerprint.js';

interface RepoResult {
  scope: 'repository' | 'region' | 'file';
  evidenceFloor: number;
  languagesAnalyzed?: string[];
  byLanguage?: LanguageProfile[];
  profile?: LanguageProfile;
  communityId?: string;
  label?: string;
  filePath?: string;
  region?: string;
  regionCount?: number;
  note?: string;
}

function renderSignal(sig: IdiomSignal | undefined): string {
  if (!sig) return '—';
  if ('signal' in sig) return `· (${sig.reason})`;
  return `${sig.dominant} ${sig.ratio} (n=${sig.samples})`;
}

function renderLanguage(p: LanguageProfile): string[] {
  const lines = [`   ${p.language}  (${p.functionsSampled} fn sampled)`];
  for (const key of IDIOM_KEYS) {
    const sig = p.idioms[key];
    if (sig === undefined) continue;
    lines.push(`     ${key.padEnd(16)} ${renderSignal(sig)}`);
  }
  return lines;
}

function renderHuman(r: RepoResult): string {
  const lines: string[] = [''];
  lines.push('🎨 Codebase style fingerprint (descriptive, not prescriptive)');
  if (r.scope === 'repository') {
    lines.push(`   scope: repository · languages: ${(r.languagesAnalyzed ?? []).join(', ') || '(none)'} · regions: ${r.regionCount ?? 0} · floor: ${r.evidenceFloor}`);
    for (const p of r.byLanguage ?? []) lines.push(...renderLanguage(p));
  } else if (r.scope === 'region') {
    lines.push(`   scope: region ${r.communityId}${r.label ? ` (${r.label})` : ''} · floor: ${r.evidenceFloor}`);
    for (const p of r.byLanguage ?? []) lines.push(...renderLanguage(p));
  } else {
    lines.push(`   scope: file ${r.filePath}${r.region ? ` · region ${r.region}` : ''} · floor: ${r.evidenceFloor}`);
    if (r.profile) lines.push(...renderLanguage(r.profile));
  }
  if (r.note) lines.push(`   ⚠ ${r.note}`);
  lines.push('');
  return lines.join('\n');
}

export interface StyleFingerprintCliOptions {
  cwd?: string;
  community?: string;
  file?: string;
  language?: string;
  json?: boolean;
}

export async function runStyleFingerprintCli(opts: StyleFingerprintCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await handleGetStyleFingerprint({
      directory: cwd,
      communityId: opts.community,
      filePath: opts.file,
      language: opts.language,
    });
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }

  if (result && typeof result === 'object' && 'error' in result) {
    const error = (result as { error: string }).error;
    if (opts.json) await writeStdout(JSON.stringify({ status: 'unavailable', error }, null, 2) + '\n');
    else logger.warning(`style-fingerprint: ${error}`);
    return 1;
  }

  if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
  else await writeStdout(renderHuman(result as RepoResult) + '\n');
  return 0;
}

export const styleFingerprintCommand = new Command('style-fingerprint')
  .description('Descriptive per-language idiom profile (function form, binding, naming case, …) for the repo, a region, or a file. Read-only, deterministic, never blocks.')
  .option('--community <id>', 'Profile one community/region (list ids with the get_map tool)')
  .option('--file <path>', 'Profile a single file (exact path or a unique path suffix)')
  .option('--language <name>', 'Restrict the output to one language (e.g. TypeScript)')
  .option('--json', 'Emit the profile as JSON', false)
  .action(async (opts: { community?: string; file?: string; language?: string; json?: boolean }) => {
    const code = await runStyleFingerprintCli({
      community: opts.community,
      file: opts.file,
      language: opts.language,
      json: opts.json,
    });
    process.exit(code);
  });
