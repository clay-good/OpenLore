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

import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, posix } from 'node:path';
import { spawn } from 'node:child_process';
import chokidar, { type FSWatcher } from 'chokidar';
import { extractSignatures, detectLanguage } from '../analyzer/signature-extractor.js';
import type { FunctionNode } from '../analyzer/call-graph.js';
import { extractFileStyle } from '../analyzer/call-graph.js';
import { assembleFromRegions, type StyleFingerprint, type FileStyleRaw } from '../analyzer/style-fingerprint.js';
import { isTestFile } from '../analyzer/test-file.js';
import { EdgeStore } from './edge-store.js';
import { refreshAttestationCounts } from '../analyzer/index-attestation.js';
import { primeContextCache, type CachedContext } from './mcp-handlers/utils.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_STYLE_FINGERPRINT,
  WATCH_DEBOUNCE_MS,
  WATCH_MAX_BATCH_MS,
  WATCH_BULK_THRESHOLD,
  WATCH_EMBED_FILE_CEILING,
  WATCH_VCS_SETTLE_MS,
  INCREMENTAL_CLOSURE_BUDGET,
} from '../../constants.js';

// Languages the watcher incrementally re-graphs on edit. MUST include every
// graphable language whose extension is in SOURCE_EXTENSIONS, otherwise editing
// such a file makes buildGraphSubset return empty and the swap WIPES that file's
// nodes/edges/overlay until the next full analyze (a graph-coverage regression).
// C/C#/PHP/Kotlin grammars are optional deps: if absent, buildGraphSubset fails
// soft to empty and the file simply isn't re-graphed (same as full analyze).
const CALL_GRAPH_LANGS = new Set([
  'Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Ruby', 'Java', 'C++', 'Swift',
  'C', 'C#', 'PHP', 'Kotlin',
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpWatcherOptions {
  /** Absolute path to the project root being watched */
  rootPath: string;
  /** Absolute path to .openlore/analysis/ — where llm-context.json lives */
  outputPath?: string;
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
}

interface ChangedFile {
  rel: string;
  content: string;
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|php|cs|cpp|cc|cxx|h|hpp|c|swift)$/;
// HTML is watched too. detectLanguage() returns 'unknown' for it, so it takes a
// dedicated path: an edit refreshes the literal-text line index, the inline-
// <script> call-graph nodes (blanked → JavaScript in buildGraphSubset), and the
// dependency-graph asset edges (<script src>/<link rel=stylesheet>). Letting HTML
// into the call-graph loop REQUIRES the buildGraphSubset blanking — otherwise the
// atomic swap would delete a page's inline-script nodes on every edit.
const HTML_EXTENSIONS = /\.html?$/i;

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
  private readonly contextPath: string;
  private readonly debounceMs: number;
  private readonly maxBatchMs: number;
  private readonly bulkThreshold: number;
  private readonly embedFileCeiling: number;
  private readonly closureBudget: number;
  private readonly extraIgnore: string[];
  private readonly debug: boolean;
  private readonly onBatchFlushed?: (changedAbsPaths: string[]) => void;

  private fsWatcher?: FSWatcher;
  private gitWatcher?: FSWatcher;

  // ── Coalescing queue (Step 1) ──────────────────────────────────────────────
  private pending = new Set<string>();              // absolute paths awaiting a flush
  private pendingDeletions = new Set<string>();     // absolute paths of unlinked files
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private maxBatchTimer?: ReturnType<typeof setTimeout>;
  private running = false;                           // single-flight for the signature flush
  private vcsBulkFlag = false;                       // set by the .git ref watcher

  // ── Embedding lane (Step 4 — decoupled, lower priority) ─────────────────────
  private embed: boolean;
  private embedDegraded = false;                     // auto-degraded on a too-large tree
  private embedFiles = new Map<string, string>();    // rel → content awaiting embed
  private embedNodes = new Map<string, FunctionNode>(); // id → node awaiting embed
  private embedTimer?: ReturnType<typeof setTimeout>;
  private embedRunning = false;
  private lastEmbedContext?: CachedContext;

  constructor(options: McpWatcherOptions) {
    this.rootPath   = options.rootPath;
    this.outputPath = options.outputPath
      ?? join(options.rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
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
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
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

      const watched = (p: string): boolean => SOURCE_EXTENSIONS.test(p) || HTML_EXTENSIONS.test(p);
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

      this.fsWatcher.on('ready', () => resolve());
      this.fsWatcher.on('error', (err: unknown) => reject(err));
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
      this.gitWatcher.on('all', () => this.onVcsEvent());
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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxBatchTimer) clearTimeout(this.maxBatchTimer);
    if (this.embedTimer) clearTimeout(this.embedTimer);
    this.debounceTimer = this.maxBatchTimer = this.embedTimer = undefined;
    // Best-effort: drain anything still queued so a save/delete right before
    // shutdown is not lost. Deletions first, then changes (same order as flush).
    if (!this.running) {
      if (this.pendingDeletions.size > 0) {
        const dels = Array.from(this.pendingDeletions);
        this.pendingDeletions.clear();
        try { await this.handleDeletions(dels); } catch { /* ignore */ }
      }
      if (this.pending.size > 0) {
        const batch = Array.from(this.pending);
        this.pending.clear();
        try { await this.handleBatch(batch, { syncFlush: true }); } catch { /* ignore */ }
      }
    }
    await this.fsWatcher?.close();
    await this.gitWatcher?.close();
    process.stderr.write('[mcp-watcher] stopped\n');
  }

  // ── Coalescing (Step 1) ──────────────────────────────────────────────────────

  /**
   * Add a changed path to the pending set and (re)arm a single debounce timer,
   * plus a one-shot hard ceiling so a continuous stream still flushes.
   */
  private enqueue(absPath: string): void {
    this.pending.add(absPath);
    // A re-create supersedes a pending delete for the same path.
    this.pendingDeletions.delete(absPath);
    this.armFlush();
  }

  /** Queue a file deletion for the next flush (reuses the same debounce). */
  private enqueueDeletion(absPath: string): void {
    this.pendingDeletions.add(absPath);
    // A delete supersedes a pending change for the same path.
    this.pending.delete(absPath);
    this.armFlush();
  }

  private armFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
    if (!this.maxBatchTimer) {
      this.maxBatchTimer = setTimeout(() => this.flush(), this.maxBatchMs);
    }
  }

  /** A .git ref changed — settle, then flush whatever changed as one bulk batch. */
  private onVcsEvent(): void {
    this.vcsBulkFlag = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), WATCH_VCS_SETTLE_MS);
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
    this.pending.clear();
    this.pendingDeletions.clear();
    this.running = true;
    // Deletions first (remove stale state), then re-index the changed/added files.
    (async () => {
      if (deletions.length > 0) await this.handleDeletions(deletions);
      if (batch.length > 0) await this.handleBatch(batch);
    })()
      .catch((err) => process.stderr.write(`[mcp-watcher] error: ${(err as Error).message}\n`))
      .finally(() => {
        this.running = false;
        if (this.pending.size > 0 || this.pendingDeletions.size > 0) {
          this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
        }
      });
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
   * Process a coalesced batch of changed files as ONE pipeline pass:
   *   • per-file incremental edge update (content-hash skip), all under one open
   *     EdgeStore;
   *   • ONE signature patch + ONE llm-context persist + ONE read-cache handoff;
   *   • ONE vector update (inline when syncFlush, else on the embed lane).
   */
  private async handleBatch(absPaths: string[], opts: { syncFlush?: boolean } = {}): Promise<void> {
    const t0 = Date.now();
    const consumedVcsBulk = this.vcsBulkFlag;
    this.vcsBulkFlag = false;

    // 1. Resolve + read candidate files (skip tests / unknown langs / deleted).
    const files: Array<{ rel: string; abs: string; content: string }> = [];
    for (const abs of absPaths) {
      const rel = relative(this.rootPath, abs);
      if (isTestFile(rel)) continue;
      // HTML is 'unknown' to detectLanguage but takes the dedicated HTML path
      // (text-line + inline-script call graph + dependency asset edges).
      if (detectLanguage(rel) === 'unknown' && !HTML_EXTENSIONS.test(rel)) continue;
      let content: string;
      try {
        content = await readFile(abs, 'utf-8');
      } catch {
        continue; // file may have been deleted between the event and now
      }
      files.push({ rel, abs, content });
    }
    if (files.length === 0) return;

    // 2. Incremental edge update (CGC _handle_modification algorithm), one open
    //    store for the whole batch. Content-hash skip drops no-op autosaves.
    const changedFiles: ChangedFile[] = [];
    const changedNodes: FunctionNode[] = [];
    if (EdgeStore.exists(this.outputPath)) {
      const store = EdgeStore.open(EdgeStore.dbPath(this.outputPath));
      try {
        // Schema-bump guard: opening a stale-version DB wipes it (rebuild-on-bump).
        // An incremental per-file update on a wiped store would leave a PARTIAL graph
        // (only the changed file's nodes). Skip it — a full `analyze` must rebuild.
        if (store.wasReset) {
          process.stderr.write(
            '[mcp-watcher] graph index was reset by a schema-version upgrade — scheduling a background rebuild. ' +
            'Skipping incremental update to avoid a partial graph.\n'
          );
          this.scheduleBackgroundRebuild();
        }
        for (const f of files) {
          if (store.wasReset) break;
          const newHash = createHash('sha256').update(f.content).digest('hex');
          if (store.getFileHash(f.rel) === newHash) continue; // no-op autosave

          // Symbol names present BEFORE the edit — diffed against the re-parsed
          // result to find names this edit ADDS (which may now bind prior
          // `external::` call sites in non-caller files).
          const oldNames = new Set(store.getNodesForFile(f.rel).map((n) => n.name));
          // Re-parse BEFORE mutating DB — graph stays readable (old state) during
          // parse. Seed resolution with all known nodes so re-parsed callers'
          // cross-file calls don't degrade to `external::`.
          const resolutionNodes = store.getAllInternalNodes();

          // ── Change-driven reverse-dependency closure ───────────────────────────
          // Converge with `analyze --force`, or mark the remainder explicitly
          // stale (fix-transitive-incremental-staleness). Direct callers first —
          // the files whose edges point INTO this one — bounded by the work budget.
          const directCallers = store.getCallerFiles(f.rel).filter((cf) => cf !== f.rel);
          let recompute = directCallers.slice(0, this.closureBudget);
          let dropped = directCallers.slice(this.closureBudget);

          // Re-parse the changed file + the callers we can afford, as ONE build so
          // cross-file calls resolve against each other (not to `external::`).
          let sub = await buildGraphSubset(f.rel, f.content, recompute, this.rootPath, resolutionNodes);

          // Class-P closure: a symbol this edit ADDED can newly bind a previously-
          // `external` call site, or flip the lowest-id `name_only` winner, in a
          // file that is NOT a caller of this one (getCallerFiles misses it).
          // Discovery runs even when direct callers already filled the budget —
          // these consumers must never be left silently divergent: re-resolve
          // within the remaining budget, mark the rest stale. Re-resolving runs
          // them alongside the changed file so the new edge resolves internally —
          // exactly as `analyze --force` would.
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
                if (cf !== f.rel && cf !== 'external' && !recompute.includes(cf)) extra.add(cf);
              }
              // `name_only` consumers already resolve the name to another file by
              // lowest candidate id; the added symbol only flips that pick when its
              // id sorts BEFORE the consumer's current target. Re-resolving the rest
              // is a verified no-op (and a needless stale flag), so prune them — this
              // is what keeps a common-name add (`get`/`run`) from re-parsing and
              // stale-flagging dozens of unaffected files.
              for (const { file: cf, calleeId } of store.getNameOnlyConsumers(name)) {
                if (cf !== f.rel && cf !== 'external' && !recompute.includes(cf) && addedId < calleeId) extra.add(cf);
              }
            }
            if (extra.size > 0) {
              const room = Math.max(0, this.closureBudget - recompute.length);
              const extraList = [...extra];
              const take = extraList.slice(0, room);
              dropped = dropped.concat(extraList.slice(room));
              if (take.length > 0) {
                recompute = [...recompute, ...take];
                sub = await buildGraphSubset(f.rel, f.content, recompute, this.rootPath, resolutionNodes);
              }
            }
          }

          const { edges: newEdges, nodes: newNodes, cfgs: newCfgs, skipped } = sub;
          // A file we INTENDED to recompute but could not READ (permissions /
          // transient I/O / a lock) must not have its edges deleted and then be
          // asserted fresh — that is the one silent-divergence the converge-or-flag
          // contract forbids. Preserve its existing edges (skip the delete) and mark
          // it stale instead, so it is honestly flagged until it can be re-read.
          const skippedSet = new Set(skipped);
          const recomputed = recompute.filter((cf) => !skippedSet.has(cf));

          // Atomic swap so concurrent MCP reads never see a torn graph.
          store.transaction(() => {
            store.deleteEdgesForFile(f.rel);
            for (const cf of recomputed) store.deleteOutgoingEdgesForFile(cf);
            store.deleteNodesForFile(f.rel);
            // Recompute only THIS file's overlay records — intra-procedural, so
            // caller files' overlays stay valid (spec: add-intraprocedural-cfg-dataflow-overlay).
            store.deleteCfgForFile(f.rel);
            store.insertNodes(newNodes);
            store.insertEdges(newEdges);
            store.insertCfgs(newCfgs);
            store.setFileHash(f.rel, newHash);
            // Self-heal: every file we actually recomputed has converged, so it
            // leaves the explicit stale region. Soundness fallback: files we could
            // not afford to recompute (over budget) OR could not read (skipped) are
            // marked stale (over-approximate, never silent).
            store.clearFilesStale([f.rel, ...recomputed]);
            const staleNow = skipped.length > 0 ? [...dropped, ...skipped] : dropped;
            if (staleNow.length > 0) store.markFilesStale(staleNow);
          });

          changedFiles.push({ rel: f.rel, content: f.content });
          for (const n of newNodes) changedNodes.push(n);
          if (this.debug) {
            const staleCount = dropped.length + skipped.length;
            process.stderr.write(
              `[mcp-watcher] graph: ${f.rel} (+${newNodes.length} nodes, +${newEdges.length} edges, ` +
              `${recomputed.length} re-resolved` +
              `${staleCount ? `, ${staleCount} → stale${skipped.length ? ` (${skipped.length} unreadable)` : ''}` : ''})\n`,
            );
          }
        }
        // Keep the index attestation's counts in lockstep with the now-mutated store so
        // the load-time verdict doesn't falsely report `degraded` on a valid incremental
        // edit (change: add-index-integrity-attestation). Best-effort; never blocks the
        // watch path. Skipped on a wasReset store (handled above — it bails before here).
        if (changedFiles.length > 0) {
          await refreshAttestationCounts(this.outputPath, store).catch(() => {});
        }
      } finally {
        store.close();
      }
    } else {
      // No edge store yet — still refresh signatures for every candidate.
      for (const f of files) changedFiles.push({ rel: f.rel, content: f.content });
    }

    if (changedFiles.length === 0) return; // every event was a no-op autosave

    // 3. Signatures: load context (shared in-memory cache), patch all changed
    //    files, then ONE persist + read-cache handoff (Step 2). The handoff
    //    means the next tool call is a cache HIT — no cold 2.1 MB re-parse.
    const context = await this.loadContext();
    if (!context) {
      process.stderr.write(`[mcp-watcher] no context at ${this.contextPath} — run analyze first\n`);
      return;
    }
    if (!context.signatures) context.signatures = [];
    for (const f of changedFiles) {
      const newMap = extractSignatures(f.rel, f.content);
      const idx = context.signatures.findIndex((m) => m.path === f.rel);
      if (idx >= 0) context.signatures[idx] = newMap;
      else context.signatures.push(newMap);
    }
    await this.persistContext(context);

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
    await this.updateDependencyGraph(changedFiles);

    // 3.7. Style fingerprint — keep style-fingerprint.json's per-file idiom counters live for the
    //      changed files (change: add-codebase-style-fingerprint). Incremental: re-tally only the
    //      changed files, reuse the stored file→region map (communities are O(graph), recomputed
    //      on the next full analyze). byLanguage and per-file profiles stay exact.
    await this.updateStyleFingerprint(changedFiles);

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
   * Self-heal a schema-reset graph by spawning one detached `analyze --force`
   * (BM25-only, no network). Runs at most once per process (`backgroundRebuild
   * Triggered`); a spawn failure logs and falls back to the existing "run
   * analyze" note rather than retrying — no thundering herd, no loop (B10).
   */
  private scheduleBackgroundRebuild(): void {
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
        [cli, 'analyze', '--force', '--no-embed', '--output', this.outputPath],
        { cwd: this.rootPath, stdio: 'ignore', detached: true }
      );
      child.on('error', (err) => {
        process.stderr.write(`[mcp-watcher] background rebuild failed to start (${err.message}) — run "openlore analyze".\n`);
      });
      child.unref();
      process.stderr.write('[mcp-watcher] background "openlore analyze --force" started; the graph will self-heal shortly.\n');
    } catch (err) {
      process.stderr.write(`[mcp-watcher] background rebuild could not be spawned (${(err as Error).message}) — run "openlore analyze".\n`);
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
    await writeFile(this.contextPath, JSON.stringify(serializable, null, 2), 'utf-8');
    // Hand the patched object back to the read cache, aligned to the new on-disk
    // mtime, so the next tool call is a cache hit (no cold re-parse). This is the
    // fix for root-cause item 2 (mtime bump forcing a full re-read). Only valid
    // for the canonical layout the read handlers cache against.
    if (this.usesStandardLayout) await primeContextCache(this.rootPath, context);
  }

  // ── Embedding lane (Step 4) ──────────────────────────────────────────────────

  private scheduleEmbed(context: CachedContext, changedFiles: ChangedFile[], nodes: FunctionNode[]): void {
    for (const f of changedFiles) this.embedFiles.set(f.rel, f.content);
    for (const node of nodes) this.embedNodes.set(node.id, node);
    this.lastEmbedContext = context;
    if (this.embedTimer) clearTimeout(this.embedTimer);
    // Slightly behind the signature debounce so structural freshness always lands
    // first and multiple flushes batch into one embed pass.
    this.embedTimer = setTimeout(() => void this.runEmbedLane(), this.debounceMs);
  }

  private async runEmbedLane(): Promise<void> {
    if (this.embedRunning) {
      // Re-arm: drain again once the in-flight pass finishes.
      this.embedTimer = setTimeout(() => void this.runEmbedLane(), this.debounceMs);
      return;
    }
    if (this.embedFiles.size === 0 || !this.lastEmbedContext) return;
    const changedFiles: ChangedFile[] = Array.from(this.embedFiles, ([rel, content]) => ({ rel, content }));
    const nodes = Array.from(this.embedNodes.values());
    const context = this.lastEmbedContext;
    this.embedFiles.clear();
    this.embedNodes.clear();
    this.embedRunning = true;
    try {
      await this.updateVectors(context, changedFiles, nodes);
    } catch (err) {
      process.stderr.write(`[mcp-watcher] embed error: ${(err as Error).message}\n`);
    } finally {
      this.embedRunning = false;
      if (this.embedFiles.size > 0) {
        this.embedTimer = setTimeout(() => void this.runEmbedLane(), this.debounceMs);
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
  private async updateDependencyGraph(changedFiles: ChangedFile[]): Promise<void> {
    const graphPath = join(this.outputPath, ARTIFACT_DEPENDENCY_GRAPH);
    try {
      let raw: string;
      try {
        raw = await readFile(graphPath, 'utf-8');
      } catch {
        return; // no dependency graph yet — nothing to keep fresh
      }
      // Narrow view for the fields we touch. We MUTATE the parsed object in place
      // and re-serialize it, so untyped node fields not modeled here (file,
      // exports, cluster, metrics.pageRank/betweenness) survive the round-trip.
      const graph = JSON.parse(raw) as {
        nodes: Array<{ id: string; file?: { path: string; absolutePath: string }; exports?: unknown[]; metrics?: Record<string, number> }>;
        edges: Array<{ source: string; target: string; httpEdge?: unknown; isCallEdge?: boolean }>;
      };
      if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return;

      const { ImportExportParser } = await import('../analyzer/import-parser.js');
      const { computeFileImportEdges } = await import('../analyzer/dependency-graph.js');
      const fileSet = new Set(graph.nodes.map((n) => n.id)); // absolute paths
      const parser = new ImportExportParser();
      let changed = false;

      for (const f of changedFiles) {
        const abs = join(this.rootPath, f.rel);
        let analysis;
        try {
          analysis = await parser.parseFile(abs);
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
        const newEdges = await computeFileImportEdges(abs, analysis, fileSet, this.rootPath);
        // Drop this file's previous IMPORT edges (keep HTTP / call-synthesized
        // edges, which the watcher does not rebuild), then splice in the fresh set.
        graph.edges = graph.edges.filter(
          (e) => e.source !== abs || e.httpEdge !== undefined || e.isCallEdge === true,
        );
        graph.edges.push(...(newEdges as typeof graph.edges));
        changed = true;
      }
      if (!changed) return;

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

      // Atomic write (tmp + rename) so a concurrent MCP read never sees a torn
      // JSON — matching the watcher's "readers never see a torn graph" invariant.
      const tmp = `${graphPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(graph));
      await rename(tmp, graphPath);
      if (this.debug) {
        process.stderr.write(
          `[mcp-watcher] dependency graph: patched import edges for ${changedFiles.length} file(s)\n`,
        );
      }
    } catch (err) {
      process.stderr.write(`[mcp-watcher] dependency-graph error: ${(err as Error).message}\n`);
    }
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
      const tmp = `${fpPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(updated, null, 2));
      await rename(tmp, fpPath);
      if (this.debug) {
        process.stderr.write(`[mcp-watcher] style fingerprint: refreshed ${changedFiles.length} changed / ${deletedRels.length} deleted\n`);
      }
    } catch (err) {
      process.stderr.write(`[mcp-watcher] style-fingerprint error: ${(err as Error).message}\n`);
    }
  }

  /**
   * Reconcile file DELETIONS across every lane so a removed file leaves no
   * phantom state: call-graph nodes/edges (incoming and outgoing), signatures,
   * text-line rows, vector rows, and dependency-graph node + edges. Best-effort;
   * a failure in one lane does not block the others.
   */
  private async handleDeletions(absPaths: string[]): Promise<void> {
    // Deletion is idempotent removal, so no need to filter — each lane no-ops for
    // a path it never indexed. (Watch-ignored paths like *.test.ts never reach
    // here anyway: chokidar prunes them, so no unlink fires.)
    const rels = absPaths.map((abs) => relative(this.rootPath, abs));
    if (rels.length === 0) return;

    // 1. Call-graph store — deleteEdgesForFile removes edges where the file is
    //    caller OR callee, so incoming edges don't dangle.
    if (EdgeStore.exists(this.outputPath)) {
      const store = EdgeStore.open(EdgeStore.dbPath(this.outputPath));
      try {
        store.transaction(() => {
          for (const rel of rels) {
            store.deleteEdgesForFile(rel);
            store.deleteNodesForFile(rel);
            store.deleteCfgForFile(rel);
            store.deleteClassesForFile(rel);
          }
          // A deleted file leaves no topology to be stale about — drop any stale
          // mark so the region doesn't accumulate phantom rows for gone files
          // (fix-transitive-incremental-staleness).
          store.clearFilesStale(rels);
        });
        // A deletion is the most likely trigger for a false `degraded` — keep the
        // attestation's counts current with the shrunken store (change:
        // add-index-integrity-attestation). Best-effort; never blocks the watch path.
        if (!store.wasReset) {
          await refreshAttestationCounts(this.outputPath, store).catch(() => {});
        }
      } catch (err) {
        process.stderr.write(`[mcp-watcher] delete (graph) error: ${(err as Error).message}\n`);
      } finally {
        store.close();
      }
    }

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

    if (this.debug) {
      process.stderr.write(`[mcp-watcher] reconciled ${rels.length} deletion(s)\n`);
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
        nodes: Array<{ id: string; metrics?: Record<string, number> }>;
        edges: Array<{ source: string; target: string }>;
      };
      if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return;

      const removed = new Set(absPaths);
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

      const tmp = `${graphPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(graph));
      await rename(tmp, graphPath);
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
): Promise<{
  edges: import('../analyzer/call-graph.js').CallEdge[];
  nodes: import('../analyzer/call-graph.js').FunctionNode[];
  cfgs: Array<{ functionId: string; filePath: string; cfg: import('../analyzer/cfg.js').FunctionCfg }>;
  /**
   * callerFiles the caller asked to re-resolve but that could NOT be read
   * (permissions / transient I/O / a lock). The caller must NOT delete-and-empty
   * these — it preserves their edges and marks them stale instead, so an
   * unreadable file is never silently emptied-and-asserted-fresh
   * (fix-transitive-incremental-staleness).
   */
  skipped: string[];
}> {
  let lang = detectLanguage(changedRel);
  let content = changedContent;
  // HTML: blank everything outside inline <script> bodies (offset-preserving) so
  // the JS extractor parses the inline scripts at their true positions. Without
  // this, html is 'unknown' → empty result → the caller's atomic swap would
  // DELETE the page's inline-script nodes on every edit (regression).
  if (lang === 'unknown' && HTML_EXTENSIONS.test(changedRel)) {
    const { extractHtmlScripts } = await import('../analyzer/html-script-extractor.js');
    const blanked = extractHtmlScripts(changedContent);
    if (!blanked) return { edges: [], nodes: [], cfgs: [], skipped: [] }; // no inline JS
    content = blanked;
    lang = 'JavaScript';
  }
  if (!CALL_GRAPH_LANGS.has(lang)) return { edges: [], nodes: [], cfgs: [], skipped: [] };

  const { CallGraphBuilder } = await import('../analyzer/call-graph.js');
  // Use relative paths as node IDs (consistent with analyze output)
  const files: Array<{ path: string; content: string; language: string }> = [
    { path: changedRel, content, language: lang },
  ];

  const skipped: string[] = [];
  for (const cf of callerFiles) {
    const cfLang = detectLanguage(cf);
    if (!CALL_GRAPH_LANGS.has(cfLang)) continue; // ungraphable lang — never had edges; not stale
    try {
      const cfContent = await readFile(join(rootDir, cf), 'utf-8');
      files.push({ path: cf, content: cfContent, language: cfLang });
    } catch {
      // Present-but-unreadable: report it so the caller marks it stale rather
      // than deleting its edges and asserting it fresh.
      skipped.push(cf);
    }
  }

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
        const modContent = await readFile(join(rootDir, rel), 'utf-8');
        return { path: rel, content: modContent, language: detectLanguage(rel) };
      } catch {
        // try next candidate
      }
    }
    return undefined;
  };
  const barrels = await collectReExportBarrels(files, readModule);
  const barrelPaths = new Set(barrels.map((b) => b.path));
  const buildInput = barrels.length > 0 ? [...files, ...barrels] : files;

  const builder = new CallGraphBuilder();
  const result = await builder.build(buildInput, undefined, undefined, resolutionNodes);

  // Only return nodes from changedFile — callerFiles nodes are already in DB and unchanged.
  // Barrel context files are resolution-only: never persist their nodes or edges.
  const changedNodes = Array.from(result.nodes.values()).filter((n) => n.filePath === changedRel);
  const resultEdges =
    barrelPaths.size > 0
      ? result.edges.filter((e) => !barrelPaths.has(e.callerId.slice(0, e.callerId.indexOf('::'))))
      : result.edges;

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

  return { edges: resultEdges, nodes: changedNodes, cfgs, skipped };
}
