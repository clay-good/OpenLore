/**
 * FileWalker Service
 *
 * Traverses the codebase intelligently, filtering noise and respecting ignore patterns.
 * Collects metadata about each file for significance scoring and analysis.
 */

import { opendir, readFile, stat } from 'node:fs/promises';
import { join, relative, basename, extname, dirname } from 'node:path';
import ignoreModule from 'ignore';
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

  // Files in src/, lib/, bin/ at depth 1 might be entry points
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
  private files: FileMetadata[] = [];
  private skippedCount = 0;
  private skippedReasons: Record<string, number> = {};
  private directoriesScanned = 0;
  private extensionCounts: Record<string, number> = {};
  private directoryCounts: Record<string, number> = {};

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
  private recordSkip(reason: string): void {
    this.skippedCount++;
    this.skippedReasons[reason] = (this.skippedReasons[reason] ?? 0) + 1;
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
    // includePatterns override all exclusions — check first
    if (this.igInclude && this.igInclude.ignores(relativePath)) {
      return false;
    }

    // Check against ignore patterns (gitignore + excludePatterns)
    if (this.ig && this.ig.ignores(relativePath)) {
      return true;
    }

    // Check exclude patterns against relative path (direct prefix match)
    for (const pattern of this.options.excludePatterns) {
      const normalized = pattern.replace(/\/\*\*$/, '').replace(/\/$/, '');
      if (relativePath === normalized || relativePath.startsWith(normalized + '/')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Walk a directory recursively
   */
  private async walkDirectory(dirPath: string, depth: number): Promise<void> {
    // Check for cancellation
    if (this.options.signal.aborted) {
      return;
    }

    // Check if we've reached max files
    if (this.files.length >= this.options.maxFiles) {
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

    try {
      const dir = await opendir(dirPath);

      const entries: { name: string; isDirectory: boolean; isFile: boolean }[] = [];

      for await (const entry of dir) {
        entries.push({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        });
      }

      // Process directories first, then files
      const directories = entries.filter((e) => e.isDirectory);
      const files = entries.filter((e) => e.isFile);

      // Process subdirectories
      for (const entry of directories) {
        if (this.options.signal.aborted) break;
        if (this.files.length >= this.options.maxFiles) break;

        const subPath = join(dirPath, entry.name);
        const relativeSubPath = relative(this.rootPath, subPath);

        if (this.shouldSkipDirectory(entry.name, depth, relativeSubPath)) {
          this.recordSkip(`directory:${entry.name}`);
          continue;
        }

        // Check against ignore patterns
        if (this.ig && this.ig.ignores(relativeSubPath + '/')) {
          this.recordSkip('gitignore');
          continue;
        }

        await this.walkDirectory(subPath, depth + 1);
      }

      // Process files sequentially to respect maxFiles limit accurately
      for (const entry of files) {
        if (this.options.signal.aborted) break;
        if (this.files.length >= this.options.maxFiles) break;

        const filePath = join(dirPath, entry.name);
        const relativePath = relative(this.rootPath, filePath);

        if (this.shouldSkipFile(relativePath, entry.name)) {
          this.recordSkip('pattern');
          continue;
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
