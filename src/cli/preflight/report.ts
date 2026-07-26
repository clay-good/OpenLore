/**
 * Human-readable + JSON renderers for preflight results.
 */

import { sanitizeForTerminal } from '../../utils/misc.js';
import type { DiffResult } from './diff.js';
import type { ScoreResult } from './score.js';

export type PreflightStatus = 'FRESH' | 'STALE' | 'ERROR';

export interface PerFileEntry {
  filePath: string;
  weight: number;
  hub: boolean;
  /** Highest fan-in across nodes in the file (for "why is this a hub"). */
  maxFanIn: number;
  /** True if the file isn't represented in the graph at all. */
  unknown: boolean;
}

export interface PreflightSummary {
  status: PreflightStatus;
  graphBuiltAt: string | null;
  graphCommit: string | null;
  workingCommit: string | null;
  changedFiles: string[];
  unknownFiles: string[];
  /** Per-file detail with weight + hub flag. Same order as `changedFiles`. */
  perFile: PerFileEntry[];
  hubCount: number;
  leafCount: number;
  stalenessScore: number;
  threshold: number;
  mechanism: 'git' | 'mtime';
  warnings: string[];
  message: string;
}

export interface BuildSummaryInput {
  diff: DiffResult;
  score: ScoreResult;
  graphBuiltAt: string | null;
  graphCommit: string | null;
  threshold: number;
}

export function buildSummary(input: BuildSummaryInput): PreflightSummary {
  const { diff, score, graphBuiltAt, graphCommit, threshold } = input;
  const totalChanged = diff.changed.length;
  const stale = score.totalScore > threshold;
  const status: PreflightStatus = stale ? 'STALE' : 'FRESH';

  let message: string;
  if (totalChanged === 0) {
    message = 'nothing to check — no changed files since graph build';
  } else if (stale) {
    message = `STALE — run \`openlore analyze\` or re-run with --fix`;
  } else {
    message = 'FRESH';
  }

  // Build per-file detail in the same order as diff.changed so renderers
  // can show "why" each file matters without re-querying the graph.
  const scoreByPath = new Map(score.perFile.map((f) => [f.filePath, f]));
  const unknownSet = new Set(score.unknownFiles);
  const perFile: PerFileEntry[] = diff.changed.map((p) => {
    const s = scoreByPath.get(p);
    return {
      filePath: p,
      weight: s?.weight ?? 0,
      hub: s?.hub ?? false,
      maxFanIn: s?.maxFanIn ?? 0,
      unknown: unknownSet.has(p),
    };
  });

  return {
    status,
    graphBuiltAt,
    graphCommit,
    workingCommit: diff.workingCommit,
    changedFiles: diff.changed,
    unknownFiles: score.unknownFiles,
    perFile,
    hubCount: score.hubCount,
    leafCount: score.leafCount,
    stalenessScore: score.totalScore,
    threshold,
    mechanism: diff.mechanism,
    warnings: diff.warnings,
    message,
  };
}

function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - s.length));
}

export function renderHuman(s: PreflightSummary): string {
  const lines: string[] = [];
  lines.push('OpenLore preflight');
  lines.push('──────────────────');
  lines.push(
    `${pad('Graph built:', 15)}${s.graphBuiltAt ?? '(unknown)'}` +
      (s.graphCommit ? `   commit ${s.graphCommit}` : '')
  );
  lines.push(
    `${pad('Working tree:', 15)}${new Date().toISOString()}` +
      (s.workingCommit ? `   commit ${s.workingCommit}` : '')
  );
  if (s.changedFiles.length === 0) {
    lines.push(`${pad('Changed files:', 15)}0`);
  } else {
    lines.push(
      `${pad('Changed files:', 15)}${s.changedFiles.length} (${s.hubCount} hub, ${s.leafCount} leaf` +
        (s.unknownFiles.length ? `, ${s.unknownFiles.length} new/untracked` : '') +
        `)`
    );
  }
  lines.push(
    `${pad('Staleness:', 15)}score ${s.stalenessScore} (threshold ${s.threshold})`
  );
  // Status line: STALE message wins; otherwise distinguish "FRESH" from the
  // genuinely-empty "nothing to check" case so users can tell why CI passed.
  let statusLine: string;
  if (s.status === 'STALE') {
    statusLine = 'STALE — ' + s.message.replace('STALE — ', '');
  } else if (s.changedFiles.length === 0) {
    statusLine = `FRESH — ${s.message}`;
  } else {
    statusLine = 'FRESH';
  }
  lines.push(`${pad('Status:', 15)}${statusLine}`);
  if (s.warnings.length) {
    lines.push('');
    for (const w of s.warnings) lines.push(`  warning: ${w}`);
  }
  // Per-file breakdown — sorted by weight DESC so hubs surface first.
  const ranked = [...s.perFile].sort((a, b) => b.weight - a.weight);
  if (ranked.length > 0) {
    lines.push('');
    const cap = 20;
    const header = ranked.length > cap ? `Changed (showing top ${cap} of ${ranked.length}, by weight):` : 'Changed:';
    lines.push(header);
    for (const f of ranked.slice(0, cap)) {
      lines.push(`  - ${formatFileLine(f)}`);
    }
  }
  return lines.join('\n');
}

function formatFileLine(f: PerFileEntry): string {
  // Paths come from `git diff` — i.e. from the analyzed repository — so a filename
  // may carry ESC and repaint the terminal. This report is built from git output
  // directly rather than from the sanitizing index path, so it has to neutralize
  // them itself (SECURITY.md: any path that reads untrusted repository contents).
  const filePath = sanitizeForTerminal(f.filePath);
  if (f.unknown) {
    return `${filePath}  (new/untracked, weight 0)`;
  }
  const tags: string[] = [];
  if (f.hub) tags.push('hub');
  if (f.maxFanIn > 0 && !f.hub) tags.push(`fan-in ${f.maxFanIn}`);
  else if (f.hub && f.maxFanIn > 0) tags.push(`fan-in ${f.maxFanIn}`);
  const tagStr = tags.length ? tags.join(', ') + ', ' : '';
  return `${filePath}  (${tagStr}weight ${f.weight})`;
}

/**
 * Emit GitHub Actions workflow-command annotations so that stale files
 * appear inline in the PR diff UI when this runs in CI. No-op outside of
 * GHA. Format docs:
 *   https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
 */
export function renderGithubAnnotations(s: PreflightSummary): string {
  if (s.status !== 'STALE') return '';
  if (process.env.GITHUB_ACTIONS !== 'true') return '';
  const lines: string[] = [];
  // Per-file warnings — point CI users at the exact files that pushed us
  // over the threshold. Only annotate files that contributed weight (i.e.
  // appeared in the graph); new/untracked files have weight 0.
  for (const f of s.changedFiles) {
    const inGraphContributor = !s.unknownFiles.includes(f);
    if (!inGraphContributor) continue;
    // Escape per GHA workflow-command escape rules.
    const msg = `OpenLore graph is stale for this file — run \`openlore analyze\` to refresh`;
    lines.push(`::warning file=${escapeAnnotation(f)}::${escapeAnnotation(msg)}`);
  }
  // Top-line error so the PR check fails visibly.
  lines.push(
    `::error::OpenLore preflight: staleness score ${s.stalenessScore} > threshold ${s.threshold} (${s.hubCount} hub, ${s.leafCount} leaf changes). Run \`openlore analyze\`.`
  );
  return lines.join('\n');
}

function escapeAnnotation(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function renderJson(s: PreflightSummary): string {
  // Schema is documented in docs/preflight.md. We deliberately ship more
  // than the spec's minimum (status / graph_built_at / graph_commit /
  // working_commit / changed_files / staleness_score / threshold) — the
  // extras (`unknown_files`, `per_file`, `hub_count`, `leaf_count`,
  // `mechanism`, `warnings`) are purely additive.
  const payload = {
    status: s.status,
    graph_built_at: s.graphBuiltAt,
    graph_commit: s.graphCommit,
    working_commit: s.workingCommit,
    changed_files: s.changedFiles,
    unknown_files: s.unknownFiles,
    per_file: s.perFile.map((f) => ({
      file: f.filePath,
      weight: f.weight,
      hub: f.hub,
      max_fan_in: f.maxFanIn,
      unknown: f.unknown,
    })),
    hub_count: s.hubCount,
    leaf_count: s.leafCount,
    staleness_score: s.stalenessScore,
    threshold: s.threshold,
    mechanism: s.mechanism,
    warnings: s.warnings,
  };
  return JSON.stringify(payload, null, 2);
}
