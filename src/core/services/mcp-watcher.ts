/**
 * McpWatcher — incremental re-indexer for the MCP server's --watch mode.
 *
 * Watches source files for changes and incrementally updates:
 *   1. signatures in llm-context.json (always)
 *   2. vector index (only when embed: true and an embedding server is reachable)
 *
 * The call graph is deliberately excluded — rebuilding it requires full
 * tree-sitter analysis of all call sites and is too expensive for a watch loop.
 * It stays current via the post-commit hook (openlore analyze --force --embed).
 *
 * Spec 13.1 (watch-mode performance): freshness is O(change), not O(repo).
 *   • Per-file events COALESCE into one batched flush (single debounce timer +
 *     hard max-batch ceiling), so a burst / branch-switch runs the pipeline once,
 *     not once per file.
 *   • The patched llm-context is handed to the MCP read cache in place
 *     (primeContextCache), so the next tool call is a cache HIT — no 2.1 MB
 *     cold re-parse — even after the disk write.
 *   • Vector updates are row-level (VectorIndex.updateFiles), not a full-corpus
 *     read+overwrite, and run on a separate lower-priority lane so signature
 *     freshness never blocks on embedding.
 *   • VCS-flood / bulk batches are detected and collapsed to a single refresh.
 *   • stderr emits one summary line per batch by default (per-file detail behind
 *     OPENLORE_WATCH_DEBUG).
 */

import { readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { acquireAnalysisLock } from '../runtime/advisory-lock.js';
import { resolveOpenspecDir } from '../../utils/openspec-dir.js';
import {
  REQUIRED_ANALYSIS_ARTIFACTS,
  discardGeneration,
  publishGeneration,
  readCurrentGeneration,
} from '../runtime/analysis-generation.js';
import { createHash } from 'node:crypto';
import { join, relative, resolve, posix } from 'node:path';
import { spawn } from 'node:child_process';
import chokidar, { type FSWatcher } from 'chokidar';
import { extractSignatures, detectLanguage } from '../analyzer/signature-extractor.js';
import type { FunctionNode } from '../analyzer/call-graph.js';
import { extractFileStyle, extractFileParseHealth } from '../analyzer/call-graph.js';
import { assembleFromRegions, type StyleFingerprint, type FileStyleRaw } from '../analyzer/style-fingerprint.js';
import { invalidateVectorIndexCaches } from '../analyzer/vector-index.js';
import { isSpecIndexLockTimeoutError, SpecVectorIndex } from '../analyzer/spec-vector-index.js';
import { buildParseHealthReport, type ParseHealthReport, type FileParseHealth } from '../analyzer/parse-health.js';
import { parseBudgetOverrunMs } from '../analyzer/parse-budget.js';
import {
  extractScriptContainer,
  summarizeScriptContainers,
  type ScriptContainerFileRecord,
} from '../analyzer/sfc-script-extractor.js';
import { isTestFile } from '../analyzer/test-file.js';
import { toRepositoryPath } from '../analyzer/file-walker.js';
import {
  combineStaleFileCompositions,
  composeStaleFiles,
  formatStaleRegionComposition,
  spendClosureBudget,
} from '../analyzer/incremental-closure.js';
import { EdgeStore } from './edge-store.js';
import { refreshAttestationCounts } from '../analyzer/index-attestation.js';
import { primeContextCache, type CachedContext } from './mcp-handlers/utils.js';
import {
  deriveEditVerdict,
  selectReachingTestsFromFullGraph,
  writeEditVerdictStore,
  type EditCallSite,
  type GraphVerdictInput,
  type ImportBreakageSite,
  MAX_EDIT_VERDICT_BASIS_FILES,
  MAX_EDIT_VERDICT_BASIS_FILE_BYTES,
  MAX_EDIT_VERDICT_BASIS_TOTAL_BYTES,
} from './edit-verdict.js';
import { isConfinedPath, readFileConfined } from '../../utils/path-confinement.js';
import { sanitizeForTerminal } from '../../utils/misc.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_STYLE_FINGERPRINT,
  ARTIFACT_PARSE_HEALTH,
  WATCH_DEBOUNCE_MS,
  WATCH_MAX_BATCH_MS,
  WATCH_BULK_THRESHOLD,
  WATCH_EMBED_FILE_CEILING,
  WATCH_VCS_SETTLE_MS,
  INCREMENTAL_CLOSURE_BUDGET,
  MAX_HTML_INLINE_SCRIPT_CHARS,
} from '../../constants.js';

// Languages the watcher incrementally re-graphs on edit. MUST include every
// graphable language whose extension is in SOURCE_EXTENSIONS, otherwise editing
// such a file makes buildGraphSubset return empty and the swap WIPES that file's
// nodes/edges/overlay until the next full analyze (a graph-coverage regression).
// C/C#/PHP/Kotlin grammars are optional deps: if absent, buildGraphSubset fails
// soft to empty and the file simply isn't re-graphed (same as full analyze).
const CALL_GRAPH_LANGS = new Set([
  'Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Ruby', 'Java', 'C++', 'Swift',
  'C', 'C#', 'PHP', 'Kotlin', 'Vue', 'Svelte', 'Astro',
]);
/**
 * Per-changed-file work budget for the incremental closure: how many OTHER files
 * one save may re-parse before the watcher stops and marks the remainder stale.
 * Replaces the old fixed depth-1 `CALLER_REPARSE_LIMIT` of 10 — see
 * INCREMENTAL_CLOSURE_BUDGET (change: fix-transitive-incremental-staleness).
 */
const DEFAULT_CLOSURE_BUDGET = INCREMENTAL_CLOSURE_BUDGET;

/**
 * Session-global latch: a SCHEMA_VERSION bump wipes the graph store, and an
 * incremental update can't repair it — only a full `analyze` can. We schedule
 * exactly one background rebuild per process (Spec 26 B10). Latched (never
 * cleared) so a persistently-failing rebuild can't spin into a loop; on failure
 * we fall back to the existing "run analyze" note.
 */
let backgroundRebuildTriggered = false;

/**
 * Debounce before firing a graph-stale rebuild (change: make-index-self-healing).
 * Coalesces a burst of HEAD flips / stale-region marks into ONE rebuild. Longer
 * than the signature debounce so a `git pull` that lands many refs settles first.
 */
const GRAPH_STALE_DEBOUNCE_MS = 1500;

/** Additional attempts after SQLite's own busy_timeout expires. */
const SQLITE_BUSY_RETRY_DELAYS_MS = [50, 150, 450] as const;

function isSqliteBusyError(err: unknown): boolean {
  const message = (err as Error | undefined)?.message?.toLowerCase() ?? '';
  return /sqlite_(?:busy|locked)|database(?: table)? is (?:locked|busy)/.test(message);
}

async function waitForSqliteRetry(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpWatcherOptions {
  /** Absolute path to the project root being watched */
  rootPath: string;
  /** Absolute path to .openlore/analysis/ — where llm-context.json lives */
  outputPath?: string;
  /** Configured OpenSpec root, relative to rootPath (default: openspec). */
  openspecPath?: string;
  /** Milliseconds to debounce file-change events (default: WATCH_DEBOUNCE_MS) */
  debounceMs?: number;
  /** Hard flush ceiling under a continuous change stream (default: WATCH_MAX_BATCH_MS) */
  maxBatchMs?: number;
  /** Batch size that trips VCS-flood handling (default: WATCH_BULK_THRESHOLD) */
  bulkThreshold?: number;
  /** Run the live vector update; false = signatures-only (default: true) */
  embed?: boolean;
  /** Above this many watched source files, auto-degrade to signatures-only */
  embedFileCeiling?: number;
  /**
   * Per-changed-file closure work budget (default DEFAULT_CLOSURE_BUDGET). The
   * max number of other files one save re-resolves before the rest are marked
   * explicitly stale. Exposed mainly so tests can force the budget-exceeded path.
   */
  closureBudget?: number;
  /** Extra glob patterns to ignore in addition to defaults */
  ignore?: string[];
  /**
   * Fired after each coalesced batch is flushed to disk (signatures + vector).
   * Lets a host — e.g. the `openlore serve` daemon — schedule heavier work, such
   * as a debounced full call-graph re-analyze, off the watcher's own lane. The
   * watcher deliberately excludes the call graph (too expensive synchronously),
   * so this is the seam where continuous call-graph freshness is layered on.
   */
  onBatchFlushed?: (changedAbsPaths: string[]) => void;
  /**
   * Call-graph freshness without the commit hook (change: make-index-self-healing).
   * Fired — debounced and coalesced — when the graph has fallen behind in a way an
   * incremental patch cannot repair: a `.git` HEAD ref change (branch switch / pull)
   * or a stale region that crossed the incremental work budget. A host that already
   * owns a rebuild coordinator (the `serve` daemon) wires this to its coordinator so
   * the two rebuild paths coalesce. When provided, the watcher delegates the rebuild
   * to this callback and does NOT spawn one itself.
   */
  onGraphStale?: (reason: GraphStaleReason) => void;
  /**
   * When true AND no `onGraphStale` host handler is provided, the watcher itself
   * spawns the debounced, coalesced background `analyze --reanalyze` on a graph-stale
   * trigger (a repeatable singleflight, distinct from the once-per-process schema-
   * reset heal). Set by the in-process MCP watcher, which — unlike `serve` — has no
   * rebuild coordinator of its own, so its graph would otherwise age with every
   * branch switch. Default false: the plain signatures-only watcher is unchanged.
   */
  selfRebuild?: boolean;
}

/** Why the call graph fell behind in a way only a full rebuild can repair. */
export type GraphStaleReason = 'head-change' | 'stale-region';

export interface RepositoryDeltaResult {
  changedFiles: string[];
  deletedFiles: string[];
  closureFiles: string[];
  staleFiles: string[];
}

interface ChangedFile {
  rel: string;
  content: string;
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|php|cs|cpp|cc|cxx|h|hpp|c|swift|vue|svelte|astro)$/;
// HTML is watched too. detectLanguage() returns 'unknown' for it, so it takes a
// dedicated path: an edit refreshes the literal-text line index, the inline-
// <script> call-graph nodes (blanked → JavaScript in buildGraphSubset), and the
// dependency-graph asset edges (<script src>/<link rel=stylesheet>). Letting HTML
// into the call-graph loop REQUIRES the buildGraphSubset blanking — otherwise the
// atomic swap would delete a page's inline-script nodes on every edit.
const HTML_EXTENSIONS = /\.html?$/i;
const INDEXED_SPEC_FILE = /^specs[/\\][^/\\]+[/\\]spec\.md$/;
const INDEXED_ADR_FILE = /^decisions[/\\]adr-\d+.*\.md$/i;

function isIndexedOpenSpecFile(openspecRoot: string, filePath: string): boolean {
  const rel = relative(openspecRoot, filePath);
  return INDEXED_SPEC_FILE.test(rel) || INDEXED_ADR_FILE.test(rel);
}

// Directory NAMES that must never be watched. Build-output and dependency
// directories can hold hundreds of thousands of files (a Rust `target/` is
// routinely tens of GB), so watching them is both wasteful and a hard EMFILE
// trigger on the first tool call.
//
// Matched against root-RELATIVE path segments (see isIgnoredRelPath), which is
// what makes this robust:
//   • The ignored directory ITSELF matches (not just its children), so chokidar
//     prunes the whole subtree and never opens FDs inside it — the actual EMFILE
//     fix. A naive `path.includes('/target/')` check only matches descendants,
//     so chokidar still descends into target/ and readdir-storms before pruning.
//   • Only segments BELOW the watch root are considered, so a repo that happens
//     to live under e.g. /home/user/dist/myapp is not wrongly ignored.
const IGNORED_DIR_NAMES = new Set([
  // VCS / openlore
  '.git', '.hg', '.svn', '.openlore',
  // JS / TS
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.parcel-cache', '.cache', 'coverage', '.vite',
  // Rust
  'target',
  // Python
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.tox', '.ruff_cache',
  // Go / vendored deps
  'vendor',
  // JVM
  '.gradle',
  // .NET
  'obj',
  // Editor metadata
  '.idea',
]);
const IGNORED_SUFFIXES = ['.test.ts', '.test.js', '.spec.ts', '.spec.js'];

/**
 * True if a root-relative path should never be watched. Evaluated as a cheap
 * segment scan before any FD is opened, so it stays allocation-light. A path is
 * ignored if ANY of its segments is a known build/dependency/VCS directory
 * name, or it has a test-file suffix. Exported for testing.
 *
 * @param relPath path relative to the watch root (forward- or back-slashed)
 */
export function isIgnoredRelPath(relPath: string): boolean {
  if (!relPath || relPath === '.') return false;
  const segments = relPath.split(/[/\\]/);
  for (const seg of segments) {
    if (IGNORED_DIR_NAMES.has(seg)) return true;
  }
  for (const suf of IGNORED_SUFFIXES) {
    if (relPath.endsWith(suf)) return true;
  }
  return false;
}

// ── McpWatcher ────────────────────────────────────────────────────────────────

export class McpWatcher {
  private readonly rootPath: string;
  private readonly outputPath: string;
  private readonly openspecRoot: string;
  private readonly contextPath: string;
  private readonly debounceMs: number;
  private readonly maxBatchMs: number;
  private readonly bulkThreshold: number;
  private readonly embedFileCeiling: number;
  private readonly closureBudget: number;
  private readonly extraIgnore: string[];
  private readonly debug: boolean;
  private readonly onBatchFlushed?: (changedAbsPaths: string[]) => void;
  private readonly onGraphStale?: (reason: GraphStaleReason) => void;
  private readonly selfRebuild: boolean;

  private fsWatcher?: FSWatcher;
  private gitWatcher?: FSWatcher;

  // ── Graph-rebuild trigger (make-index-self-healing) ────────────────────────
  private graphStaleTimer?: ReturnType<typeof setTimeout>;
  private graphStalePendingReason?: GraphStaleReason;
  private graphStaleDeadline?: number;
  private graphRebuildRunning = false;   // singleflight for the self-spawned rebuild
  private graphRebuildPending = false;   // a trigger arrived mid-rebuild → run once more
  private rebuildChildren = new Set<ReturnType<typeof spawn>>();

  // ── Coalescing queue (Step 1) ──────────────────────────────────────────────
  private pending = new Set<string>();              // absolute paths awaiting a flush
  private pendingDeletions = new Set<string>();     // absolute paths of unlinked files
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private maxBatchTimer?: ReturnType<typeof setTimeout>;
  private running = false;                           // single-flight for the signature flush
  private flushPromise?: Promise<void>;              // lets stop() join the active flush
  private stopping = false;                          // reject events once shutdown begins
  private vcsBulkFlag = false;                       // set by the .git ref watcher
  private vcsSettling = false;                       // preserve the VCS settle window across file events
  private appliedClosureFiles?: Set<string>;         // populated only by explicit repository-delta callers

  // ── Embedding lane (Step 4 — decoupled, lower priority) ─────────────────────
  private embed: boolean;
  private embedDegraded = false;                     // auto-degraded on a too-large tree
  private embedFiles = new Map<string, string>();    // rel → content awaiting embed
  private embedNodes = new Map<string, FunctionNode>(); // id → node awaiting embed
  private embedTimer?: ReturnType<typeof setTimeout>;
  private embedRunning = false;
  private embedPromise?: Promise<void>;              // lets stop() join vector persistence
  private lastEmbedContext?: CachedContext;

  constructor(options: McpWatcherOptions) {
    this.rootPath   = options.rootPath;
    this.outputPath = options.outputPath
      ?? join(options.rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    this.openspecRoot = resolveOpenspecDir(options.rootPath, options.openspecPath);
    this.contextPath = join(this.outputPath, ARTIFACT_LLM_CONTEXT);
    this.debounceMs  = options.debounceMs ?? WATCH_DEBOUNCE_MS;
    this.maxBatchMs  = options.maxBatchMs ?? WATCH_MAX_BATCH_MS;
    this.bulkThreshold = options.bulkThreshold ?? WATCH_BULK_THRESHOLD;
    this.embedFileCeiling = options.embedFileCeiling ?? WATCH_EMBED_FILE_CEILING;
    this.closureBudget = options.closureBudget ?? DEFAULT_CLOSURE_BUDGET;
    this.embed       = options.embed ?? true;
    this.extraIgnore = options.ignore ?? [];
    this.debug       = !!process.env.OPENLORE_WATCH_DEBUG;
    this.onBatchFlushed = options.onBatchFlushed;
    this.onGraphStale = options.onGraphStale;
    this.selfRebuild = options.selfRebuild ?? false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopping = false;
    // Auto-degrade live embedding on very large trees (Step 4). Counting is
    // bounded — it stops as soon as the ceiling is exceeded.
    if (this.embed) {
      const count = await this.countSourceFiles(this.embedFileCeiling + 1);
      if (count > this.embedFileCeiling) {
        this.embedDegraded = true;
        process.stderr.write(
          `[mcp-watcher] ${count}+ source files exceed the live-embed ceiling ` +
          `(${this.embedFileCeiling}); running signatures-only — embeddings refresh at commit\n`
        );
      }
    }

    await new Promise<void>((resolve, reject) => {
      const extraIgnore = this.extraIgnore;
      const rootPath = this.rootPath;
      this.fsWatcher = chokidar.watch(rootPath, {
        // Resolve each candidate to a root-relative path first, then prune by
        // directory name. This prunes the ignored directory itself (chokidar
        // never opens FDs inside it — the EMFILE fix) without false-matching on
        // parent path components above the watch root.
        ignored: (filePath: string) => {
          const rel = relative(rootPath, filePath);
          return isIgnoredRelPath(rel) || extraIgnore.some((p) => rel.includes(p));
        },
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      });

      const watched = (p: string): boolean =>
        SOURCE_EXTENSIONS.test(p) || HTML_EXTENSIONS.test(p) || isIndexedOpenSpecFile(this.openspecRoot, p);
      this.fsWatcher.on('change', (absPath: string) => {
        if (watched(absPath)) this.enqueue(absPath);
      });
      // A new file is indexed via the same change pipeline (insert is a no-op
      // delete + add). ignoreInitial:true means only files created AFTER start
      // fire 'add', so the initial scan never storms this.
      this.fsWatcher.on('add', (absPath: string) => {
        if (watched(absPath)) this.enqueue(absPath);
      });
      // A deleted file must be removed from every lane (call graph, signatures,
      // text-line index, vector index, dependency graph) — otherwise its symbols/
      // edges/lines linger as phantom results until the next full analyze.
      this.fsWatcher.on('unlink', (absPath: string) => {
        if (watched(absPath)) this.enqueueDeletion(absPath);
      });

      let watcherReady = false;
      this.fsWatcher.on('ready', () => { watcherReady = true; resolve(); });
      this.fsWatcher.on('error', (err: unknown) => {
        // Before 'ready', an error is a setup failure — reject the start promise.
        // After 'ready', the promise is already settled, so reject() is a silent
        // no-op (the pre-hardening behavior). An async watcher error must never
        // pass silently on the long-lived host: disclose once and keep serving —
        // pending file changes are still caught at the next full analyze.
        if (!watcherReady) {
          const failedWatcher = this.fsWatcher;
          if (this.fsWatcher === failedWatcher) this.fsWatcher = undefined;
          void failedWatcher?.close().finally(() => reject(err));
          return;
        }
        process.stderr.write(
          `[mcp-watcher] source watcher error (${(err as Error)?.message ?? String(err)}); ` +
          `continuing — changes may lag until the next analyze\n`
        );
      });
    });

    // Best-effort VCS-flood detection (Step 5): a branch switch / rebase / merge
    // bumps these refs. We never recurse into .git (it stays ignored above); we
    // watch only these specific files, then collapse the churn into one refresh.
    try {
      const gitDir = join(this.rootPath, '.git');
      const refs = ['HEAD', 'index', 'MERGE_HEAD', 'ORIG_HEAD'].map((f) => join(gitDir, f));
      this.gitWatcher = chokidar.watch(refs, {
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
      });
      this.gitWatcher.on('all', (_event: string, changedPath?: string) => {
        this.onVcsEvent();
        // Call-graph freshness without the commit hook (make-index-self-healing):
        // a HEAD / MERGE_HEAD / ORIG_HEAD change is a branch switch / pull / merge —
        // the graph must rebuild. A bare `index` change (git add) is staging churn
        // that the per-file signature lane already handles, so it does NOT rebuild.
        const base = changedPath ? posix.basename(changedPath.split(/[/\\]/).join('/')) : '';
        if (base === 'HEAD' || base === 'MERGE_HEAD' || base === 'ORIG_HEAD') {
          this.scheduleGraphRebuild('head-change');
        }
      });
      // A .git ref watch is a best-effort optimization; an ASYNC chokidar 'error'
      // (FD pressure, a locked .git/index, ref churn during a rebase) is emitted
      // AFTER this synchronous try/catch returns. Without a listener it surfaces
      // as an unhandled 'error' event and throws — fatal for the warm daemon every
      // connected agent shares. Disclose once, release the failed watcher, and
      // degrade to the batch-size VCS-flood threshold in handleBatch (the same
      // fallback the catch block below promises when setup fails).
      this.gitWatcher.on('error', (err: unknown) => {
        process.stderr.write(
          `[mcp-watcher] .git ref watcher error (${(err as Error)?.message ?? String(err)}); ` +
          `VCS-flood detection falling back to the batch-size threshold\n`
        );
        const failed = this.gitWatcher;
        this.gitWatcher = undefined;
        void failed?.close().catch(() => { /* already gone */ });
      });
    } catch {
      // no .git, or watch failed — VCS detection falls back to the batch-size
      // threshold in handleBatch, which is enough for G3.
    }

    process.stderr.write(
      `[mcp-watcher] watching ${this.rootPath}` +
      `${this.embed && !this.embedDegraded ? '' : ' (signatures-only)'}\n`
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxBatchTimer) clearTimeout(this.maxBatchTimer);
    if (this.embedTimer) clearTimeout(this.embedTimer);
    if (this.graphStaleTimer) clearTimeout(this.graphStaleTimer);
    this.debounceTimer = this.maxBatchTimer = this.embedTimer = this.graphStaleTimer = undefined;
    this.graphStaleDeadline = undefined;
    // Close event sources before joining the active flush. Once close resolves,
    // the stopping guard below makes the pending sets a finite shutdown queue.
    await this.fsWatcher?.close();
    await this.gitWatcher?.close();
    this.fsWatcher = this.gitWatcher = undefined;
    await this.flushPromise;
    await this.embedPromise;
    // A completed structural flush may have queued the lower-priority embed lane
    // immediately before stop cleared its timer. Drain it explicitly so shutdown
    // cannot leave semantic search behind the committed structural generation.
    if (this.embedFiles.size > 0) await this.runEmbedLane();
    this.graphRebuildPending = false;
    const rebuilds = [...this.rebuildChildren];
    await Promise.all(rebuilds.map(child => new Promise<void>(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        done();
      }, 2_000);
      child.once('close', done);
      child.once('error', done);
      try { child.kill('SIGTERM'); } catch { done(); }
    })));

    // Drain anything queued immediately before shutdown through the same busy
    // retry path as a live flush. If contention outlives that bounded retry,
    // disclose the still-deferred work: shutdown cannot retry forever, but it
    // must never make an unpersisted batch disappear silently.
    const shutdownDeletions = Array.from(this.pendingDeletions);
    const shutdownBatch = Array.from(this.pending);
    this.pendingDeletions.clear();
    this.pending.clear();
    if (shutdownDeletions.length > 0 || shutdownBatch.length > 0) {
      try {
        await this.flushBatchWithBusyRetry(shutdownBatch, shutdownDeletions, { syncFlush: true });
      } catch (err) {
        process.stderr.write(`[mcp-watcher] shutdown flush error: ${(err as Error).message}\n`);
      }
    }
    if (this.pending.size > 0 || this.pendingDeletions.size > 0) {
      process.stderr.write(
        `[mcp-watcher] stopped with ${this.pending.size} change(s) and ` +
        `${this.pendingDeletions.size} deletion(s) still deferred — run analyze to reconcile\n`,
      );
    }
    process.stderr.write('[mcp-watcher] stopped\n');
  }

  // ── Coalescing (Step 1) ──────────────────────────────────────────────────────

  /**
   * Add a changed path to the pending set and (re)arm a single debounce timer,
   * plus a one-shot hard ceiling so a continuous stream still flushes.
   */
  private enqueue(absPath: string): void {
    if (this.stopping) return;
    this.pending.add(absPath);
    // A re-create supersedes a pending delete for the same path.
    this.pendingDeletions.delete(absPath);
    this.armFlush();
  }

  /** Queue a file deletion for the next flush (reuses the same debounce). */
  private enqueueDeletion(absPath: string): void {
    if (this.stopping) return;
    this.pendingDeletions.add(absPath);
    // A delete supersedes a pending change for the same path.
    this.pending.delete(absPath);
    this.armFlush();
  }

  /**
   * Create a self-expiring timer that never by itself keeps the process alive
   * (change: fix-process-exit-lifecycle). Every watcher timer is short-lived and
   * cleared on stop(); unref'ing them means a missed teardown degrades to an
   * early exit rather than a process that outlives its transport.
   */
  private armTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  }

  private armFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.vcsSettling) {
      this.debounceTimer = this.armTimer(() => this.flush(), WATCH_VCS_SETTLE_MS);
      return;
    }
    this.debounceTimer = this.armTimer(() => this.flush(), this.debounceMs);
    if (!this.maxBatchTimer) {
      this.maxBatchTimer = this.armTimer(() => this.flush(), this.maxBatchMs);
    }
  }

  /** A .git ref changed — settle, then flush whatever changed as one bulk batch. */
  private onVcsEvent(): void {
    if (this.stopping) return;
    this.vcsBulkFlag = true;
    this.vcsSettling = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxBatchTimer) { clearTimeout(this.maxBatchTimer); this.maxBatchTimer = undefined; }
    this.debounceTimer = this.armTimer(() => this.flush(), WATCH_VCS_SETTLE_MS);
    if (this.debug) {
      process.stderr.write('[mcp-watcher] VCS operation detected — coalescing into one refresh\n');
    }
  }

  /**
   * Drain the pending set into a single batch. Single-flight: if a flush is
   * already running, leave the new paths in `pending` and reschedule once it
   * finishes — never interleave two flushes.
   */
  private flush(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    if (this.maxBatchTimer) { clearTimeout(this.maxBatchTimer); this.maxBatchTimer = undefined; }
    if (this.running) return;            // a follow-up is scheduled in finally{}
    if (this.pending.size === 0 && this.pendingDeletions.size === 0) return;

    const batch = Array.from(this.pending);
    const deletions = Array.from(this.pendingDeletions);
    this.vcsSettling = false;
    this.pending.clear();
    this.pendingDeletions.clear();
    this.running = true;
    const operation = this.flushBatchWithBusyRetry(batch, deletions)
      .catch((err) => { process.stderr.write(`[mcp-watcher] error: ${(err as Error).message}\n`); });
    this.flushPromise = operation;
    void operation.finally(() => {
      if (this.flushPromise === operation) this.flushPromise = undefined;
      this.running = false;
      if (!this.stopping && (this.pending.size > 0 || this.pendingDeletions.size > 0)) {
        this.debounceTimer = this.armTimer(() => this.flush(), this.debounceMs);
      }
    });
  }

  /**
   * Retry a contended SQLite batch, then put it back in the in-memory queue.
   * The queue is drained only after a successful pass, so a long external write
   * lock delays freshness but never silently loses the file events.
   */
  private async flushBatchWithBusyRetry(
    batch: string[],
    deletions: string[],
    opts: { syncFlush?: boolean } = {},
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.recordSpecIndexChanges([...batch, ...deletions]);
        if (await this.fallbackBulkBatch(batch, deletions)) return;
        // Deletions first (remove stale state), then re-index changed/added files.
        if (deletions.length > 0) await this.handleDeletions(deletions, false);
        if (batch.length > 0) await this.handleBatch(batch, { ...opts, recordSpecChanges: false });
        return;
      } catch (err) {
        if (isSpecIndexLockTimeoutError(err)) {
          for (const path of deletions) {
            this.pendingDeletions.add(path);
            this.pending.delete(path);
          }
          for (const path of batch) {
            if (!this.pendingDeletions.has(path)) this.pending.add(path);
          }
          process.stderr.write(
            `[mcp-watcher] spec index remained locked for ${err.timeoutMs}ms; ` +
            `deferred ${batch.length} change(s) and ${deletions.length} deletion(s) for retry\n`,
          );
          return;
        }
        if (!isSqliteBusyError(err)) throw err;
        const delay = SQLITE_BUSY_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          await waitForSqliteRetry(delay);
          continue;
        }
        for (const path of deletions) {
          this.pendingDeletions.add(path);
          this.pending.delete(path);
        }
        for (const path of batch) {
          if (!this.pendingDeletions.has(path)) this.pending.add(path);
        }
        process.stderr.write(
          `[mcp-watcher] SQLite remained busy after ${attempt + 1} attempts; ` +
          `deferred ${batch.length} change(s) and ${deletions.length} deletion(s) for retry\n`,
        );
        return;
      }
    }
  }

  /**
   * A VCS-scale batch is cheaper and safer as one full rebuild than as hundreds
   * of incremental swaps. Persist the whole affected region as stale before
   * handing it to the host's existing coalesced rebuild lane.
   */
  // change: optimize-incremental-and-coldstart-scale
  private async fallbackBulkBatch(batch: string[], deletions: string[]): Promise<boolean> {
    // Shutdown cannot hand work to a future rebuild: drain it incrementally.
    if (this.stopping) return false;
    if (batch.length + deletions.length <= this.bulkThreshold) return false;
    if (!this.onGraphStale && !this.selfRebuild) return false;

    const staleFiles = [...new Set([...batch, ...deletions]
      .map(abs => relative(this.rootPath, abs))
      .filter(rel => !isTestFile(rel))
      .filter(rel => detectLanguage(rel) !== 'unknown' || HTML_EXTENSIONS.test(rel)))]
      .sort();
    if (staleFiles.length === 0) return false;

    const releaseAnalysis = await acquireAnalysisLock(this.outputPath);
    try {
      if (EdgeStore.exists(this.outputPath)) {
        const store = EdgeStore.open(EdgeStore.dbPath(this.outputPath));
        try {
          if (!store.notReady) store.markFilesStale(staleFiles);
        } finally {
          store.close();
        }
      }
    } finally {
      await releaseAnalysis();
    }

    const scheduled = this.scheduleGraphRebuild('stale-region');
    if (!scheduled) return false;
    this.vcsBulkFlag = false;
    process.stderr.write(
      `[mcp-watcher] bulk fallback: marked ${staleFiles.length} file(s) stale and scheduled one full rebuild\n`,
    );
    return true;
  }

  // ── Core re-index ──────────────────────────────────────────────────────────

  /**
   * Re-index a single changed file. Exposed for unit testing without needing a
   * real file watcher; flushes synchronously so callers observe the update on
   * disk immediately. Internally this is just a batch of one.
   */
  async handleChange(absPath: string): Promise<void> {
    await this.handleBatch([absPath], { syncFlush: true });
  }

  /**
   * Apply an already-bounded, repository-relative delta through the exact same
   * mutation lanes as watch mode. This does not start a filesystem watcher and
   * never schedules a full rebuild; callers receive the explicit stale region.
   * (change: add-incremental-bundle-delta)
   */
  async applyRepositoryDelta(
    changedFiles: readonly string[],
    deletedFiles: readonly string[],
  ): Promise<RepositoryDeltaResult> {
    const normalize = (files: readonly string[]): string[] => [...new Set(files.map(file => {
      if (!file || file.includes('\0')) throw new Error('Repository delta contains an invalid path.');
      const absolute = resolve(this.rootPath, file);
      if (!isConfinedPath(this.rootPath, absolute) || absolute === this.rootPath) {
        throw new Error(`Repository delta path escapes the project root: ${file}`);
      }
      return toRepositoryPath(relative(this.rootPath, absolute));
    }))].sort();
    const changed = normalize(changedFiles);
    const deleted = normalize(deletedFiles);
    let deletionRepair: string[] = [];
    let deletionStale: string[] = [];
    if (deleted.length > 0 && EdgeStore.exists(this.outputPath)) {
      const store = EdgeStore.open(EdgeStore.dbPath(this.outputPath));
      try {
        if (!store.notReady) {
          const resolutionNodes = store.getAllInternalNodes();
          const deletedNames = new Set(deleted.flatMap(file =>
            store.getNodesForFile(file).map(node => node.name)));
          const nameCounts = new Map<string, number>();
          for (const node of resolutionNodes) {
            nameCounts.set(node.name, (nameCounts.get(node.name) ?? 0) + 1);
          }
          const ambiguityCandidates = [...deletedNames].some(name => (nameCounts.get(name) ?? 0) > 1)
            ? resolutionNodes.map(node => node.filePath)
            : [];
          const callers = [...new Set([
            ...deleted.flatMap(file => store.getCallerFiles(file)),
            ...[...deletedNames].flatMap(name => store.getExternalConsumerFiles(name)),
            ...ambiguityCandidates,
          ])]
            .filter(file => !deleted.includes(file));
          const budget = spendClosureBudget(callers, this.closureBudget, resolutionNodes);
          deletionRepair = budget.selected;
          deletionStale = budget.dropped;
        }
      } finally {
        store.close();
      }
    }
    this.appliedClosureFiles = new Set<string>();
    try {
      if (deleted.length > 0) {
        await this.handleDeletions(deleted.map(file => join(this.rootPath, file)), false);
      }
      const repair = [...new Set([...changed, ...deletionRepair])].sort();
      if (repair.length > 0) {
        await this.handleBatch(repair.map(file => join(this.rootPath, file)), {
          syncFlush: true,
          recordSpecChanges: false,
          forceFiles: new Set(deletionRepair),
        });
      }
      let staleFiles: string[] = [];
      if (EdgeStore.exists(this.outputPath)) {
        const store = EdgeStore.open(EdgeStore.dbPath(this.outputPath));
        try {
          if (!store.notReady) {
            const unapplied: string[] = [];
            for (const file of [...new Set([...changed, ...deletionRepair])]) {
              if (this.appliedClosureFiles.has(file)) continue;
              try {
                const content = await readFileConfined(this.rootPath, file, MAX_EDIT_VERDICT_BASIS_FILE_BYTES);
                const hash = createHash('sha256').update(content).digest('hex');
                if (store.getFileHash(file) === hash) continue;
              } catch {
                // Unreadable or oversized changed files cannot be asserted fresh.
              }
              unapplied.push(file);
            }
            if (unapplied.length > 0) {
              store.markFilesStale(unapplied, Date.now(), composeStaleFiles(unapplied, store.getAllInternalNodes()));
            }
            if (deletionStale.length > 0) {
              store.markFilesStale(
                deletionStale,
                Date.now(),
                composeStaleFiles(deletionStale, store.getAllInternalNodes()),
              );
            }
            staleFiles = store.getStaleFiles();
          }
        } finally {
          store.close();
        }
      }
      return {
        changedFiles: changed,
        deletedFiles: deleted,
        closureFiles: [...this.appliedClosureFiles].sort(),
        staleFiles,
      };
    } finally {
      this.appliedClosureFiles = undefined;
    }
  }

  /**
   * Process a coalesced batch of changed files as ONE pipeline pass:
   *   • per-file incremental edge update (content-hash skip), all under one open
   *     EdgeStore;
   *   • ONE signature patch + ONE llm-context persist + ONE read-cache handoff;
   *   • ONE vector update (inline when syncFlush, else on the embed lane).
   */
  private async handleBatch(
    absPaths: string[],
    opts: { syncFlush?: boolean; recordSpecChanges?: boolean; forceFiles?: ReadonlySet<string> } = {},
  ): Promise<void> {
    const t0 = Date.now();
    const consumedVcsBulk = this.vcsBulkFlag;
    this.vcsBulkFlag = false;

    if (opts.recordSpecChanges !== false) await this.recordSpecIndexChanges(absPaths);

    // 1. Resolve + read candidate files (skip tests / unknown langs / deleted).
    const files: Array<{ rel: string; abs: string; content: string }> = [];
    for (const abs of absPaths) {
      const rel = toRepositoryPath(relative(this.rootPath, abs));
      if (isTestFile(rel)) continue;
      // HTML is 'unknown' to detectLanguage but takes the dedicated HTML path
      // (text-line + inline-script call graph + dependency asset edges).
      if (detectLanguage(rel) === 'unknown' && !HTML_EXTENSIONS.test(rel)) continue;
      let content: string;
      try {
        content = await readFileConfined(this.rootPath, rel, MAX_EDIT_VERDICT_BASIS_FILE_BYTES);
      } catch {
        continue; // file may have been deleted between the event and now
      }
      files.push({ rel, abs, content });
    }
    if (files.length === 0) return;

    // The graph database and required JSON artifacts are one logical generation.
    // Hold the same fence across both mutations; splitting them into two sections
    // lets a full analyze overwrite the DB between the watcher's DB and JSON writes.
    const releaseAnalysis = await acquireAnalysisLock(this.outputPath);
    let previousGenerationId: string | undefined;
    let context: CachedContext;
    const changedFiles: ChangedFile[] = [];
    const changedNodes: FunctionNode[] = [];
    const graphVerdictInputs: GraphVerdictInput[] = [];
    try {
      previousGenerationId = (await readCurrentGeneration(
        this.outputPath, [...REQUIRED_ANALYSIS_ARTIFACTS],
      ))?.generationId;
      const loaded = await this.loadContext();
      if (!loaded) {
        process.stderr.write(`[mcp-watcher] no context at ${this.contextPath} — run analyze first\n`);
        return;
      }
      // 2. Incremental edge update (CGC _handle_modification algorithm), one open
    //    store for the whole batch. Content-hash skip drops no-op autosaves.
    if (EdgeStore.exists(this.outputPath)) {
      const store = EdgeStore.open(EdgeStore.dbPath(this.outputPath));
      try {
        // Not-ready guard: a schema-version mismatch or a quarantined (corrupt) store is
        // reported without being destroyed (change: harden-index-store-lifecycle). An
        // incremental per-file update against it would leave a PARTIAL graph (only the
        // changed file's nodes), so skip it — a full `analyze` must rebuild.
        if (store.notReady) {
          process.stderr.write(
            `[mcp-watcher] graph index not ready (${store.notReady.reason}) — scheduling a background rebuild. ` +
            'Skipping incremental update to avoid a partial graph.\n'
          );
          this.scheduleBackgroundRebuild();
        }
        // Capture every file's pre-edit facts before mutating any file in this
        // coalesced batch. A producer and its consumer can be saved in the same
        // debounce; deriving between their swaps would persist a transient false
        // broken-reference finding.
        const work: Array<{
          f: { rel: string; abs: string; content: string };
          newHash: string;
          oldNodes: FunctionNode[];
          oldIncoming: EditCallSite[];
          preTests: ReturnType<typeof selectReachingTestsFromFullGraph>;
          preTestHashes: Map<string, string>;
        }> = [];
        for (const f of store.notReady ? [] : files) {
          const newHash = createHash('sha256').update(f.content).digest('hex');
          if (!opts.forceFiles?.has(f.rel) && store.getFileHash(f.rel) === newHash) continue;
          const oldNodes = store.getNodesForFile(f.rel);
          const oldIncoming: EditCallSite[] = [];
          for (const node of oldNodes) {
            for (const edge of store.getCallers(node.id)) {
              const caller = store.getNode(edge.callerId);
              if (!caller) continue;
              oldIncoming.push({
                callerId: edge.callerId,
                callerFile: caller.filePath,
                calleeId: edge.calleeId,
                calleeName: edge.calleeName,
                confidence: edge.confidence,
                ...(edge.kind !== undefined ? { kind: edge.kind } : {}),
                ...(edge.line !== undefined ? { line: edge.line } : {}),
                ...(edge.argCount !== undefined ? { argCount: edge.argCount } : {}),
                ...(edge.argCountLowerBound ? { argCountLowerBound: true as const } : {}),
              });
            }
          }
          const preTests = selectReachingTestsFromFullGraph(loaded.callGraph, oldNodes.map(n => n.id));
          const testPaths = preTests.tests.flatMap(test => test.basisFiles ?? [test.file]);
          const preTestHashes = await this.snapshotVerdictFiles(testPaths) ?? new Map<string, string>();
          if (testPaths.length > 0 && preTestHashes.size === 0) {
            preTests.tests = [];
            preTests.truncated = true;
          }
          work.push({ f, newHash, oldNodes, oldIncoming, preTests, preTestHashes });
        }
        const pendingVerdicts: Array<{
          file: string;
          contentHash: string;
          oldNodes: FunctionNode[];
          newNodes: FunctionNode[];
          oldIncoming: EditCallSite[];
          recomputedCallerFiles: Set<string>;
          staleFiles: string[];
          preTests: ReturnType<typeof selectReachingTestsFromFullGraph>;
          basisSnapshots: Map<string, string>;
        }> = [];

        // Load the cross-file resolution seed once for the whole batch. Patch it
        // after each changed file so later subset builds observe the same state
        // they would have received from reloading the node table.
        const resolutionNodes = store.notReady ? [] : store.getAllInternalNodes();
        const resolutionClasses = store.notReady ? [] : store.getAllClasses();
        const batchMemberIndex = new Map(work.map((item, index) => [item.f.rel, index]));
        const directCallersByFile = new Map<string, string[]>();
        const directCallerOwner = new Map<string, number>();
        for (const [index, item] of work.entries()) {
          const callers = store.getCallerFiles(item.f.rel)
            .filter(caller => caller !== item.f.rel)
            // A later batch member rebuilds itself against this producer. An
            // earlier member has already used old nodes, so repair it here.
            .filter(caller => {
              const callerIndex = batchMemberIndex.get(caller);
              return callerIndex === undefined || callerIndex < index;
            });
          directCallersByFile.set(item.f.rel, callers);
          for (const caller of callers) directCallerOwner.set(caller, index);
        }
        for (const [itemIndex, item] of work.entries()) {
          if (store.notReady) break;
          const { f, newHash, oldNodes, oldIncoming, preTests, preTestHashes } = item;

          // Symbol names present BEFORE the edit — diffed against the re-parsed
          // result to find names this edit ADDS (which may now bind prior
          // `external::` call sites in non-caller files).
          const oldNames = new Set(store.getNodesForFile(f.rel).map((n) => n.name));
          // Re-parse BEFORE mutating DB — graph stays readable (old state) during
          // parse. Seed resolution with all known nodes so re-parsed callers'
          // cross-file calls don't degrade to `external::`.
          // ── Change-driven reverse-dependency closure ───────────────────────────
          // Converge with `analyze --force`, or mark the remainder explicitly
          // stale (fix-transitive-incremental-staleness). Direct callers first —
          // the files whose edges point INTO this one — bounded by the work budget.
          const directCallers = (directCallersByFile.get(f.rel) ?? [])
            .filter(caller => directCallerOwner.get(caller) === itemIndex);
          const directCallerSet = new Set(directCallers);
          const directBudget = spendClosureBudget(directCallers, this.closureBudget, resolutionNodes);
          let recompute = directBudget.selected;
          let dropped = directBudget.dropped;
          let usedPathFallback = directBudget.usedPathFallback;
          let testReachabilityDegraded = directBudget.testReachabilityDegraded;

          // Re-parse the changed file + the callers we can afford, as ONE build so
          // cross-file calls resolve against each other (not to `external::`).
          let sub = await buildGraphSubset(
            f.rel,
            f.content,
            recompute,
            this.rootPath,
            resolutionNodes,
            resolutionClasses,
          );

          // Class-P closure: a symbol this edit ADDED can newly bind a previously-
          // `external` call site, or turn a previously-UNIQUE `name_only` bind into
          // an ambiguous (unbound) one, in a file that is NOT a caller of this one
          // (getCallerFiles misses it). Discovery runs even when direct callers
          // already filled the budget — these consumers must never be left silently
          // divergent: re-resolve within the remaining budget, mark the rest stale.
          // Re-resolving runs them alongside the changed file so the new edge (or the
          // new ambiguity) resolves exactly as `analyze --force` would.
          const addedIdByName = new Map<string, string>(); // added name → lowest new id
          for (const n of sub.nodes) {
            if (oldNames.has(n.name)) continue;
            const cur = addedIdByName.get(n.name);
            if (cur === undefined || n.id < cur) addedIdByName.set(n.name, n.id);
          }
          if (addedIdByName.size > 0) {
            const extra = new Set<string>();
            for (const [name, addedId] of addedIdByName) {
              // `external` consumers were unresolved — they always rebind to the new symbol.
              for (const cf of store.getExternalConsumerFiles(name)) {
                const memberIndex = batchMemberIndex.get(cf);
                if (cf !== f.rel && cf !== 'external' &&
                    (memberIndex === undefined || memberIndex < itemIndex) && !directCallerSet.has(cf)) extra.add(cf);
              }
              // `name_only` consumers currently resolve the name to a UNIQUE cross-file
              // definition. Adding a SECOND definition of that name makes the bare call
              // ambiguous — the resolver refuses to guess, so the edge disappears —
              // REGARDLESS of id sort order (change: harden-call-resolution-ambiguity).
              // Every such consumer therefore diverges from a full rebuild and must be
              // re-resolved (the pre-ambiguity `addedId < calleeId` prune, which assumed
              // only a lower-id add flipped the pick, would now leave higher-id adds
              // silently holding a stale unique edge). `!==` guards the same-node no-op.
              for (const { file: cf, calleeId } of store.getNameOnlyConsumers(name)) {
                const memberIndex = batchMemberIndex.get(cf);
                if (cf !== f.rel && cf !== 'external' &&
                    (memberIndex === undefined || memberIndex < itemIndex) &&
                    !directCallerSet.has(cf) && addedId !== calleeId) extra.add(cf);
              }
            }
            if (extra.size > 0) {
              const room = Math.max(0, this.closureBudget - recompute.length);
              const extraBudget = spendClosureBudget([...extra], room, resolutionNodes);
              usedPathFallback ||= extraBudget.usedPathFallback;
              testReachabilityDegraded ||= extraBudget.testReachabilityDegraded;
              const take = extraBudget.selected;
              dropped = dropped.concat(extraBudget.dropped);
              if (take.length > 0) {
                recompute = [...recompute, ...take];
                sub = await buildGraphSubset(
                  f.rel,
                  f.content,
                  recompute,
                  this.rootPath,
                  resolutionNodes,
                  resolutionClasses,
                );
              }
            }
          }

          const {
            edges: newEdges,
            nodes: newNodes,
            cfgs: newCfgs,
            classes: newClasses,
            inheritanceEdges: newInheritanceEdges,
            skipped,
          } = sub;
          // A file we INTENDED to recompute but could not READ (permissions /
          // transient I/O / a lock) must not have its edges deleted and then be
          // asserted fresh — that is the one silent-divergence the converge-or-flag
          // contract forbids. Preserve its existing edges (skip the delete) and mark
          // it stale instead, so it is honestly flagged until it can be re-read.
          const skippedSet = new Set(skipped);
          const recomputed = recompute.filter((cf) => !skippedSet.has(cf));
          const staleNow = [...new Set([...dropped, ...skipped])];
          this.appliedClosureFiles?.add(f.rel);
          for (const cf of recomputed) this.appliedClosureFiles?.add(cf);
          // Atomic swap so concurrent MCP reads never see a torn graph.
          store.transaction(() => {
            store.deleteEdgesForFile(f.rel);
            for (const cf of recomputed) store.deleteOutgoingEdgesForFile(cf);
            store.deleteNodesForFile(f.rel);
            store.deleteClassesForFile(f.rel);
            // Recompute only THIS file's overlay records — intra-procedural, so
            // caller files' overlays stay valid (spec: add-intraprocedural-cfg-dataflow-overlay).
            store.deleteCfgForFile(f.rel);
            store.insertNodes(newNodes);
            store.insertEdges(newEdges);
            store.insertCfgs(newCfgs);
            store.insertClasses(newClasses);
            store.replaceInheritanceEdges(newInheritanceEdges);
            store.deleteOrphanExternalNodes();
            store.refreshExternalClasses();
            store.recomputeStructuralMetrics();
            store.setFileHash(f.rel, newHash);
            // Self-heal: every file we actually recomputed has converged, so it
            // leaves the explicit stale region. Soundness fallback: files we could
            // not afford to recompute (over budget) OR could not read (skipped) are
            // marked stale (over-approximate, never silent).
            store.clearFilesStale([f.rel, ...recomputed]);
            if (staleNow.length > 0) {
              store.markFilesStale(staleNow, Date.now(), composeStaleFiles(staleNow, resolutionNodes));
              // The incremental closure hit its work budget and left files explicitly
              // stale. Rather than let that region grow unbounded until a manual
              // analyze, schedule the debounced full rebuild (make-index-self-healing).
              this.scheduleGraphRebuild('stale-region');
            }
          });
          const retainedResolutionNodes = resolutionNodes.filter(node => node.filePath !== f.rel);
          resolutionNodes.splice(0, resolutionNodes.length, ...retainedResolutionNodes, ...newNodes);
          const retainedResolutionClasses = resolutionClasses.filter(cls => cls.filePath !== f.rel);
          resolutionClasses.splice(0, resolutionClasses.length, ...retainedResolutionClasses, ...newClasses);

          pendingVerdicts.push({
            file: f.rel,
            contentHash: newHash,
            oldNodes,
            newNodes,
            oldIncoming,
            recomputedCallerFiles: new Set(recomputed),
            staleFiles: staleNow,
            preTests,
            basisSnapshots: new Map([...preTestHashes, ...sub.analyzedFileHashes]),
          });

          changedFiles.push(f);
          for (const n of newNodes) changedNodes.push(n);
          if (this.debug) {
            const staleComposition = combineStaleFileCompositions(
              [...composeStaleFiles(staleNow, resolutionNodes).values()],
              staleNow.length,
            );
            process.stderr.write(
              `[mcp-watcher] graph: ${sanitizeForTerminal(f.rel)} (+${newNodes.length} nodes, +${newEdges.length} edges, ` +
              `${recomputed.length} re-resolved` +
              `${staleNow.length ? `, ${formatStaleRegionComposition(staleComposition)} → stale${usedPathFallback ? ', stable-path fallback' : ''}${testReachabilityDegraded ? ', configured budget defers test reachability' : ''}${skipped.length ? ` (${skipped.length} unreadable)` : ''}` : ''})\n`,
            );
          }
        }
        // All swaps in the debounce are now committed. Only now inspect the post
        // graph, so a consumer changed later in this same batch can clear a site.
        for (const pendingVerdict of pendingVerdicts) {
          const postIncoming: EditCallSite[] = [];
          for (const node of pendingVerdict.newNodes) {
            for (const edge of store.getCallers(node.id)) {
              const caller = store.getNode(edge.callerId);
              if (!caller) continue;
              postIncoming.push({
                callerId: edge.callerId,
                callerFile: caller.filePath,
                calleeId: edge.calleeId,
                calleeName: edge.calleeName,
                confidence: edge.confidence,
                ...(edge.kind !== undefined ? { kind: edge.kind } : {}),
                ...(edge.line !== undefined ? { line: edge.line } : {}),
                ...(edge.argCount !== undefined ? { argCount: edge.argCount } : {}),
                ...(edge.argCountLowerBound ? { argCountLowerBound: true as const } : {}),
              });
            }
          }
          const postOutgoingByCaller = new Map<string, import('../analyzer/call-graph.js').CallEdge[]>();
          for (const site of pendingVerdict.oldIncoming) {
            if (!postOutgoingByCaller.has(site.callerId)) {
              postOutgoingByCaller.set(site.callerId, store.getCallees(site.callerId));
            }
          }
          graphVerdictInputs.push({
            ...pendingVerdict,
            postOutgoingByCaller,
            postIncoming,
            reachingTests: pendingVerdict.preTests.tests,
            reachingTestsTruncated: pendingVerdict.preTests.truncated,
            reachingTestsBasis: 'last-full-analysis',
            basis: [],
          });
        }
        // Keep the index attestation's counts in lockstep with the now-mutated store so
        // the load-time verdict doesn't falsely report `degraded` on a valid incremental
        // edit (change: add-index-integrity-attestation). Best-effort; never blocks the
        // watch path. Skipped on a not-ready store (the loop above breaks immediately,
        // so changedFiles stays empty).
        if (changedFiles.length > 0) {
          await refreshAttestationCounts(this.outputPath, store).catch(() => {});
        }
      } finally {
        store.close();
      }
    } else {
      // No edge store yet — still refresh signatures for every candidate.
      for (const f of files) changedFiles.push(f);
    }

    if (changedFiles.length === 0) return; // every event was a no-op autosave

    // 3. Signatures: load context (shared in-memory cache), patch all changed
    //    files, then ONE persist + read-cache handoff (Step 2). The handoff
    //    means the next tool call is a cache HIT — no cold 2.1 MB re-parse.
    //
    // The whole artifact-mutation section (load → patch → persist → the four
    // update* lanes) runs under the analysis lock so this read-modify-write of the
    // JSON artifact set cannot interleave with a full `analyze` writing the same
    // directory — including the watcher's own self-heal `analyze --reanalyze` spawn
    // (change: harden-artifact-write-atomicity). loadContext is INSIDE the lock so
    // our persist can never clobber a fresh full write that landed after we read.
      if (!loaded.signatures) loaded.signatures = [];
      for (const f of changedFiles) {
        const newMap = extractSignatures(f.rel, f.content);
        const idx = loaded.signatures.findIndex((m) => m.path === f.rel);
        if (idx >= 0) loaded.signatures[idx] = newMap;
        else loaded.signatures.push(newMap);
      }
      await this.persistContext(loaded);

      // 3.5. Literal-text line index — keep it fresh for the changed files
      //      (source + HTML). Runs regardless of the embed setting (BM25-only).
      //      File deletions are handled separately by handleDeletions (the 'unlink'
      //      lane), which drops the removed file's lines from this index.
      await this.updateTextLines(changedFiles);

      // 3.6. Dependency graph — keep dependency-graph.json's file→file import edges
      //      live (get_file_dependencies reads that static artifact). Incremental,
      //      O(change): re-resolve the changed files' imports and splice their
      //      edges, recompute in/out-degree. Global metrics (pageRank, clusters,
      //      betweenness) are O(graph) and left to the next full `analyze`.
      const importBreakages = await this.updateDependencyGraph(changedFiles);

      // 3.7. Style fingerprint — keep style-fingerprint.json's per-file idiom counters live for the
      //      changed files (change: add-codebase-style-fingerprint). Incremental: re-tally only the
      //      changed files, reuse the stored file→region map (communities are O(graph), recomputed
      //      on the next full analyze). byLanguage and per-file profiles stay exact.
      await this.updateStyleFingerprint(changedFiles);

      // 3.8. Parse health — keep parse-health.json's per-file degradation records live for the
      //      changed files (change: add-parse-health-boundary-disclosure). Unlike the style
      //      fingerprint, this artifact is ABSENT on a clean repo, so a newly-introduced parse error
      //      must be able to create it, and a repaired file must be able to remove its entry (and the
      //      artifact once empty).
      await this.updateParseHealth(changedFiles);
      const generationId = await this.republishGeneration();
      if (generationId && graphVerdictInputs.length > 0) {
        const derived = await Promise.all(graphVerdictInputs.map(async input => {
          const sites = importBreakages.get(input.file) ?? [];
          const basis = await this.buildVerdictBasis(input, sites);
          if (!basis) return null;
          return deriveEditVerdict({
            ...input,
            importBreakages: sites,
            basis,
          });
        }));
        const verdicts = derived.filter(verdict => verdict !== null);
        const invalidatedFiles = new Set(files.map(file => file.rel));
        for (const input of graphVerdictInputs) {
          for (const file of input.recomputedCallerFiles) invalidatedFiles.add(file);
          for (const file of input.staleFiles) invalidatedFiles.add(file);
        }
        try {
          const evictedFiles = graphVerdictInputs
            .filter((_input, index) => derived[index] === null)
            .map(input => input.file);
          await writeEditVerdictStore(this.outputPath, generationId, verdicts, {
            previousGenerationId,
            invalidatedFiles: [...invalidatedFiles],
            evictedFiles,
          });
        } catch (err) {
          // The generation already advanced, so any previous verdict is rejected
          // as stale by readers. Preserve graph freshness and disclose the missing
          // optional delivery artifact rather than rolling back committed analysis.
          process.stderr.write(`[mcp-watcher] edit-verdict write error: ${(err as Error).message}\n`);
        }
      }
      context = loaded;
    } finally {
      await releaseAnalysis();
    }
    // 4. Vector update — decoupled from signature freshness (Step 4).
    const isBulk = consumedVcsBulk || changedFiles.length >= this.bulkThreshold;
    if (this.embed && !this.embedDegraded && context.callGraph) {
      if (opts.syncFlush) {
        // Direct handleChange path: inline so callers/tests observe it.
        await this.updateVectors(context, changedFiles, changedNodes);
      } else {
        // Watcher path: schedule on the lower-priority embed lane. On a bulk
        // event this still collapses to a single deferred pass.
        this.scheduleEmbed(context, changedFiles, changedNodes);
      }
    }

    // 5. One summary line per batch (Step 6). Per-file detail is behind debug.
    const n = changedFiles.length;
    // Every downstream lane has consumed the source or copied it into its own
    // queue. Release potentially large batch strings before callbacks retain
    // this frame any longer.
    for (const file of changedFiles) file.content = '';
    files.length = 0;
    process.stderr.write(
      `[mcp-watcher] ${isBulk ? `coalesced ${n} changes` : `updated ${n} file${n === 1 ? '' : 's'}`} (${Date.now() - t0}ms)\n`
    );

    // Real change flushed (signatures + edges patched on disk). Hand off to any
    // host lane — e.g. serve's debounced call-graph re-analyze. Reached only when
    // a meaningful batch was processed (the no-op early returns above skip it).
    // Best-effort: a host callback error must never break the watcher.
    try { this.onBatchFlushed?.(absPaths); } catch { /* host lane is best-effort */ }
  }

  /**
   * The spec index is full-build-only. Keep that bounded behavior and persist an
   * honest receipt instead of silently serving stale spec rows.
   */
  private async recordSpecIndexChanges(absPaths: string[]): Promise<void> {
    const changedSpecs = [...new Set(absPaths
      .filter(path => isIndexedOpenSpecFile(this.openspecRoot, path))
      .map(path => relative(this.rootPath, path).split('\\').join('/')))]
      .sort();
    if (changedSpecs.length === 0) return;
    await SpecVectorIndex.noteSpecFilesChanged(this.outputPath, changedSpecs);
  }

  /**
   * Self-heal a schema-reset graph by spawning one detached `analyze --reanalyze`
   * (BM25-only, no network). Runs at most once per process (`backgroundRebuild
   * Triggered`); a spawn failure logs and falls back to the existing "run
   * analyze" note rather than retrying — no thundering herd, no loop (B10).
   */
  private scheduleBackgroundRebuild(): void {
    if (this.stopping) return;
    if (backgroundRebuildTriggered) return;
    backgroundRebuildTriggered = true;
    const cli = process.argv[1];
    if (!cli) {
      process.stderr.write('[mcp-watcher] cannot locate the openlore CLI to auto-rebuild — run "openlore analyze".\n');
      return;
    }
    try {
      const child = spawn(
        process.execPath,
        // `--reanalyze`, not `--force`: what this heal needs is to RUN — a schema-reset index
        // can carry a fingerprint that still matches source, which a plain analyze would skip
        // — not to re-parse the repo (change: optimize-hash-keyed-analyze).
        //
        // On THIS path the extraction cache is lost anyway: it lives in the same store, and a
        // SCHEMA_VERSION bump drops it along with everything else, so the run re-extracts and
        // then repopulates. The flag is still the honest one to use, and the sibling heal
        // below — which fires on ordinary staleness and is the one that repeats — does keep
        // its cache.
        [cli, 'analyze', '--reanalyze', '--no-embed', '--output', this.outputPath],
        // windowsHide: detached alone surfaces a console window on Windows (same reason
        // serve-client's daemon spawn sets it) — without it, every self-heal here flashes
        // a visible cmd window (change: extend-api-for-supervising-hosts).
        { cwd: this.rootPath, stdio: 'ignore', detached: true, windowsHide: true }
      );
      this.rebuildChildren.add(child);
      child.once('close', (code) => {
        this.rebuildChildren.delete(child);
        if (code === 0) invalidateVectorIndexCaches(this.outputPath);
      });
      child.on('error', (err) => {
        process.stderr.write(`[mcp-watcher] background rebuild failed to start (${err.message}) — run "openlore analyze".\n`);
      });
      child.unref();
      process.stderr.write('[mcp-watcher] background "openlore analyze --reanalyze" started; the graph will self-heal shortly.\n');
    } catch (err) {
      process.stderr.write(`[mcp-watcher] background rebuild could not be spawned (${(err as Error).message}) — run "openlore analyze".\n`);
    }
  }

  /** Test-only: drive the graph-stale trigger without a real git/fs event. */
  _triggerGraphStaleForTesting(reason: GraphStaleReason): void {
    this.scheduleGraphRebuild(reason);
  }

  /**
   * Hand a read-time freshness mismatch to this host's existing stale-region
   * repair lane (change: disclose-stale-serving-on-cold-reads). The caller has
   * already confined and normalized these repository-relative paths. Marking
   * them preserves the factual stale region while the coalesced full rebuild is
   * pending; the method returns true only when this watcher actually owns a
   * rebuild lane, so response wording never promises an unscheduled repair.
   */
  requestColdReadRepair(staleFiles: readonly string[]): boolean {
    const files = [...new Set(staleFiles.filter(file => file.length > 0))].sort();
    if (files.length === 0 || (!this.onGraphStale && !this.selfRebuild)) return false;
    try {
      if (EdgeStore.exists(this.outputPath)) {
        const store = EdgeStore.open(EdgeStore.dbPath(this.outputPath));
        try {
          if (!store.notReady) store.markFilesStale(files);
        } finally {
          store.close();
        }
      }
    } catch {
      // The full rebuild remains the repair authority even when the stale-region
      // receipt cannot be persisted (legacy/corrupt store). Never block the read.
    }
    return this.scheduleGraphRebuild('stale-region');
  }

  /**
   * Schedule a debounced, coalesced full-graph rebuild after a trigger an
   * incremental patch cannot repair (change: make-index-self-healing). Rapid
   * successive triggers (a `git pull` touching many refs) collapse into one
   * rebuild. No-op unless a host wired `onGraphStale` or `selfRebuild` is set, so
   * the plain signatures-only watcher is byte-for-byte unchanged.
   */
  private scheduleGraphRebuild(reason: GraphStaleReason): boolean {
    if (this.stopping) return false;
    if (!this.onGraphStale && !this.selfRebuild) return false;
    // Keep the first reason of a coalesced burst — HEAD-change is the more
    // salient cause when both fire together, and it arrives first on a switch.
    if (this.graphStalePendingReason === undefined) this.graphStalePendingReason = reason;
    const candidateDeadline = Date.now() + GRAPH_STALE_DEBOUNCE_MS;
    // Coalescing may lengthen an armed settle window, never shorten it. Keeping
    // the absolute deadline explicit preserves that invariant if a future stale
    // composition selects a longer delay.
    const deadline = Math.max(this.graphStaleDeadline ?? 0, candidateDeadline);
    if (this.graphStaleTimer) clearTimeout(this.graphStaleTimer);
    this.graphStaleDeadline = deadline;
    this.graphStaleTimer = setTimeout(() => {
      const r = this.graphStalePendingReason ?? reason;
      this.graphStalePendingReason = undefined;
      this.graphStaleTimer = undefined;
      this.graphStaleDeadline = undefined;
      if (this.onGraphStale) {
        try { this.onGraphStale(r); } catch { /* host lane is best-effort */ }
      } else {
        this.spawnGraphRebuild(r);
      }
    }, Math.max(0, deadline - Date.now()));
    this.graphStaleTimer.unref?.();
    return true;
  }

  /**
   * Repeatable singleflight full `analyze --reanalyze` (BM25-only, no network) for the
   * in-process watcher, which has no host rebuild coordinator. Distinct from the
   * once-per-process schema-reset heal: this must re-fire across a session (every
   * branch switch), so it coalesces a trigger that arrives mid-rebuild into one
   * follow-up run rather than latching forever. Never throws.
   */
  private spawnGraphRebuild(reason: GraphStaleReason): void {
    if (this.graphRebuildRunning) { this.graphRebuildPending = true; return; }
    const cli = process.argv[1];
    if (!cli) {
      process.stderr.write('[mcp-watcher] cannot locate the openlore CLI to auto-rebuild — run "openlore analyze".\n');
      return;
    }
    this.graphRebuildRunning = true;
    try {
      const child = spawn(
        process.execPath,
        // `--reanalyze`, not `--force`: what is stale here is the graph STORE, never the
        // per-file extraction cache, which is keyed by content hash and survives a rebuild.
        // Re-parsing the whole repo to heal an index would throw away the exact saving the
        // cache exists for, on the path that repeats most — this one re-fires on every branch
        // switch for the life of the session (change: optimize-hash-keyed-analyze).
        [cli, 'analyze', '--reanalyze', '--no-embed', '--output', this.outputPath],
        // windowsHide: this path re-fires on every branch switch and coalesces retries —
        // without windowsHide it flashes a new console window each time on Windows.
        { cwd: this.rootPath, stdio: 'ignore', detached: true, windowsHide: true }
      );
      this.rebuildChildren.add(child);
      child.once('close', (code) => {
        this.rebuildChildren.delete(child);
        if (code === 0) invalidateVectorIndexCaches(this.outputPath);
      });
      child.on('error', (err) => {
        this.graphRebuildRunning = false;
        process.stderr.write(`[mcp-watcher] background graph rebuild failed to start (${err.message}) — run "openlore analyze".\n`);
      });
      child.on('exit', () => {
        this.graphRebuildRunning = false;
        if (!this.stopping && this.graphRebuildPending) { this.graphRebuildPending = false; this.spawnGraphRebuild(reason); }
      });
      child.unref();
      process.stderr.write(`[mcp-watcher] background "openlore analyze --reanalyze" started (${reason}); the graph will refresh shortly.\n`);
    } catch (err) {
      this.graphRebuildRunning = false;
      process.stderr.write(`[mcp-watcher] background graph rebuild could not be spawned (${(err as Error).message}) — run "openlore analyze".\n`);
    }
  }

  // ── llm-context load + persistence + read-cache handoff (Step 2) ─────────────

  /**
   * True when this watcher writes to the canonical `<root>/.openlore/analysis`
   * layout that the MCP read handlers cache against. Only then is the shared
   * in-memory read cache (primeContextCache) the right channel to prime; a custom
   * `outputPath` (tests / non-standard installs) writes only to disk.
   */
  private get usesStandardLayout(): boolean {
    return this.outputPath === join(this.rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  }

  /**
   * Load the context the watcher is about to patch. This ALWAYS reads fresh from
   * disk — never through the shared read cache — because the cache is a read-path
   * (tool-call) optimization, and patching a possibly-stale cached object could
   * silently drop signatures written by a concurrent `analyze` between events.
   * The writer reads ground truth; persistContext then primes the read cache with
   * the result so the next tool call is still a hit (Step 2a, G1).
   */
  private async loadContext(): Promise<CachedContext | null> {
    try {
      const raw = await readFile(this.contextPath, 'utf-8');
      return JSON.parse(raw) as CachedContext;
    } catch {
      return null;
    }
  }

  private async persistContext(context: CachedContext): Promise<void> {
    // Strip the runtime-only EdgeStore handle before serializing.
    const { edgeStore: _edgeStore, ...serializable } = context as CachedContext & { edgeStore?: unknown };
    void _edgeStore;
    // Atomic write (temp + rename via atomicWriteFile) so a crash mid-write never tears
    // llm-context.json and a concurrent reader never sees a truncated file (change:
    // harden-artifact-write-atomicity). Set-level serialization against a full analyze is
    // owned by the caller's analysis lock — persist itself stays lock-free (it runs inside a
    // lane that already holds the lock, so it must never re-acquire it).
    await atomicWriteFile(this.contextPath, JSON.stringify(serializable, null, 2));
    // NOT rewritten here: the precomputed reachability structure
    // (change: optimize-reachability-precompute). This lane patches `signatures`
    // (and, on delete, prunes them) — nothing in this watcher ever assigns
    // `context.callGraph`, so the structure it would rebuild is bit-for-bit the one
    // already on disk. Measured, rebuilding + reserializing it here cost +40-53% on
    // a flush of this repo, and ~1.3-7.6 s of synchronous, event-loop-blocking CPU
    // at 200k-600k nodes — while holding the analysis lock, to produce a file this
    // process then discards.
    //
    // INVARIANT, now load-bearing (change: shrink-traversal-index-invalidation-scope):
    // the persisted structure is keyed to `context.graphDigest` — a digest of the
    // GRAPH, not the artifact bytes — and this write round-trips the parsed context, so
    // `graphDigest` is carried through unchanged. A signature-only flush therefore
    // leaves the structure valid: a later COLD read loads it rather than rebuilding.
    // That is only sound because this lane never changes the graph. Any future watcher
    // path that assigns `context.callGraph` MUST recompute `graphDigest` in the same
    // write, or a stale structure would be served for the new graph; a source-scan
    // guard (`traversal-graph-digest-guard.test.ts`) fails CI if one does not.
    // Hand the patched object back to the read cache, aligned to the new on-disk
    // mtime, so the next tool call is a cache hit (no cold re-parse). This is the
    // fix for root-cause item 2 (mtime bump forcing a full re-read). Only valid
    // for the canonical layout the read handlers cache against.
    if (this.usesStandardLayout) await primeContextCache(this.rootPath, context);
  }

  // ── Embedding lane (Step 4) ──────────────────────────────────────────────────

  private scheduleEmbed(context: CachedContext, changedFiles: ChangedFile[], nodes: FunctionNode[]): void {
    if (this.stopping) return;
    for (const f of changedFiles) this.embedFiles.set(f.rel, f.content);
    for (const node of nodes) this.embedNodes.set(node.id, node);
    this.lastEmbedContext = context;
    if (this.embedTimer) clearTimeout(this.embedTimer);
    // Slightly behind the signature debounce so structural freshness always lands
    // first and multiple flushes batch into one embed pass.
    this.embedTimer = this.armTimer(() => void this.runEmbedLane(), this.debounceMs);
  }

  private async runEmbedLane(): Promise<void> {
    if (this.embedRunning) {
      // Re-arm: drain again once the in-flight pass finishes.
      this.embedTimer = this.armTimer(() => void this.runEmbedLane(), this.debounceMs);
      return;
    }
    if (this.embedFiles.size === 0 || !this.lastEmbedContext) {
      if (this.embedFiles.size === 0) this.lastEmbedContext = undefined;
      return;
    }
    const changedFiles: ChangedFile[] = Array.from(this.embedFiles, ([rel, content]) => ({ rel, content }));
    const nodes = Array.from(this.embedNodes.values());
    const context = this.lastEmbedContext;
    this.lastEmbedContext = undefined;
    this.embedFiles.clear();
    this.embedNodes.clear();
    this.embedRunning = true;
    const operation = (async () => {
      try {
        await this.updateVectors(context, changedFiles, nodes);
      } catch (err) {
        process.stderr.write(`[mcp-watcher] embed error: ${(err as Error).message}\n`);
      }
    })();
    this.embedPromise = operation;
    try {
      await operation;
    } finally {
      if (this.embedPromise === operation) this.embedPromise = undefined;
      this.embedRunning = false;
      if (!this.stopping && this.embedFiles.size > 0) {
        this.embedTimer = this.armTimer(() => void this.runEmbedLane(), this.debounceMs);
      }
    }
  }

  /**
   * Row-level vector update for the changed files only (Step 3). Falls back to a
   * silent no-op when no embedding service and no index are available.
   */
  private async updateVectors(context: CachedContext, changedFiles: ChangedFile[], changedNodes: FunctionNode[]): Promise<void> {
    try {
      const { VectorIndex } = await import('../analyzer/vector-index.js');
      const { resolveEmbedder } = await import('../analyzer/embedder.js');
      const { readOpenLoreConfig } = await import('./config-manager.js');

      if (!VectorIndex.exists(this.outputPath)) return;

      // Same resolution path as analyze/query so watch keeps the configured
      // provider (env remote → local → remote config). embedSvc may be null:
      // updateFiles then refreshes the BM25-only corpus rather than re-embedding,
      // keeping the keyword index live in watch mode.
      const cfg = await readOpenLoreConfig(this.rootPath);
      const embedSvc = await resolveEmbedder(cfg);

      const cg = context.callGraph;
      if (!cg) return;
      const hubIds = new Set((cg.hubFunctions ?? []).map((f) => f.id));
      const entryIds = new Set((cg.entryPoints ?? []).map((f) => f.id));
      const changedFilePaths = new Set(changedFiles.map((f) => f.rel));
      const fileContents = new Map(changedFiles.map((f) => [f.rel, f.content]));
      // Prefer the freshly-parsed nodes; fall back to the (possibly stale)
      // call-graph nodes for the changed files when no edge store seeded them.
      const nodes = changedNodes.length > 0
        ? changedNodes
        : (cg.nodes ?? []).filter((n) => changedFilePaths.has(n.filePath));

      const { embedded, reused, total, hasEmbeddings, deferred } = await VectorIndex.updateFiles(
        this.outputPath,
        nodes,
        changedFilePaths,
        context.signatures ?? [],
        hubIds,
        entryIds,
        embedSvc,
        fileContents,
      );

      if (deferred === 'model-changed') {
        // Honest signal, not a silent no-op: the embedding model changed, so the
        // incremental vector update was refused to avoid mixing dimensions. The
        // changed files' vectors are stale until a full rebuild. Surfaced even
        // without --debug because it needs user action.
        process.stderr.write(
          `[mcp-watcher] embedding model changed — vector update deferred for ${changedFilePaths.size} file(s); run "openlore analyze --force" (or "openlore embed --local") to rebuild the semantic index\n`
        );
      } else if (deferred === 'tokenizer-changed') {
        // Honest signal: the keyword tokenizer changed, so the incremental patch
        // was refused to avoid mixing token sets. Search still serves correct
        // results (the corpus is re-tokenized from raw text each process), but the
        // on-disk index is not re-stamped until a full rebuild. Surfaced without
        // --debug because it needs user action.
        process.stderr.write(
          `[mcp-watcher] keyword tokenizer changed — index update deferred for ${changedFilePaths.size} file(s); run "openlore analyze --force" to rebuild the keyword index\n`
        );
      } else if (this.debug) {
        process.stderr.write(
          hasEmbeddings
            ? `[mcp-watcher] re-embedded ${changedFilePaths.size} file(s): ${embedded} new, ${reused} reused\n`
            : `[mcp-watcher] refreshed BM25 index for ${changedFilePaths.size} file(s): ${total} functions\n`
        );
      }
    } catch (err) {
      process.stderr.write(`[mcp-watcher] embed error: ${(err as Error).message}\n`);
    }
  }

  /**
   * Row-level literal-text line update for the changed files. No-op when the
   * text-line index has not been built. Never throws into the batch loop.
   */
  private async updateTextLines(changedFiles: ChangedFile[]): Promise<void> {
    try {
      const { TextLineIndex } = await import('../analyzer/text-line-index.js');
      if (!TextLineIndex.exists(this.outputPath)) return;
      const changed = changedFiles.map((f) => ({ filePath: f.rel, content: f.content }));
      await TextLineIndex.updateFiles(this.outputPath, changed);
      if (this.debug) {
        process.stderr.write(`[mcp-watcher] text-line index: updated ${changed.length} file(s)\n`);
      }
    } catch (err) {
      process.stderr.write(`[mcp-watcher] text-line error: ${(err as Error).message}\n`);
    }
  }

  /**
   * Incrementally patch dependency-graph.json's file→file import edges for the
   * changed files. `get_file_dependencies` reads that static artifact, so without
   * this an import edit goes stale until a full `analyze`. O(change): re-resolve
   * each changed file's imports (reusing the builder's `computeFileImportEdges`,
   * so resolution can't drift), replace that file's import edges, and recompute
   * in/out-degree. HTTP- and call-graph-synthesized edges are preserved (the
   * watcher does not rebuild them). Global metrics (pageRank, betweenness,
   * clusters) are O(graph) and deliberately left to the next full `analyze`.
   * No-op when no dependency graph exists. Never throws into the batch loop.
   */
  private async snapshotVerdictFiles(paths: readonly string[]): Promise<Map<string, string> | null> {
    const files = [...new Set(paths)].sort();
    if (files.length > MAX_EDIT_VERDICT_BASIS_FILES) return null;
    const hashes = new Map<string, string>();
    let totalBytes = 0;
    for (const file of files) {
      try {
        const content = await readFileConfined(this.rootPath, file, MAX_EDIT_VERDICT_BASIS_FILE_BYTES);
        totalBytes += Buffer.byteLength(content);
        if (totalBytes > MAX_EDIT_VERDICT_BASIS_TOTAL_BYTES) return null;
        hashes.set(file, createHash('sha256').update(content).digest('hex'));
      } catch {
        return null;
      }
    }
    return hashes;
  }

  private async buildVerdictBasis(
    input: GraphVerdictInput,
    importBreakages: readonly ImportBreakageSite[],
  ): Promise<Array<{ file: string; contentHash: string }> | null> {
    const snapshots = new Map(input.basisSnapshots ?? []);
    snapshots.set(input.file, input.contentHash);
    const importHashes = await this.snapshotVerdictFiles(importBreakages.map(site => site.importerFile));
    if (!importHashes) return null;
    for (const [file, hash] of importHashes) snapshots.set(file, hash);
    const required = new Set<string>([input.file]);
    for (const site of input.oldIncoming) {
      if (input.recomputedCallerFiles.has(site.callerFile)) required.add(site.callerFile);
    }
    for (const site of input.postIncoming) {
      if (!input.staleFiles.includes(site.callerFile)) required.add(site.callerFile);
    }
    for (const site of importBreakages) required.add(site.importerFile);
    for (const test of input.reachingTests) for (const file of test.basisFiles ?? [test.file]) required.add(file);
    // Every snapshot was captured while deriving a graph fact (including barrel
    // resolution and intermediate reaching-test nodes), so it is mandatory.
    for (const file of snapshots.keys()) required.add(file);
    if (required.size > MAX_EDIT_VERDICT_BASIS_FILES || [...required].some(file => !snapshots.has(file))) return null;
    return [...required].sort().map(file => ({ file, contentHash: snapshots.get(file)! }));
  }

  private async updateDependencyGraph(changedFiles: ChangedFile[]): Promise<Map<string, ImportBreakageSite[]>> {
    const graphPath = join(this.outputPath, ARTIFACT_DEPENDENCY_GRAPH);
    const breakages = new Map<string, ImportBreakageSite[]>();
    try {
      let raw: string;
      try {
        raw = await readFile(graphPath, 'utf-8');
      } catch {
        return breakages; // no dependency graph yet — nothing to keep fresh
      }
      // Narrow view for the fields we touch. We MUTATE the parsed object in place
      // and re-serialize it, so untyped node fields not modeled here (file,
      // exports, cluster, metrics.pageRank/betweenness) survive the round-trip.
      const graph = JSON.parse(raw) as {
        nodes: Array<{ id: string; file?: { path: string; absolutePath: string }; exports?: unknown[]; metrics?: Record<string, number> }>;
        edges: Array<{ source: string; target: string; httpEdge?: unknown; isCallEdge?: boolean }>;
      };
      if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return breakages;

      const { ImportExportParser } = await import('../analyzer/import-parser.js');
      const { computeFileImportEdges } = await import('../analyzer/dependency-graph.js');
      type ExportFact = { name?: unknown; isDefault?: unknown; isReExport?: unknown };
      type ImportEdge = { source: string; target: string; importedSourceNames?: unknown; httpEdge?: unknown; isCallEdge?: boolean };
      const fileSet = new Set(graph.nodes.map((n) => n.id)); // absolute paths
      const canonicalRoot = await realpath(this.rootPath).catch(() => this.rootPath);
      // Preserve the identity convention already used by the artifact. Full
      // analysis uses canonical IDs, while older/hand-seeded graphs may use the
      // watcher's lexical root. Mixing the two retains stale edges and creates
      // duplicate nodes.
      const usesLexicalIds = graph.nodes.some((node) => {
        const rel = relative(this.rootPath, node.id);
        return rel === '' || (!rel.startsWith('/') && !rel.startsWith('\\') &&
          !/^[A-Za-z]:[\\/]/.test(rel) && rel !== '..' && !rel.split(/[\\/]/).includes('..'));
      });
      const artifactRoot = usesLexicalIds ? this.rootPath : canonicalRoot;
      const relativePathById = new Map(
        graph.nodes
          .filter((node): node is typeof node & { file: { path: string; absolutePath: string } } =>
            typeof node.file?.path === 'string')
          .map(node => [node.id, node.file.path]),
      );
      const absolutePathByRel = new Map<string, string>();
      const parser = new ImportExportParser();
      let changed = false;
      const oldExports = new Map<string, Set<string>>();
      const newExports = new Map<string, Set<string>>();
      const unresolvedStarExports = new Set<string>();

      for (const f of changedFiles) {
        // Full analysis canonicalizes its root. Reuse that artifact identity
        // when the watcher was opened through a symlink alias, or a lexical
        // duplicate node would be inserted and exact target joins would fail.
        const existingNode = graph.nodes.find(node => node.file?.path === f.rel) ??
          graph.nodes.find(node => node.id === join(artifactRoot, f.rel));
        const abs = existingNode?.id ?? join(artifactRoot, f.rel);
        absolutePathByRel.set(f.rel, abs);
        let analysis;
        try {
          analysis = parser.parseContent(abs, f.content);
        } catch {
          continue;
        }
        if (!fileSet.has(abs)) {
          // New file (watch 'add'): create a node so its OUTGOING imports are
          // tracked. Added AFTER a successful parse so a parse failure can't leave
          // a bogus edgeless node. Incoming edges (importers of this file) refresh
          // when those importers are next touched, or on the next full analyze.
          graph.nodes.push({ id: abs, file: { path: f.rel, absolutePath: abs }, exports: [], metrics: { inDegree: 0, outDegree: 0 } });
          fileSet.add(abs);
        }
        const node = existingNode ?? graph.nodes.find(n => n.id === abs);
        const old = new Set(
          ((node?.exports ?? []) as ExportFact[])
            .filter(e => typeof e.name === 'string' && e.name !== '*' && e.isDefault !== true)
            .map(e => e.name as string),
        );
        const fresh = new Set(
          analysis.exports
            .filter(e => e.name !== '*' && !e.isDefault)
            .map(e => e.name),
        );
        if (detectLanguage(f.rel) === 'Python') {
          for (const imported of analysis.imports) {
            if (!imported.isTopLevel) continue;
            if (imported.importedNames.includes('*')) unresolvedStarExports.add(f.rel);
            else for (const name of imported.importedNames) if (!name.startsWith('_')) fresh.add(name);
          }
        }
        if (analysis.exports.some(e => e.name === '*' && e.isReExport)) unresolvedStarExports.add(f.rel);
        oldExports.set(f.rel, old);
        newExports.set(f.rel, fresh);
        if (node) node.exports = analysis.exports;
        const newEdges = await computeFileImportEdges(abs, analysis, fileSet, artifactRoot);
        // Drop this file's previous IMPORT edges (keep HTTP / call-synthesized
        // edges, which the watcher does not rebuild), then splice in the fresh set.
        graph.edges = graph.edges.filter(
          (e) => e.source !== abs || e.httpEdge !== undefined || e.isCallEdge === true,
        );
        graph.edges.push(...(newEdges as typeof graph.edges));
        changed = true;
      }
      if (!changed) return breakages;

      // Inspect the fully-patched batch, not each source independently. If a
      // consumer removed or renamed its import in the same debounce, its fresh
      // edge is absent and no transient finding survives.
      const removedByTarget = new Map<string, { rel: string; names: Set<string> }>();
      for (const f of changedFiles) {
        if (unresolvedStarExports.has(f.rel)) continue;
        const names = new Set([...oldExports.get(f.rel) ?? []].filter(name => !newExports.get(f.rel)?.has(name)));
        const target = absolutePathByRel.get(f.rel);
        if (target && names.size > 0) removedByTarget.set(target, { rel: f.rel, names });
      }
      for (const edge of graph.edges as ImportEdge[]) {
        const removed = removedByTarget.get(edge.target);
        if (!removed || edge.source === edge.target || edge.httpEdge !== undefined || edge.isCallEdge === true ||
            !Array.isArray(edge.importedSourceNames)) continue;
        const importerFile = relativePathById.get(edge.source) ?? relative(artifactRoot, edge.source);
        if (importerFile.startsWith('/') || importerFile.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(importerFile) ||
            importerFile === '..' || importerFile.split(/[\\/]/).includes('..')) continue;
        const sites = breakages.get(removed.rel) ?? [];
        for (const name of edge.importedSourceNames) {
          if (typeof name === 'string' && name !== '*' && name !== 'default' && removed.names.has(name)) {
            sites.push({ importerFile, importedName: name });
          }
        }
        if (sites.length > 0) breakages.set(removed.rel, sites);
      }

      // Recompute file-level in/out degree from the patched edge set (cheap).
      const out = new Map<string, Set<string>>();
      const inn = new Map<string, Set<string>>();
      for (const n of graph.nodes) {
        out.set(n.id, new Set());
        inn.set(n.id, new Set());
      }
      for (const e of graph.edges) {
        out.get(e.source)?.add(e.target);
        inn.get(e.target)?.add(e.source);
      }
      for (const n of graph.nodes) {
        if (!n.metrics) n.metrics = {};
        n.metrics.outDegree = out.get(n.id)?.size ?? 0;
        n.metrics.inDegree = inn.get(n.id)?.size ?? 0;
      }

      // Atomic write (temp + rename via the shared atomicWriteFile) so a concurrent MCP
      // read never sees a torn JSON — matching the watcher's "readers never see a torn
      // graph" invariant (change: harden-artifact-write-atomicity — one atomic-write home).
      await atomicWriteFile(graphPath, JSON.stringify(graph));
      if (this.debug) {
        process.stderr.write(
          `[mcp-watcher] dependency graph: patched import edges for ${changedFiles.length} file(s)\n`,
        );
      }
    } catch (err) {
      process.stderr.write(`[mcp-watcher] dependency-graph error: ${(err as Error).message}\n`);
    }
    return breakages;
  }

  /**
   * Keep style-fingerprint.json live for the changed (and deleted) files (change:
   * add-codebase-style-fingerprint). Re-tally each changed file's idioms with the same extractor
   * the full build uses; splice it into the persisted raw per-file counters; drop deleted/now-
   * unsupported files; then re-roll-up byLanguage + per-file + regions, reusing the STORED
   * file→region map (communities are O(graph), refreshed on the next full analyze — a brand-new
   * file is simply unattributed to a region until then). Best-effort + atomic; never throws into
   * the batch. No-op when no fingerprint exists yet (a full analyze creates it).
   */
  private async updateStyleFingerprint(changedFiles: ChangedFile[], deletedRels: string[] = []): Promise<void> {
    const fpPath = join(this.outputPath, ARTIFACT_STYLE_FINGERPRINT);
    try {
      const raw = await readFile(fpPath, 'utf-8').catch(() => null);
      if (!raw) return; // no fingerprint yet — next full analyze will create it
      const fp = JSON.parse(raw) as StyleFingerprint;
      if (!Array.isArray(fp.files)) return;

      const byPath = new Map<string, FileStyleRaw>(fp.files.map(f => [f.filePath, f]));
      let touched = false;

      for (const rel of deletedRels) {
        if (byPath.delete(rel)) touched = true;
      }
      for (const f of changedFiles) {
        const language = detectLanguage(f.rel);
        const style = await extractFileStyle({ path: f.rel, content: f.content, language });
        // A supported-but-empty edit still yields a defined (empty-counter) style, matching a full
        // analyze — so this drop branch only fires if extractFileStyle returns undefined, i.e. an
        // unsupported language (extension-keyed, so rare for an in-place edit). Defensive, not hot.
        if (style) { byPath.set(f.rel, style); touched = true; }
        else if (byPath.delete(f.rel)) touched = true;
      }
      if (!touched) return;

      // Reconstruct region labels from the existing regions so re-roll-up keeps them.
      const labels: Record<string, string> = {};
      for (const r of fp.regions ?? []) if (r.label) labels[r.communityId] = r.label;

      const updated = assembleFromRegions([...byPath.values()], fp.fileRegions ?? {}, labels, fp.evidenceFloor);
      await atomicWriteFile(fpPath, JSON.stringify(updated, null, 2));
      if (this.debug) {
        process.stderr.write(`[mcp-watcher] style fingerprint: refreshed ${changedFiles.length} changed / ${deletedRels.length} deleted\n`);
      }
    } catch (err) {
      process.stderr.write(`[mcp-watcher] style-fingerprint error: ${(err as Error).message}\n`);
    }
  }

  /**
   * Keep parse-health.json live for the changed (and deleted) files (change:
   * add-parse-health-boundary-disclosure). Unlike the style fingerprint (which every supported repo
   * has), this artifact is ABSENT on a clean repo — so this lane must be able to CREATE it when a
   * changed file newly degrades, and DELETE it when the last degraded file is repaired or removed.
   * Re-tally each changed file with the same dispatch the full build uses; a changed file that is
   * now clean drops its entry. Best-effort + atomic; never throws into the batch.
   */
  private async updateParseHealth(changedFiles: ChangedFile[], deletedRels: string[] = []): Promise<void> {
    const phPath = join(this.outputPath, ARTIFACT_PARSE_HEALTH);
    try {
      // Start from the existing report if present, else an empty set (a clean repo has no artifact).
      const raw = await readFile(phPath, 'utf-8').catch(() => null);
      const existing = raw ? (JSON.parse(raw) as ParseHealthReport) : null;
      const byPath = new Map<string, FileParseHealth>(
        Array.isArray(existing?.files) ? existing!.files.map(f => [f.filePath, f]) : [],
      );
      const containerFiles = new Map<string, ScriptContainerFileRecord>(
        (existing?.scriptContainers ?? [])
          .flatMap(boundary => boundary.files ?? [])
          .map(file => [file.filePath, file]),
      );
      let touched = false;

      for (const rel of deletedRels) {
        if (byPath.delete(rel)) touched = true;
        if (containerFiles.delete(rel)) touched = true;
      }
      for (const f of changedFiles) {
        const language = detectLanguage(f.rel);
        const container = extractScriptContainer(f.rel, f.content);
        if (container) {
          containerFiles.set(f.rel, {
            filePath: f.rel,
            format: container.format,
            scriptBlockCount: container.scriptBlockCount,
            extractedScriptBlockCount: container.extractedScriptBlockCount,
          });
          touched = true;
        } else if (containerFiles.delete(f.rel)) {
          touched = true;
        }
        let health: FileParseHealth | undefined;
        try {
          // The watcher sees already-decoded content, so it maintains the tree-derived signals
          // (ERROR/MISSING, parse failure); the byte-level encoding-fallback signal is recomputed at
          // the next full analyze. A prior encoding-fallback flag on this file is preserved.
          health = await extractFileParseHealth({ path: f.rel, content: f.content, language });
        } catch (err) {
          // Classify the same way the full build does, off the same message marker, so the record
          // this splices into `parse-health.json` is indistinguishable from the one a full analyze
          // would have written for the same file (change:
          // fix-analyze-native-abort-and-file-cost-budget). Two producers, one vocabulary.
          const overrunBudgetMs = parseBudgetOverrunMs((err as Error | undefined)?.message);
          health = {
            filePath: f.rel, language, errorCount: 0, missingCount: 0, errorLines: [],
            parseFailed: true,
            exclusion: overrunBudgetMs !== undefined ? 'budget-exceeded' : 'parse-failure',
            ...(overrunBudgetMs !== undefined ? { budgetMs: overrunBudgetMs } : {}),
          };
        }
        const priorEncoding = byPath.get(f.rel)?.encodingFallback;
        // A size-capped HTML file is EXCLUDED before extraction, so `extractFileParseHealth`
        // returns nothing for it and the delete below would silently clear the exclusion the full
        // build recorded — `doctor` would then bless a repository the next `analyze` excludes a
        // file from again. The watcher applies the same bound rather than assuming the file became
        // healthy (change: fix-analyze-native-abort-and-file-cost-budget).
        if (/\.html?$/i.test(f.rel) && f.content.length > MAX_HTML_INLINE_SCRIPT_CHARS) {
          byPath.set(f.rel, {
            filePath: f.rel, language, errorCount: 0, missingCount: 0, errorLines: [],
            exclusion: 'size-cap',
          });
          touched = true;
          continue;
        }
        if (container?.sizeCapped) {
          byPath.set(f.rel, {
            filePath: f.rel, language, errorCount: 0, missingCount: 0, errorLines: [],
            exclusion: 'size-cap',
          });
          touched = true;
          continue;
        }
        if (health && priorEncoding) health.encodingFallback = true;
        if (health) { health.language = language; byPath.set(f.rel, health); touched = true; }
        else if (priorEncoding) { byPath.set(f.rel, { filePath: f.rel, language, errorCount: 0, missingCount: 0, errorLines: [], encodingFallback: true }); touched = true; }
        else if (byPath.delete(f.rel)) touched = true;
      }
      if (!touched) return;

      // Carry the last full analyze's memory-degradation disclosure forward (change:
      // make-analyze-scale-to-any-repo). The overlay is shed in the persisted graph until the next
      // full analyze, and the watcher — which only re-tallies per-file parse health — cannot
      // re-derive a whole-repo memory-pressure decision. Dropping it here would erase the
      // "coverage is a LOWER BOUND" signal on the first incremental update, so a shed overlay would
      // read as genuine structural absence. Preserving `existing.memoryDegradation` is the only
      // correct behavior; it also keeps `buildParseHealthReport` from returning undefined (and
      // unlinking the artifact) when the last per-file record is repaired but the degradation stands.
      const report = buildParseHealthReport(
        [...byPath.values()],
        undefined,
        existing?.memoryDegradation,
        existing?.grammarUnavailable,
        summarizeScriptContainers([...containerFiles.values()]),
      );
      if (!report) {
        // The repo is now clean AND no degradation stands — remove the stale artifact.
        if (raw !== null) await unlink(phPath).catch(() => {});
        return;
      }
      await atomicWriteFile(phPath, JSON.stringify(report, null, 2));
      if (this.debug) {
        process.stderr.write(`[mcp-watcher] parse health: refreshed ${changedFiles.length} changed / ${deletedRels.length} deleted\n`);
      }
    } catch (err) {
      process.stderr.write(`[mcp-watcher] parse-health error: ${(err as Error).message}\n`);
    }
  }

  /**
   * Reconcile file DELETIONS across every lane so a removed file leaves no
   * phantom state: call-graph nodes/edges (incoming and outgoing), signatures,
   * text-line rows, vector rows, and dependency-graph node + edges. Best-effort;
   * a failure in one lane does not block the others.
   */
  private async handleDeletions(absPaths: string[], recordSpecChanges = true): Promise<void> {
    if (recordSpecChanges) await this.recordSpecIndexChanges(absPaths);
    // Deletion is idempotent removal, so no need to filter — each lane no-ops for
    // a path it never indexed. (Watch-ignored paths like *.test.ts never reach
    // here anyway: chokidar prunes them, so no unlink fires.)
    const rels = absPaths.map((abs) => toRepositoryPath(relative(this.rootPath, abs)));
    if (rels.length === 0) return;
    const releaseAnalysis = await acquireAnalysisLock(this.outputPath);
    try {

    // 1. Call-graph store — deleteEdgesForFile removes edges where the file is
    //    caller OR callee, so incoming edges don't dangle.
    if (EdgeStore.exists(this.outputPath)) {
      const store = EdgeStore.open(EdgeStore.dbPath(this.outputPath));
      try {
        // Not-ready guard: never mutate a schema-mismatched or quarantined store —
        // a full `analyze` rebuild subsumes these deletions (change:
        // harden-index-store-lifecycle).
        if (store.notReady) {
          this.scheduleBackgroundRebuild();
          return;
        }
        store.transaction(() => {
          for (const rel of rels) {
            store.deleteEdgesForFile(rel);
            store.deleteNodesForFile(rel);
            store.deleteCfgForFile(rel);
            store.deleteClassesForFile(rel);
          }
          const survivingClassIds = new Set(store.getAllClasses().map(cls => cls.id));
          store.replaceInheritanceEdges(store.getAllInheritanceEdges().filter(edge =>
            survivingClassIds.has(edge.parentId) && survivingClassIds.has(edge.childId)));
          store.deleteOrphanExternalNodes();
          store.refreshExternalClasses();
          store.recomputeStructuralMetrics();
          // A deleted file leaves no topology to be stale about — drop any stale
          // mark so the region doesn't accumulate phantom rows for gone files
          // (fix-transitive-incremental-staleness).
          store.clearFilesStale(rels);
        });
        // A deletion is the most likely trigger for a false `degraded` — keep the
        // attestation's counts current with the shrunken store (change:
        // add-index-integrity-attestation). Best-effort; never blocks the watch path.
        // Skipped on a not-ready store (a schema-mismatched/quarantined index is
        // rebuilt by analyze, not patched here).
        if (!store.notReady) {
          await refreshAttestationCounts(this.outputPath, store).catch(() => {});
        }
      } catch (err) {
        if (isSqliteBusyError(err)) throw err;
        process.stderr.write(`[mcp-watcher] delete (graph) error: ${(err as Error).message}\n`);
      } finally {
        store.close();
      }
    }

    // Steps 2–7 mutate the JSON artifact set (and the vector index) for the deleted
    // files. They run under the analysis lock so this deletion reconciliation cannot
    // interleave its set with a concurrent full `analyze` writing the same directory
    // (change: harden-artifact-write-atomicity). The vector delete (step 4) is kept
    // inside the section rather than reordered — deletions are infrequent, and holding
    // the lock briefly is cheaper than risking a reorder.
      // 2. Signatures in llm-context.json.
      const context = await this.loadContext();
      if (context?.signatures) {
        const relSet = new Set(rels);
        const kept = context.signatures.filter((m) => !relSet.has(m.path));
        if (kept.length !== context.signatures.length) {
          context.signatures = kept;
          await this.persistContext(context);
        }
      }

      // 3. Text-line index — drop the deleted files' lines.
      try {
        const { TextLineIndex } = await import('../analyzer/text-line-index.js');
        if (TextLineIndex.exists(this.outputPath)) {
          await TextLineIndex.updateFiles(this.outputPath, [], rels);
        }
      } catch (err) {
        process.stderr.write(`[mcp-watcher] delete (text) error: ${(err as Error).message}\n`);
      }

      // 4. Vector index — delete the deleted files' rows (no nodes to add).
      try {
        const { VectorIndex } = await import('../analyzer/vector-index.js');
        if (VectorIndex.exists(this.outputPath)) {
          await VectorIndex.updateFiles(
            this.outputPath, [], new Set(rels), context?.signatures ?? [],
            new Set(), new Set(), undefined,
          );
        }
      } catch (err) {
        process.stderr.write(`[mcp-watcher] delete (vector) error: ${(err as Error).message}\n`);
      }

      // 5. Dependency graph — remove the deleted nodes and every edge touching them.
      await this.removeFromDependencyGraph(absPaths);

      // 6. Style fingerprint — drop the deleted files' counters and re-roll-up.
      await this.updateStyleFingerprint([], rels);

      // 7. Parse health — drop the deleted files' degradation records and re-roll-up.
      await this.updateParseHealth([], rels);
      await this.republishGeneration();
    } finally {
      await releaseAnalysis();
    }

    if (this.debug) {
      process.stderr.write(`[mcp-watcher] reconciled ${rels.length} deletion(s)\n`);
    }

    // Deletions change the same authoritative repository snapshot as edits and
    // additions. Hand them to the host's full-repair coordinator too: the
    // incremental delete removes dangling graph state immediately, while the
    // repair rebuild re-resolves surviving callers (for example, to an external
    // target) and refreshes whole-graph artifacts. A path rename arrives as an
    // unlink + add; the host debounce coalesces both receipts into one rebuild.
    try { this.onBatchFlushed?.(absPaths); } catch { /* host lane is best-effort */ }
  }

  /**
   * Republish the generation manifest at the commit point of an incremental write.
   *
   * The watcher rewrites the SAME required artifacts a full analyze publishes, so
   * leaving the manifest alone would keep the old generation id on new content: a
   * multi-artifact reader would then validate before/after against an identity that
   * never moved and label a mixed read `ok`, and every cache keyed on the
   * generation id would keep serving superseded structure. Always called inside the
   * artifact lock, after the whole write set is durable.
   */
  private async republishGeneration(): Promise<string | null> {
    try {
      const manifest = await publishGeneration(
        this.outputPath,
        [...REQUIRED_ANALYSIS_ARTIFACTS],
        { coherence: 'incremental' },
      );
      // An incomplete artifact set cannot be published. Drop the manifest rather
      // than leave one vouching for content it no longer describes — readers then
      // fall back to the disclosed legacy identity, which does track the rewrite.
      if (!manifest) {
        await discardGeneration(this.outputPath);
        return null;
      }
      return manifest.generationId;
    } catch (err) {
      process.stderr.write(`[mcp-watcher] generation republish error: ${(err as Error).message}\n`);
      return null;
    }
  }

  /**
   * Remove deleted files' nodes and any edge referencing them from
   * dependency-graph.json, recompute degrees, and persist atomically.
   */
  private async removeFromDependencyGraph(absPaths: string[]): Promise<void> {
    const graphPath = join(this.outputPath, ARTIFACT_DEPENDENCY_GRAPH);
    try {
      let raw: string;
      try {
        raw = await readFile(graphPath, 'utf-8');
      } catch {
        return;
      }
      const graph = JSON.parse(raw) as {
        nodes: Array<{ id: string; file?: { path?: string }; metrics?: Record<string, number> }>;
        edges: Array<{ source: string; target: string }>;
      };
      if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return;

      const removedPaths = new Set(absPaths.map(abs => toRepositoryPath(relative(this.rootPath, abs))));
      const removed = new Set(graph.nodes
        .filter(node => absPaths.includes(node.id) ||
          (typeof node.file?.path === 'string' && removedPaths.has(node.file.path)))
        .map(node => node.id));
      const nodesBefore = graph.nodes.length;
      graph.nodes = graph.nodes.filter((n) => !removed.has(n.id));
      const edgesBefore = graph.edges.length;
      graph.edges = graph.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
      if (graph.nodes.length === nodesBefore && graph.edges.length === edgesBefore) return;

      const out = new Map<string, Set<string>>();
      const inn = new Map<string, Set<string>>();
      for (const n of graph.nodes) { out.set(n.id, new Set()); inn.set(n.id, new Set()); }
      for (const e of graph.edges) { out.get(e.source)?.add(e.target); inn.get(e.target)?.add(e.source); }
      for (const n of graph.nodes) {
        if (!n.metrics) n.metrics = {};
        n.metrics.outDegree = out.get(n.id)?.size ?? 0;
        n.metrics.inDegree = inn.get(n.id)?.size ?? 0;
      }

      await atomicWriteFile(graphPath, JSON.stringify(graph));
    } catch (err) {
      process.stderr.write(`[mcp-watcher] delete (dep-graph) error: ${(err as Error).message}\n`);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Bounded count of watched source files; stops early once `cap` is exceeded. */
  private async countSourceFiles(cap: number): Promise<number> {
    let count = 0;
    const walk = async (dir: string): Promise<void> => {
      if (count > cap) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (count > cap) return;
        const abs = join(dir, entry.name);
        const rel = relative(this.rootPath, abs);
        if (entry.isDirectory()) {
          if (!isIgnoredRelPath(rel)) await walk(abs);
        } else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name) && !isIgnoredRelPath(rel)) {
          count++;
        }
      }
    };
    await walk(this.rootPath);
    return count;
  }
}

// ── Module helpers ──────────────────────────────────────────────────────────────
// isTestFile is the shared cross-language predicate (../analyzer/test-file.js).
// Incremental graph updates MUST classify tests identically to a full `analyze`,
// or the watcher would add test files (e.g. foo_test.go, tests/foo.py) that a
// full rebuild drops — leaving the incremental graph divergent from the rebuilt one.

/**
 * Re-parse changedFile + the given callerFiles (the closure the caller already
 * bounded by the work budget — fix-transitive-incremental-staleness). Returns
 * fresh edges (all files in the subset) and nodes (changedFile only — callerFiles
 * nodes are untouched since their function signatures didn't change).
 *
 * Exported for unit testing (locks the HTML-blanking node-refresh contract).
 */
export async function buildGraphSubset(
  changedRel: string,
  changedContent: string,
  callerFiles: string[],
  rootDir: string,
  resolutionNodes?: import('../analyzer/call-graph.js').FunctionNode[],
  resolutionClasses?: import('../analyzer/call-graph.js').ClassNode[],
): Promise<{
  edges: import('../analyzer/call-graph.js').CallEdge[];
  nodes: import('../analyzer/call-graph.js').FunctionNode[];
  cfgs: Array<{ functionId: string; filePath: string; cfg: import('../analyzer/cfg.js').FunctionCfg }>;
  classes: import('../analyzer/call-graph.js').ClassNode[];
  inheritanceEdges: import('../analyzer/call-graph.js').InheritanceEdge[];
  /**
   * callerFiles the caller asked to re-resolve but that could NOT be read
   * (permissions / transient I/O / a lock). The caller must NOT delete-and-empty
   * these — it preserves their edges and marks them stale instead, so an
   * unreadable file is never silently emptied-and-asserted-fresh
   * (fix-transitive-incremental-staleness).
   */
  skipped: string[];
  analyzedFileHashes: Map<string, string>;
}> {
  let lang = detectLanguage(changedRel);
  let content = changedContent;
  const scriptContainer = extractScriptContainer(changedRel, changedContent);
  if (scriptContainer) {
    lang = scriptContainer.format;
  }
  // HTML: blank everything outside inline <script> bodies (offset-preserving) so
  // the JS extractor parses the inline scripts at their true positions. Without
  // this, html is 'unknown' → empty result → the caller's atomic swap would
  // DELETE the page's inline-script nodes on every edit (regression).
  if (lang === 'unknown' && HTML_EXTENSIONS.test(changedRel)) {
    const { extractHtmlScripts } = await import('../analyzer/html-script-extractor.js');
    const blanked = extractHtmlScripts(changedContent);
    if (!blanked) return { edges: [], nodes: [], cfgs: [], classes: [], inheritanceEdges: [], skipped: [], analyzedFileHashes: new Map([[changedRel, createHash('sha256').update(changedContent).digest('hex')]]) }; // no inline JS
    content = blanked;
    lang = 'JavaScript';
  }
  if (!CALL_GRAPH_LANGS.has(lang)) return { edges: [], nodes: [], cfgs: [], classes: [], inheritanceEdges: [], skipped: [], analyzedFileHashes: new Map([[changedRel, createHash('sha256').update(changedContent).digest('hex')]]) };

  const { CallGraphBuilder } = await import('../analyzer/call-graph.js');
  // Use relative paths as node IDs (consistent with analyze output)
  const files: Array<{ path: string; content: string; language: string }> = [
    { path: changedRel, content, language: lang },
  ];
  const analyzedFileHashes = new Map<string, string>([
    [changedRel, createHash('sha256').update(changedContent).digest('hex')],
  ]);

  const skipped: string[] = [];
  for (const cf of callerFiles) {
    let cfLang = detectLanguage(cf);
    let cfContent: string;
    try {
      cfContent = await readFileConfined(rootDir, cf, MAX_EDIT_VERDICT_BASIS_FILE_BYTES);
    } catch {
      skipped.push(cf);
      continue;
    }
    const cfHash = createHash('sha256').update(cfContent).digest('hex');
    const callerContainer = extractScriptContainer(cf, cfContent);
    if (callerContainer) {
      cfLang = callerContainer.format;
    }
    if (!CALL_GRAPH_LANGS.has(cfLang)) continue; // ungraphable lang — never had edges; not stale
    files.push({ path: cf, content: cfContent, language: cfLang });
    analyzedFileHashes.set(cf, cfHash);
  }

  // HTTP topology has no import/call edge before the first client↔route match,
  // so the ordinary reverse-caller closure cannot discover the counterpart of
  // a newly added client or route. Bring a small, deterministic set of known
  // HTTP-capable files into this subset as resolution context. If the set is too
  // large, mark the omitted files stale so the existing self-healing rebuild
  // converges them rather than silently serving a partial topology.
  const HTTP_CONTEXT_CAP = 64;
  const HTTP_CONTEXT_SCAN_CAP = 1_024;
  const HTTP_CONTEXT_EXT = /\.(?:py|pyw|go|ts|tsx|js|jsx|mjs|cjs|java)$/i;
  const httpRoles = (path: string, source: string): { client: boolean; route: boolean } => {
    const ext = posix.extname(path).toLowerCase();
    const client = ext === '.go'
      ? /["`]net\/http["`]/.test(source)
      : ext === '.py' || ext === '.pyw'
        ? /\b(?:requests|httpx)\b/.test(source)
        : /\.(?:[cm]?[jt]sx?)$/.test(path)
          ? /\b(?:fetch|axios|ky|got)\b/.test(source)
          : false;
    const route = ext === '.py' || ext === '.pyw'
      ? /@[^\n]+\.(?:get|post|put|patch|delete|head|options|route)\s*\(|\b(?:path|re_path)\s*\(/i.test(source)
      : ext === '.java'
        ? /@(?:RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/.test(source)
        : /\.(?:[cm]?[jt]sx?)$/.test(path)
          ? /\.(?:get|post|put|patch|delete|head|options)\s*\(|@(?:Get|Post|Put|Patch|Delete)\s*\(/.test(source) ||
            /(?:^|\/)app\/.*\/route\.[jt]sx?$|(?:^|\/)pages\/api\//.test(path.replace(/\\/g, '/'))
          : false;
    return { client, route };
  };
  const changedHttpRoles = httpRoles(changedRel, changedContent);
  const needsHttpContext = changedHttpRoles.client || changedHttpRoles.route;
  const alreadyIncluded = new Set(files.map(file => file.path));
  const contextCandidates = needsHttpContext ? [...new Set((resolutionNodes ?? [])
    .map(node => node.filePath)
    .filter(path => HTTP_CONTEXT_EXT.test(path) && !alreadyIncluded.has(path)))]
    .sort() : [];
  const contextFiles: Array<{ path: string; content: string; language: string }> = [];
  for (const rel of contextCandidates.slice(0, HTTP_CONTEXT_SCAN_CAP)) {
    try {
      const contextContent = await readFileConfined(rootDir, rel, MAX_EDIT_VERDICT_BASIS_FILE_BYTES);
      const roles = httpRoles(rel, contextContent);
      const isCounterpart = (changedHttpRoles.client && roles.route) || (changedHttpRoles.route && roles.client);
      if (!isCounterpart) continue;
      if (contextFiles.length >= HTTP_CONTEXT_CAP) {
        skipped.push(rel);
        continue;
      }
      contextFiles.push({ path: rel, content: contextContent, language: detectLanguage(rel) });
      analyzedFileHashes.set(rel, createHash('sha256').update(contextContent).digest('hex'));
    } catch {
      skipped.push(rel);
    }
  }
  // Beyond the scan bound a relevant counterpart may exist. Mark only this
  // genuinely uninspected tail stale; the watcher schedules its existing
  // self-healing rebuild. Ordinary non-HTTP edits never enter this scan.
  skipped.push(...contextCandidates.slice(HTTP_CONTEXT_SCAN_CAP));

  // Re-export barrels a subset file imports through are neither the changed file nor a
  // caller of it, so they are absent from the subset — without them buildResolvedImportMap
  // cannot follow the chain and a barrel call degrades from `re_export`/`import` to
  // `name_only`, diverging from a full rebuild (change: add-call-resolution-recall). Pull
  // in just the barrel files (followed along the chain), for export-indexing only; their
  // own edges are filtered out below so nothing extra is persisted.
  const { collectReExportBarrels } = await import('../analyzer/import-resolver-bridge.js');
  const TS_MODULE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
  const readModule = async (
    spec: string,
    fromFile: string,
  ): Promise<{ path: string; content: string; language: string } | undefined> => {
    if (!spec.startsWith('.')) return undefined; // relative imports only
    const base = posix
      .normalize(posix.join(posix.dirname(fromFile), spec))
      .replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, '');
    const candidates = [
      ...TS_MODULE_EXTS.map((e) => base + e),
      ...TS_MODULE_EXTS.map((e) => `${base}/index${e}`),
    ];
    for (const rel of candidates) {
      try {
        const modContent = await readFileConfined(rootDir, rel, MAX_EDIT_VERDICT_BASIS_FILE_BYTES);
        analyzedFileHashes.set(rel, createHash('sha256').update(modContent).digest('hex'));
        return { path: rel, content: modContent, language: detectLanguage(rel) };
      } catch {
        // try next candidate
      }
    }
    return undefined;
  };
  const barrels = await collectReExportBarrels(files, readModule);
  const barrelPaths = new Set(barrels.map((b) => b.path));
  const buildInput = [...files, ...contextFiles, ...barrels];

  const builder = new CallGraphBuilder();
  const retainedClasses = resolutionClasses?.filter(cls => cls.filePath !== changedRel);
  const result = await builder.build(buildInput, undefined, undefined, resolutionNodes, retainedClasses);

  // Caller-file nodes are already in DB and unchanged. Barrel context files are
  // resolution-only. Newly synthesized external endpoints must be returned too,
  // or their foreign-keyed edges cannot be inserted after a deletion rebind.
  const primaryPaths = new Set(files.map(file => file.path));
  const resultEdges = result.edges.filter((edge) => {
    const callerFile = edge.callerId.slice(0, edge.callerId.indexOf('::'));
    if (barrelPaths.has(callerFile)) return false;
    if (primaryPaths.has(callerFile)) return true;
    if (edge.confidence !== 'http_endpoint') return false;
    return result.nodes.get(edge.calleeId)?.filePath === changedRel;
  });
  const persistedIds = new Set(resultEdges.flatMap(edge => [edge.callerId, edge.calleeId]));
  const changedNodes = Array.from(result.nodes.values()).filter((node) =>
    node.filePath === changedRel || (node.isExternal && persistedIds.has(node.id)));
  const changedClasses = result.classes.filter(cls => cls.filePath === changedRel);

  // CFG/def-use overlay (spec: add-intraprocedural-cfg-dataflow-overlay) for the
  // changed file's functions only — intra-procedural, so caller files' overlays
  // are unaffected by this edit.
  const cfgs: Array<{ functionId: string; filePath: string; cfg: import('../analyzer/cfg.js').FunctionCfg }> = [];
  if (result.cfgs) {
    for (const n of changedNodes) {
      const cfg = result.cfgs.get(n.id);
      if (cfg) cfgs.push({ functionId: n.id, filePath: changedRel, cfg });
    }
  }

  return {
    edges: resultEdges,
    nodes: changedNodes,
    cfgs,
    classes: changedClasses,
    inheritanceEdges: result.inheritanceEdges,
    skipped,
    analyzedFileHashes,
  };
}
