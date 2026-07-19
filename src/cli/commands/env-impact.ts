/**
 * `openlore env-impact` — the env-impact tool's CLI surface
 * (change: add-env-config-impact-graph).
 *
 * Prints what breaks if an environment variable is removed or renamed (the same
 * conclusion the `analyze_env_impact` MCP tool returns) so a developer can answer
 * "what reads this, and what is the blast radius?" without an MCP client.
 * Read-only, deterministic, offline, never blocks.
 *
 *   openlore env-impact --name DATABASE_URL
 *   openlore env-impact --name PORT --max-depth 5
 *   openlore env-impact --name SECRET_KEY --json
 */

import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { toCliVocabulary } from '../surface-vocabulary.js';
import { handleAnalyzeEnvImpact } from '../../core/services/mcp-handlers/env-impact.js';

interface ReadSiteView {
  file: string;
  line: number;
  required: boolean;
  enclosingFunction: string | null;
}

export interface EnvImpactView {
  error?: string;
  candidates?: string[];
  hint?: string;
  variable?: {
    name: string;
    required: boolean;
    hasDefault: boolean;
    declaredInEnvFile: boolean;
    description?: string;
    files: string[];
  };
  summary?: {
    readSites: number;
    requiredReadSites: number;
    moduleLevelReadSites: number;
    readingFunctions: number;
    affectedFunctions: number;
    affectedFiles: number;
    reachingTests: number;
  };
  readSites?: ReadSiteView[];
  affectedFunctions?: Array<{ symbol: string; file: string; distance: number }>;
  reachingTests?: Array<{ test: string; file: string }>;
  affectedFiles?: string[];
  staleness?: { indexCommit: string; filesChangedSince: number; detail: string };
  boundaries?: string[];
  note?: string;
}

export function renderHuman(r: EnvImpactView): string {
  const lines: string[] = [''];
  lines.push('🔧 Env-var impact');
  const v = r.variable;
  if (v) {
    const flags = [v.required ? 'required' : null, v.hasDefault ? 'has-default' : null].filter(Boolean).join(', ');
    lines.push(`   variable: ${v.name}${flags ? ` [${flags}]` : ''}`);
    if (v.description) lines.push(`   ${v.description}`);
  }

  const s = r.summary;
  if (s) {
    lines.push(
      `   ${s.readSites} read site${s.readSites === 1 ? '' : 's'} (${s.requiredReadSites} required, ` +
        `${s.moduleLevelReadSites} module-level) · ${s.affectedFunctions} affected function${s.affectedFunctions === 1 ? '' : 's'} · ` +
        `${s.affectedFiles} file${s.affectedFiles === 1 ? '' : 's'} · ${s.reachingTests} test${s.reachingTests === 1 ? '' : 's'}`,
    );
  }

  for (const site of r.readSites ?? []) {
    const where = site.enclosingFunction ?? '(module-level)';
    const req = site.required ? 'required' : 'has-fallback';
    lines.push(`     ${site.file}:${site.line}  ${where}  [${req}]`);
  }
  if ((r.readSites ?? []).length === 0) lines.push('     (no source read sites found)');

  if ((r.affectedFunctions ?? []).length > 0) {
    lines.push('   blast radius (upstream callers):');
    for (const f of r.affectedFunctions ?? []) lines.push(`     d${f.distance}  ${f.symbol}`);
  }
  if ((r.reachingTests ?? []).length > 0) {
    lines.push('   tests to run:');
    for (const t of r.reachingTests ?? []) lines.push(`     ${t.test}  (${t.file})`);
  }

  for (const b of r.boundaries ?? []) lines.push(`   · ${b}`);
  lines.push('');
  return lines.join('\n');
}

export interface EnvImpactCliOptions {
  cwd?: string;
  name?: string;
  maxDepth?: number;
  json?: boolean;
}

export async function runEnvImpactCli(opts: EnvImpactCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await handleAnalyzeEnvImpact({
      directory: cwd,
      name: opts.name,
      maxDepth: opts.maxDepth,
    });
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }

  if (result && typeof result === 'object' && 'error' in result) {
    const r = result as EnvImpactView;
    if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
    else {
      logger.warning(`env-impact: ${toCliVocabulary(r.error ?? '')}`);
      if (r.candidates?.length) logger.info('candidates', r.candidates.join(', '));
      if (r.hint) logger.info('hint', toCliVocabulary(r.hint));
    }
    return 1;
  }

  if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
  else await writeStdout(toCliVocabulary(renderHuman(result as EnvImpactView)) + '\n');
  return 0;
}

export const envImpactCommand = new Command('env-impact')
  .description('Analyze what breaks if an environment variable is removed or renamed: read sites, blast radius, tests (TS/JS/Python/Go/Ruby). Read-only, deterministic, never blocks.')
  .option('--name <var>', 'The environment variable to analyze, e.g. DATABASE_URL')
  .option('--max-depth <n>', 'Backward-reachability depth bound (default 12, clamped to [1, 30])', (v) => parseInt(v, 10))
  .option('--json', 'Emit the result as JSON', false)
  .action(async (opts: { name?: string; maxDepth?: number; json?: boolean }) => {
    const code = await runEnvImpactCli({
      name: opts.name,
      maxDepth: opts.maxDepth,
      json: opts.json,
    });
    process.exit(code);
  });
