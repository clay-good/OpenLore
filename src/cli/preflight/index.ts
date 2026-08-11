/**
 * `openlore preflight` — CI staleness gate.
 *
 * Determines whether the persisted analysis graph is current relative to
 * the working tree. Designed to run on every PR so out-of-date graphs
 * never reach orient() / agent runtime silently.
 *
 * Exit codes: 0 = fresh, 1 = stale, 2 = error.
 */

import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { logger } from '../../utils/logger.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_CALL_GRAPH_DB,
} from '../../constants.js';
import { readAnalysisOwner } from '../../core/runtime/analysis-ownership.js';
import { computeDiff, readGraphFingerprint } from './diff.js';
import { scoreChangedFiles } from './score.js';
import {
  buildSummary,
  renderHuman,
  renderJson,
  renderGithubAnnotations,
  type PreflightSummary,
} from './report.js';

export interface PreflightOptions {
  cwd?: string;
  fix?: boolean;
  json?: boolean;
  since?: string;
  maxStaleness?: number;
  /**
   * Test-only seam: replace the analyzer invocation used by --fix. Returns
   * the exit code (0 = success). Production code spawns `openlore analyze`;
   * tests pass a stub that simulates the side-effect (refreshing
   * fingerprint.json) without needing the full pipeline.
   */
  analyzeFn?: (cwd: string) => Promise<number>;
}

const DEFAULT_THRESHOLD = 0;

export async function runPreflight(opts: PreflightOptions): Promise<{
  code: number;
  summary?: PreflightSummary;
}> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const threshold = typeof opts.maxStaleness === 'number' ? opts.maxStaleness : DEFAULT_THRESHOLD;

  // 1. Graph must exist.
  const dbPath = join(cwd, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_CALL_GRAPH_DB);
  try {
    await access(dbPath);
  } catch {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            status: 'ERROR',
            error: 'no graph found',
            hint: 'run `openlore analyze` first',
          },
          null,
          2
        ) + '\n'
      );
    } else {
      logger.error(
        'No graph found. Run `openlore analyze` first to build the analysis graph.'
      );
    }
    return { code: 2 };
  }

  // 2. Read graph metadata.
  const fp = await readGraphFingerprint(cwd);
  const graphBuiltAt = fp?.computedAt ?? null;
  // We don't store the build commit today — leave null. Once analyze records
  // it, this is the single place to surface it. (See TODO in docs/preflight.md.)
  const graphCommit: string | null = null;

  // 3. Compute changed files.
  let diff;
  try {
    diff = await computeDiff({ repoRoot: cwd, graphBuiltAt, since: opts.since });
  } catch (err) {
    const e = err as Error & { exitCode?: number };
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ status: 'ERROR', error: e.message }, null, 2) + '\n'
      );
    } else {
      logger.error(e.message);
    }
    return { code: e.exitCode ?? 2 };
  }

  // 4. Score.
  const score = scoreChangedFiles(cwd, diff.changed);

  // 5. Build summary. A live analysis owner outranks staleness, so preflight
  // never tells a user to rebuild an index that is already being rebuilt.
  const active = await readAnalysisOwner(cwd, join(cwd, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR));
  const summary = buildSummary({
    diff, score, graphBuiltAt, graphCommit, threshold,
    ...(active ? {
      activeAnalysis: {
        pid: active.owner?.pid ?? null,
        stage: active.owner?.stage ?? null,
        startedAt: active.owner?.startedAt ?? null,
        elapsedMs: active.elapsedMs,
        heartbeatAgeMs: active.heartbeatAgeMs,
      },
    } : {}),
  });
  const stale = summary.stalenessScore > threshold;

  // 6. --fix path runs `openlore analyze` then re-checks. Never while another
  // process owns the analysis: that is the duplicate run single flight prevents.
  if (stale && opts.fix && !active) {
    if (!opts.json) logger.discovery('Stale graph detected — running `openlore analyze --fix`');
    const code = await (opts.analyzeFn ?? runAnalyzeFix)(cwd);
    if (code !== 0) {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ status: 'ERROR', error: 'openlore analyze --fix failed' }, null, 2) +
            '\n'
        );
      } else {
        logger.error('openlore analyze failed during --fix; manual intervention required');
      }
      return { code: 2 };
    }
    // Re-run preflight WITHOUT --fix and WITHOUT --since (now everything
    // should be current vs. the freshly built graph).
    return runPreflight({
      cwd,
      json: opts.json,
      maxStaleness: opts.maxStaleness,
      analyzeFn: opts.analyzeFn,
    });
  }

  // 7. Render.
  if (opts.json) {
    process.stdout.write(renderJson(summary) + '\n');
  } else {
    process.stdout.write(renderHuman(summary) + '\n');
  }

  // 8. GitHub Actions inline annotations (no-op outside GHA).
  const annotations = renderGithubAnnotations(summary);
  if (annotations) process.stdout.write(annotations + '\n');

  return { code: stale ? 1 : 0, summary };
}

async function runAnalyzeFix(cwd: string): Promise<number> {
  return new Promise((resolveProm) => {
    // `--reanalyze`: this runs BECAUSE the graph was judged stale, and staleness is not
    // always a source change — a bare `analyze` would hit the source-unchanged skip and
    // silently do nothing, leaving the gate to fail again. It is deliberately not `--force`:
    // the per-file extraction cache is keyed by content, so unchanged files are reused and
    // the fix costs the diff (change: optimize-hash-keyed-analyze).
    const child = spawn(process.execPath, [process.argv[1], 'analyze', '--reanalyze'], {
      cwd,
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolveProm(code ?? 1));
    child.on('error', () => resolveProm(1));
  });
}

export const preflightCommand = new Command('preflight')
  .description('CI staleness gate: check whether the analysis graph is current relative to the working tree.')
  .option('--fix', 'Run `openlore analyze` if the graph is stale, then re-check', false)
  .option('--json', 'Emit JSON instead of human-readable output', false)
  .option('--since <ref>', 'Diff against this git ref (e.g. origin/main) instead of mtimes')
  .option(
    '--max-staleness <n>',
    `Maximum allowed staleness score (default ${DEFAULT_THRESHOLD})`,
    (v) => parseInt(v, 10),
    DEFAULT_THRESHOLD
  )
  .action(async (opts: PreflightOptions) => {
    const { code } = await runPreflight(opts);
    process.exit(code);
  });
