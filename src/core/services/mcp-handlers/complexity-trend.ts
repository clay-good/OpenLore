/**
 * Complexity trend for hotspots (change: add-complexity-trend-signal).
 *
 * Current complexity is a snapshot: a function at 20 for two years and one that climbed 8 → 20 last
 * month look the same. For a bounded set of hotspots — functions at or above
 * {@link HIGH_COMPLEXITY_THRESHOLD} in files with recorded churn — this re-parses the file at the
 * last few non-merge, non-bulk commits that touched it (`git show <sha>:<path>`, the same
 * extractor and complexity estimator analyze uses) and labels the sequence:
 *
 *   rising  — never decreases and ends higher than it started
 *   falling — never increases and ends lower than it started
 *   flat    — every sample equal
 *   mixed   — went both ways
 *
 * No score, no threshold on the size of a change. The label is withheld when fewer than
 * {@link MIN_TREND_POINTS} samples exist (shallow history, or a function newer than the window).
 * A function that is rising and at or above the threshold in its latest sample is a
 * `declining-health` finding (advisory). Paths are matched exactly: git does not follow renames.
 */

import { CallGraphBuilder, serializeCallGraph, type FunctionNode } from '../../analyzer/call-graph.js';
import { detectLanguage } from '../../analyzer/language-detection.js';
import { COUPLING_BULK_THRESHOLD } from '../../provenance/change-coupling.js';
import { HIGH_COMPLEXITY_THRESHOLD } from '../../../constants.js';
import { gitPathArgs } from '../../../utils/git-args.js';
import { execFileGit } from '../../../utils/git-exec.js';
import type { GovernanceFinding } from './enforcement-policy.js';

/** Commits sampled per hotspot file, newest first. */
export const TREND_SAMPLES = 4;
/** Fewest samples a label is drawn from: two points are a difference, not a trend. */
export const MIN_TREND_POINTS = 3;
/** Most hotspot files sampled per call: each costs one `git log` and up to {@link TREND_SAMPLES} re-parses. */
export const MAX_TREND_FILES = 10;
/** Commits scanned per file to find {@link TREND_SAMPLES} that are not bulk commits. */
const LOG_SCAN = 40;

export type ComplexityTrend = 'rising' | 'falling' | 'flat' | 'mixed';

export interface FunctionComplexityTrend {
  name: string;
  file: string;
  /** Oldest first; `commit` is the short SHA. */
  samples: Array<{ commit: string; complexity: number }>;
  trend?: ComplexityTrend;
  /** Why no trend is given. */
  withheld?: 'shallow-history' | 'history-unavailable';
}

export interface ComplexityTrendReport {
  hotspots: FunctionComplexityTrend[];
  /** Hotspot functions not sampled because of the file cap. */
  notSampled: number;
  caveats: string[];
}

export const COMPLEXITY_TREND_CAVEATS = [
  `Sampled at up to ${TREND_SAMPLES} recent non-merge commits per file, skipping commits that touched more than ${COUPLING_BULK_THRESHOLD} files; at most ${MAX_TREND_FILES} files per call.`,
  'Samples are committed history only: uncommitted edits are not in the trend.',
  'Paths are matched exactly; git does not follow renames, so a renamed file\'s history before the rename is not sampled.',
];

/** The label for a sequence, oldest first; undefined below {@link MIN_TREND_POINTS}. */
export function trendOf(values: readonly number[]): ComplexityTrend | undefined {
  if (values.length < MIN_TREND_POINTS) return undefined;
  let up = false;
  let down = false;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) up = true;
    else if (values[i] < values[i - 1]) down = true;
  }
  return up && down ? 'mixed' : up ? 'rising' : down ? 'falling' : 'flat';
}

/** Non-bulk commits that touched `file`, newest first, at most {@link TREND_SAMPLES}. */
async function sampleCommits(root: string, file: string): Promise<string[]> {
  const { stdout } = await execFileGit('git', gitPathArgs(
    'log', '--no-merges', '--full-diff', '--name-only', '--format=%x01%H', '-n', String(LOG_SCAN), '--', file,
  ), { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const out: string[] = [];
  for (const record of stdout.split('\x01').slice(1)) {
    const [sha, ...files] = record.split('\n').map(l => l.trim()).filter(Boolean);
    if (!/^[0-9a-f]{40,64}$/.test(sha ?? '') || files.length > COUPLING_BULK_THRESHOLD) continue;
    out.push(sha);
    if (out.length === TREND_SAMPLES) break;
  }
  return out;
}

/** Complexity by node id for `file` as it was at `sha`; empty when the file is absent there. */
async function complexityAt(root: string, sha: string, file: string): Promise<Map<string, number>> {
  let content: string;
  try {
    ({ stdout: content } = await execFileGit('git', ['show', `${sha}:${file}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
  } catch {
    return new Map();
  }
  const graph = serializeCallGraph(await new CallGraphBuilder().build([{ path: file, content, language: detectLanguage(file) }]));
  const out = new Map<string, number>();
  for (const n of graph.nodes) if (!n.isExternal && n.cyclomaticComplexity !== undefined) out.set(n.id, n.cyclomaticComplexity);
  return out;
}

/**
 * Trends for the hotspots among `nodes`: complexity at or above the threshold, in a file in
 * `churnedFiles`, highest complexity first, at most `limit` functions from {@link MAX_TREND_FILES} files.
 */
export async function computeComplexityTrends(
  root: string,
  nodes: readonly FunctionNode[],
  churnedFiles: ReadonlySet<string>,
  limit: number,
): Promise<ComplexityTrendReport> {
  const candidates = nodes
    .filter(n => !n.isExternal && !n.isTest && churnedFiles.has(n.filePath)
      && (n.cyclomaticComplexity ?? 0) >= HIGH_COMPLEXITY_THRESHOLD)
    .sort((a, b) => (b.cyclomaticComplexity ?? 0) - (a.cyclomaticComplexity ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const files: string[] = [];
  const picked: FunctionNode[] = [];
  for (const n of candidates) {
    if (picked.length === limit) break;
    if (!files.includes(n.filePath)) {
      if (files.length === MAX_TREND_FILES) continue;
      files.push(n.filePath);
    }
    picked.push(n);
  }

  const byFile = new Map<string, Array<{ commit: string; complexity: Map<string, number> }> | null>();
  for (const file of files) {
    try {
      const commits = await sampleCommits(root, file);
      const points: Array<{ commit: string; complexity: Map<string, number> }> = [];
      for (const sha of commits.reverse()) points.push({ commit: sha.slice(0, 8), complexity: await complexityAt(root, sha, file) });
      byFile.set(file, points);
    } catch {
      byFile.set(file, null);
    }
  }

  const hotspots = picked.map((n): FunctionComplexityTrend => {
    const points = byFile.get(n.filePath);
    if (!points) return { name: n.name, file: n.filePath, samples: [], withheld: 'history-unavailable' };
    const samples = points.flatMap(p => {
      const c = p.complexity.get(n.id);
      return c === undefined ? [] : [{ commit: p.commit, complexity: c }];
    });
    const trend = trendOf(samples.map(s => s.complexity));
    return { name: n.name, file: n.filePath, samples, ...(trend ? { trend } : { withheld: 'shallow-history' as const }) };
  });
  return { hotspots, notSampled: candidates.length - picked.length, caveats: COMPLEXITY_TREND_CAVEATS };
}

/** One advisory `declining-health` finding per hotspot that is rising and high in its latest sample. */
export function decliningHealthFindings(report: ComplexityTrendReport): GovernanceFinding[] {
  return report.hotspots.flatMap(h => {
    const latest = h.samples[h.samples.length - 1];
    if (h.trend !== 'rising' || !latest || latest.complexity < HIGH_COMPLEXITY_THRESHOLD) return [];
    return [{
      code: 'declining-health',
      severity: 'warning' as const,
      source: 'health-map',
      subject: `${h.file}::${h.name}`,
      location: { path: h.file },
      message: `"${h.name}" complexity rose from ${h.samples[0].complexity} to ${latest.complexity} over its last ${h.samples.length} sampled commits.`,
    }];
  });
}
