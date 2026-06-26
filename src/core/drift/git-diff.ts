/**
 * Git diff integration for drift detection
 *
 * Shells out to git to determine what files changed between the current
 * working tree and a base ref (typically main/master).
 */

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { DIFF_MAX_CHARS } from '../../constants.js';

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
 * Check if the given path is a git repository
 */
export async function isGitRepository(rootPath: string): Promise<boolean> {
  try {
    await access(join(rootPath, '.git'));
    return true;
  } catch {
    return false;
  }
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
      'git', ['diff', '--name-status', '--diff-filter=ACDMR', `${resolvedBase}...HEAD`],
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
        'git', ['diff', '--name-status', '--diff-filter=ACDMR', `${resolvedBase}..HEAD`],
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
        'git', ['diff', '--cached', '--name-status', '--diff-filter=ACDMR'],
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
        'git', ['diff', '--name-status', '--diff-filter=ACDMR'],
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
      'git', ['diff', '--numstat', `${resolvedBase}...HEAD`],
      { cwd: rootPath }
    );
    numstatMap = parseNumstat(stdout);
  } catch (err) {
    logger.debug(`Three-dot numstat failed, falling back to two-dot: ${(err as Error).message}`);
    try {
      const { stdout } = await execFileAsync(
        'git', ['diff', '--numstat', `${resolvedBase}..HEAD`],
        { cwd: rootPath }
      );
      numstatMap = parseNumstat(stdout);
    } catch (err2) {
      logger.debug(`Two-dot numstat also failed: ${(err2 as Error).message}`);
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
