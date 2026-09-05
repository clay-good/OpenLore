/**
 * Change-Coupling & Volatility Analysis (spec-22) — mined from local git history.
 *
 * Two facts the call graph structurally cannot see:
 *
 *   1. Change coupling — "these files almost always change together." The
 *      *invisible* coupling with no import/call edge: the config and the parser
 *      that move in lockstep, the handler and its migration. An agent editing one
 *      is warned about the sibling it would otherwise miss.
 *   2. Volatility / churn — "this file changed 23 times." A caution flag: high-churn
 *      code is where edits are riskiest.
 *
 * Prior art is logical/change coupling (CodeScene), whose own framing is decisive:
 * change coupling "isn't possible to calculate from code alone — it is mined from
 * git." Local, deterministic, no network (builds on Spec 18's git ingestion).
 *
 * Honest limits: co-change is CORRELATION, not causation; it is statistical and
 * needs sufficient history; bulk commits (formatting sweeps, mass renames, vendored
 * drops) manufacture false coupling. So: support/confidence thresholds, a documented
 * bulk-commit size filter, and presentation as a SIGNAL, never a rule.
 */

import { isGitRepository, getRepoPrefix, reframeRepoPath, validateGitRef } from '../drift/git-diff.js';
import { gitPathArgs } from '../../utils/git-args.js';
import { execFileGit as execFileAsync } from '../../utils/git-exec.js';


// Documented bounds & thresholds.
export const COUPLING_MAX_COMMITS = 1000;     // history window scanned
export const COUPLING_BULK_THRESHOLD = 25;    // commits touching > this many files are filtered (manufacture coupling)
export const COUPLING_MIN_SUPPORT = 3;        // min co-changes for a pair to count
export const COUPLING_MIN_CONFIDENCE = 0.3;   // min co-changes / churn(A)
export const COUPLING_TOP_PAIRS = 5;          // coupled files kept per file
// Absolute churn thresholds over the scanned window → volatility level.
export const VOLATILITY_HIGH = 12;
export const VOLATILITY_MEDIUM = 5;

const RS = '\x1e';

export interface CoupledFile {
  file: string;
  /** Number of commits that changed both files. */
  support: number;
  /** support / churn(thisFile) — P(B changes | A changes), 0..1. */
  confidence: number;
}

export interface ChangeCouplingResult {
  /** file → number of (non-bulk) commits that touched it. */
  churn: Map<string, number>;
  /** file → its most-coupled files (above thresholds, capped, sorted). */
  coupling: Map<string, CoupledFile[]>;
  stats: { commitsScanned: number; bulkCommitsFiltered: number; filesTracked: number };
}

/** Per-file change-coupling record as persisted/queried (spec-22). */
export interface FileChangeCoupling {
  filePath: string;
  churn: number;
  coupledWith: CoupledFile[];
}

export interface ChangeCouplingOptions {
  maxCommits?: number;
  bulkThreshold?: number;
  minSupport?: number;
  minConfidence?: number;
  topPairs?: number;
  /**
   * Mine history at or before this ref instead of from HEAD. A consumer that wants
   * churn strictly BEFORE a range (e.g. `briefing_since`'s prior-churn tier) passes
   * its resolved base ref so the briefed commits themselves are excluded. Omitted →
   * from HEAD, byte-identical to the pre-change behavior.
   */
  startRef?: string;
}

/** Map a churn count to a volatility level (absolute thresholds over the window). */
export function volatilityLevel(churn: number): 'high' | 'medium' | 'low' {
  if (churn >= VOLATILITY_HIGH) return 'high';
  if (churn >= VOLATILITY_MEDIUM) return 'medium';
  return 'low';
}

/** Round a confidence to 2 decimals deterministically. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute co-change coupling + churn from the local git log. Returns empty maps
 * for a non-git / empty repo — never throws, never blocks analyze. Deterministic
 * for a fixed git state.
 */
export async function analyzeChangeCoupling(
  rootPath: string,
  opts: ChangeCouplingOptions = {},
): Promise<ChangeCouplingResult> {
  const empty: ChangeCouplingResult = {
    churn: new Map(), coupling: new Map(),
    stats: { commitsScanned: 0, bulkCommitsFiltered: 0, filesTracked: 0 },
  };
  if (!(await isGitRepository(rootPath))) return empty;

  const maxCommits = opts.maxCommits ?? COUPLING_MAX_COMMITS;
  const bulkThreshold = opts.bulkThreshold ?? COUPLING_BULK_THRESHOLD;
  const minSupport = opts.minSupport ?? COUPLING_MIN_SUPPORT;
  const minConfidence = opts.minConfidence ?? COUPLING_MIN_CONFIDENCE;
  const topPairs = opts.topPairs ?? COUPLING_TOP_PAIRS;

  // Optional start ref: log from `<startRef>` (that commit and its ancestors) instead
  // of HEAD, so a caller can measure churn strictly BEFORE a range. Validated as an
  // argument-injection guard before it reaches git's argv.
  let startRefArgs: string[] = [];
  if (opts.startRef) {
    try {
      validateGitRef(opts.startRef);
    } catch {
      return empty;
    }
    startRefArgs = [opts.startRef];
  }

  // Below the repository root, git emits repo-root-relative paths while the analyzer's
  // node paths are analyzed-root-relative; re-frame so churn/coupling keys join. Empty
  // prefix (the root) makes re-framing a no-op → output byte-identical to before.
  const prefix = (await getRepoPrefix(rootPath)) ?? '';

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      gitPathArgs('log', ...startRefArgs, `--max-count=${maxCommits}`, '--no-merges', `--format=${RS}%h`, '--name-only'),
      { cwd: rootPath, maxBuffer: 128 * 1024 * 1024 },
    ));
  } catch {
    return empty;
  }

  // Parse into per-commit file sets (raw, repo-root-relative paths).
  const commitFileSets: string[][] = [];
  for (const seg of stdout.split(RS)) {
    if (!seg.trim()) continue;
    const lines = seg.split('\n').map(s => s.trim()).filter(Boolean);
    // First line is the short SHA (from the format); the rest are file paths.
    const files = lines.slice(1);
    if (files.length > 0) commitFileSets.push(files);
  }

  const churn = new Map<string, number>();
  // coOccur: "A\x00B" (A < B sorted) → count.
  const coOccur = new Map<string, number>();
  let bulkFiltered = 0;
  let scanned = 0;

  for (const rawFiles of commitFileSets) {
    // Bulk filter uses the RAW repo-wide commit size: a mass sweep manufactures false
    // coupling for its files whether or not they lie in the analyzed subtree.
    if (rawFiles.length > bulkThreshold) { bulkFiltered++; continue; }
    // Re-frame to analyzed-root paths and drop files outside the subtree (no-op at root).
    const files = rawFiles
      .map(f => reframeRepoPath(f, prefix))
      .filter((f): f is string => f !== null);
    if (files.length === 0) continue; // commit touched nothing in the analyzed subtree
    scanned++;
    const uniq = [...new Set(files)].sort();
    for (const f of uniq) churn.set(f, (churn.get(f) ?? 0) + 1);
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const key = `${uniq[i]}\x00${uniq[j]}`;
        coOccur.set(key, (coOccur.get(key) ?? 0) + 1);
      }
    }
  }

  // Build directed coupling per file from the symmetric co-occurrence counts.
  const couplingTmp = new Map<string, CoupledFile[]>();
  const addPair = (a: string, b: string, support: number) => {
    const churnA = churn.get(a) ?? 0;
    if (churnA === 0) return;
    const confidence = support / churnA;
    if (support < minSupport || confidence < minConfidence) return;
    const arr = couplingTmp.get(a) ?? [];
    arr.push({ file: b, support, confidence: round2(confidence) });
    couplingTmp.set(a, arr);
  };
  for (const [key, support] of coOccur) {
    const [a, b] = key.split('\x00');
    addPair(a, b, support);
    addPair(b, a, support);
  }

  // Sort + cap each file's coupled list deterministically.
  const coupling = new Map<string, CoupledFile[]>();
  for (const [file, arr] of couplingTmp) {
    arr.sort((x, y) => y.confidence - x.confidence || y.support - x.support || x.file.localeCompare(y.file));
    coupling.set(file, arr.slice(0, topPairs));
  }

  return {
    churn,
    coupling,
    stats: { commitsScanned: scanned, bulkCommitsFiltered: bulkFiltered, filesTracked: churn.size },
  };
}
