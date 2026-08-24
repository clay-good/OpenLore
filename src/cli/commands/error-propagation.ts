/**
 * `openlore error-propagation` — the error-propagation tool's CLI surface
 * (change: add-error-propagation-graph).
 *
 * Prints the exceptions that can escape a function and which are caught within it
 * (the same conclusion the `analyze_error_propagation` MCP tool returns) so a
 * developer can ask "what can throw out of here, and is it handled?" without an
 * MCP client. Read-only, deterministic, offline, never blocks.
 *
 *   openlore error-propagation --symbol handleRequest
 *   openlore error-propagation --symbol handleRequest::src/api/handler.ts --max-depth 5
 *   openlore error-propagation --symbol parseConfig --json
 */

import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { toCliVocabulary } from '../surface-vocabulary.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';

interface EscapeView {
  type?: string;
  value?: string;
  kind: 'direct' | 'declared' | 'propagated' | 'returned_error' | 'propagated_error' | 'panic';
  originFunction: string;
  originFile: string;
  originLine: number;
  path: string[];
}

interface HandledView {
  type?: string;
  value?: string;
  kind?: 'checked_error' | 'recovered_panic';
  caughtIn?: string;
  caughtAtLine?: number;
  handledIn?: string;
  handledAtLine?: number;
  fromCallee?: string;
}

export interface ErrorPropagationView {
  error?: string;
  candidates?: string[];
  hint?: string;
  unsupported?: boolean;
  errorModel?: 'go-value';
  query?: Record<string, unknown>;
  summary?: {
    escapes: number;
    direct?: number;
    propagated: number;
    dynamic?: number;
    declared?: number;
    handledInternally: number;
    functionsAnalyzed: number;
    unresolvedSelfCalls?: number;
    returnedErrors?: number;
    panics?: number;
  };
  escapes?: EscapeView[];
  handledInternally?: HandledView[];
  boundaries?: string[];
  note?: string;
}

export function renderHuman(r: ErrorPropagationView): string {
  const lines: string[] = [''];
  lines.push('🔥 Error propagation');
  const q = r.query ?? {};
  if (q.symbol) lines.push(`   query: ${String(q.symbol)} (${String(q.language)})`);

  if (r.unsupported) {
    lines.push(`   ⚠ ${r.note ?? 'Language not supported for error-propagation analysis.'}`);
    lines.push('');
    return lines.join('\n');
  }

  if (r.errorModel === 'go-value') {
    const s = r.summary ?? { escapes: 0, direct: 0, propagated: 0, dynamic: 0, handledInternally: 0, functionsAnalyzed: 0 };
    lines.push(`   ${s.escapes} escaping Go error value/panic site${s.escapes === 1 ? '' : 's'} (${s.returnedErrors ?? 0} returned errors, ${s.panics ?? 0} panics) · ${s.handledInternally} handled internally · ${s.functionsAnalyzed} functions analyzed`);
    for (const e of r.escapes ?? []) lines.push(`     ${(e.value ?? 'error').padEnd(20)} ${e.originFunction}:${e.originLine}  (${e.kind.replaceAll('_', ' ')})`);
    if (!(r.escapes ?? []).length) lines.push((r.boundaries ?? []).length
      ? '     (no returned error values or unrecovered panics proven in the analyzed portion)'
      : '     (no returned error values or unrecovered panics escape this function)');
    if ((r.handledInternally ?? []).length) {
      lines.push('   handled internally:');
      for (const h of r.handledInternally ?? []) lines.push(`     ${(h.value ?? 'error').padEnd(20)} ${h.kind?.replaceAll('_', ' ')} in ${h.handledIn}:${h.handledAtLine}`);
    }
    for (const b of r.boundaries ?? []) lines.push(`   · ${b}`);
    lines.push('');
    return lines.join('\n');
  }

  const s = r.summary ?? { escapes: 0, direct: 0, propagated: 0, dynamic: 0, handledInternally: 0, functionsAnalyzed: 0 };
  const declared = s.declared ? `, declared ${s.declared}` : '';
  lines.push(
    `   ${s.escapes} escaping exception${s.escapes === 1 ? '' : 's'} (direct ${s.direct}, propagated ${s.propagated}, ` +
      `dynamic ${s.dynamic}${declared}) · ${s.handledInternally} handled internally · ${s.functionsAnalyzed} functions analyzed`,
  );
  for (const e of r.escapes ?? []) {
    const via = e.kind === 'direct' ? 'thrown here' : e.kind === 'declared' ? 'declared in throws clause' : `via ${e.path.slice(1).join(' → ')}`;
    lines.push(`     ${(e.type ?? '<dynamic>').padEnd(20)} ${e.originFunction}:${e.originLine}  (${via})`);
  }
  if ((r.escapes ?? []).length === 0) lines.push((r.boundaries ?? []).length
    ? '     (no escaping exceptions proven in the analyzed portion)'
    : '     (no exceptions escape this function)');

  if ((r.handledInternally ?? []).length > 0) {
    lines.push('   handled internally (callers shielded):');
    for (const h of r.handledInternally ?? []) {
      lines.push(`     ${(h.type ?? '<dynamic>').padEnd(20)} caught in ${h.caughtIn}:${h.caughtAtLine}  (from ${h.fromCallee})`);
    }
  }

  for (const b of r.boundaries ?? []) lines.push(`   · ${b}`);
  lines.push('');
  return lines.join('\n');
}

export interface ErrorPropagationCliOptions {
  cwd?: string;
  symbol?: string;
  maxDepth?: number;
  json?: boolean;
}

export async function runErrorPropagationCli(opts: ErrorPropagationCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await dispatchTool('analyze_error_propagation', {
      directory: cwd,
      symbol: opts.symbol,
      maxDepth: opts.maxDepth,
    }, cwd);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }

  if (result && typeof result === 'object' && 'error' in result) {
    const r = result as ErrorPropagationView;
    if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
    else {
      logger.warning(`error-propagation: ${toCliVocabulary(r.error ?? '')}`);
      if (r.candidates?.length) logger.info('candidates', r.candidates.join(', '));
      if (r.hint) logger.info('hint', toCliVocabulary(r.hint));
    }
    return 1;
  }

  if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
  else await writeStdout(toCliVocabulary(renderHuman(result as ErrorPropagationView)) + '\n');
  return 0;
}

export const errorPropagationCommand = new Command('error-propagation')
  .description('Analyze escaping exceptions (TS/JS/Python/Java/C#) or returned errors and panics (Go). Read-only, deterministic, never blocks.')
  .option('--symbol <name>', 'The function to analyze: its name, or name::path to disambiguate')
  .option('--max-depth <n>', 'Callee-traversal depth bound (default 10, clamped to [1, 30])', (v) => parseInt(v, 10))
  .option('--json', 'Emit the result as JSON', false)
  .action(async (opts: { symbol?: string; maxDepth?: number; json?: boolean }) => {
    const code = await runErrorPropagationCli({
      symbol: opts.symbol,
      maxDepth: opts.maxDepth,
      json: opts.json,
    });
    process.exit(code);
  });
