/**
 * Preset task-COMPLETION benchmark — phase 1 of the rigorous DefaultSurfaceRevealsAllFaces
 * validation (change: refine-happy-path-and-defaults).
 *
 * `bench-preset-selection.ts` measured first-tool SELECTION on a hand-authored corpus.
 * This measures end-to-end task completion for arbitrary preset A and preset B on
 * pinned real repos, scored by an INDEPENDENT oracle.
 *
 * It does not reimplement the agent loop — it drives the existing `bench-agent.ts`
 * (clone @ SHA → analyze → run headless `claude` → score by `expect.mustInclude` →
 * metrics) once per preset via its `--with-only --results-json` hook, then compares the
 * two WITH arms per repo TIER. The outer protocol runner applies its selected,
 * pre-registered decision rule. Reusing that
 * harness means the corpus, oracle, isolation (`--strict-mcp-config`) and metrics are
 * the audited ones, not a second implementation.
 *
 * Setup runs ONCE (clone+analyze) and is reused across both presets (same index; only
 * the wired MCP preset differs). Uses the Claude Code CLI — subscription auth, no API key.
 *
 * Run:  npx tsx scripts/bench-preset-completion.ts [--runs N] [--model sonnet|opus]
 *                                                  [--repos a,b] [--tasks x,y]
 *                                                  [--dry-run] [--skip-setup] [--json]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_AGENT = join(__dirname, 'bench-agent.ts');

type Preset = string;
type Tier = 'small-familiar' | 'large-unfamiliar';

interface Cell { costUsd: number; correctRate: number; n: number; failures: number; freshInputTokens: number; cacheReadTokens: number }
interface TaskResult {
  taskId: string;
  repo: string;
  tier: Tier;
  with: Cell;
  trajectories: Array<{ rawArtifact?: string; steps?: number; tokenCost?: number }>;
}
interface AgentResults {
  corpus: { id: string; image: string; digest: string };
  repositories: Array<{ id: string; url: string; sha: string; tier: Tier }>;
  perTask: TaskResult[];
}

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const hasFlag = (f: string): boolean => process.argv.includes(f);

function runArm(preset: Preset, work: string, resultsPath: string, firstArm: boolean): AgentResults {
  const args = [
    BENCH_AGENT,
    '--with-only',
    '--with-preset', preset,
    '--results-json', resultsPath,
    '--out', join(work, `report-${preset}.md`),
    '--work', work,
    '--runs', arg('--runs', '3')!,
    '--model', arg('--model', 'sonnet')!,
    '--max-budget-usd', arg('--max-budget-usd', '2')!,
  ];
  if (arg('--repos')) args.push('--repos', arg('--repos')!);
  if (arg('--tasks')) args.push('--tasks', arg('--tasks')!);
  if (arg('--artifacts-dir')) args.push('--artifacts-dir', arg('--artifacts-dir')!);
  if (hasFlag('--dry-run')) args.push('--dry-run');
  // Setup (clone + analyze) runs only for the FIRST arm; the second reuses the same
  // work dir + index. A caller-supplied --skip-setup forces reuse for both.
  if (hasFlag('--skip-setup') || !firstArm) args.push('--skip-setup');

  execFileSync(process.execPath, ['--import', 'tsx', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  return JSON.parse(readFileSync(resultsPath, 'utf-8')) as AgentResults;
}

const TIERS: Tier[] = ['small-familiar', 'large-unfamiliar'];

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface TierAgg { tier: Tier; tasks: number; correctness: number; costUsd: number; failures: number }
function aggregate(results: AgentResults): Record<Tier, TierAgg> {
  const out = {} as Record<Tier, TierAgg>;
  for (const tier of TIERS) {
    const cells = results.perTask.filter((t) => t.tier === tier).map((t) => t.with);
    out[tier] = {
      tier,
      tasks: cells.length,
      correctness: mean(cells.map((c) => c.correctRate)),
      costUsd: median(cells.map((c) => c.costUsd)),
      failures: cells.reduce((total, cell) => total + cell.failures, 0),
    };
  }
  return out;
}

function pctOrDash(n: number): string { return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—'; }

function main(): void {
  const work = arg('--work', join(tmpdir(), 'openlore-bench-preset-completion'))!;
  mkdirSync(work, { recursive: true });
  const json = hasFlag('--json');
  const presets = [arg('--preset-a', 'navigation')!, arg('--preset-b', 'substrate')!];

  if (!hasFlag('--dry-run')) {
    console.error('[bench-preset-completion] LIVE run — clones repos and makes real agent calls (Claude Code CLI). Ctrl-C to abort.');
  }

  const byPreset: Record<Preset, AgentResults> = {};
  presets.forEach((preset, idx) => {
    console.error(`\n[bench-preset-completion] === arm: ${preset} ===`);
    byPreset[preset] = runArm(preset, work, join(work, `results-${preset}.json`), idx === 0);
  });

  const aggA = aggregate(byPreset[presets[0]]);
  const aggB = aggregate(byPreset[presets[1]]);

  const perTier = TIERS.map((tier) => {
    const current = aggA[tier], candidate = aggB[tier];
    const costDelta = current.costUsd > 0 ? candidate.costUsd / current.costUsd - 1 : 0;
    return { tier, current, candidate, costDelta };
  });

  const summary = {
    presets,
    corpus: Object.values(byPreset)[0]?.corpus.id,
    repositories: Object.values(byPreset)[0]?.repositories,
    perTier,
    rawArmArtifacts: Object.fromEntries(presets.map((preset) => [
      preset,
      byPreset[preset].perTask.flatMap((task) => task.trajectories.map((trajectory) => trajectory.rawArtifact).filter(Boolean)),
    ])),
    trajectoryScores: Object.fromEntries(presets.map((preset) => [
      preset,
      byPreset[preset].perTask.map((task) => ({ taskId: task.taskId, repo: task.repo, runs: task.trajectories })),
    ])),
    note: hasFlag('--dry-run') ? 'DRY RUN — synthetic mock numbers, not decision-grade' : undefined,
  };

  // Persist the evidence (gitignored dir; the report numbers go in the change docs).
  try {
    const dir = join(process.cwd(), '.openlore', 'bench');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'preset-completion.json'), JSON.stringify({ byPreset, summary }, null, 2));
  } catch { /* non-fatal */ }

  if (json) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); return; }

  const L: string[] = ['', `Task-completion comparison — ${presets[0]} vs ${presets[1]} (end-to-end, oracle-scored):`, ''];
  L.push('  tier              tasks   correctness(A→B)      median cost(A→B)     Δcost');
  L.push('  ' + '-'.repeat(78));
  for (const t of perTier) {
    L.push('  ' + t.tier.padEnd(18) + String(t.candidate.tasks).padStart(3) + '     ' +
      `${pctOrDash(t.current.correctness)} → ${pctOrDash(t.candidate.correctness)}`.padEnd(22) +
      `$${t.current.costUsd.toFixed(3)} → $${t.candidate.costUsd.toFixed(3)}`.padEnd(22) +
      `${t.costDelta >= 0 ? '+' : ''}${Math.round(t.costDelta * 100)}%`);
  }
  L.push('');
  L.push('  The outer protocol runner applies the selected pre-registered rule.');
  L.push('');
  process.stdout.write(L.join('\n') + '\n');
}

main();
