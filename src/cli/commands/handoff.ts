/**
 * `openlore handoff` — the session-succession briefing (change: add-session-handoff-briefing).
 *
 * The CLI face of `get_handoff_briefing`: the in-flight change in this repository, computed from
 * the repository (never a transcript), the same bytes for the same state. Read-only.
 */

import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';
import { renderHandoff } from '../../core/services/mcp-handlers/handoff.js';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';

export interface HandoffCliOptions {
  cwd?: string;
  budget?: number;
  json?: boolean;
}

export async function runHandoffCli(opts: HandoffCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await dispatchTool('get_handoff_briefing', { directory: cwd, tokenBudget: opts.budget }, cwd);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }
  if (result && typeof result === 'object' && 'error' in result) {
    const error = (result as { error: string }).error;
    if (opts.json) await writeStdout(JSON.stringify({ status: 'unavailable', error }, null, 2) + '\n');
    else logger.warning(`handoff: ${safe(error)}`);
    return 1;
  }
  if (opts.json) await writeStdout(JSON.stringify(result, null, 2) + '\n');
  // Repository text is sanitized line by line (the sanitizer also removes line breaks).
  else await writeStdout(renderHandoff(result as Record<string, unknown>).split('\n').map(l => safe(l)).join('\n') + '\n');
  return 0;
}

export const handoffCommand = new Command('handoff')
  .description('Brief the in-flight change for a successor session: touched symbols, open changes and unchecked tasks, tests to run, memories in scope, uncommitted files. Deterministic, read-only.')
  .option('--budget <tokens>', 'Approximate token budget (default 1500)', (v) => Number(v))
  .option('--json', 'Emit the briefing as JSON', false)
  .action(async (opts: { budget?: number; json?: boolean }) => {
    process.exit(await runHandoffCli({ budget: opts.budget, json: opts.json }));
  });
