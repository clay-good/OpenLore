/**
 * Local provenance extractor (spec-18) — "who last changed this, in which PR".
 *
 * Reads the local `.git` history (and, only if present and authenticated, the
 * local `gh` CLI) to produce per-file provenance. The deliberate constraint:
 * **everything is local, nothing is uploaded.** This is the no-OAuth alternative
 * to cloud connectors — the git-only path needs no network at all; `gh` is an
 * optional enrichment that degrades gracefully when absent.
 *
 * Mirrors the parser→projector split used by IaC and decisions: this module is
 * the parser (raw git → normalized records); project.ts maps records to typed
 * `authored_by` / `changed_in_pr` graph edges.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger.js';
import { isGitRepository } from '../drift/git-diff.js';

const execFileAsync = promisify(execFile);

// Bounds (documented caps — never import unbounded history; never bloat the graph).
export const PROVENANCE_MAX_COMMITS = 1000; // history depth scanned per pass
export const PROVENANCE_TOP_AUTHORS = 5;    // recent distinct authors kept per file
export const PROVENANCE_MAX_PRS = 5;        // distinct PRs kept per file
const GH_PR_LIMIT = 200;                    // single bounded `gh pr list` enrichment
const GH_TIMEOUT_MS = 10_000;               // hard cap so a stalled `gh` can never block analyze

const RS = '\x1e'; // record separator between commits
const FS = '\x1f'; // field separator within a commit header

export interface Author {
  name: string;
  email: string;
}

export interface PullRequest {
  number: number;
  /** Title — only populated when `gh` enrichment succeeds. */
  title?: string;
  /** open | closed | merged — only populated when `gh` enrichment succeeds. */
  state?: string;
}

/** Per-file provenance — derived, regenerable, repo-relative POSIX path. */
export interface FileProvenance {
  filePath: string;
  lastAuthor: Author;
  lastDate: string;    // ISO 8601, author date of the last-touch commit
  lastCommit: string;  // short SHA
  lastSubject: string;
  /** Distinct authors, most-recent-first, capped — includes lastAuthor. */
  recentAuthors: Author[];
  /** Distinct PRs that touched the file, most-recent-first, capped. */
  prs: PullRequest[];
}

export interface ProvenanceOptions {
  maxCommits?: number;
  topAuthors?: number;
  maxPrs?: number;
  /** Attempt `gh` enrichment for PR titles/state. Auto-skips if gh is absent. */
  useGh?: boolean;
}

/** Extract the PR number a commit subject references (squash "(#123)" or merge). */
export function parsePrNumber(subject: string): number | undefined {
  const merge = subject.match(/Merge pull request #(\d+)/);
  if (merge) return parseInt(merge[1], 10);
  const squash = subject.match(/\(#(\d+)\)\s*$/) ?? subject.match(/\(#(\d+)\)/);
  if (squash) return parseInt(squash[1], 10);
  return undefined;
}

interface Commit {
  sha: string;
  author: Author;
  date: string;
  subject: string;
  files: string[];
}

/** Run one `git log` pass and parse commits + their changed files. */
async function gitLog(rootPath: string, extraArgs: string[], maxCommits: number): Promise<Commit[]> {
  const format = `${RS}%h${FS}%an${FS}%ae${FS}%aI${FS}%s`;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['log', `--max-count=${maxCommits}`, `--format=${format}`, '--name-only', ...extraArgs],
      { cwd: rootPath, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    return []; // shallow/empty history, bad ref, etc. — never throw
  }

  const commits: Commit[] = [];
  for (const seg of stdout.split(RS)) {
    if (!seg.trim()) continue;
    const nl = seg.indexOf('\n');
    const header = nl === -1 ? seg : seg.slice(0, nl);
    const [sha, name, email, date, subject] = header.split(FS);
    if (!sha) continue;
    const files = nl === -1 ? [] : seg.slice(nl + 1).split('\n').map(s => s.trim()).filter(Boolean);
    commits.push({ sha, author: { name: name ?? '', email: email ?? '' }, date: date ?? '', subject: subject ?? '', files });
  }
  return commits;
}

/**
 * Extract per-file provenance for `files` (repo-relative POSIX paths).
 *
 * - Authors come from non-merge commits (real contributors, not the merger).
 * - PR numbers come from squash subjects `(#N)` and merge commits
 *   (`--first-parent`, which attributes a PR's full diff to its files).
 * - Returns `[]` for a non-git or empty repo — never throws, never blocks analyze.
 */
export async function extractProvenance(
  rootPath: string,
  files: string[],
  opts: ProvenanceOptions = {},
): Promise<FileProvenance[]> {
  if (files.length === 0) return [];
  if (!(await isGitRepository(rootPath))) return [];

  const maxCommits = opts.maxCommits ?? PROVENANCE_MAX_COMMITS;
  const topAuthors = opts.topAuthors ?? PROVENANCE_TOP_AUTHORS;
  const maxPrs = opts.maxPrs ?? PROVENANCE_MAX_PRS;
  const wanted = new Set(files);

  // Pass A — authorship + squash PRs (real authors, no merge commits).
  const authorCommits = await gitLog(rootPath, ['--no-merges'], maxCommits);
  // Pass B — merge-workflow PRs (merge commits with their full diff).
  const mergeCommits = await gitLog(rootPath, ['--merges', '--first-parent'], maxCommits);

  if (authorCommits.length === 0 && mergeCommits.length === 0) return [];

  interface Acc {
    lastAuthor?: Author; lastDate?: string; lastCommit?: string; lastSubject?: string;
    authors: Author[]; authorKeys: Set<string>;
    prNumbers: number[]; prSeen: Set<number>;
  }
  const byFile = new Map<string, Acc>();
  const acc = (f: string): Acc => {
    let a = byFile.get(f);
    if (!a) { a = { authors: [], authorKeys: new Set(), prNumbers: [], prSeen: new Set() }; byFile.set(f, a); }
    return a;
  };

  // git log is newest-first; the first commit touching a file is its last-touch.
  for (const c of authorCommits) {
    const pr = parsePrNumber(c.subject);
    for (const f of c.files) {
      if (!wanted.has(f)) continue;
      const a = acc(f);
      if (!a.lastAuthor) {
        a.lastAuthor = c.author; a.lastDate = c.date; a.lastCommit = c.sha; a.lastSubject = c.subject;
      }
      const key = c.author.email || c.author.name;
      if (key && !a.authorKeys.has(key) && a.authors.length < topAuthors) {
        a.authorKeys.add(key); a.authors.push(c.author);
      }
      if (pr !== undefined && !a.prSeen.has(pr) && a.prNumbers.length < maxPrs) {
        a.prSeen.add(pr); a.prNumbers.push(pr);
      }
    }
  }
  for (const c of mergeCommits) {
    const pr = parsePrNumber(c.subject);
    if (pr === undefined) continue;
    for (const f of c.files) {
      if (!wanted.has(f)) continue;
      const a = acc(f);
      if (!a.prSeen.has(pr) && a.prNumbers.length < maxPrs) { a.prSeen.add(pr); a.prNumbers.push(pr); }
    }
  }

  // Optional gh enrichment — one bounded call, best-effort, never required.
  const allPrs = new Set<number>();
  for (const a of byFile.values()) for (const n of a.prNumbers) allPrs.add(n);
  const prMeta = (opts.useGh ?? true) && allPrs.size > 0
    ? await enrichWithGh(rootPath)
    : new Map<number, { title: string; state: string }>();

  const result: FileProvenance[] = [];
  for (const [filePath, a] of byFile) {
    if (!a.lastAuthor) continue; // only PRs from merge pass, no authorship → skip (no last-touch)
    result.push({
      filePath,
      lastAuthor: a.lastAuthor,
      lastDate: a.lastDate!,
      lastCommit: a.lastCommit!,
      lastSubject: a.lastSubject!,
      recentAuthors: a.authors,
      prs: a.prNumbers.map(number => {
        const meta = prMeta.get(number);
        return meta ? { number, title: meta.title, state: meta.state } : { number };
      }),
    });
  }
  // Deterministic order.
  result.sort((x, y) => x.filePath.localeCompare(y.filePath));
  return result;
}

/**
 * Enrich PR numbers with title/state via the local `gh` CLI — one bounded call.
 * Returns an empty map when `gh` is absent, unauthenticated, or the repo has no
 * GitHub remote. Never throws; the git-only path is unaffected.
 */
export async function enrichWithGh(
  rootPath: string,
): Promise<Map<number, { title: string; state: string }>> {
  const out = new Map<number, { title: string; state: string }>();
  // A non-git directory can have no GitHub remote — short-circuit before spawning
  // `gh` at all. This keeps the graceful-degradation path instant and deterministic
  // (a stray `gh` subprocess in a remote-less dir can otherwise stall on the network).
  if (!(await isGitRepository(rootPath))) return out;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', String(GH_PR_LIMIT), '--json', 'number,title,state'],
      { cwd: rootPath, maxBuffer: 16 * 1024 * 1024, timeout: GH_TIMEOUT_MS },
    );
    const prs = JSON.parse(stdout) as Array<{ number: number; title: string; state: string }>;
    for (const p of prs) out.set(p.number, { title: p.title, state: (p.state ?? '').toLowerCase() });
  } catch {
    logger.debug?.('provenance: gh enrichment unavailable — using git-only provenance');
  }
  return out;
}
