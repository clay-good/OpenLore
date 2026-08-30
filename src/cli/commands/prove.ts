/**
 * `openlore prove` (Spec 25 Q2) — measure OpenLore's token value on the user's
 * OWN repo and print a personal scorecard. Runs a WITH/WITHOUT agent pass over
 * a few graph-derived orientation tasks, isolated with --strict-mcp-config, and
 * reports cost / round-trips / correctness deltas + an honest verdict.
 *
 * The substrate needs no API key; this command's agent arm does (it shells out
 * to `claude`). When `claude` is absent it fails fast with guidance; `--dry-run`
 * exercises the whole pipeline with clearly-labelled synthetic numbers.
 *
 * Output + sharing (add-prove-shareable-scorecard):
 *   --json       stable, CI-consumable scorecard (decision 581a90bf)
 *   --markdown   paste-ready block + shields.io badge for a README
 *   --save       persist a dated scorecard under .openlore/prove/ (decision 670b5f0b)
 *   --estimate   deterministic, no-API graph projection of the orientation tax (decision 66feae62)
 */

import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import { readCachedContext } from '../../core/services/mcp-handlers/utils.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { OPENLORE_ANALYSIS_REL_PATH, OPENLORE_PROVE_REL_PATH } from '../../constants.js';
import {
  deriveTasks,
  measureProveEligibility,
  proveEligibilityFromCount,
  PROVE_MIN_CALLERS,
  scoreAnswer,
  type GraphFact,
  type ProveTask,
} from '../../core/agent-eval/tasks.js';
import {
  claudeRunner, writeProveMcpConfigs, summarize, parseAgentJson,
  type AgentRunner, type Condition, type Metrics, type Cell,
} from '../../core/agent-eval/measure.js';
import { estimateCells } from '../../core/agent-eval/estimate.js';
import {
  estimateVocabularyRecall,
  type RetrievalRecallEstimate,
  type RetrievalRecallNode,
} from '../../core/agent-eval/retrieval-recall-estimate.js';
import {
  computeScorecard, renderScorecard, serializeScorecard, renderScorecardMarkdown, money,
  type Scorecard, type ScorecardMeta, type ProveMode,
} from '../../core/agent-eval/scorecard.js';

interface ProveOptions {
  directory?: string;
  runs?: string;
  model?: string;
  maxBudgetUsd?: string;
  dryRun?: boolean;
  estimate?: boolean;
  json?: boolean;
  markdown?: boolean;
  save?: boolean;
}

export function formatProveIneligibleMessage(eligibility: ReturnType<typeof measureProveEligibility>): string {
  return `Could not derive orientation tasks: ${eligibility.eligibleFunctions} functions have ` +
    `≥${eligibility.minCallers} callers; at least ${eligibility.requiredEligibleFunctions} is required. ` +
    'Nothing is wrong with the installation — skip this prove run for this repo, or run it on a larger repo.';
}

const PROVE_GRAPH_UNAVAILABLE =
  'Could not read the analysis graph. Retry after any running "openlore analyze" completes; ' +
  'if the problem persists, run "openlore analyze" to rebuild it.';

/** Locate this CLI's own entry so the spawned MCP server is the same build. */
function localCliEntry(): string {
  // dist/cli/commands/prove.js → dist/cli/index.js
  return resolve(fileURLToPath(import.meta.url), '..', '..', 'index.js');
}

/** Build GraphFacts from the analysis EdgeStore (the call graph). */
export async function loadGraphFacts(absDir: string): Promise<GraphFact[] | null> {
  const ctx = await readCachedContext(absDir);
  const store = ctx?.edgeStore;
  if (!store) return null;
  const nodes = store.getAllInternalNodes();
  return nodes.map(n => {
    const callerNames = store.getCallers(n.id)
      .map(e => store.getNode(e.callerId)).filter(x => x && !x.isExternal).map(x => x!.name);
    const calleeNames = store.getCallees(n.id)
      .map(e => store.getNode(e.calleeId)).filter(x => x && !x.isExternal).map(x => x!.name);
    // Entry point = no internal callers (matches the analyzer's definition).
    return { name: n.name, filePath: n.filePath, isEntryPoint: callerNames.length === 0, callerNames, calleeNames };
  });
}

async function loadRetrievalRecallNodes(absDir: string): Promise<RetrievalRecallNode[]> {
  const ctx = await readCachedContext(absDir);
  return ctx?.edgeStore?.getAllInternalNodes().map((node) => ({
    id: node.id,
    name: node.name,
    filePath: node.filePath,
    className: node.className,
    signature: node.signature,
    docstring: node.docstring,
  })) ?? [];
}

/** Read prove's structural precondition with one bounded aggregate query. */
export async function loadProveEligibility(absDir: string): Promise<ReturnType<typeof measureProveEligibility> | null> {
  const analysisDir = join(absDir, OPENLORE_ANALYSIS_REL_PATH);
  if (!EdgeStore.exists(analysisDir)) return null;
  const store = EdgeStore.open(EdgeStore.dbPath(analysisDir));
  try {
    if (store.notReady) return null;
    return proveEligibilityFromCount(store.countNodesWithMinFanIn(PROVE_MIN_CALLERS));
  } finally {
    store.close();
  }
}

function claudeAvailable(): boolean {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Best-effort short repo SHA for scorecard provenance; null when unavailable. */
function gitShortSha(cwd: string): string | null {
  try {
    // Silence the child's stderr ('fatal: not a git repository' / 'Needed a single
    // revision') — the throw is handled here; we don't want it on our stderr.
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Parse a numeric CLI flag, clamping a valid value to `min` but REJECTING a
 * non-numeric one (e.g. `--runs abc`) instead of silently letting NaN through —
 * NaN would skip every agent run and emit a degenerate all-zero scorecard.
 */
export function parseNumericFlag(
  raw: string | undefined, name: string, integer: boolean, min: number, dflt: number,
): number | { error: string } {
  if (raw === undefined) return dflt;
  const n = integer ? parseInt(raw, 10) : parseFloat(raw);
  if (!Number.isFinite(n)) return { error: `--${name} must be a number (got "${raw}")` };
  return Math.max(min, n);
}

/** Synthetic metrics for --dry-run: WITH is cheaper + fewer turns, both correct. */
function mockRun(task: ProveTask, condition: Condition, runIdx: number): Metrics {
  const withCond = condition === 'with';
  const base = (task.id.length + runIdx) % 4;
  const answer = `[mock] ${task.mustIncludeAny[0] ?? 'answer'}`;
  return {
    freshInputTokens: withCond ? 4000 + base * 100 : 13000 + base * 400,
    cacheReadTokens: withCond ? 30000 : 6000,
    outputTokens: withCond ? 300 : 800,
    costUsd: withCond ? 0.040 + base * 0.001 : 0.052 + base * 0.003,
    numTurns: withCond ? 3 + (base % 2) : 7 + base,
    durationMs: withCond ? 9000 : 24000,
    answer,
    correct: scoreAnswer(task, answer),
  };
}

function runOne(
  task: ProveTask, condition: Condition, runIdx: number,
  cfg: { withPath: string; withoutPath: string; systemPrompt: string },
  opts: { cwd: string; model: string; maxBudgetUsd: number; dryRun: boolean; runner: AgentRunner },
): Metrics {
  if (opts.dryRun) return mockRun(task, condition, runIdx);
  try {
    const raw = opts.runner({
      prompt: task.prompt,
      mcpConfigPath: condition === 'with' ? cfg.withPath : cfg.withoutPath,
      cwd: opts.cwd,
      model: opts.model,
      maxBudgetUsd: opts.maxBudgetUsd,
      systemPrompt: condition === 'with' ? cfg.systemPrompt : undefined,
    });
    const parsed = parseAgentJson(raw);
    return { ...parsed, correct: scoreAnswer(task, parsed.answer) };
  } catch (err) {
    return {
      freshInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 0,
      durationMs: 0, answer: '', correct: false, error: (err as Error).message,
    };
  }
}

/** Raw metrics carried alongside a scorecard, for persistence (`--save`). */
export interface ProveRaw {
  withoutCell: Cell;
  withCell: Cell;
  /** Per-run metrics (measured / dry-run only; absent for an estimate). */
  withoutRuns?: Metrics[];
  withRuns?: Metrics[];
}

export interface ProveResult {
  ok: boolean;
  message: string;
  scorecard?: Scorecard;
  meta?: ScorecardMeta;
  raw?: ProveRaw;
  /** Present only for the deterministic estimate arm. */
  retrievalRecall?: RetrievalRecallEstimate;
}

/**
 * Summarize the two measured arms into comparable cells — but only over
 * SUCCESSFUL runs. An errored run (agent threw / unparseable output) is not a
 * valid cost/turn sample: including its zeros pollutes the medians, and if EVERY
 * run failed the all-zero cells would emit a confident-looking but meaningless
 * "break-even" verdict through the JSON contract. So errored runs are dropped,
 * and if either arm has no successful sample we fail loudly rather than report a
 * verdict over no data. Pure + exported for unit testing without a graph.
 */
export function summarizeArms(
  withoutRuns: Metrics[], withRuns: Metrics[],
): { ok: true; withoutCell: Cell; withCell: Cell } | { ok: false; message: string } {
  const okWithout = withoutRuns.filter(r => !r.error);
  const okWith = withRuns.filter(r => !r.error);
  if (okWithout.length === 0 || okWith.length === 0) {
    const total = withoutRuns.length + withRuns.length;
    const failed = total - okWithout.length - okWith.length;
    const firstErr = [...withoutRuns, ...withRuns].find(r => r.error)?.error ?? 'unknown error';
    return {
      ok: false,
      message: `prove produced no usable measurement — ${failed}/${total} agent runs failed (e.g. "${firstErr}"). ` +
        'Check that `claude` works here (auth, API key, budget), then retry; or use `--estimate` for a no-agent projection.',
    };
  }
  return { ok: true, withoutCell: summarize(okWithout), withCell: summarize(okWith) };
}

/**
 * Core (testable) prove run: derive tasks, then either run both agent arms N
 * times (measured / dry-run) or compute the deterministic estimate. Returns the
 * scorecard + provenance so the command can render any output form. `runner` is
 * injectable so tests never call a real agent; `generatedAt`/`repoSha` are passed
 * in so the core stays deterministic.
 */
export async function runProve(opts: {
  directory: string;
  runs: number;
  model: string;
  maxBudgetUsd: number;
  dryRun: boolean;
  estimate?: boolean;
  generatedAt: string;
  repoSha: string | null;
  runner?: AgentRunner;
}): Promise<ProveResult> {
  const absDir = resolve(opts.directory);
  let eligibility: Awaited<ReturnType<typeof loadProveEligibility>>;
  try {
    eligibility = await loadProveEligibility(absDir);
  } catch {
    return { ok: false, message: PROVE_GRAPH_UNAVAILABLE };
  }
  if (!eligibility) {
    return { ok: false, message: 'No analysis graph found. Run "openlore analyze" first, then "openlore prove".' };
  }
  if (!eligibility.eligible) {
    return {
      ok: false,
      message: formatProveIneligibleMessage(eligibility),
    };
  }
  const facts = await loadGraphFacts(absDir);
  if (!facts) {
    return { ok: false, message: 'No analysis graph found. Run "openlore analyze" first, then "openlore prove".' };
  }
  const tasks = deriveTasks(facts);

  const mode: ProveMode = opts.estimate ? 'estimate' : opts.dryRun ? 'dry-run' : 'measured';

  // ── Estimate arm: deterministic, no agent, no API key ──────────────────────
  if (mode === 'estimate') {
    const cells = estimateCells(facts, tasks);
    if (!cells) {
      return { ok: false, message: 'Could not estimate — no oracle-able tasks for this graph.' };
    }
    const sc = computeScorecard(cells.without, cells.with);
    const meta: ScorecardMeta = {
      mode, generatedAt: opts.generatedAt, repoSha: opts.repoSha, model: null, tasks: tasks.length,
    };
    const retrievalRecall = estimateVocabularyRecall(
      join(absDir, OPENLORE_ANALYSIS_REL_PATH),
      await loadRetrievalRecallNodes(absDir),
    );
    const recallLine = `Retrieval recall@${retrievalRecall.recallAt} (estimate, symbol/doc-comment pairs): `
      + `${retrievalRecall.baselineRecall.toFixed(2)}% → ${retrievalRecall.vocabularyRecall.toFixed(2)}% `
      + `(${retrievalRecall.deltaPercentagePoints >= 0 ? '+' : ''}${retrievalRecall.deltaPercentagePoints.toFixed(2)} pp; `
      + `${retrievalRecall.evaluatedPairs}/${retrievalRecall.availablePairs} pairs evaluated)`;
    return {
      ok: true,
      message: `${renderScorecard(sc, { tasks: tasks.length, mode })}\n\n${recallLine}`,
      scorecard: sc,
      meta,
      raw: { withoutCell: cells.without, withCell: cells.with },
      retrievalRecall,
    };
  }

  // ── Measured / dry-run arms: WITH vs WITHOUT agent passes ───────────────────
  const work = mkdtempSync(join(tmpdir(), 'openlore-prove-'));
  const cfg = writeProveMcpConfigs(work, localCliEntry());
  const runner = opts.runner ?? claudeRunner;

  const withRuns: Metrics[] = [];
  const withoutRuns: Metrics[] = [];
  for (const task of tasks) {
    for (let i = 0; i < opts.runs; i++) {
      withoutRuns.push(runOne(task, 'without', i, cfg, { cwd: absDir, ...opts, runner }));
      withRuns.push(runOne(task, 'with', i, cfg, { cwd: absDir, ...opts, runner }));
    }
  }

  const arms = summarizeArms(withoutRuns, withRuns);
  if (!arms.ok) return { ok: false, message: arms.message };
  const { withoutCell, withCell } = arms;
  const sc = computeScorecard(withoutCell, withCell);
  const meta: ScorecardMeta = {
    mode, generatedAt: opts.generatedAt, repoSha: opts.repoSha, model: opts.model, tasks: tasks.length,
  };
  return {
    ok: true,
    message: renderScorecard(sc, { tasks: tasks.length, mode }),
    scorecard: sc,
    meta,
    raw: { withoutCell, withCell, withoutRuns, withRuns },
  };
}

/**
 * Persist a scorecard to a dated, non-clobbering file under .openlore/prove/.
 * Returns the absolute path written. Same-day repeats get a numeric suffix so a
 * prior run is never overwritten (decision 670b5f0b).
 */
/** Round the monetary fields of a raw cell/metrics block so the saved file carries no float noise. */
function roundRawCosts(raw: ProveRaw): ProveRaw {
  const cell = (c: Cell): Cell => ({ ...c, costUsd: money(c.costUsd) });
  const runs = (rs?: Metrics[]): Metrics[] | undefined =>
    rs?.map(r => ({ ...r, costUsd: money(r.costUsd) }));
  return {
    withoutCell: cell(raw.withoutCell),
    withCell: cell(raw.withCell),
    withoutRuns: runs(raw.withoutRuns),
    withRuns: runs(raw.withRuns),
  };
}

export function saveScorecard(absDir: string, result: ProveResult): string {
  const sc = result.scorecard!;
  const meta = result.meta!;
  const dir = join(absDir, OPENLORE_PROVE_REL_PATH);
  mkdirSync(dir, { recursive: true });
  const day = meta.generatedAt.slice(0, 10); // YYYY-MM-DD
  const payload = JSON.stringify(
    {
      ...serializeScorecard(sc, meta),
      raw: result.raw ? roundRawCosts(result.raw) : undefined,
      retrievalRecall: result.retrievalRecall,
    },
    null, 2,
  ) + '\n';
  // Pick a non-clobbering name ATOMICALLY: open each candidate with O_CREAT|O_EXCL
  // (`wx`) and advance the suffix on EEXIST. An existsSync-then-write check races
  // under concurrency and silently overwrites a prior run; `wx` closes that window
  // so the "never overwritten" guarantee actually holds.
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? `prove-${day}.json` : `prove-${day}-${n}.json`);
    try {
      writeFileSync(path, payload, { encoding: 'utf-8', flag: 'wx' });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
}

export const proveCommand = new Command('prove')
  .description("Measure OpenLore's token value on YOUR repo (WITH vs WITHOUT, personal scorecard)")
  .option('--directory <path>', 'Repo to measure (default: current directory)')
  .option('--runs <n>', 'Runs per arm per task — more = less noise (default: 2)')
  .option('--model <name>', 'Agent model (default: sonnet)')
  .option('--max-budget-usd <n>', 'Per-agent-call USD ceiling (default: 0.5)')
  .option('--estimate', 'Deterministic graph projection of the orientation tax — no agent, no API key', false)
  .option('--dry-run', 'Exercise the pipeline with synthetic numbers (no agent, no API key)', false)
  .option('--json', 'Emit the scorecard as stable JSON (CI-consumable) instead of the human view', false)
  .option('--markdown', 'Emit a paste-ready markdown block + badge for a README', false)
  .option('--save', 'Persist a dated scorecard under .openlore/prove/', false)
  .addHelpText('after', `
Measures fewer-round-trips / lower-cost at equal correctness over a few tasks
auto-derived from your call graph. The agent arm shells out to \`claude\` (needs
an API key); the openlore substrate itself needs none.

Examples:
  $ openlore prove --estimate        Honest estimate, no API key (great first look)
  $ openlore prove --dry-run         See the scorecard shape with synthetic data
  $ openlore prove --runs 4          Real measurement (needs claude + API key)
  $ openlore prove --estimate --markdown --save   Shareable badge + a saved record
`)
  .action(async (opts: ProveOptions) => {
    const directory = opts.directory ?? process.cwd();
    const model = opts.model ?? 'sonnet';
    const dryRun = opts.dryRun ?? false;
    const estimate = opts.estimate ?? false;
    const json = opts.json ?? false;
    const markdown = opts.markdown ?? false;

    // Two machine forms can't both own stdout — fail loudly rather than silently
    // dropping one.
    if (json && markdown) {
      logger.error('--json and --markdown are mutually exclusive; pass only one.');
      process.exitCode = 1;
      return;
    }
    // Machine output owns stdout — suppress the human log chrome so it stays parseable.
    const machine = json || markdown;

    // Reject non-numeric --runs / --max-budget-usd (NaN would skip every run and
    // emit a degenerate all-zero scorecard).
    const runs = parseNumericFlag(opts.runs, 'runs', true, 1, 2);
    if (typeof runs === 'object') { logger.error(runs.error); process.exitCode = 1; return; }
    const maxBudgetUsd = parseNumericFlag(opts.maxBudgetUsd, 'max-budget-usd', false, 0, 0.5);
    if (typeof maxBudgetUsd === 'object') { logger.error(maxBudgetUsd.error); process.exitCode = 1; return; }

    // The agent arm needs `claude`; the estimate + dry-run arms do not.
    if (!dryRun && !estimate && !claudeAvailable()) {
      let eligibility: Awaited<ReturnType<typeof loadProveEligibility>>;
      try {
        eligibility = await loadProveEligibility(resolve(directory));
      } catch {
        logger.error(PROVE_GRAPH_UNAVAILABLE);
        process.exitCode = 1;
        return;
      }
      if (!eligibility) {
        logger.error('No analysis graph found. Run "openlore analyze" first, then "openlore prove".');
        process.exitCode = 1;
        return;
      }
      if (!eligibility.eligible) {
        logger.error(formatProveIneligibleMessage(eligibility));
        process.exitCode = 1;
        return;
      }
      logger.error('`claude` CLI not found on PATH — the prove agent arm needs it (plus an API key).');
      logger.info('Try', 'Run `openlore prove --estimate` for a no-API-key projection, or `--dry-run` to preview the shape.');
      process.exitCode = 1;
      return;
    }

    if (!machine) {
      logger.section('openlore prove');
      if (!dryRun && !estimate) {
        logger.discovery(`Running ${runs} run(s)/arm over graph-derived tasks (this calls \`claude\` and costs money)…`);
      }
    }

    const generatedAt = new Date().toISOString();
    const repoSha = gitShortSha(resolve(directory));
    const result = await runProve({ directory, runs, model, maxBudgetUsd, dryRun, estimate, generatedAt, repoSha });
    if (!result.ok) {
      logger.error(result.message);
      process.exitCode = 1;
      return;
    }

    if (opts.save) {
      // A filesystem failure (e.g. .openlore/prove is a file, permissions, full
      // disk) must not crash the process with a stack trace and discard the
      // already-computed scorecard — surface it and still print the result.
      try {
        const path = saveScorecard(resolve(directory), result);
        // Written to stderr directly so it never pollutes --json / --markdown stdout.
        process.stderr.write(`Saved scorecard → ${path}\n`);
      } catch (err) {
        process.stderr.write(`Could not save scorecard: ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    }

    if (json) {
      console.log(JSON.stringify({
        ...serializeScorecard(result.scorecard!, result.meta!),
        retrievalRecall: result.retrievalRecall,
      }, null, 2));
    } else if (markdown) {
      const recall = result.retrievalRecall;
      console.log(renderScorecardMarkdown(result.scorecard!, result.meta!)
        + (recall
          ? `\n\nRetrieval recall@${recall.recallAt} (estimate): ${recall.baselineRecall.toFixed(2)}% → ${recall.vocabularyRecall.toFixed(2)}%.`
          : ''));
    } else {
      console.log(result.message);
    }
  });
