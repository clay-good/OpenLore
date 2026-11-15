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
}

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

export function scoreReplay(c: ReplayCase, selectedFiles: readonly string[]): ReplayScore {
  const selected = new Set(selectedFiles);
  const misses = c.truth.filter(f => !selected.has(f));
  return { commit: c.commit, subject: c.subject, truth: c.truth.length, hits: c.truth.length - misses.length, misses, selectedFiles: selected.size };
}

export interface ReplaySummary { cases: number; truth: number; hits: number; recall: number; meanSelectedFiles: number }

export function summarize(scores: readonly ReplayScore[]): ReplaySummary {
  const truth = scores.reduce((n, s) => n + s.truth, 0);
  const hits = scores.reduce((n, s) => n + s.hits, 0);
  return {
    cases: scores.length,
    truth,
    hits,
    recall: truth ? hits / truth : 1,
    meanSelectedFiles: scores.length ? Math.round(scores.reduce((n, s) => n + s.selectedFiles, 0) / scores.length) : 0,
  };
}
