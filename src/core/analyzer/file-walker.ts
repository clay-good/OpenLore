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
  private extensionCounts: Record<string, number> = {};
  /**
   * Keyed by directory path, which comes from the scanned repository — so a directory
   * literally named `__proto__` would otherwise read and write `Object.prototype`
   * instead of this table. `Object.create(null)` has no prototype to reach, and still
   * serializes as a plain object for `byDirectory`.
   */
  private directoryCounts: Record<string, number> = Object.create(null) as Record<string, number>;

  constructor(rootPath: string, options: FileWalkerOptions = {}) {
    this.rootPath = rootPath;
    this.options = {
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
      includePatterns: options.includePatterns ?? [],
      excludePatterns: options.excludePatterns ?? [],
      onProgress: options.onProgress ?? (() => {}),
      signal: options.signal ?? new AbortController().signal,
      concurrency: options.concurrency ?? 10,
    };
  }

  /**
   * Record a skipped file with reason
   */
  /** Real paths of directories already walked — stops a symlink cycle from walking forever. */
  private readonly visitedRealDirs = new Set<string>();

  /** The root, resolved, so confinement compares like with like when the root itself is a link. */
  private realRootPath = '';

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
   * Check if we should skip a file
   */
  private shouldSkipFile(relativePath: string, _fileName: string): boolean {
    const posixPath = toPosixPath(relativePath);

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

    this.directoriesScanned++;

    const relativeDirPath = relative(this.rootPath, dirPath);

    // Honor a `.gitignore` in this directory (git scopes it to this subtree). The repository
    // root's `.gitignore` is already folded into `this.ig`; nested ones are added here so their
    // patterns apply only below where they live, matching git — not to the whole repo.
    let activeNested = nestedIgnores;
    if (depth > 0) {
      const local = await this.loadDirectoryGitignore(dirPath, relativeDirPath);
      if (local) activeNested = [...nestedIgnores, local];
    }

    // Report progress
    this.options.onProgress({
      filesFound: this.files.length,
      directoriesScanned: this.directoriesScanned,
      currentPath: relativeDirPath || '.',
    });

    try {
      const dir = await opendir(dirPath);

      const entries: { name: string; isDirectory: boolean; isFile: boolean }[] = [];

      for await (const entry of dir) {
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
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (!isDirectory && !isFile && entry.isSymbolicLink()) {
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
        entries.push({ name: entry.name, isDirectory, isFile });
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

        if (this.shouldSkipFile(relativePath, entry.name)) {
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

        await this.processFile(filePath, relativePath, entry.name, depth);
      }
    } catch {
      // Permission denied or other read error, skip this directory
      this.recordSkip('error');
    }
  }

  /**
   * Process a single file and collect metadata
   */
  private async processFile(
    absolutePath: string,
    relativePath: string,
    fileName: string,
    depth: number
  ): Promise<void> {
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
      this.extensionCounts[ext] = (this.extensionCounts[ext] ?? 0) + 1;

      const dir = directory === '' || directory === '.' ? '(root)' : directory;
      this.directoryCounts[dir] = (this.directoryCounts[dir] ?? 0) + 1;
    } catch {
      this.recordSkip('error');
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
    this.extensionCounts = {};
    this.directoryCounts = Object.create(null) as Record<string, number>;
    this.stopWalk = false;
    this.truncatedAtPath = null;
    this.postCapEntriesExamined = 0;

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

    return {
      files: this.files,
      summary: {
        totalFiles: this.files.length,
        totalDirectories: this.directoriesScanned,
        byExtension: this.extensionCounts,
        byDirectory: this.directoryCounts,
        skippedCount: this.skippedCount,
        skippedReasons: this.skippedReasons,
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
