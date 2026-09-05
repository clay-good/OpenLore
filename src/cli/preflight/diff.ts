/**
 * Compute the set of source files that have changed since the graph was built.
 *
 * Two paths:
 *
 *  1. `--since <git-ref>` (CI-friendly) — `git diff --name-only <ref>...HEAD`
 *     plus uncommitted modifications. The merge-base form is intentional:
 *     it captures every file the PR touched, not just the latest commit.
 *
 *  2. No `--since` flag — fall back to comparing file mtimes against
 *     `fingerprint.json.computedAt`. Slower but works without git history.
 *
 * Either path returns paths relative to the repo root. Non-source files
 * (anything not tracked by the analyzer's language config) are filtered out
 * by the caller via the node table.
 */

import { stat, readdir, readFile, access } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { gitPathArgs } from '../../utils/git-args.js';
import { execFileGit as execFileAsync } from '../../utils/git-exec.js';


export interface DiffResult {
  /** Repo-relative paths of files that may have changed since graph build. */
  changed: string[];
  /** Which mechanism produced the list. */
  mechanism: 'git' | 'mtime';
  /** Any non-fatal warnings (e.g. "no .git found, used mtime"). */
  warnings: string[];
  /** The short commit hash of HEAD at the moment of the check, if available. */
  workingCommit: string | null;
}

export interface DiffOptions {
  repoRoot: string;
  /** Iso8601 timestamp the graph was built — used by mtime fallback. */
  graphBuiltAt: string | null;
  /** Optional git ref to diff against (e.g. "origin/main"). */
  since?: string;
}

export async function hasGitDirectory(repoRoot: string): Promise<boolean> {
  try {
    await access(join(repoRoot, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function runGit(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot });
  return stdout;
}

export async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

async function shortHead(repoRoot: string): Promise<string | null> {
  try {
    return (await runGit(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

/** Changed files via git diff against `since`, plus uncommitted modifications. */
async function diffViaGit(repoRoot: string, since: string): Promise<string[]> {
  // Use ...HEAD (merge-base) so we capture every file the PR touched relative
  // to the branch point, not just the latest commit's diff.
  const tracked = (await runGit(repoRoot, gitPathArgs('diff', '--name-only', `${since}...HEAD`)))
    .split('\n')
    .filter(Boolean);
  // Include uncommitted modifications so a developer running locally before
  // committing also gets honest feedback.
  const uncommitted = (await runGit(repoRoot, gitPathArgs('diff', '--name-only', 'HEAD')))
    .split('\n')
    .filter(Boolean);
  const set = new Set([...tracked, ...uncommitted]);
  return Array.from(set).sort();
}

/** Changed files via mtime comparison against graphBuiltAtMs. */
async function diffViaMtime(repoRoot: string, graphBuiltAtMs: number): Promise<string[]> {
  const out: string[] = [];
  await walk(repoRoot, repoRoot, graphBuiltAtMs, out);
  return out.sort();
}

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  OPENLORE_DIR,
  '.git',
]);

async function walk(repoRoot: string, dir: string, cutoffMs: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.gitignore') continue;
    if (SKIP_DIRECTORIES.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(repoRoot, full, cutoffMs, out);
      continue;
    }
    if (!ent.isFile()) continue;
    try {
      const s = await stat(full);
      if (s.mtimeMs > cutoffMs) {
        out.push(relative(repoRoot, full).split(sep).join('/'));
      }
    } catch {
      /* unreadable file — skip */
    }
  }
}

export async function computeDiff(opts: DiffOptions): Promise<DiffResult> {
  const root = resolve(opts.repoRoot);
  const warnings: string[] = [];
  const workingCommit = await shortHead(root);
  const gitAvailable = await hasGitDirectory(root);

  if (opts.since) {
    if (!gitAvailable) {
      throw Object.assign(new Error(`--since requires a git repository`), { exitCode: 2 });
    }
    if (!(await refExists(root, opts.since))) {
      throw Object.assign(
        new Error(`git ref not found: ${opts.since}`),
        { exitCode: 2 }
      );
    }
    const changed = await diffViaGit(root, opts.since);
    return { changed, mechanism: 'git', warnings, workingCommit };
  }

  if (!gitAvailable) {
    warnings.push('no .git found — falling back to mtime comparison');
  }

  if (!opts.graphBuiltAt) {
    warnings.push('graph has no build timestamp — everything will look stale');
    // Treat as "everything changed since epoch" — caller can decide.
    const changed = await diffViaMtime(root, 0);
    return { changed, mechanism: 'mtime', warnings, workingCommit };
  }

  const cutoff = Date.parse(opts.graphBuiltAt);
  if (Number.isNaN(cutoff)) {
    warnings.push(`graph build timestamp unparseable: ${opts.graphBuiltAt}`);
    const changed = await diffViaMtime(root, 0);
    return { changed, mechanism: 'mtime', warnings, workingCommit };
  }

  const changed = await diffViaMtime(root, cutoff);
  return { changed, mechanism: 'mtime', warnings, workingCommit };
}

/** Read `fingerprint.json` if present. */
export async function readGraphFingerprint(repoRoot: string): Promise<{
  computedAt: string | null;
  fileCount: number | null;
} | null> {
  const path = join(repoRoot, OPENLORE_DIR, 'analysis', 'fingerprint.json');
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { computedAt?: string; fileCount?: number };
    return {
      computedAt: parsed.computedAt ?? null,
      fileCount: typeof parsed.fileCount === 'number' ? parsed.fileCount : null,
    };
  } catch {
    return null;
  }
}
