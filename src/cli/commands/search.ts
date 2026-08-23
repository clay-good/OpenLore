/**
 * Standalone CLI face for the existing code/spec retrieval handlers and the
 * target-scoped retrieval-miss diagnostic.
 */

import { Command } from 'commander';
import { configureLogger, logger } from '../../utils/logger.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';
import { writeStdout } from '../output.js';

type TargetKind = 'symbol' | 'file' | 'requirement';

interface MatchEvidenceView {
  field: string;
  terms: string[];
  tier: number;
}

interface SearchResultView {
  name?: string;
  filePath?: string;
  startLine?: number;
  title?: string;
  domain?: string;
  section?: string;
  matchEvidence?: MatchEvidenceView;
}

interface SearchResponseView {
  error?: string;
  hint?: string;
  query?: string;
  retrievalMode?: string;
  searchMode?: string;
  count?: number;
  results?: SearchResultView[];
  target?: { kind?: string; value?: string; filePath?: string };
  surfaced?: boolean;
  rank?: number;
  cause?: string;
  filter?: string;
  value?: unknown;
  cutoff?: number;
  language?: string;
  minFanIn?: number;
  budget?: string;
  tokenBudget?: number;
  matchEvidence?: MatchEvidenceView;
}

export interface SearchCliOptions {
  cwd?: string;
  specs?: boolean;
  json?: boolean;
  explain?: string;
  targetKind?: string;
  file?: string;
  limit?: number;
  language?: string;
  minFanIn?: number;
  domain?: string;
  section?: string;
  tokenBudget?: number;
}

function evidenceText(evidence: MatchEvidenceView | undefined): string {
  if (!evidence) return '';
  const terms = evidence.terms.length > 0 ? evidence.terms.join(', ') : '(none)';
  return `field=${evidence.field} · terms=${terms} · tier=${evidence.tier}`;
}

export function renderSearchHuman(result: SearchResponseView, specs: boolean): string {
  const lines = ['', `🔎 ${specs ? 'Spec' : 'Code'} search`];
  if (result.query) lines.push(`   query: ${result.query}`);
  const mode = result.retrievalMode ?? result.searchMode;
  if (mode) lines.push(`   retrieval mode: ${mode}`);
  lines.push(`   ${result.count ?? result.results?.length ?? 0} result(s)`);

  for (const hit of result.results ?? []) {
    const label = hit.name ?? hit.title ?? '(unnamed result)';
    const location = hit.filePath
      ? `${hit.filePath}${hit.startLine === undefined ? '' : `:${hit.startLine}`}`
      : [hit.domain, hit.section].filter(Boolean).join(' / ');
    lines.push(`   ${label}${location ? `  (${location})` : ''}`);
    const evidence = evidenceText(hit.matchEvidence);
    if (evidence) lines.push(`     match: ${evidence}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderExplainHuman(result: SearchResponseView): string {
  const lines = ['', '🔎 Retrieval explanation'];
  if (result.query) lines.push(`   query: ${result.query}`);
  if (result.target) {
    const scopedFile = result.target.filePath ? ` in ${result.target.filePath}` : '';
    lines.push(`   target: ${result.target.kind ?? 'target'} ${result.target.value ?? ''}${scopedFile}`);
  }
  if (result.surfaced) {
    lines.push(`   surfaced: yes${result.rank === undefined ? '' : ` · rank=${result.rank}`}`);
    const evidence = evidenceText(result.matchEvidence);
    if (evidence) lines.push(`   match: ${evidence}`);
  } else {
    lines.push(`   surfaced: no${result.cause ? ` · cause=${result.cause}` : ''}`);
    if (result.filter) lines.push(`   filter: ${result.filter}${result.value === undefined ? '' : `=${String(result.value)}`}`);
    if (result.rank !== undefined) lines.push(`   rank: ${result.rank}`);
    if (result.cutoff !== undefined) lines.push(`   cutoff: ${result.cutoff}`);
    if (result.language) lines.push(`   language: ${result.language}`);
    if (result.budget) lines.push(`   budget: ${result.budget}`);
    if (result.tokenBudget !== undefined) lines.push(`   token budget: ${result.tokenBudget}`);
  }
  lines.push('');
  return lines.join('\n');
}

function positiveInteger(value: number | undefined, option: string): string | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    return `${option} must be a positive integer`;
  }
  return undefined;
}

export async function runSearchCli(query: string, opts: SearchCliOptions): Promise<number> {
  const directory = opts.cwd ?? process.cwd();
  const targetKind = opts.targetKind as TargetKind | undefined;
  const usageError =
    positiveInteger(opts.limit, '--limit') ??
    positiveInteger(opts.tokenBudget, '--token-budget') ??
    (opts.minFanIn !== undefined && (!Number.isInteger(opts.minFanIn) || opts.minFanIn < 0)
      ? '--min-fan-in must be a non-negative integer'
      : undefined) ??
    (opts.explain && !targetKind ? '--explain requires --target-kind symbol|file|requirement' : undefined) ??
    (targetKind && !['symbol', 'file', 'requirement'].includes(targetKind)
      ? '--target-kind must be symbol, file, or requirement'
      : undefined) ??
    (!opts.explain && targetKind ? '--target-kind requires --explain <target>' : undefined) ??
    (!opts.explain && opts.file ? '--file requires --explain <target>' : undefined);
  const surfaceError =
    (opts.specs && (opts.language || opts.minFanIn !== undefined || opts.tokenBudget !== undefined)
      ? '--language, --min-fan-in, and --token-budget are code-search options'
      : undefined) ??
    (!opts.specs && (opts.domain || opts.section)
      ? '--domain and --section require --specs'
      : undefined) ??
    (opts.explain && opts.tokenBudget !== undefined
      ? '--token-budget is not part of retrieval diagnosis; candidate-window truncation is reported directly'
      : undefined) ??
    (opts.explain && opts.specs && targetKind !== 'requirement'
      ? '--specs --explain requires --target-kind requirement'
      : undefined) ??
    (opts.explain && !opts.specs && targetKind === 'requirement'
      ? '--target-kind requirement requires --specs'
      : undefined) ??
    (opts.file && targetKind !== 'symbol' ? '--file is valid only with --target-kind symbol' : undefined);

  if (usageError || surfaceError) {
    const error = usageError ?? surfaceError!;
    if (opts.json) await writeStdout(JSON.stringify({ error }, null, 2) + '\n');
    else logger.error(`search: ${error}`);
    return 1;
  }

  const limit = opts.limit ?? 10;
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    if (opts.explain) {
      result = await dispatchTool('explain_retrieval_miss', {
        directory,
        query,
        surface: opts.specs ? 'spec' : 'code',
        target: {
          kind: targetKind!,
          value: opts.explain,
          ...(opts.file ? { filePath: opts.file } : {}),
        },
        limit,
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.minFanIn !== undefined ? { minFanIn: opts.minFanIn } : {}),
        ...(opts.domain ? { domain: opts.domain } : {}),
        ...(opts.section ? { section: opts.section } : {}),
      }, directory);
    } else if (opts.specs) {
      result = await dispatchTool('search_specs', {
        directory, query, limit, domain: opts.domain, section: opts.section,
      }, directory);
    } else {
      result = await dispatchTool('search_code', {
        directory, query, limit, language: opts.language, minFanIn: opts.minFanIn,
        tokenBudget: opts.tokenBudget,
      }, directory);
    }
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    configureLogger({ quiet: false });
  }

  const response = result as SearchResponseView;
  if (response?.error) {
    if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
    else {
      logger.error(`search: ${response.error}`);
      if (response.hint) logger.info('Hint', response.hint);
    }
    return 1;
  }

  if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
  else await writeStdout(opts.explain ? renderExplainHuman(response) + '\n' : renderSearchHuman(response, opts.specs ?? false) + '\n');
  return 0;
}

export const searchCommand = new Command('search')
  .description('Search indexed code or specs, or explain why one named target did not surface')
  .argument('<query>', 'Query to search for')
  .option('--specs', 'Search the spec index instead of the code index', false)
  .option('--explain <target>', 'Explain why this named target did or did not surface')
  .option('--target-kind <kind>', 'Target kind for --explain: symbol, file, or requirement')
  .option('--file <path>', 'Optional file scope for a symbol target')
  .option('--directory <path>', 'Project directory to search (default: current directory)')
  .option('--limit <n>', 'Maximum results to return (default: 10)', (value) => parseInt(value, 10))
  .option('--language <language>', 'Filter code results by language')
  .option('--min-fan-in <n>', 'Filter code results by minimum caller count', (value) => parseInt(value, 10))
  .option('--domain <domain>', 'Filter spec results by domain')
  .option('--section <section>', 'Filter spec results by section')
  .option('--token-budget <n>', 'Cap code results to this approximate token budget', (value) => parseInt(value, 10))
  .option('--json', 'Emit the handler result as JSON', false)
  .addHelpText('after', `\nExamples:\n  $ openlore search "authentication handler"\n  $ openlore search "rate limiting" --specs --json\n  $ openlore search "authentication" --explain verifyToken --target-kind symbol --file src/auth.ts\n`)
  .action(async (query: string, opts: Omit<SearchCliOptions, 'cwd'> & { directory?: string }) => {
    process.exitCode = await runSearchCli(query, { ...opts, cwd: opts.directory });
  });
