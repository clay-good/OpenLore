/**
 * Scoring for `npm run bench:select-tests`: did `select_tests` name the tests a real change had to
 * touch? Pure and deterministic; the runner (scripts/bench-select-tests.ts) does the git and index
 * work.
 *
 * Ground truth for one commit: the test files it MODIFIED (not added). A change that edits an
 * existing test usually had to, because the change broke or changed what that test checks. It is a
 * proxy: a commit can also edit a test it did not need to, so a miss is a lead to read, not a proven
 * bug.
 */

export interface ChangedFile { status: string; path: string }

export interface ReplayCase {
  commit: string;
  subject: string;
  /** Production files the replay applies. */
  applied: string[];
  /** Test files the commit modified: what select_tests should name. */
  truth: string[];
}

export interface ReplayScore {
  commit: string;
  subject: string;
  truth: number;
  hits: number;
  misses: string[];
  selectedFiles: number;
  /**
   * Per confidence tier, cumulative (`medium` includes `high`): how many files an agent runs if it
   * stops at that tier, and how many truth files those include. A file counts at its best tier.
   */
  tiers?: Record<Tier, { files: number; hits: number }>;
}

export type Tier = 'high' | 'medium' | 'low';
const TIERS: Tier[] = ['high', 'medium', 'low'];
const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

const isTest = (path: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);

/**
 * The replay case for one commit's `git diff --name-status` lines, or null when it has nothing to
 * score: no production change under `src/`, or no existing test file modified.
 */
export function replayCase(commit: string, subject: string, nameStatus: string): ReplayCase | null {
  const files: ChangedFile[] = nameStatus.split('\n').filter(Boolean).map(line => {
    const [status, ...rest] = line.split('\t');
    return { status: status[0], path: rest.at(-1)! };
  });
  const applied = files.filter(f => f.path.startsWith('src/') && !isTest(f.path) && f.status !== 'D').map(f => f.path);
  const truth = files.filter(f => f.status === 'M' && f.path.startsWith('src/') && isTest(f.path)).map(f => f.path);
  if (applied.length === 0 || truth.length === 0) return null;
  return { commit, subject, applied, truth };
}

export function scoreReplay(c: ReplayCase, selected: ReadonlyArray<string | { file: string; confidence: string }>): ReplayScore {
  // Each file at its best (most confident) tier.
  const best = new Map<string, number>();
  for (const s of selected) {
    const [file, rank] = typeof s === 'string' ? [s, RANK.low] : [s.file, RANK[s.confidence] ?? RANK.low];
    best.set(file, Math.min(best.get(file) ?? Infinity, rank));
  }
  const misses = c.truth.filter(f => !best.has(f));
  const tiers = Object.fromEntries(TIERS.map((tier, i) => {
    const files = [...best].filter(([, rank]) => rank <= i).map(([f]) => f);
    return [tier, { files: files.length, hits: c.truth.filter(f => files.includes(f)).length }];
  })) as Record<Tier, { files: number; hits: number }>;
  return { commit: c.commit, subject: c.subject, truth: c.truth.length, hits: c.truth.length - misses.length, misses, selectedFiles: best.size, tiers };
}

export interface ReplaySummary {
  cases: number; truth: number; hits: number; recall: number; meanSelectedFiles: number;
  /** Per tier, cumulative: recall and mean files when an agent runs only that tier and above. */
  tiers?: Record<Tier, { recall: number; meanFiles: number }>;
}

export function summarize(scores: readonly ReplayScore[]): ReplaySummary {
  const truth = scores.reduce((n, s) => n + s.truth, 0);
  const hits = scores.reduce((n, s) => n + s.hits, 0);
  return {
    cases: scores.length,
    truth,
    hits,
    recall: truth ? hits / truth : 1,
    meanSelectedFiles: scores.length ? Math.round(scores.reduce((n, s) => n + s.selectedFiles, 0) / scores.length) : 0,
    ...(scores.length && scores.every(s => s.tiers) ? {
      tiers: Object.fromEntries(TIERS.map(tier => [tier, {
        recall: truth ? scores.reduce((n, s) => n + s.tiers![tier].hits, 0) / truth : 1,
        meanFiles: Math.round(scores.reduce((n, s) => n + s.tiers![tier].files, 0) / scores.length),
      }])) as Record<Tier, { recall: number; meanFiles: number }>,
    } : {}),
  };
}
