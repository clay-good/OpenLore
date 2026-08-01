/**
 * Git diff integration for drift detection
 *
 * Shells out to git to determine what files changed between the current
 * working tree and a base ref (typically main/master).
 */

import { execFile } from 'node:child_process';
import { extname, basename } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { DIFF_MAX_CHARS } from '../../constants.js';
import { gitPathArgs } from '../../utils/git-args.js';

const execFileAsync = promisify(execFile);

/** Git's well-known empty tree SHA — used as base ref for single-commit repos */
const GIT_EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf899d15f71049056';

// ============================================================================
// TYPES
// ============================================================================

export interface GitDiffOptions {
  rootPath: string;
  baseRef: string;
  pathFilter?: string[];
  includeUnstaged: boolean;
}

export interface GitDiffResult {
  resolvedBase: string;
  files: ChangedFile[];
  hasUnstagedChanges: boolean;
  currentBranch: string;
}

// ============================================================================
// FILE CLASSIFICATION (mirrors FileWalker heuristics)
// ============================================================================

const TEST_DIR_PATTERNS = [
  /\/test\//,
  /\/tests\//,
  /\/__tests__\//,
  /\/spec\//,
  /\/specs\//,
  /^test\//,
  /^tests\//,
  /^__tests__\//,
];

const TEST_FILE_PATTERNS = [
  /\.test\.[^.]+$/,
  /\.spec\.[^.]+$/,
  /_test\.[^.]+$/,
  /_spec\.[^.]+$/,
  /^test_.*\.[^.]+$/,
];

const CONFIG_PATTERNS = [
  /^\..*rc$/,
  /^\..*rc\.(js|json|yaml|yml)$/,
  /config\./,
  /\.config\./,
  /settings\./,
  /^tsconfig.*\.json$/,
  /^package\.json$/,
  /^pyproject\.toml$/,
  /^Cargo\.toml$/,
  /^go\.mod$/,
  /^Gemfile$/,
  /^composer\.json$/,
];

const SKIP_EXTENSIONS = new Set([
  '.lock', '.lockb', '.map',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pyc', '.pyo', '.class', '.o', '.so', '.dll', '.exe',
]);

const SKIP_FILENAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  '.DS_Store', 'Thumbs.db',
]);

/**
 * Classify a file path as test/config/generated
 */
export function classifyFile(filePath: string): Pick<ChangedFile, 'isTest' | 'isConfig' | 'isGenerated' | 'extension'> {
  const fileName = basename(filePath);
  const ext = extname(filePath);

  const isTest =
    TEST_DIR_PATTERNS.some(p => p.test(filePath)) ||
    TEST_FILE_PATTERNS.some(p => p.test(fileName));

  const isConfig = CONFIG_PATTERNS.some(p => p.test(fileName));

  const isGenerated =
    fileName.endsWith('.d.ts') ||
    fileName.endsWith('.generated.ts') ||
    fileName.endsWith('.generated.js') ||
    filePath.includes('/generated/') ||
    filePath.includes('/__generated__/');

  return { isTest, isConfig, isGenerated, extension: ext };
}

/**
 * Check if a file is a skippable binary/lock file
 */
export function isSkippableFile(filePath: string): boolean {
  const fileName = basename(filePath);
  const ext = extname(filePath);
  return SKIP_EXTENSIONS.has(ext) || SKIP_FILENAMES.has(fileName);
}

// ============================================================================
// GIT OPERATIONS
// ============================================================================

/**
 * Check whether `rootPath` is inside a git work tree.
 *
 * Asks git (`rev-parse --is-inside-work-tree`) rather than testing for a `.git`
 * entry at `rootPath`. The old `access(rootPath/.git)` test recognized only the
 * repository ROOT: a monorepo package directory (`repo/packages/foo`) failed it and
 * every git-derived signal (churn, coupling, provenance, structural diff) silently
 * went empty there, even though every git shell-out with that cwd succeeds.
 * `--is-inside-work-tree` is true for the root, any subdirectory, a worktree, and a
 * submodule checkout alike; it is false inside the `.git` directory and outside any
 * repository. (Worktrees/submodules previously passed only incidentally because
 * their `.git` is a file.)
 */
export async function isGitRepository(rootPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootPath });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Check whether `rootPath` is the ROOT of a git work tree (not a subdirectory of one).
 *
 * True iff {@link getRepoPrefix} is the empty string — i.e. inside a work tree AND at
 * its top level. This is behaviorally identical to the pre-work-tree-aware
 * `access(rootPath/.git)` test across every case (normal root, worktree/submodule
 * root where `.git` is a file, subdirectory, `.git` dir, bare repo, non-repo), so it
 * is the drop-in for git-signal callers that JOIN git's repo-root-relative path output
 * against analyzed-root-relative data and are therefore only correct when the analyzed
 * root IS the repository root (drift, decisions, staleness, review). Below-root support
 * for those flows is out of scope for this change; pinning them here preserves their
 * exact prior "root-only" behavior instead of silently joining mismatched path frames.
 */
export async function isGitRepositoryRoot(rootPath: string): Promise<boolean> {
  return (await getRepoPrefix(rootPath)) === '';
}

/**
 * The repo-root → analyzed-root path prefix, for re-framing git's path-list output.
 *
 * Git emits `diff`/`log --name-only` paths relative to the REPOSITORY ROOT
 * regardless of cwd, while the analyzer's node paths are relative to the analyzed
 * root. At the repo root the two agree; below it they diverge, so every churn /
 * provenance / diff join must translate between them. Returns:
 *   - `''` when `rootPath` IS the repository root (re-framing is a no-op),
 *   - `'packages/foo/'` (trailing slash) when `rootPath` is a subdirectory,
 *   - `null` when `rootPath` is not inside a work tree.
 */
export async function getRepoPrefix(rootPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-prefix'], { cwd: rootPath });
    // --show-prefix ends with a newline (and '' at the root); strip line endings only.
    return stdout.replace(/\r?\n/g, '');
  } catch {
    return null;
  }
}

/**
 * Re-frame one repo-root-relative git path to be relative to the analyzed root,
 * given a {@link getRepoPrefix} value. Returns `null` for a path OUTSIDE the analyzed
 * subtree (the caller drops it) or for the analyzed directory itself. With an empty
 * prefix (the repo root) it is the identity — so callers that re-frame unconditionally
 * are byte-for-byte unchanged at the root.
 */
export function reframeRepoPath(repoRelPath: string, prefix: string): string | null {
  if (!prefix) return repoRelPath;
  if (!repoRelPath.startsWith(prefix)) return null;
  const reframed = repoRelPath.slice(prefix.length);
  return reframed.length > 0 ? reframed : null;
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(rootPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootPath });
    return stdout.trim();
  } catch (err) {
    logger.debug(`Could not get current branch: ${(err as Error).message}`);
    return 'unknown';
  }
}

/**
 * Validate a user-supplied git ref to prevent unexpected git argument injection.
 * Allows branch/tag names, SHA hashes, relative refs (HEAD~1, @{upstream}), and
 * the empty-tree SHA. Rejects refs containing shell metacharacters or null bytes.
 *
 * Argument-injection guard (mcp-security: Subprocess Argument Safety): a ref is
 * always passed to git as a single argv element, which prevents shell injection but
 * NOT flag interpretation — `--upload-pack=...` or `--output=x` would still be read
 * by git as an OPTION. Real refs/branches/SHAs never begin with `-`, so a
 * leading-dash ref is rejected outright; this is the validation half of the spec's
 * "`--` separator OR allowlist" requirement (ref operands are also placed after `--`
 * at the call sites where git supports it).
 */
export function validateGitRef(ref: string): void {
  if (ref === GIT_EMPTY_TREE_SHA || ref === 'auto') return;
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error('Invalid git ref: must be a non-empty string.');
  }
  if (ref.startsWith('-')) {
    throw new Error(`Invalid git ref: "${ref}". A ref must not begin with "-" (argument-injection guard).`);
  }
  // Allow: alphanumeric, -, _, ., /, ~, ^, @, {, }, :
  if (!/^[\w\-./~^@{}:]+$/.test(ref)) {
    throw new Error(`Invalid git ref: "${ref}". Refs must contain only alphanumeric characters and -_./ ~^@{}:`);
  }
}

/**
 * True iff `ref` resolves to a commit in the repo at `rootPath`. Unlike
 * `resolveBaseRef` (which silently falls back to main/master/HEAD~1), this answers
 * the plain question "does the caller's ref exist?" so a consumer can disclose a
 * fallback instead of briefing against a base the caller never asked for. Validates
 * the ref first (argument-injection guard); any failure → false, never throws.
 */
export async function refExists(rootPath: string, ref: string): Promise<boolean> {
  try {
    validateGitRef(ref);
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: rootPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a base ref, falling back through main → master → HEAD~1
 */
export async function resolveBaseRef(rootPath: string, preferredRef: string): Promise<string> {
  if (preferredRef && preferredRef !== 'auto') {
    validateGitRef(preferredRef);
    try {
      await execFileAsync('git', ['rev-parse', '--verify', preferredRef], { cwd: rootPath });
      return preferredRef;
    } catch (err) {
      logger.debug(`Preferred ref "${preferredRef}" not found: ${(err as Error).message}`);
    }
  }

  // Try common default branches
  for (const ref of ['main', 'master']) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', ref], { cwd: rootPath });
      return ref;
    } catch {
      continue;
    }
  }

  // Try HEAD~1 (previous commit)
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD~1'], { cwd: rootPath });
    return 'HEAD~1';
  } catch (err) {
    // Single-commit repo or detached HEAD with no parent — use the empty tree SHA
    // so git diff shows all files as "added"
    logger.debug(`HEAD~1 not available (single-commit repo?): ${(err as Error).message}`);
    return GIT_EMPTY_TREE_SHA;
  }
}

/**
 * The disclosed resolution of a `--base` ref. `requested` is what the caller asked
 * for (verbatim, or the command's default sentinel); `resolved` is the ref git will
 * actually diff against after {@link resolveBaseRef}'s main → master → HEAD~1 fallback.
 * `fellBack` is true exactly when the caller passed an EXPLICIT ref that git could not
 * resolve — so `resolved` is a base the caller did not ask for. A conclusion command
 * must never present a verdict over a fallback base without disclosing this.
 */
export interface BaseRefResolution {
  requested: string;
  resolved: string;
  fellBack: boolean;
}

/**
 * Resolve a base ref AND disclose whether the caller's requested ref actually
 * resolved — the single "resolve-or-disclose" point every `--base` command shares
 * (fix-cli-conclusion-honesty). Advisory commands surface `fellBack` as a caveat;
 * certification commands treat it as fatal unless the caller opts into fallback.
 *
 * The `auto`/empty sentinel (the briefing default that explicitly REQUESTS the
 * fallback chain) never counts as a fallback. For an explicit ref we confirm the
 * fallback with {@link refExists}, so a ref that resolves to a differently-spelled
 * commit (e.g. a short SHA, a tag) is correctly reported as resolved, not fallen-back.
 */
export async function resolveBaseRefDisclosed(
  rootPath: string,
  requestedRef: string,
): Promise<BaseRefResolution> {
  const resolved = await resolveBaseRef(rootPath, requestedRef);
  const isAuto = !requestedRef || requestedRef === 'auto';
  const fellBack =
    !isAuto && resolved !== requestedRef && !(await refExists(rootPath, requestedRef));
  return { requested: requestedRef, resolved, fellBack };
}

/**
 * Parse a git status character into a ChangedFile status
 */
function parseGitStatus(statusChar: string): ChangedFile['status'] {
  switch (statusChar) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'M': return 'modified';
    case 'R': return 'renamed';
    case 'C': return 'added'; // copied = effectively added
    default: return 'modified';
  }
}

/**
 * Parse git diff --name-status output into file entries
 */
function parseNameStatus(output: string): Array<{ path: string; status: ChangedFile['status']; oldPath?: string }> {
  const entries: Array<{ path: string; status: ChangedFile['status']; oldPath?: string }> = [];
  const lines = output.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const statusRaw = parts[0].charAt(0); // R100 → R
    const status = parseGitStatus(statusRaw);

    if (statusRaw === 'R' && parts.length >= 3) {
      entries.push({ path: parts[2], status: 'renamed', oldPath: parts[1] });
    } else {
      entries.push({ path: parts[1], status });
    }
  }

  return entries;
}

/**
 * Parse git diff --numstat output into addition/deletion counts.
 * Handles rename format: "10\t5\told/path => new/path" or "10\t5\t{dir => dir2}/file.ts"
 */
function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const lines = output.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    // Binary files show '-' for additions/deletions
    const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
    const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
    let filePath = parts.slice(2).join('\t'); // Rejoin in case path contained tabs

    // Handle rename formats:
    //   "old/path => new/path"  →  extract "new/path"
    //   "{old => new}/file.ts"  →  expand to "new/file.ts"
    if (filePath.includes(' => ')) {
      const braceMatch = filePath.match(/^(.*?)\{[^}]* => ([^}]*)\}(.*)$/);
      if (braceMatch) {
        // "{old => new}/file.ts" format
        filePath = braceMatch[1] + braceMatch[2] + braceMatch[3];
      } else {
        // "old/path => new/path" format
        filePath = filePath.split(' => ').pop()!;
      }
    }

    stats.set(filePath, { additions, deletions });
  }

  return stats;
}

/**
 * Merge a numstat map into an accumulator, summing per-path counts.
 * A file that is both staged and modified in the working tree contributes both
 * diffs; the summed count slightly over-counts overlapping lines, which is
 * acceptable for the severity thresholds it feeds (never under-counts to zero).
 */
function mergeNumstat(
  into: Map<string, { additions: number; deletions: number }>,
  from: Map<string, { additions: number; deletions: number }>,
): void {
  for (const [path, stat] of from) {
    const existing = into.get(path);
    if (existing) {
      existing.additions += stat.additions;
      existing.deletions += stat.deletions;
    } else {
      into.set(path, { additions: stat.additions, deletions: stat.deletions });
    }
  }
}

/**
 * Get the unified diff content for a specific file against a base ref.
 * Returns the diff text, truncated to maxChars to fit LLM context windows.
 */
export async function getFileDiff(
  rootPath: string,
  filePath: string,
  baseRef: string,
  maxChars: number = DIFF_MAX_CHARS,
): Promise<string> {
  validateGitRef(baseRef); // argument-injection guard before interpolating into a git rev range
  // Try three-dot diff first (merge-base), fall back to two-dot
  for (const separator of ['...', '..']) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', `${baseRef}${separator}HEAD`, '--', filePath],
        { cwd: rootPath },
      );
      if (stdout.trim()) {
        return stdout.length > maxChars
          ? stdout.slice(0, maxChars) + '\n... (truncated)'
          : stdout;
      }
    } catch (err) {
      logger.debug(`git diff ${separator} failed for ${filePath}: ${(err as Error).message}`);
    }
  }

  // Fall back to unstaged/staged diff (for uncommitted changes)
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', 'HEAD', '--', filePath],
      { cwd: rootPath },
    );
    if (stdout.trim()) {
      return stdout.length > maxChars
        ? stdout.slice(0, maxChars) + '\n... (truncated)'
        : stdout;
    }
  } catch (err) {
    logger.debug(`git diff HEAD failed for ${filePath}: ${(err as Error).message}`);
  }

  return '';
}

/**
 * Get commit messages between baseRef and HEAD as a single string.
 * Returns empty string if no commits or git fails.
 */
export async function getCommitMessages(rootPath: string, baseRef: string): Promise<string> {
  validateGitRef(baseRef); // argument-injection guard before interpolating into a git rev range
  for (const separator of ['...', '..']) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', '--oneline', `${baseRef}${separator}HEAD`],
        { cwd: rootPath },
      );
      if (stdout.trim()) return stdout.trim();
    } catch { /* try next separator */ }
  }
  return '';
}

/**
 * Get changed files between working tree and a base ref
 */
export async function getChangedFiles(options: GitDiffOptions): Promise<GitDiffResult> {
  const { rootPath, baseRef, includeUnstaged } = options;

  // Resolve base ref
  const resolvedBase = await resolveBaseRef(rootPath, baseRef);
  const currentBranch = await getCurrentBranch(rootPath);

  const fileMap = new Map<string, { status: ChangedFile['status']; oldPath?: string }>();

  // Get committed changes on branch vs base
  try {
    const { stdout } = await execFileAsync(
      'git', gitPathArgs('diff', '--name-status', '--diff-filter=ACDMR', `${resolvedBase}...HEAD`),
      { cwd: rootPath }
    );
    for (const entry of parseNameStatus(stdout)) {
      fileMap.set(entry.path, { status: entry.status, oldPath: entry.oldPath });
    }
  } catch (err) {
    // If three-dot diff fails (e.g., no common ancestor), try two-dot
    logger.debug(`Three-dot diff failed, falling back to two-dot: ${(err as Error).message}`);
    try {
      const { stdout } = await execFileAsync(
        'git', gitPathArgs('diff', '--name-status', '--diff-filter=ACDMR', `${resolvedBase}..HEAD`),
        { cwd: rootPath }
      );
      for (const entry of parseNameStatus(stdout)) {
        fileMap.set(entry.path, { status: entry.status, oldPath: entry.oldPath });
      }
    } catch (err2) {
      logger.debug(`Two-dot diff also failed, using empty file list: ${(err2 as Error).message}`);
    }
  }

  // Get unstaged + staged changes if requested
  let hasUnstagedChanges = false;
  if (includeUnstaged) {
    // Staged changes
    try {
      const { stdout } = await execFileAsync(
        'git', gitPathArgs('diff', '--cached', '--name-status', '--diff-filter=ACDMR'),
        { cwd: rootPath }
      );
      for (const entry of parseNameStatus(stdout)) {
        if (!fileMap.has(entry.path)) {
          fileMap.set(entry.path, { status: entry.status, oldPath: entry.oldPath });
        }
      }
    } catch (err) {
      logger.debug(`Could not get staged changes: ${(err as Error).message}`);
    }

    // Unstaged working tree changes
    try {
      const { stdout } = await execFileAsync(
        'git', gitPathArgs('diff', '--name-status', '--diff-filter=ACDMR'),
        { cwd: rootPath }
      );
      const unstaged = parseNameStatus(stdout);
      if (unstaged.length > 0) {
        hasUnstagedChanges = true;
        for (const entry of unstaged) {
          if (!fileMap.has(entry.path)) {
            fileMap.set(entry.path, { status: entry.status, oldPath: entry.oldPath });
          }
        }
      }
    } catch (err) {
      logger.debug(`Could not get unstaged changes: ${(err as Error).message}`);
    }
  }

  // Get line-level stats
  let numstatMap = new Map<string, { additions: number; deletions: number }>();
  try {
    const { stdout } = await execFileAsync(
      'git', gitPathArgs('diff', '--numstat', `${resolvedBase}...HEAD`),
      { cwd: rootPath }
    );
    numstatMap = parseNumstat(stdout);
  } catch (err) {
    logger.debug(`Three-dot numstat failed, falling back to two-dot: ${(err as Error).message}`);
    try {
      const { stdout } = await execFileAsync(
        'git', gitPathArgs('diff', '--numstat', `${resolvedBase}..HEAD`),
        { cwd: rootPath }
      );
      numstatMap = parseNumstat(stdout);
    } catch (err2) {
      logger.debug(`Two-dot numstat also failed: ${(err2 as Error).message}`);
    }
  }

  // When staged/working-tree files are part of the changeset, their line counts
  // are not in the commit-range numstat above — gather them and merge per path so
  // uncommitted work carries real counts into severity and messages (not +0/-0).
  if (includeUnstaged) {
    try {
      const { stdout } = await execFileAsync(
        'git', gitPathArgs('diff', '--cached', '--numstat'),
        { cwd: rootPath }
      );
      mergeNumstat(numstatMap, parseNumstat(stdout));
    } catch (err) {
      logger.debug(`Could not get staged numstat: ${(err as Error).message}`);
    }

    try {
      const { stdout } = await execFileAsync(
        'git', gitPathArgs('diff', '--numstat'),
        { cwd: rootPath }
      );
      mergeNumstat(numstatMap, parseNumstat(stdout));
    } catch (err) {
      logger.debug(`Could not get working-tree numstat: ${(err as Error).message}`);
    }
  }

  // Build ChangedFile list
  const files: ChangedFile[] = [];
  for (const [path, { status, oldPath }] of fileMap) {
    if (isSkippableFile(path)) continue;

    const stats = numstatMap.get(path) ?? { additions: 0, deletions: 0 };
    const classification = classifyFile(path);

    files.push({
      path,
      status,
      oldPath,
      additions: stats.additions,
      deletions: stats.deletions,
      ...classification,
    });
  }

  // Apply path filter if provided
  const filtered = options.pathFilter?.length
    ? files.filter(f => options.pathFilter!.some(p => f.path.startsWith(p) || f.path === p))
    : files;

  return {
    resolvedBase,
    files: filtered,
    hasUnstagedChanges,
    currentBranch,
  };
}
