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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { logger, withLoggerOptions } from '../../utils/logger.js';
// Repo-derived values are printed here with bare console.log (not via logger), so
// they are neutralized explicitly. Whole-line sanitizing is not an option: these
// lines carry intentional \n spacing that the sanitizer would strip.
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { withQuietStdout } from '../../utils/quiet-stdout.js';
import { jsonOutput } from '../output.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';
import { estimateTokens } from '../../core/services/llm-service.js';
import { OPENLORE_ANALYSIS_REL_PATH, OPENLORE_DIR } from '../../constants.js';
import { DECISIONS_REVIEW_COMMAND, takeAutoAcceptsSinceLastSession } from '../../core/decisions/autopilot.js';
import { buildInjection, buildProposalOnlyInjection, extractPrompt, pointerLineFor } from './orient-inject.js';
import { SILENCE_CONTRACT_LINE } from './orient-inject-render.js';
import {
  oneShotBuildNote,
  registerOneShotRepair,
  runBackgroundIndexBuild,
  startDetachedIndexBuild,
  type OneShotBuild,
} from '../../core/services/one-shot-index-build.js';
import { readStdin } from '../../utils/stdin.js';
import { findingIdentity, markShown, readSession, wasShown, writeSession } from '../../core/services/hook-session.js';
import { errorReason, recordHookRun, type HookOutcome } from '../../core/services/hook-health.js';
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
  /** The install scope that wired this hook (`user` stands down for repo wiring). */
  scope?: string;
}

// readStdin moved to ../../utils/stdin.js (dependency-light leaf) so latency-sensitive hooks can
// share it without importing this command's heavy graph. Re-exported here for existing callers.
export { readStdin };

/**
 * `orient --inject` — task-scoped context injection
 * (change: add-task-scoped-context-injection). Returns a bounded, attributed,
 * ignorable orientation block (or a single pointer line) for a pre-turn agent
 * hook. Reads the task from --task or the hook's stdin payload.
 *
 * This is the prompt-submitted moment of the agent loop (change: hook-reliability):
 * a thrown error returns '' — the agent is told nothing about OpenLore's own failure.
 */
export async function injectOutput(
  directory: string,
  taskOpt: string | undefined,
  buildNote?: string,
  silentWithoutIndex = false,
  run?: { outcome: HookOutcome; reason?: string },
): Promise<string> {
  let prompt = taskOpt ?? '';
  let sessionId: string | undefined;
  if (!prompt) {
    try {
      const raw = await readStdin();
      prompt = extractPrompt(raw);
      sessionId = sessionIdOf(raw);
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
    let withheld: string | undefined;
    // Quiet logger too: a hook writes nothing to stderr either ("[ok] Successfully validated…").
    const block = await withQuietStdout(() => withLoggerOptions({ quiet: true }, () => buildInjection(directory, prompt, evaluation => {
      // A failed lookup is silent to the agent and counted for the operator.
      if (evaluation.reason === 'error' && run) { run.outcome = 'error'; if (evaluation.error) run.reason = evaluation.error; }
      withheld = evaluation.passes ? undefined : evaluation.reason;
      if (!debug) return;
      const verdict = evaluation.passes ? 'passed' : 'suppressed';
      process.stderr.write(
        `[openlore:inject] verdict=${verdict} reason=${evaluation.reason ?? 'none'} ` +
        `passed=${evaluation.passedCriteria.join(',') || 'none'} ` +
        `failed=${evaluation.failedCriteria.join(',') || 'none'}\n`,
      );
    })));
    // Outside any git work tree (e.g. $HOME) with no index, say nothing: "run openlore
    // analyze" on every prompt there invites an agent to index the whole directory.
    // With a build in flight, "run openlore analyze" is the wrong remedy: say what is happening.
    // A propose prompt may carry the proposal instruction after the pointer line; keep it.
    let out = block;
    const noGraph = pointerLineFor('no-graph');
    if (out.startsWith(noGraph)) {
      const rest = out.slice(noGraph.length).trim();
      // A build in flight is the user's to watch (the status line and `openlore status` show its
      // progress), not the agent's: the agent gets nothing about it, and tool answers served
      // meanwhile already say they are partial (change: hook-reliability, task 9.4). With no build
      // possible, the no-index line is stated once per harness session (task 4.3).
      //
      // No user-only line either. Task 9.1 asked the Claude Code hooks docs to confirm that a
      // hook's `systemMessage` reaches the user and NOT the model. Checked 2026-11-14 at
      // https://code.claude.com/docs/en/hooks: it is "shown to the user", and UserPromptSubmit
      // accepts it, but the docs do not say it stays out of the model's context. Unconfirmed, so
      // per 9.1 the line is dropped and the status line is the only progress channel.
      const notice = silentWithoutIndex || buildNote ? undefined : 'no-index';
      const head = notice && await firstTimeThisSession(directory, sessionId, notice) ? noGraph : '';
      out = [head, rest].filter(Boolean).join('\n\n');
    }
    // A turn the anchor gate kept silent: what silence means is said once per session, not on every
    // turn (change: anchor-gated-prompt-briefing).
    if (!out && withheld && ['no-anchor', 'management-intent', 'empty-prompt'].includes(withheld)
      && await firstTimeThisSession(directory, sessionId, 'silence-contract')) {
      out = SILENCE_CONTRACT_LINE;
    }
    // Screened on the way out, whole-block: the framed part is already screened by
    // frameServedContent, but the pointer line and the build note are assembled here, and this is
    // the always-on UserPromptSubmit path. A bare console.log is invisible to the terminal-sink
    // guard, which only inspects INTERPOLATIONS — which is why this leaked for so long.
    return out ? safe(out, { keepNewlines: true }) : '';
  } catch (error) {
    // buildInjection is fail-open; guard the assembly too: never throw.
    if (run) { run.outcome = 'error'; run.reason = errorReason(error); }
    return '';
  }
}

/** The harness session id in a hook payload, when it carries one. */
function sessionIdOf(raw: string): string | undefined {
  try {
    const v = JSON.parse(raw) as { session_id?: unknown };
    return typeof v?.session_id === 'string' && v.session_id ? v.session_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True the first time `notice` is asked about in this harness session, and records it. Without a
 * session id, or without a `.openlore/` to record it in, every time (nothing is deduplicated).
 */
async function firstTimeThisSession(root: string, sessionId: string | undefined, notice: string): Promise<boolean> {
  // No `.openlore/` (auto-init off): write nothing into the repository; nothing is deduplicated.
  if (!sessionId || !existsSync(join(root, OPENLORE_DIR))) return true;
  const session = readSession(root, sessionId);
  const { identity } = findingIdentity('notice', notice);
  if (wasShown(session, identity, 'agent')) return false;
  markShown(session, identity, { code: 'notice', subject: notice }, 'prompt-submitted', 'agent');
  await writeSession(root, sessionId, session);
  return true;
}

/**
 * The prompt-submitted moment's runtime limit, timed in-process: the timer starts after the CLI
 * has loaded, as every hook moment's does (hook-reliability design section 2; owner, 2026-11-14).
 */
export const PROMPT_SUBMITTED_LIMIT_MS = 3_000;

/** What a moment's work settles to when it passed its runtime limit. */
export const TIMED_OUT = Symbol('timed-out');

/**
 * Race `work` against `limitMs`. A thrown error settles to '' (silence); a passed limit to
 * `TIMED_OUT`. Never rejects.
 */
export async function withinLimit(work: () => Promise<string>, limitMs: number): Promise<string | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<typeof TIMED_OUT>(r => { timer = setTimeout(() => r(TIMED_OUT), limitMs); timer.unref?.(); });
  try {
    return await Promise.race([work().catch(() => ''), limit]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whether `hooks.prompt-submitted` is `false` in `.openlore/config.json` (an unreadable config is "on"). */
export function promptSubmittedOff(root: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(root, OPENLORE_DIR, 'config.json'), 'utf-8')) as { hooks?: Record<string, unknown> };
    return cfg?.hooks?.['prompt-submitted'] === false;
  } catch {
    return false;
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
  if (context) console.log(safe(context, { keepNewlines: true }));
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
/**
 * One line naming the decisions autopilot accepted since the previous session, or
 * undefined (change: default-decision-autopilot-with-visible-trace).
 */
export function autoAcceptLine(entries: ReadonlyArray<{ title: string }>): string | undefined {
  if (entries.length === 0) return undefined;
  const clip = (t: string) => (t.length > 60 ? `${t.slice(0, 59)}…` : t);
  const named = entries.slice(0, 3).map((e) => `"${safe(clip(e.title))}"`).join(', ');
  const more = entries.length > 3 ? ` and ${entries.length - 3} more` : '';
  return `Decisions auto-accepted since last session (${entries.length}): ${named}${more} — review: ${DECISIONS_REVIEW_COMMAND}`;
}

function printPrimer(directory: string, asJson: boolean, buildNote?: string, decisionsLine?: string): void {
  const ready = hasAnalysis(directory);
  if (asJson) {
    console.log(jsonOutput({
      openlore: ready ? 'ready' : 'no-analysis',
      message: ready
        ? 'OpenLore architectural memory is active. Call orient with a task before reading source files.'
        : buildNote ?? 'OpenLore is installed but no analysis was found. Run "openlore analyze" to build the graph.',
      usage: 'openlore orient --json --task "<task description>"',
      ...(decisionsLine ? { decisions: decisionsLine } : {}),
    }));
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
  if (decisionsLine) console.log(decisionsLine);
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

/**
 * One-shot self-bootstrap (change: bootstrap-index-from-one-shot-orient): start one detached build
 * for an absent index, and let the read path's staleness signals start the same build. Neither
 * waits. A present index whose call graph is unusable (a version-upgrade schema reset empties the
 * store) is rebuilt too. Both spawn SYNCHRONOUSLY: a one-shot orient process.exit(0)s before any
 * deferred read-path repair microtask could run (change: self-heal-empty-graph-index).
 */
async function bootstrapOneShotIndex(root: string): Promise<OneShotBuild | undefined> {
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
  return build;
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
  .option('--scope <scope>', 'the install scope that wired this hook; `user` stands down where the repository wires the same hook itself')
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

    const root = resolve(directory);
    // A user-scope hook stands down where the repository wires the same hook itself, so a
    // repository wired at both scopes is briefed once (change: user-scope-loop-hooks).
    if (opts.scope === 'user' && (opts.inject || !task)) {
      const { repoWiresStep } = await import('../install/hook-wiring-health.js');
      if (repoWiresStep([process.env.CLAUDE_PROJECT_DIR, root], opts.inject ? 'orient --inject' : 'orient --json')) return;
    }
    // The prompt-submitted moment: off switch first (nothing runs, no build), then the whole
    // moment — index bootstrap and lookup — under its runtime limit (change: hook-reliability).
    if (opts.inject) {
      if (promptSubmittedOff(root)) return;
      const run: { outcome: HookOutcome; reason?: string } = { outcome: 'ok' };
      const out = await withinLimit(async () => {
        try {
          const build = await bootstrapOneShotIndex(root);
          const building = build?.state === 'started' || build?.state === 'running';
          return await injectOutput(directory, task, build && oneShotBuildNote(build), !building && !hasAnalysis(root) && !isInsideGitWorkTree(root), run);
        } catch (error) {
          run.outcome = 'error';
          run.reason = errorReason(error);
          throw error;
        }
      }, PROMPT_SUBMITTED_LIMIT_MS);
      if (out === TIMED_OUT) run.outcome = 'overrun';
      if (out !== TIMED_OUT && out) console.log(out);
      // Hook health (change: hook-reliability, task 6.1): whole-process time, after the output.
      await recordHookRun(root, { moment: 'prompt-submitted', ms: process.uptime() * 1000, outcome: run.outcome, shown: 0, ...(run.reason ? { reason: run.reason } : {}) });
      // Past the limit: stop the work still running.
      if (out === TIMED_OUT) process.exit(0);
      return;
    }

    let build = await bootstrapOneShotIndex(root);
    const buildNote = (): string | undefined => build && oneShotBuildNote(build);

    // No task → session-start primer (keeps the install hook from erroring).
    if (!task) {
      printPrimer(directory, asJson, buildNote(), autoAcceptLine(await takeAutoAcceptsSinceLastSession(root)));
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
        console.log(jsonOutput(result));
      } else {
        printHuman(result);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (asJson) {
        console.log(jsonOutput({ error: message }));
      } else {
        logger.error(`orient failed: ${message}`);
      }
      process.exitCode = 1;
    }
  });
