/**
 * openlore orient command
 *
 * CLI surface for the orient tool (also exposed through the MCP server). Given
 * a task, returns the relevant functions, callers, spec sections, and insertion
 * points — as JSON (for tooling) or a human-readable summary.
 *
 * With no task it prints a short session-start primer instead of erroring, so
 * the SessionStart hook written by `openlore install`
 * (`npx --yes openlore orient --json`) is a no-op that injects useful context
 * rather than failing on every session start.
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { withQuietStdout } from '../../utils/quiet-stdout.js';
import { handleOrient } from '../../core/services/mcp-handlers/orient.js';
import { estimateTokens } from '../../core/services/llm-service.js';
import { OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';
import { buildInjection, extractPrompt } from './orient-inject.js';

interface OrientCliOptions {
  task?: string;
  directory?: string;
  limit?: string;
  tokenBudget?: string;
  lean?: boolean;
  json?: boolean;
  metrics?: boolean;
  inject?: boolean;
}

/**
 * Read all of stdin (the hook prompt payload). Resolves '' when stdin is a TTY
 * (nothing piped). Exported for testing; defaults to `process.stdin`.
 *
 * Load-bearing for the "a hook must never hang the user's turn" contract: when
 * the fallback timer fires (a writer that opened the pipe but never wrote/closed
 * it), `done()` not only resolves but TEARS DOWN the stream — pausing it,
 * detaching listeners, and unref-ing the underlying handle — so the process can
 * exit immediately instead of waiting for an EOF that may never come. Resolving
 * the promise alone is not enough: a still-referenced, flowing stdin keeps the
 * event loop alive until the writer closes the pipe.
 */
export function readStdin(
  stream: NodeJS.ReadStream = process.stdin,
  timeoutMs = 1500,
): Promise<string> {
  return new Promise(resolve => {
    if (stream.isTTY) return resolve('');
    let data = '';
    let settled = false;
    const onData = (chunk: string): void => {
      data += chunk;
    };
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', done);
      stream.removeListener('error', done);
      stream.pause();
      stream.unref?.();
      resolve(data);
    };
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.on('end', done);
    stream.on('error', done);
    // A hook must never hang the user's turn: if stdin neither closes nor errors,
    // proceed with whatever arrived (typically '' → pointer line) and detach.
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
  });
}

/**
 * `orient --inject` — task-scoped context injection
 * (change: add-task-scoped-context-injection). Emits a bounded, attributed,
 * ignorable orientation block (or a single pointer line) to stdout for a
 * pre-turn agent hook. Reads the task from --task or the hook's stdin payload.
 * Always exits 0: a hook must never break the user's turn.
 */
async function runInject(directory: string, taskOpt: string | undefined): Promise<void> {
  let prompt = taskOpt ?? '';
  if (!prompt) {
    try {
      prompt = extractPrompt(await readStdin());
    } catch {
      prompt = '';
    }
  }
  try {
    // Keep stdout clean: handleOrient → validateDirectory writes a "[ok] …"
    // success line via console.log, which would otherwise pollute the injected
    // context. Redirect diagnostics to stderr (same discipline as --json mode)
    // so stdout carries only the orientation block.
    const block = await withQuietStdout(() => buildInjection(directory, prompt));
    if (block) console.log(block);
  } catch {
    // buildInjection is fail-open, but guard the print path too: never throw.
  }
}

/**
 * Opt-in performance readout (Issue #128). Off by default — nothing is measured
 * or printed unless the caller passes --metrics. Reported to stderr so it never
 * corrupts the JSON on stdout that the skill wrappers parse. Local-only: wall
 * time plus an estimate of the result's output size; no network, no LLM.
 */
function reportMetrics(startNs: bigint, result: Record<string, unknown>): void {
  const wallMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  const tokens = estimateTokens(JSON.stringify(result));
  process.stderr.write(
    `[orient:metrics] wall=${wallMs.toFixed(1)}ms output≈${tokens} tokens (local, no network)\n`
  );
}

/** True once `openlore analyze` has produced an llm-context artifact. */
function hasAnalysis(directory: string): boolean {
  return existsSync(join(directory, OPENLORE_ANALYSIS_REL_PATH, 'llm-context.json'));
}

/** Session-start primer printed when orient is invoked without a task. */
function printPrimer(directory: string, asJson: boolean): void {
  const ready = hasAnalysis(directory);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          openlore: ready ? 'ready' : 'no-analysis',
          message: ready
            ? 'OpenLore architectural memory is active. Call orient with a task before reading source files.'
            : 'OpenLore is installed but no analysis was found. Run "openlore analyze" to build the graph.',
          usage: 'openlore orient --json --task "<task description>"',
        },
        null,
        2
      )
    );
    return;
  }
  if (ready) {
    console.log('OpenLore architectural memory is active.');
    console.log('Call orient with a task before reading source files:');
    console.log('  openlore orient --task "<task description>"');
  } else {
    console.log('OpenLore is installed but no analysis was found.');
    console.log('Run "openlore analyze" to build the graph, then:');
    console.log('  openlore orient --task "<task description>"');
  }
}

/** Concise human-readable rendering of a handleOrient result. */
function printHuman(result: Record<string, unknown>): void {
  if (result.error) {
    logger.error(String(result.error));
    if (result.hint) logger.info('Hint', String(result.hint));
    return;
  }

  const fns = (result.relevantFunctions as Array<{ name: string; filePath: string }>) ?? [];
  const ips =
    (result.insertionPoints as Array<{ rank: number; name: string; filePath: string; reason: string }>) ?? [];
  const next = (result.nextSteps as string[]) ?? [];

  console.log(`Task: ${result.task}`);
  // State the honest, served retrieval mode (keyword / local-semantic /
  // remote-semantic) — not the internal score-scale token.
  console.log(`Retrieval mode: ${result.retrievalMode ?? result.searchMode}`);

  if (fns.length > 0) {
    console.log('\nRelevant functions:');
    for (const f of fns) console.log(`  ${f.name}  (${f.filePath})`);
  }
  if (ips.length > 0) {
    console.log('\nInsertion points:');
    for (const ip of ips) console.log(`  ${ip.rank}. ${ip.name}  (${ip.filePath}) — ${ip.reason}`);
  }
  if (next.length > 0) {
    console.log('\nNext steps:');
    for (const s of next) console.log(`  - ${s}`);
  }
}

export const orientCommand = new Command('orient')
  .description('Get the relevant functions, callers, specs, and insertion points for a task')
  // Accept the task as a bare positional too (`openlore orient "add rate limiting"`) — the
  // most natural thing a user/agent types. Without it (and without --task) we still print
  // the session-start primer, so the install SessionStart hook (`orient --json`) is unaffected.
  .argument('[task]', 'Natural-language task (positional alternative to --task)')
  .option('--task <task>', 'Natural-language task description (e.g. "add rate limiting to the API")')
  .option('--directory <path>', 'Project directory to orient in (default: current directory)')
  .option('--limit <n>', 'Number of relevant functions to return (default: 5)')
  .option('--token-budget <n>', 'Cap relevantFunctions to ~this many tokens (Spec 25 P4); highest-scored kept, exact duplicates collapsed')
  .option('--lean', 'Return only the navigation core — drop provenance/change-coupling/insertion-points/specs/decisions enrichment (Spec 27)', false)
  .option('--json', 'Emit the full result as JSON instead of a human-readable summary', false)
  .option('--metrics', 'Report wall time and output size to stderr (opt-in; off by default)', false)
  .option('--inject', 'Emit a bounded, ignorable task-scoped orientation block for a pre-turn agent hook (reads the task from --task or stdin); always exits 0', false)
  .addHelpText(
    'after',
    `
Examples:
  $ openlore orient --task "add a new CLI command"
  $ openlore orient --json --task "fix the analyze cache"
  $ openlore orient --json --task "auth flow" --limit 10
  $ openlore orient --metrics --task "auth flow"   # opt-in wall-time/output-size readout

Requires "openlore analyze" to have been run at least once. With no --task,
prints a short session-start primer (used by the install SessionStart hook).
`
  )
  .action(async (taskArg: string | undefined, opts: OrientCliOptions) => {
    const directory = opts.directory ?? process.cwd();
    const asJson = opts.json ?? false;
    // --task wins; otherwise a bare positional task is honored.
    const task = (opts.task ?? taskArg)?.trim();

    // Task-scoped injection hook mode: emit a bounded orientation block (or a
    // pointer line) to stdout and always exit 0 — a pre-turn hook must never
    // break the user's turn. Reads the task from --task or stdin.
    if (opts.inject) {
      await runInject(directory, task);
      return;
    }

    // No task → session-start primer (keeps the install hook from erroring).
    if (!task) {
      printPrimer(directory, asJson);
      return;
    }

    const limit = opts.limit ? parseInt(opts.limit, 10) : 5;
    if (Number.isNaN(limit) || limit < 1) {
      logger.error('--limit must be a positive integer');
      process.exitCode = 1;
      return;
    }

    let tokenBudget: number | undefined;
    if (opts.tokenBudget !== undefined) {
      tokenBudget = parseInt(opts.tokenBudget, 10);
      if (Number.isNaN(tokenBudget) || tokenBudget < 1) {
        logger.error('--token-budget must be a positive integer');
        process.exitCode = 1;
        return;
      }
    }

    try {
      // In --json mode keep stdout clean (validateDirectory logs to stdout);
      // in human mode let diagnostics through normally.
      const lean = opts.lean ?? false;
      const startNs = opts.metrics ? process.hrtime.bigint() : 0n;
      const result = (asJson
        ? await withQuietStdout(() => handleOrient(directory, task, limit, tokenBudget, lean))
        : await handleOrient(directory, task, limit, tokenBudget, lean)) as Record<string, unknown>;
      if (opts.metrics) reportMetrics(startNs, result);
      // Always emit structured results (including the "no analysis" error object)
      // on stdout so wrapper scripts can parse them — mirroring the MCP tool.
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printHuman(result);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (asJson) {
        console.log(JSON.stringify({ error: message }, null, 2));
      } else {
        logger.error(`orient failed: ${message}`);
      }
      process.exitCode = 1;
    }
  });
