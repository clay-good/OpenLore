/**
 * FileWalker Service
 *
 * Traverses the codebase intelligently, filtering noise and respecting ignore patterns.
 * Collects metadata about each file for significance scoring and analysis.
 *
 * The walker is where the substrate's honesty starts: every directory entry it does not analyze
 * is accounted for under a named skip reason or a truncation receipt, `includePatterns` override
 * every exclusion layer (down to directory pruning), and nested `.gitignore` files are honored
 * with git's subtree scoping — so a corpus is never silently smaller than it claims to be
 * (change: harden-walker-corpus-boundary).
 */

import { opendir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, basename, extname, dirname } from 'node:path';
import ignoreModule from 'ignore';
import { isConfinedPath } from '../../utils/path-confinement.js';
import { DEFAULT_MAX_FILES, OPENLORE_DIR, OPENSPEC_DIR } from '../../constants.js';
// `ignore` ships as CJS with `module.exports = ignore` plus a self-referencing
// `.default`, and which of the two an interop path hands back varies. The runtime
// unwrap is kept exactly as it was — v7 only dropped `.default` from its published
// types, so the cast restores the type while leaving resolution behaviour identical.
// This decides which files get analyzed, so it is deliberately not "simplified".
const ignore =
  (ignoreModule as typeof ignoreModule & { default?: typeof ignoreModule }).default ?? ignoreModule;
type Ignore = ReturnType<typeof ignore>;
import type { FileMetadata, FileWalkerResult } from '../../types/index.js';

/**
 * The `ignore` package matches POSIX-separated paths only. `path.relative()` yields
 * backslash separators on Windows, so every relative path handed to `ig.ignores()` must be
 * normalized first — otherwise gitignore/exclude/include matching silently no-ops there
 * (nothing excluded, or everything walked). This is the concrete site the
 * `fix-windows-invocation-surface` change names.
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * The glob-free leading directory of an include pattern — the deepest ancestor a walk must
 * descend into to ever reach a file the pattern can match. `vendor/mylib/**` → `vendor/mylib`,
 * `src/**\/*.ts` → `src`, a bare `foo.ts` → `foo.ts`. Returned POSIX-normalized.
 */
export function includePatternPrefix(pattern: string): string {
  const normalized = toPosixPath(pattern).replace(/^\.\//, '').replace(/^\//, '');
  const literal: string[] = [];
  for (const seg of normalized.split('/')) {
    if (seg.length === 0) continue;
    if (/[*?[\]{}!]/.test(seg)) break;
    literal.push(seg);
  }
  return literal.join('/');
}

/**
 * Classify a filesystem error hit while listing/reading an entry into a named skip reason. A
 * permission-denied directory drops a whole subtree, which is a very different disclosure from a
 * transient read error — lumping both under a bare `error` read like an ordinary hiccup.
 */
function directorySkipReason(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  return code === 'EACCES' || code === 'EPERM' ? 'error:permission' : 'error:read';
}

/** A `.gitignore` found in a subdirectory, scoped (git semantics) to its own subtree. */
interface NestedIgnore {
  /** POSIX repo-relative path of the directory that owns the `.gitignore`. */
  baseDir: string;
  ig: Ignore;
}

/**
 * Options for the FileWalker
 */
export interface FileWalkerOptions {
  /** Maximum number of files to process */
  maxFiles?: number;
  /** Additional glob patterns to include */
  includePatterns?: string[];
  /** Additional glob patterns to exclude */
  excludePatterns?: string[];
  /** Paths that cannot be force-included (generated analysis/spec output). */
  protectedExcludePatterns?: string[];
  /** Hard traversal depth bound; exceeding it fails closed. */
  maxDepth?: number;
  /** Hard entry examination bound, checked before directory entries are retained or sorted. */
  maxEntries?: number;
  /** Progress callback for UI updates */
  onProgress?: (progress: FileWalkerProgress) => void;
  /** AbortController signal for cancellation */
  signal?: AbortSignal;
  /** Maximum concurrent file reads */
  concurrency?: number;
}

/**
 * Progress information during file walking
 */
export interface FileWalkerProgress {
  filesFound: number;
  directoriesScanned: number;
  currentPath: string;
}

/**
 * Built-in directories to always skip
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '__pycache__',
  'coverage',
  'vendor',
  'storybook-static',
  'cdk.out',
  'android',
  'ios',
  OPENSPEC_DIR,
  OPENLORE_DIR,
]);

/**
 * Hidden directories (dot-prefixed) we DO want to traverse — they hold
 * analysis-relevant config (CI workflows, etc.).
 */
const ALLOW_DOT_DIRECTORIES = new Set([
  '.github',
  '.gitlab',
  '.circleci',
  '.azure',
]);

/**
 * Directories to skip only when not at root level
 */
const SKIP_DIRECTORIES_NOT_ROOT = new Set([
  'deps',
  'packages',
]);

/**
 * File extensions to always skip (binary/generated files)
 */
const SKIP_EXTENSIONS = new Set([
  // Lock files
  '.lock',
  '.lockb',
  // Minified/bundled
  '.min.js',
  '.min.css',
  '.bundle.js',
  '.chunk.js',
  // Source maps
  '.map',
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.bmp',
  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  // Media
  '.mp3',
  '.mp4',
  '.wav',
  '.avi',
  '.mov',
  '.webm',
  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  // Compiled
  '.pyc',
  '.pyo',
  '.class',
  '.o',
  '.so',
  '.dll',
  '.exe',
]);

/**
 * Specific filenames to always skip
 */
const SKIP_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.DS_Store',
  'Thumbs.db',
]);

/**
 * Entry point file name patterns (without extension)
 */
const ENTRY_POINT_NAMES = new Set([
  'index',
  'main',
  'app',
  'server',
  'cli',
  'entry',
]);

/**
 * Configuration file name patterns
 */
const CONFIG_PATTERNS = [
  /^\..*rc$/,
  /^\..*rc\.js$/,
  /^\..*rc\.json$/,
  /^\..*rc\.yaml$/,
  /^\..*rc\.yml$/,
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

/**
 * Test file/directory patterns.
 *
 * NOTE: deliberately distinct from the shared call-graph predicate in
 * ../analyzer/test-file.ts. This classifier sets FileMetadata.isTest, which feeds
 * the repository map / significance scorer (a different view), and is intentionally
 * broader — it excludes whole test/spec DIRECTORIES and any extension. The shared
 * predicate is per-language and precise for graph-node classification. Do not merge
 * them: narrowing this one would let directory-convention test code back into the
 * repo map, and broadening the shared one would over-classify graph nodes.
 */
const TEST_DIR_PATTERNS = [
  /\/test\//,
  /\/tests\//,
  /\/__tests__\//,
  /\/spec\//,
  /\/specs\//,
  /^test\//,
  /^tests\//,
  /^__tests__\//,
  /^spec\//,
  /^specs\//,
];

const TEST_FILE_PATTERNS = [
  /\.test\.[^.]+$/,
  /\.spec\.[^.]+$/,
  /_test\.[^.]+$/,
  /_spec\.[^.]+$/,
  /^test_.*\.[^.]+$/,
  /^spec_.*\.[^.]+$/,
];

/** Maximum file size to read for line counting / shebang detection (10 MB). */
const MAX_READ_SIZE = 10_000_000;

/**
 * How many directory entries the walk may examine PAST the `maxFiles` cap while confirming a
 * truncation before it gives up and conservatively declares the corpus partial. Precise detection
 * (a truncation is real iff a genuinely admissible file is denied) means walking until the next
 * admissible file; in a realistic oversized repo source files are dense, so that file appears
 * almost immediately. This bound caps the pathological case — the cap filling right before a large
 * trailing subtree of only-skipped files — so the walk never re-scans the whole repository just to
 * label it. Generous enough that a real sibling overflow is always found precisely; small enough
 * that the fallback scan stays well under a tenth of a second.
 */
const POST_CAP_PROBE_LIMIT = 10_000;
const DEFAULT_MAX_WALK_DEPTH = 100;

/**
 * Check if a file has a shebang line
 */
async function hasShebang(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    if (s.size > MAX_READ_SIZE) return false;
    const content = await readFile(filePath, { encoding: 'utf-8', flag: 'r' });
    return content.startsWith('#!');
  } catch {
    return false;
  }
}

/**
 * Count lines in a file. Returns -1 for files larger than MAX_READ_SIZE.
 */
async function countLines(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    if (s.size > MAX_READ_SIZE) return -1;
    const content = await readFile(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * Check if file path matches test patterns
 */
function isTestFile(relativePath: string, fileName: string): boolean {
  // Check directory patterns
  for (const pattern of TEST_DIR_PATTERNS) {
    if (pattern.test(relativePath)) {
      return true;
    }
  }

  // Check file name patterns
  for (const pattern of TEST_FILE_PATTERNS) {
    if (pattern.test(fileName)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if file is a configuration file
 */
function isConfigFile(fileName: string): boolean {
  for (const pattern of CONFIG_PATTERNS) {
    if (pattern.test(fileName)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if file is likely generated
 */
function isGeneratedFile(fileName: string, relativePath: string): boolean {
  // Check common generated file patterns
  if (fileName.endsWith('.d.ts')) return true;
  if (fileName.endsWith('.generated.ts')) return true;
  if (fileName.endsWith('.generated.js')) return true;
  if (relativePath.includes('/generated/')) return true;
  if (relativePath.includes('/__generated__/')) return true;

  return false;
}

/**
 * Check if file might be an entry point
 */
async function isEntryPoint(
  fileName: string,
  relativePath: string,
  absolutePath: string,
  depth: number
): Promise<boolean> {
  const nameWithoutExt = basename(fileName, extname(fileName));

  // Check if name matches entry point patterns
  if (ENTRY_POINT_NAMES.has(nameWithoutExt.toLowerCase())) {
    return true;
  }

  // Files in src/, lib/, bin/ at depth 1 might be entry points. Note: `bin` is in
  // SKIP_DIRECTORIES, so a file under `bin/` only reaches this classifier when the user's
  // `includePatterns` override descends into it (see matchesIncludeLineage) — the branch is
  // reachable exactly on that path, not dead.
  if (depth === 1) {
    const dir = dirname(relativePath);
    if (['src', 'lib', 'bin'].includes(dir)) {
      return true;
    }
  }

  // Check for shebang
  if (await hasShebang(absolutePath)) {
    return true;
  }

  return false;
}

/**
 * Load and combine ignore patterns
 */
async function loadIgnorePatterns(rootPath: string): Promise<Ignore> {
  const ig = ignore();

  // Add built-in patterns for directories
  for (const dir of SKIP_DIRECTORIES) {
    ig.add(`${dir}/`);
  }

  // Add built-in patterns for files
  for (const ext of SKIP_EXTENSIONS) {
    ig.add(`*${ext}`);
  }

  for (const filename of SKIP_FILENAMES) {
    ig.add(filename);
  }

  // Load .gitignore
  try {
    const gitignorePath = join(rootPath, '.gitignore');
    const gitignoreContent = await readFile(gitignorePath, 'utf-8');
    ig.add(gitignoreContent);
  } catch {
    // .gitignore not found, continue without it
  }

  // Load .openlore-ignore (optional)
  try {
    const openloreIgnorePath = join(rootPath, '.openlore-ignore');
    const openloreIgnoreContent = await readFile(openloreIgnorePath, 'utf-8');
    ig.add(openloreIgnoreContent);
  } catch {
    // .openlore-ignore not found, continue without it
  }

  return ig;
}

/**
 * FileWalker class for traversing codebases
 */
export class FileWalker {
  private rootPath: string;
  private options: Required<FileWalkerOptions>;
  private ig: Ignore | null = null;
  /** Separate ignore instance used to check if a file matches includePatterns. */
  private igInclude: Ignore | null = null;
  /**
   * Glob-free directory prefixes of the include patterns. A directory on the lineage of any
   * of these must be descended even when a built-in skip / gitignore / excludePatterns rule
   * would otherwise prune it, so the documented "includePatterns override all exclusions"
   * contract holds at directory granularity, not only at file granularity.
   */
  private includePrefixes: string[] = [];
  /**
   * True when an include pattern begins with a glob segment (`**\/*.ts`, `*.ts`) and therefore
   * has no glob-free directory prefix to anchor on. Such a pattern can match a file at ANY depth,
   * so every directory is on its lineage — no directory may be pruned, or the override is a
   * silent no-op inside pruned trees.
   */
  private includeMatchesAnyDir = false;
  /**
   * Where the walk stopped when it hit `maxFiles`, if it did. Non-null means the corpus is a
   * truncated prefix of the repository, and the walk summary must say so rather than present
   * a partial corpus as complete.
   */
  private truncatedAtPath: string | null = null;
  /**
   * Set once truncation is confirmed (an admissible file was denied because the cap was full).
   * Unwinds the recursion promptly instead of scanning the rest of the tree.
   */
  private stopWalk = false;
  /** Entries examined past the `maxFiles` cap while probing for an overflow file (see the bound). */
  private postCapEntriesExamined = 0;
  private files: FileMetadata[] = [];
  private skippedCount = 0;
  private skippedReasons: Record<string, number> = {};
  private directoriesScanned = 0;
  private entriesExamined = 0;
  private fatalBudgetError: Error | null = null;
  /**
   * Counters keyed by file extension and by directory path. Both keys come from the
   * scanned repository, so a file whose extension or directory is literally `__proto__`
   * (or `constructor`) must never reach `Object.prototype`. A `Map` has no such sink;
   * it is materialized to a plain object for the public summary at the walk boundary.
   */
  private extensionCounts = new Map<string, number>();
  private directoryCounts = new Map<string, number>();

  constructor(rootPath: string, options: FileWalkerOptions = {}) {
    this.rootPath = rootPath;
    this.options = {
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
      includePatterns: options.includePatterns ?? [],
      excludePatterns: options.excludePatterns ?? [],
      protectedExcludePatterns: options.protectedExcludePatterns ?? [],
      maxDepth: options.maxDepth ?? DEFAULT_MAX_WALK_DEPTH,
      maxEntries: options.maxEntries ?? Math.min(1_000_000, Math.max(100_000, (options.maxFiles ?? DEFAULT_MAX_FILES) * 20)),
      onProgress: options.onProgress ?? (() => {}),
      signal: options.signal ?? new AbortController().signal,
      concurrency: options.concurrency ?? 10,
    };
  }

  /** Real paths of directories already walked — stops a symlink cycle from walking forever. */
  private readonly visitedRealDirs = new Set<string>();

  /** The root, resolved, so confinement compares like with like when the root itself is a link. */
  private realRootPath = '';

  /** How many followed symlinks (dir or file) entered the corpus — disclosed in the summary. */
  private symlinkFollowedCount = 0;

  /** Record a skipped directory entry under a named reason. */
  private recordSkip(reason: string): void {
    this.skippedCount++;
    this.skippedReasons[reason] = (this.skippedReasons[reason] ?? 0) + 1;
  }

  /**
   * Record where the walk hit the `maxFiles` cap. Only the first stop location wins.
   *
   * Called from exactly one site — the point where a file that passed every skip check cannot be
   * added because the corpus is full — so a non-null value means at least one genuinely
   * analyzable file was dropped. A complete corpus (even one that exactly fills the cap) is never
   * marked, because no admissible file is ever denied in that case.
   */
  private markTruncated(atPath: string): void {
    if (this.truncatedAtPath === null) {
      this.truncatedAtPath = atPath.length > 0 ? toPosixPath(atPath) : '.';
    }
  }

  /**
   * Count one entry examined past a full corpus and, if the probe budget is spent, conservatively
   * declare truncation and arm the unwind. Returns true when the caller should stop. A no-op (and
   * false) while the corpus is not yet full — the probe only runs past the cap. Reaching the budget
   * without an admissible file means a large trailing all-skipped subtree: continuing would re-scan
   * the repository the cap exists to bound, and a corpus with that much beyond it is honestly partial.
   */
  private probePastCap(atPath: string): boolean {
    if (this.files.length < this.options.maxFiles) return false;
    this.postCapEntriesExamined++;
    if (this.postCapEntriesExamined > POST_CAP_PROBE_LIMIT) {
      this.markTruncated(atPath);
      this.stopWalk = true;
      return true;
    }
    return false;
  }

  /**
   * Is `relativeDir` on the lineage of an include pattern — i.e. it either contains (is an
   * ancestor of) or lies under a directory an include pattern targets? Such a directory must
   * be descended regardless of any exclusion layer, or the include is a silent no-op because
   * its directory was pruned before any file inside it was ever tested.
   */
  private matchesIncludeLineage(relativeDir: string): boolean {
    // A glob-leading include pattern (`**/*.ts`, `*.ts`) can match at any depth, so no directory
    // may be pruned — every one is on its lineage.
    if (this.includeMatchesAnyDir) return true;
    if (this.includePrefixes.length === 0) return false;
    const dir = toPosixPath(relativeDir);
    if (dir === '' || dir === '.') return true;
    for (const prefix of this.includePrefixes) {
      if (dir === prefix || dir.startsWith(prefix + '/') || prefix.startsWith(dir + '/')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Does any active nested `.gitignore` exclude this POSIX path? Each scope only governs its
   * own subtree (git semantics), so a pattern in `packages/app/.gitignore` never leaks to
   * `packages/lib/`. The directory holding a `.gitignore` is never excluded by its own file.
   *
   * BOUNDARY (deliberate): the root and nested `.gitignore` files are evaluated as INDEPENDENT
   * subtree filters (ignored if the root `this.ig` OR any scope says so), not as one git-style
   * depth-ordered chain. So a deeper `!important.log` that re-includes what a shallower `*.log`
   * excluded is NOT honored — the walker errs toward over-exclusion (a smaller, never a wrongly
   * larger, corpus). Same-file negation works (delegated to the `ignore` package). Full
   * cross-file negation precedence is a separate, larger change (it must not resurrect the
   * builtin skip dirs); see the follow-up task.
   */
  private isIgnoredByNested(posixRelPath: string, nested: NestedIgnore[]): boolean {
    for (const scope of nested) {
      const base = scope.baseDir;
      let sub: string;
      if (base === '' || base === '.') {
        sub = posixRelPath;
      } else if (posixRelPath === base || posixRelPath === base + '/') {
        continue;
      } else if (posixRelPath.startsWith(base + '/')) {
        sub = posixRelPath.slice(base.length + 1);
      } else {
        continue;
      }
      if (sub.length > 0 && scope.ig.ignores(sub)) return true;
    }
    return false;
  }

  /** Read a directory's own `.gitignore` (if any) into a subtree-scoped matcher. */
  private async loadDirectoryGitignore(
    dirPath: string,
    relativeDirPath: string,
  ): Promise<NestedIgnore | null> {
    try {
      const content = await readFile(join(dirPath, '.gitignore'), 'utf-8');
      const ig = ignore();
      ig.add(content);
      return { baseDir: toPosixPath(relativeDirPath), ig };
    } catch {
      return null;
    }
  }

  /**
   * Check if we should skip a directory
   */
  private shouldSkipDirectory(dirName: string, depth: number, relativeDir?: string): boolean {
    // Always skip these directories
    if (SKIP_DIRECTORIES.has(dirName)) {
      return true;
    }

    // Skip hidden directories (dot-prefixed) — never contain analyzable source code.
    // Allow-list a few that hold CI/config metadata we DO want to detect.
    if (dirName.startsWith('.') && !ALLOW_DOT_DIRECTORIES.has(dirName)) {
      return true;
    }

    // Skip these only when not at root
    if (depth > 0 && SKIP_DIRECTORIES_NOT_ROOT.has(dirName)) {
      return true;
    }

    // Check exclude patterns against relative path
    if (relativeDir) {
      for (const pattern of this.options.excludePatterns) {
        const normalized = pattern.replace(/\/\*\*$/, '').replace(/\/$/, '');
        if (relativeDir === normalized || relativeDir.startsWith(normalized + '/')) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if we should skip a file. `posixPath` is the caller's already-normalized relative path
   * (avoids re-running `toPosixPath` per file on the walk's hot path).
   */
  private shouldSkipFile(posixPath: string): boolean {
    for (const pattern of this.options.protectedExcludePatterns) {
      const normalized = toPosixPath(pattern).replace(/\/\*\*$/, '').replace(/\/$/, '');
      if (posixPath === normalized || posixPath.startsWith(normalized + '/')) return true;
    }
    // includePatterns override all exclusions — check first
    if (this.igInclude && this.igInclude.ignores(posixPath)) {
      return false;
    }

    // Check against ignore patterns (gitignore + excludePatterns)
    if (this.ig && this.ig.ignores(posixPath)) {
      return true;
    }

    // Check exclude patterns against relative path (direct prefix match)
    for (const pattern of this.options.excludePatterns) {
      const normalized = toPosixPath(pattern).replace(/\/\*\*$/, '').replace(/\/$/, '');
      if (posixPath === normalized || posixPath.startsWith(normalized + '/')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Walk a directory recursively
   */
  private async walkDirectory(
    dirPath: string,
    depth: number,
    nestedIgnores: NestedIgnore[] = [],
  ): Promise<void> {
    // Check for cancellation, or an already-confirmed truncation unwinding the recursion.
    if (this.options.signal.aborted || this.stopWalk) {
      return;
    }
    if (depth > this.options.maxDepth) {
      this.fatalBudgetError = new Error(`Repository walk depth budget exceeded (${this.options.maxDepth}) at ${toPosixPath(relative(this.rootPath, dirPath))}`);
      this.stopWalk = true;
      return;
    }

    this.directoriesScanned++;

    const relativeDirPath = relative(this.rootPath, dirPath);

    // Report progress
    this.options.onProgress({
      filesFound: this.files.length,
      directoriesScanned: this.directoriesScanned,
      currentPath: relativeDirPath || '.',
    });

    // The repository root's `.gitignore` is folded into `this.ig`; a nested one is added below,
    // scoped to this subtree so its patterns apply only where they live (git semantics).
    let activeNested = nestedIgnores;

    try {
      const dir = await opendir(dirPath);

      const entries: { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }[] =
        [];
      let hasGitignore = false;

      for await (const entry of dir) {
        this.entriesExamined++;
        if (this.entriesExamined > this.options.maxEntries) {
          if (this.files.length >= this.options.maxFiles) {
            this.markTruncated(relativeDirPath);
          } else {
            this.fatalBudgetError = new Error(`Repository walk entry budget exceeded (${this.options.maxEntries})`);
          }
          this.stopWalk = true;
          break;
        }
        // A `Dirent` does NOT follow symlinks, so a symlink reports false for BOTH `isDirectory`
        // and `isFile` — it fell out of both lists below and was dropped with no `recordSkip` at
        // all. A repository laid out as `src -> packages/app/src` (pnpm and lerna workspaces, or
        // any shared checkout) was therefore analyzed as though `src` did not exist, and reported
        // success: "Files analyzed: 5", a green `doctor`, and `orient` confidently answering about
        // functions it had never opened. That is the failure this project's honesty contract
        // exists to prevent — a path we could not look at, served as a path with nothing in it.
        //
        // Resolve the link and classify it by its TARGET. Escapes and loops are handled below;
        // neither was previously possible only because nothing was followed.
        const isSymlink = entry.isSymbolicLink();
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (!isDirectory && !isFile && isSymlink) {
          try {
            const target = await stat(join(dirPath, entry.name));
            isDirectory = target.isDirectory();
            isFile = target.isFile();
          } catch {
            // Broken link, or a target we may not stat. Disclosed, not silently dropped.
            this.recordSkip('symlink:unresolvable');
            continue;
          }
          if (!isDirectory && !isFile) {
            // A link to a FIFO, socket, or device. Nothing to analyze, but say so.
            this.recordSkip('symlink:not-a-regular-file');
            continue;
          }
        }
        if (isFile && entry.name === '.gitignore') hasGitignore = true;
        entries.push({ name: entry.name, isDirectory, isFile, isSymlink });
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));

      // Load this directory's own `.gitignore` ONLY when the listing we just built actually
      // contains one. Probing `readFile('.gitignore')` in every directory was one doomed ENOENT
      // syscall per directory across the whole tree; the `opendir` above already told us whether
      // the file exists, so reuse that instead of asking the filesystem twice.
      if (depth > 0 && hasGitignore) {
        const local = await this.loadDirectoryGitignore(dirPath, relativeDirPath);
        if (local) activeNested = [...nestedIgnores, local];
      }

      // Process directories first, then files
      const directories = entries.filter((e) => e.isDirectory);
      const files = entries.filter((e) => e.isFile);

      // Process subdirectories
      for (const entry of directories) {
        if (this.options.signal.aborted || this.stopWalk) break;
        // Past a full corpus, bound how far we descend probing for an overflow file.
        if (this.probePastCap(relativeDirPath)) break;

        const subPath = join(dirPath, entry.name);
        const relativeSubPath = relative(this.rootPath, subPath);
        const posixSubPath = toPosixPath(relativeSubPath);

        // includePatterns override EVERY exclusion layer, including directory pruning: a
        // directory on the lineage of an include pattern is descended even when a built-in
        // skip dir, gitignore, or excludePatterns rule would prune it — otherwise the include
        // is a silent no-op because its directory vanished before any file was tested. The
        // file-level check (shouldSkipFile) still admits only the files that actually match.
        const protectedExclude = this.options.protectedExcludePatterns.some(pattern => {
          const normalized = toPosixPath(pattern).replace(/\/\*\*$/, '').replace(/\/$/, '');
          return posixSubPath === normalized || posixSubPath.startsWith(normalized + '/');
        });
        if (protectedExclude) {
          this.recordSkip('pattern');
          continue;
        }
        const forceInclude = this.matchesIncludeLineage(relativeSubPath);

        if (!forceInclude) {
          if (this.shouldSkipDirectory(entry.name, depth, relativeSubPath)) {
            this.recordSkip(`directory:${entry.name}`);
            continue;
          }

          // Check against ignore patterns (root gitignore + built-ins + excludes)
          if (this.ig && this.ig.ignores(posixSubPath + '/')) {
            this.recordSkip('gitignore');
            continue;
          }

          // Check against nested `.gitignore` scopes active for this subtree
          if (this.isIgnoredByNested(posixSubPath + '/', activeNested)) {
            this.recordSkip('gitignore');
            continue;
          }
        }

        // Following symlinks makes two hazards reachable that could not occur while they were
        // being dropped, so both are handled HERE rather than left to chance.
        //
        //  - A link may point outside the repository (`node_modules/x -> /usr/lib/...`). Indexing
        //    that would put files the user never checked in into their graph.
        //  - A link may point at an ancestor (`d/up -> ../..`), which walks forever.
        //
        // The real path answers both: confinement is checked against it, and a directory already
        // visited under its real path is not walked twice. A hard-link cycle is impossible for
        // directories, so real-path identity is sufficient.
        let realSubPath: string;
        try {
          realSubPath = await realpath(subPath);
        } catch {
          this.recordSkip('symlink:unresolvable');
          continue;
        }
        if (!isConfinedPath(this.realRootPath, realSubPath)) {
          this.recordSkip('symlink:outside-root');
          continue;
        }
        if (this.visitedRealDirs.has(realSubPath)) {
          this.recordSkip('symlink:already-visited');
          continue;
        }
        this.visitedRealDirs.add(realSubPath);

        // A directory reached THROUGH a symlink is now being analyzed rather than dropped. The
        // corpus is correct, but the walk summary must be able to explain why files under a link
        // appear — disclose the followed link, distinct from the skipped-link reasons above.
        if (entry.isSymlink) this.symlinkFollowedCount++;

        await this.walkDirectory(subPath, depth + 1, activeNested);
        if (this.stopWalk) break;
      }

      // Process files sequentially. The `maxFiles` cap is enforced AFTER the skip checks so the
      // truncation receipt fires only when a genuinely ADMISSIBLE file is denied — never on a
      // trailing empty/skipped entry, which would brand a complete corpus as partial.
      for (const entry of files) {
        if (this.options.signal.aborted || this.stopWalk) break;
        // Past a full corpus, bound how many skipped files we scan probing for an overflow file.
        if (this.probePastCap(relativeDirPath)) break;

        const filePath = join(dirPath, entry.name);
        const relativePath = relative(this.rootPath, filePath);
        const posixPath = toPosixPath(relativePath);

        // A nested `.gitignore` excludes its own subtree's files — unless an include pattern
        // overrides it, keeping includePatterns supreme over every exclusion layer.
        const includedByPattern = this.igInclude?.ignores(posixPath) ?? false;
        if (!includedByPattern && this.isIgnoredByNested(posixPath, activeNested)) {
          this.recordSkip('gitignore');
          continue;
        }

        if (this.shouldSkipFile(posixPath)) {
          this.recordSkip('pattern');
          continue;
        }

        // This file WOULD be analyzed — but the corpus is already full. That is a real
        // truncation: record where it happened and unwind. (The walk keeps scanning past the cap
        // only until this first admissible-but-denied file, so a genuinely oversized repo stops
        // promptly while an exact-fit repo is never mislabeled.)
        if (this.files.length >= this.options.maxFiles) {
          this.markTruncated(relativeDirPath);
          this.stopWalk = true;
          break;
        }

        // Count a followed symlinked file only once it ACTUALLY entered the corpus — processFile
        // swallows a stat/read failure, so incrementing before it would disclose a "followed" link
        // that was never analyzed.
        const added = await this.processFile(filePath, relativePath, entry.name, depth);
        if (added && entry.isSymlink) this.symlinkFollowedCount++;
      }
    } catch (e) {
      // Could not list the directory (permission denied, or a transient read error). Disclose
      // WHICH, so a permission-pruned subtree is not read as an ordinary hiccup.
      this.recordSkip(directorySkipReason(e));
    }
  }

  /**
   * Process a single file and collect metadata. Returns true when the file was added to the
   * corpus, false when a stat/read failure dropped it (recorded under a skip reason).
   */
  private async processFile(
    absolutePath: string,
    relativePath: string,
    fileName: string,
    depth: number
  ): Promise<boolean> {
    try {
      const fileStat = await stat(absolutePath);
      const extension = extname(fileName);
      const directory = dirname(relativePath);
      const lines = await countLines(absolutePath);

      const metadata: FileMetadata = {
        path: relativePath,
        absolutePath,
        name: fileName,
        extension,
        size: fileStat.size,
        lines,
        depth,
        directory: directory === '.' ? '' : directory,
        isEntryPoint: await isEntryPoint(fileName, relativePath, absolutePath, depth),
        isConfig: isConfigFile(fileName),
        isTest: isTestFile(relativePath, fileName),
        isGenerated: isGeneratedFile(fileName, relativePath),
      };

      this.files.push(metadata);

      // Update counts
      const ext = extension || '(no extension)';
      this.extensionCounts.set(ext, (this.extensionCounts.get(ext) ?? 0) + 1);

      const dir = directory === '' || directory === '.' ? '(root)' : directory;
      this.directoryCounts.set(dir, (this.directoryCounts.get(dir) ?? 0) + 1);
      return true;
    } catch (e) {
      this.recordSkip(directorySkipReason(e));
      return false;
    }
  }

  /**
   * Walk the codebase and collect file metadata
   */
  async walk(): Promise<FileWalkerResult> {
    // Resolve the root once. Confinement must compare real path against real path, or a repository
    // whose own root is reached through a symlink would judge every one of its directories to be
    // outside itself.
    this.realRootPath = await realpath(this.rootPath).catch(() => this.rootPath);
    this.visitedRealDirs.clear();
    this.visitedRealDirs.add(this.realRootPath);
    // Reset every accumulator so a re-used instance re-walks cleanly rather than double-counting.
    this.files = [];
    this.skippedCount = 0;
    this.skippedReasons = {};
    this.directoriesScanned = 0;
    this.entriesExamined = 0;
    this.fatalBudgetError = null;
    this.extensionCounts = new Map();
    this.directoryCounts = new Map();
    this.stopWalk = false;
    this.truncatedAtPath = null;
    this.postCapEntriesExamined = 0;
    this.symlinkFollowedCount = 0;
    this.includePrefixes = [];
    this.includeMatchesAnyDir = false;

    // Load ignore patterns
    this.ig = await loadIgnorePatterns(this.rootPath);

    // Add user-specified exclude patterns
    for (const pattern of this.options.excludePatterns) {
      this.ig.add(pattern);
    }

    // includePatterns override gitignore/excludePatterns at file level.
    // Add them as negated patterns so this.ig lets them through, and
    // build a separate igInclude instance for the direct excludePatterns check.
    if (this.options.includePatterns.length > 0) {
      this.igInclude = ignore();
      for (const pattern of this.options.includePatterns) {
        this.ig.add('!' + pattern);
        this.igInclude.add(pattern);
      }
      // Glob-free directory lineage of each include pattern, so directory pruning can honor
      // the "includePatterns override all exclusions" contract before pruning a directory.
      this.includePrefixes = this.options.includePatterns
        .map(includePatternPrefix)
        .filter((p) => p.length > 0);
      // An UNANCHORED pattern with no glob-free prefix (it starts with a glob, e.g. `**/*.ts` or
      // `*.ts`) can match a file at any depth, so it must force every directory open. An anchored
      // pattern (`/*.ts`) is root-relative: its lineage is captured by its prefix (empty here means
      // "root only", and root is always descended), so it must NOT force the whole tree open.
      this.includeMatchesAnyDir = this.options.includePatterns.some((p) => {
        const t = p.trim();
        return t.length > 0 && !t.startsWith('/') && includePatternPrefix(t) === '';
      });
    }

    // Start walking from root
    await this.walkDirectory(this.rootPath, 0);
    if (this.fatalBudgetError) throw this.fatalBudgetError;

    // An include pattern that matched NOTHING is a silent config no-op — the user asked to force
    // something in and it wasn't there (a typo, a wrong path). Surface it so the config failure is
    // visible rather than silently doing nothing. Checked against the admitted corpus; each
    // pattern gets its own matcher once, tested over the (usually scoped) file set.
    let includePatternsUnmatched: string[] | undefined;
    if (this.options.includePatterns.length > 0 && !this.truncatedAtPath) {
      const admitted = this.files.map((f) => toPosixPath(f.path));
      const unmatched = this.options.includePatterns.filter((pat) => {
        if (pat.trim().length === 0) return false;
        const matcher = ignore().add(pat);
        return !admitted.some((p) => matcher.ignores(p));
      });
      if (unmatched.length > 0) includePatternsUnmatched = unmatched;
    }

    return {
      files: this.files,
      summary: {
        totalFiles: this.files.length,
        totalDirectories: this.directoriesScanned,
        byExtension: Object.fromEntries(this.extensionCounts),
        byDirectory: Object.fromEntries(this.directoryCounts),
        skippedCount: this.skippedCount,
        skippedReasons: this.skippedReasons,
        // Followed symlinks entered the corpus (a symlinked `src/`, a vendored file). The spec
        // requires the followed count be disclosed so a corpus reachable only through a link is
        // explainable from the summary alone, not just the SKIPPED links. Absent means none.
        ...(this.symlinkFollowedCount > 0 ? { symlinkFollowed: this.symlinkFollowedCount } : {}),
        // Include patterns the user set that matched no admitted file — a visible config no-op.
        ...(includePatternsUnmatched ? { includePatternsUnmatched } : {}),
        // A partial corpus must announce itself: hitting `maxFiles` leaves the graph a truncated
        // prefix of the repository, which every downstream tool would otherwise present as the
        // whole repo. Absent means the walk completed within the cap.
        ...(this.truncatedAtPath !== null
          ? { truncated: { limit: this.options.maxFiles, atPath: this.truncatedAtPath } }
          : {}),
      },
      rootPath: this.rootPath,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Convenience function to walk a directory
 */
export async function walkDirectory(
  rootPath: string,
  options?: FileWalkerOptions
): Promise<FileWalkerResult> {
  const walker = new FileWalker(rootPath, options);
  return walker.walk();
}
