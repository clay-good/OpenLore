/**
 * `openlore find-clones` — the clone-query tool's CLI surface (change: add-clone-query-tool).
 *
 * Prints the existing clones of a single symbol or snippet (the same conclusion the `find_clones`
 * MCP tool returns) so a developer can ask "does a near-duplicate of THIS already exist?" without an
 * MCP client. Read-only, deterministic, offline, never blocks.
 *
 *   openlore find-clones --symbol handleFoo
 *   openlore find-clones --symbol handleFoo::src/handlers/foo.ts --min 0.6
 *   openlore find-clones --snippet "$(cat candidate.ts)"
 */

import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { toCliVocabulary } from '../surface-vocabulary.js';
import { handleFindClones } from '../../core/services/mcp-handlers/clone-query.js';

interface CloneMatchView {
  type: 'exact' | 'structural' | 'near';
  similarity: number;
  file: string;
  functionName: string;
  className?: string;
  startLine: number;
  endLine: number;
  language?: string;
}

export interface CloneQueryView {
  error?: string;
  candidates?: string[];
  hint?: string;
  query?: Record<string, unknown>;
  belowThreshold?: boolean;
  similarityFloor?: number;
  comparedAgainst?: number;
  htmlExcluded?: number;
  summary?: { exact: number; structural: number; near: number; total: number };
  matches?: CloneMatchView[];
  note?: string;
}

export function renderHuman(r: CloneQueryView): string {
  const lines: string[] = [''];
  lines.push('🧬 Clone query');
  const q = r.query ?? {};
  if (q.mode === 'symbol') lines.push(`   query: symbol ${String(q.symbol)} (lines ${q.startLine}-${q.endLine})`);
  else if (q.mode === 'snippet') lines.push(`   query: snippet (${q.lines} lines)`);

  if (r.belowThreshold) {
    lines.push(`   ⚠ ${r.note ?? 'Query below the evidence floor — too small to compare.'}`);
    lines.push('');
    return lines.join('\n');
  }

  const s = r.summary ?? { exact: 0, structural: 0, near: 0, total: 0 };
  lines.push(
    `   compared against ${r.comparedAgainst ?? 0} functions · floor ${r.similarityFloor} · ` +
      `${s.total} match${s.total === 1 ? '' : 'es'} (exact ${s.exact}, structural ${s.structural}, near ${s.near})`,
  );
  const queryLang = typeof (r.query ?? {}).language === 'string' ? (r.query as { language: string }).language : undefined;
  for (const m of r.matches ?? []) {
    const where = m.className ? `${m.className}.${m.functionName}` : m.functionName;
    // Flag a cross-language match (the query is one language, this match another) — the documented
    // out-of-scope case made visible exactly when it occurs.
    const crossLang = queryLang && m.language && m.language !== queryLang ? `  ⚠ ${m.language}` : '';
    lines.push(`     ${m.type.padEnd(10)} ${m.similarity.toFixed(2)}  ${where}  ${m.file}:${m.startLine}-${m.endLine}${crossLang}`);
  }
  if ((r.matches ?? []).length === 0) lines.push('     (no clones found above the floor)');
  if (r.htmlExcluded) lines.push(`   · ${r.htmlExcluded} HTML inline-script symbol(s) excluded from comparison`);
  lines.push('');
  return lines.join('\n');
}

export interface FindClonesCliOptions {
  cwd?: string;
  symbol?: string;
  snippet?: string;
  min?: number;
  max?: number;
  json?: boolean;
}

export async function runFindClonesCli(opts: FindClonesCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await handleFindClones({
      directory: cwd,
      symbol: opts.symbol,
      snippet: opts.snippet,
      minSimilarity: opts.min,
      maxResults: opts.max,
    });
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }

  if (result && typeof result === 'object' && 'error' in result) {
    const r = result as CloneQueryView;
    if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
    else {
      logger.warning(`find-clones: ${toCliVocabulary(r.error ?? '')}`);
      if (r.candidates?.length) logger.info('candidates', r.candidates.join(', '));
      if (r.hint) logger.info('hint', toCliVocabulary(r.hint));
    }
    return 1;
  }

  if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
  else await writeStdout(toCliVocabulary(renderHuman(result as CloneQueryView)) + '\n');
  return 0;
}

export const findClonesCommand = new Command('find-clones')
  .description('Find existing clones of a single function symbol or code snippet (reuse instead of reinventing). Read-only, deterministic, never blocks.')
  .option('--symbol <name>', 'A function in the index: its name, or name::path. Provide exactly one of --symbol / --snippet')
  .option('--snippet <code>', 'Raw code to compare (need not be in the index). Provide exactly one of --symbol / --snippet')
  .option('--min <ratio>', 'Near-clone similarity floor (default 0.7, clamped to [0.1, 1])', parseFloat)
  .option('--max <n>', 'Cap on returned matches (default 25, max 200)', (v) => parseInt(v, 10))
  .option('--json', 'Emit the result as JSON', false)
  .action(async (opts: { symbol?: string; snippet?: string; min?: number; max?: number; json?: boolean }) => {
    const code = await runFindClonesCli({
      symbol: opts.symbol,
      snippet: opts.snippet,
      min: opts.min,
      max: opts.max,
      json: opts.json,
    });
    process.exit(code);
  });
