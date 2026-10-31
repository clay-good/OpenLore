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

import { Command, Option } from 'commander';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { logger } from '../../utils/logger.js';
// Repo-derived values are printed here with bare console.log (not via logger), so
// they are neutralized explicitly. Whole-line sanitizing is not an option: these
// lines carry intentional \n spacing that the sanitizer would strip.
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { withQuietStdout } from '../../utils/quiet-stdout.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';
import { estimateTokens } from '../../core/services/llm-service.js';
import { OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';
import { buildInjection, buildProposalOnlyInjection, extractPrompt, pointerLineFor } from './orient-inject.js';
import {
  oneShotBuildNote,
  registerOneShotRepair,
  runBackgroundIndexBuild,
  startDetachedIndexBuild,
  type OneShotBuild,
} from '../../core/services/one-shot-index-build.js';
import { readStdin } from '../../utils/stdin.js';
import { autoInitSuppression, isInsideGitWorkTree, recordDetachedRepair } from '../../core/services/cold-start-bootstrap.js';
import { seedFromSiblingCheckout, servingSeededIndex } from '../../core/runtime/seed-from-sibling.js';
import { EdgeStore } from '../../core/services/edge-store.js';

interface OrientCliOptions {
  task?: string;
  directory?: string;
  limit?: string;
  tokenBudget?: string;
  lean?: boolean;
  json?: boolean;
  metrics?: boolean;
  inject?: boolean;
  proposalOnly?: boolean;
  backgroundBuild?: boolean;
  backgroundRepair?: boolean;
}

// readStdin moved to ../../utils/stdin.js (dependency-light leaf) so latency-sensitive hooks can
// share it without importing this command's heavy graph. Re-exported here for existing callers.
export { readStdin };

/**
 * `orient --inject` — task-scoped context injection
 * (change: add-task-scoped-context-injection). Emits a bounded, attributed,
 * ignorable orientation block (or a single pointer line) to stdout for a
 * pre-turn agent hook. Reads the task from --task or the hook's stdin payload.
 * Always exits 0: a hook must never break the user's turn.
 */
async function runInject(
  directory: string,
  taskOpt: string | undefined,
  buildNote?: string,
  silentWithoutIndex = false,
): Promise<void> {
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
    const debug = process.env.OPENLORE_INJECT_DEBUG === '1';
    const block = await withQuietStdout(() => buildInjection(directory, prompt, debug ? evaluation => {
      const verdict = evaluation.passes ? 'passed' : 'suppressed';
      process.stderr.write(
        `[openlore:inject] verdict=${verdict} reason=${evaluation.reason ?? 'none'} ` +
        `passed=${evaluation.passedCriteria.join(',') || 'none'} ` +
        `failed=${evaluation.failedCriteria.join(',') || 'none'}\n`,
      );
    } : undefined));
    // Outside any git work tree (e.g. $HOME) with no index, say nothing: "run openlore
    // analyze" on every prompt there invites an agent to index the whole directory.
    // With a build in flight, "run openlore analyze" is the wrong remedy: say what is happening.
    // A propose prompt may carry the proposal instruction after the pointer line; keep it.
    let out = block;
    const noGraph = pointerLineFor('no-graph');
    if (out.startsWith(noGraph)) {
      const rest = out.slice(noGraph.length).trim();
      if (silentWithoutIndex) out = rest;
      else if (buildNote) out = [`[OpenLore] ${safe(buildNote)}`, rest].filter(Boolean).join('\n\n');
    }
    if (out) console.log(out);
  } catch {
    // buildInjection is fail-open, but guard the print path too: never throw.
  }
}

/** Emit only the short OpenSpec proposal instruction; Codex gates the full task in its hook. */
async function runProposalOnly(directory: string, taskOpt: string | undefined): Promise<void> {
  let prompt = taskOpt ?? '';
  if (!prompt) {
    try { prompt = extractPrompt(await readStdin()); }
    catch { prompt = ''; }
  }
  const context = await withQuietStdout(() => buildProposalOnlyInjection(directory, prompt));
  if (context) console.log(context);
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

/**
 * True when analysis exists but its call graph is UNUSABLE — the edge store is
 * absent, or (the common field case) a version-upgrade schema reset left it
 * open-but-empty, since EdgeStore empties itself on a schema change. This is the
 * same state `readCachedContext`'s empty-store guard detects; it is re-checked
 * here, cheaply and SYNCHRONOUSLY, because a one-shot `orient` (the install
 * hooks) `process.exit(0)`s before any deferred read-path repair microtask could
 * spawn — so the rebuild has to be kicked inline or the graph never self-heals
 * and `orient` degrades to search-only every turn (change: self-heal-empty-graph-index).
 */
function graphIndexUnusable(root: string): boolean {
  const analysisDir = join(root, OPENLORE_ANALYSIS_REL_PATH);
  try {
    if (!EdgeStore.exists(analysisDir)) return true;
    const es = EdgeStore.open(EdgeStore.dbPath(analysisDir));
    try {
      return es.notReady != null || es.countNodes() === 0;
    } finally {
      es.close();
    }
  } catch {
    return false; // can't tell → never force a rebuild on a guess
  }
}

/**
 * The project an implicit (cwd) orient serves: the nearest ancestor that already has an
 * index, else the enclosing git work tree's root, else the start directory. Agent hooks run
 * from wherever the agent's shell is; from `<repo>/src` a plain cwd would report "no index"
 * and start a second build that writes `src/.openlore`. The walk never crosses a `.git`
 * boundary, so a nested repository is never served its parent's index.
 */
export function implicitOrientRoot(start: string): string {
  const origin = resolve(start);
  for (let dir = origin; ; dir = dirname(dir)) {
    if (hasAnalysis(dir) || existsSync(join(dir, '.git'))) return dir === origin ? start : dir;
    if (dirname(dir) === dir) return start;
  }
}

/** Session-start primer printed when orient is invoked without a task. */
function printPrimer(directory: string, asJson: boolean, buildNote?: string): void {
  const ready = hasAnalysis(directory);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          openlore: ready ? 'ready' : 'no-analysis',
          message: ready
            ? 'OpenLore architectural memory is active. Call orient with a task before reading source files.'
            : buildNote ?? 'OpenLore is installed but no analysis was found. Run "openlore analyze" to build the graph.',
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
  } else if (buildNote) {
    console.log(buildNote);
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

  console.log(`Task: ${safe(String(result.task))}`);
  // State the honest, served retrieval mode (keyword / local-semantic /
  // remote-semantic) — not the internal score-scale token.
  console.log(`Retrieval mode: ${safe(String(result.retrievalMode ?? result.searchMode))}`);
  // A degraded graph index has to be said OUT LOUD on the human surface too. Without this the
  // JSON caller learns the call paths were omitted and the terminal caller does not — they just
  // see a briefing with no callers, which reads as "nothing calls this" rather than "I could not
  // look" (change: shrink-receiver-resolution-boundary).
  if (result.graphIndexNote) logger.warning(safe(String(result.graphIndexNote)));

  if (fns.length > 0) {
    console.log('\nRelevant functions:');
    for (const f of fns) console.log(`  ${safe(f.name)}  (${safe(f.filePath)})`);
  }
  if (ips.length > 0) {
    console.log('\nInsertion points:');
    for (const ip of ips) console.log(`  ${ip.rank}. ${safe(ip.name)}  (${safe(ip.filePath)}) — ${safe(ip.reason)}`);
  }
  const budget = result.budget as { tokenBudget: number; estimatedTokens: number; fits: boolean; omitted?: Record<string, number>; addedBeyondLimit?: number } | undefined;
  if (budget) {
    const omitted = Object.entries(budget.omitted ?? {}).map(([section, count]) => `${count} ${section}`).join(', ');
    const met = budget.fits ? '' : ' (not met)';
    const added = budget.addedBeyondLimit ? `; ${safe(String(budget.addedBeyondLimit))} more function(s) added` : '';
    console.log(`\nToken budget: ~${safe(String(budget.estimatedTokens))} of ${safe(String(budget.tokenBudget))}${safe(met)}` +
      added + (omitted ? `; omitted ${safe(omitted)}` : ''));
  }
  if (next.length > 0) {
    console.log('\nNext steps:');
    for (const s of next) console.log(`  - ${safe(s)}`);
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
  .option('--token-budget <n>', 'Fit the whole answer to ~this many tokens: more ranked functions are added while they fit, or the lowest-ranked entries are dropped; decisions are never dropped')
  .option('--lean', 'Return only the navigation core — drop provenance/change-coupling/insertion-points/specs/decisions enrichment (Spec 27)', false)
  .option('--json', 'Emit the full result as JSON instead of a human-readable summary', false)
  .option('--metrics', 'Report wall time and output size to stderr (opt-in; off by default)', false)
  .option('--inject', 'Emit a bounded, ignorable task-scoped orientation block for a pre-turn agent hook (reads the task from --task or stdin); always exits 0', false)
  .option('--proposal-only', 'Emit the concise OpenSpec proposal instruction only when the submitted prompt invokes propose; always exits 0', false)
  .addOption(new Option('--background-build').hideHelp())
  .addOption(new Option('--background-repair').hideHelp())
  .addHelpText(
    'after',
    `
Examples:
  $ openlore orient --task "add a new CLI command"
  $ openlore orient --json --task "fix the analyze cache"
  $ openlore orient --json --task "auth flow" --limit 10
  $ openlore orient --metrics --task "auth flow"   # opt-in wall-time/output-size readout

When no index exists, or the index is stale, a background build starts and this
command returns at once; run it again when the build completes. With no --task,
prints a short session-start primer (used by the install SessionStart hook).
`
  )
  .action(async (taskArg: string | undefined, opts: OrientCliOptions) => {
    const directory = opts.directory ?? implicitOrientRoot(process.cwd());
    const asJson = opts.json ?? false;
    // --task wins; otherwise a bare positional task is honored.
    const task = (opts.task ?? taskArg)?.trim();

    // The detached supervisor a one-shot orient hands the build to (hidden).
    if (opts.backgroundBuild) {
      await runBackgroundIndexBuild(resolve(directory), { repair: opts.backgroundRepair });
      return;
    }

    // Lightweight proposal trigger for hosts such as Codex whose prompt-submit hook matcher is
    // ignored. It does no structural lookup and emits nothing for unrelated prompts.
    if (opts.proposalOnly) {
      await runProposalOnly(directory, task);
      return;
    }

    // One-shot self-bootstrap (change: bootstrap-index-from-one-shot-orient): start one
    // detached build for an absent index, and let the read path's staleness signals
    // start the same build. Neither waits.
    const root = resolve(directory);
    // Self-bootstrap an ABSENT index, and — crucially for the install hooks — ALSO kick a
    // rebuild when the index is present but its call graph is unusable (a version-upgrade
    // schema reset empties the store). Both spawn SYNCHRONOUSLY: a one-shot orient
    // process.exit(0)s before any deferred read-path repair microtask could run, so the
    // async self-heal the long-running MCP server relies on never fires here — the exact
    // reason orient stayed degraded every turn and agents fell back to grep
    // (change: self-heal-empty-graph-index).
    let build: OneShotBuild | undefined;
    // A new worktree first copies a sibling checkout's verified index, awaited here because
    // this process exits as soon as it answers (change: seed-worktree-index-from-sibling-checkout).
    if (!hasAnalysis(root) && !autoInitSuppression(root)) await seedFromSiblingCheckout(root);
    if (!hasAnalysis(root)) {
      build = startDetachedIndexBuild(root, 'index-absent');
    } else if (await servingSeededIndex(root)) {
      // Until the rebuild publishes, every answer is disclosed as served from the seed.
      build = startDetachedIndexBuild(root, 'seeded');
      if (build.state === 'started' || build.state === 'running') recordDetachedRepair(root, 'seeded');
    } else if (graphIndexUnusable(root)) {
      build = startDetachedIndexBuild(root, 'stale-region');
    }
    registerOneShotRepair(root);
    const buildNote = (): string | undefined => build && oneShotBuildNote(build);

    // Task-scoped injection hook mode: emit a bounded orientation block (or a
    // pointer line) to stdout and always exit 0 — a pre-turn hook must never
    // break the user's turn. Reads the task from --task or stdin.
    if (opts.inject) {
      const building = build?.state === 'started' || build?.state === 'running';
      await runInject(directory, task, buildNote(), !building && !hasAnalysis(root) && !isInsideGitWorkTree(root));
      return;
    }

    // No task → session-start primer (keeps the install hook from erroring).
    if (!task) {
      printPrimer(directory, asJson, buildNote());
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
        ? await withQuietStdout(() => dispatchTool('orient', {
            directory, task, limit, tokenBudget, lean,
          }, directory))
        : await dispatchTool('orient', {
            directory, task, limit, tokenBudget, lean,
          }, directory)) as Record<string, unknown>;
      if (opts.metrics) reportMetrics(startNs, result);
      if (result.notReady === true && result.reason === 'index-absent') {
        // An analysis without a search index is rebuilt, not first-built.
        build ??= startDetachedIndexBuild(root, 'stale-region');
        const note = buildNote();
        if (note) {
          result.error = note;
          delete result.hint;
          if (build.state === 'started' || build.state === 'running') result.remedy = 'retry';
          result.indexBuild = build;
        }
      }
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
