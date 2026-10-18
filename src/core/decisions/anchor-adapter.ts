/**
 * Disk-backed adapter for the code-anchored memory engine.
 * (change: add-code-anchored-memory-staleness)
 *
 * Bridges the pure {@link ./anchor.ts} engine to the running project: it reads
 * the call graph from the edge store and function/file source from disk to supply
 * {@link AnchorNode}s (for resolution) and a {@link GraphFreshnessView} (for
 * verdicts). All operations are deterministic static analysis — no LLM.
 *
 * File buffers are read once and cached per operation; an anchor set touches only
 * a handful of files, so this stays cheap. The freshness-view builder is exported
 * standalone ({@link makeFreshnessView}) so callers that already hold an open
 * edge store (e.g. orient) can reuse it instead of opening a second handle.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
} from '../../constants.js';
import { EdgeStore } from '../services/edge-store.js';
import type { FunctionNode } from '../analyzer/call-graph.js';
import { factKey } from '../analyzer/pass1-fact-cache.js';
import { detectLanguage } from '../analyzer/language-detection.js';
import type { StructuralAnchor, GroundingCertificate } from '../../types/index.js';
import {
  hashSpan,
  resolveSymbolAnchors,
  fileAnchor,
  locateSpan,
  type AnchorNode,
  type GraphFreshnessView,
} from './anchor.js';

function analysisDir(rootPath: string): string {
  return join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
}

/** Read a file's content from disk via a cache, or null if unreadable. */
function readFileCached(rootPath: string, filePath: string, cache: Map<string, string | null>): string | null {
  const hit = cache.get(filePath);
  if (hit !== undefined) return hit;
  let content: string | null;
  // filePath originates from decision anchors / affectedFiles (tool-arg or
  // stored-artifact controlled). Confine the read to the project root so a "../"
  // path can't read out-of-root content for freshness verdicts (mcp-security).
  const abs = resolve(rootPath, filePath);
  if (abs !== rootPath && !abs.startsWith(rootPath + sep)) {
    cache.set(filePath, null);
    return null;
  }
  try {
    content = readFileSync(abs, 'utf-8');
  } catch {
    content = null;
  }
  cache.set(filePath, content);
  return content;
}

/**
 * Slice a node's source span out of its file. `startIndex`/`endIndex` are the
 * tree-sitter offsets, which are UTF-16 code-unit indices (not byte offsets) — so
 * we slice the JS string directly. Slicing a Buffer by these indices would drift
 * in any file containing multibyte characters before the span, citing misaligned
 * source. String.slice clamps out-of-range indices, so a shrunken file still
 * yields a deterministic (and differing → drifted) span.
 */
function sliceNodeSpan(content: string, node: FunctionNode): string {
  return content.slice(node.startIndex, node.endIndex);
}

/**
 * Read a node's current source span text (code-unit offsets) from disk, confined
 * to the project root, or `undefined` when the file is unreadable. Exported so the
 * continuity carry-forward computes span hashes the SAME way the freshness engine
 * does (one slicing source — avoids a latent divergence).
 */
export function nodeSpanText(rootPath: string, node: FunctionNode, cache: Map<string, string | null>): string | undefined {
  const content = readFileCached(rootPath, node.filePath, cache);
  if (content === null) return undefined;
  return sliceNodeSpan(content, node);
}

/**
 * Whether the stored offsets of `node` still describe the file on disk
 * (add-memory-anchor-verdicts). Offsets come from the last analysis; after an edit
 * they point at other text, and a span search there could find the span in a
 * neighboring symbol. The watcher records the hash of each file it re-indexed; a
 * full analyze records the content key of each file it extracted. Either must match
 * the current content, or the offsets are not trusted. Memoized per file.
 */
/** Per-view memos keyed by file path; a view's file cache holds one content per path. */
interface ViewMemo {
  offsetsCurrent: Map<string, boolean>;
  newlines: Map<string, number[]>;
}

function newViewMemo(): ViewMemo {
  return { offsetsCurrent: new Map(), newlines: new Map() };
}

function offsetsCurrent(
  store: EdgeStore,
  node: FunctionNode,
  content: string,
  viewMemo: ViewMemo,
): boolean {
  const memo = viewMemo.offsetsCurrent;
  const hit = memo.get(node.filePath);
  if (hit !== undefined) return hit;
  let current: boolean;
  try {
    const indexed = store.getFileHash(node.filePath);
    current = indexed !== null
      ? indexed === createHash('sha256').update(content).digest('hex')
      : store.getPass1FactHash(node.filePath) === factKey({ path: node.filePath, language: node.language, content });
  } catch {
    current = false;
  }
  memo.set(node.filePath, current);
  return current;
}

/**
 * A node's current span text and the 1-based file line it starts on, or undefined
 * when the file is unreadable or the stored offsets no longer describe it.
 */
function nodeSource(
  store: EdgeStore,
  rootPath: string,
  node: FunctionNode,
  cache: Map<string, string | null>,
  memo: ViewMemo,
): { text: string; startLine: number } | undefined {
  const content = readFileCached(rootPath, node.filePath, cache);
  if (content === null || !offsetsCurrent(store, node, content, memo)) return undefined;
  return { text: sliceNodeSpan(content, node), startLine: lineOf(content, node.startIndex, node.filePath, memo) };
}

/**
 * 1-based line of a code-unit offset in `content`, by binary search over the
 * file's newline offsets. The offsets are computed once per content string, so
 * many span anchors in one large file cost one scan, not one scan each.
 */
function lineOf(content: string, offset: number, filePath: string, memo: ViewMemo): number {
  let starts = memo.newlines.get(filePath);
  if (!starts) {
    starts = [];
    for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) starts.push(i);
    memo.newlines.set(filePath, starts);
  }
  // Count newlines strictly before `offset`.
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * Why a requested span was not recorded on an anchor (add-memory-anchor-verdicts):
 * the hint named no symbol that resolved, the text does not occur exactly once in
 * the symbol's body, the source is unreadable, or the file changed since it was
 * analyzed (its stored offsets no longer locate the symbol). The anchor is then recorded without the span, and
 * `remember` says so.
 */
export type SpanNotRecordedReason = 'no-symbol' | 'not-found' | 'line-endings' | 'ambiguous' | 'unreadable' | 'index-stale';

/** Hash a node's source span (code-unit offsets) against current file content. */
function hashNodeSpan(rootPath: string, node: FunctionNode, cache: Map<string, string | null>): string | undefined {
  const text = nodeSpanText(rootPath, node, cache);
  return text === undefined ? undefined : hashSpan(text);
}

/**
 * Build a {@link GraphFreshnessView} over an already-open edge store + disk. The
 * view carries its own short-lived file cache. No rename map by default — a
 * missing symbol is `orphaned` unless the caller supplies `renameOf`.
 */
export function makeFreshnessView(
  store: EdgeStore,
  rootPath: string,
  renameOf?: (nodeId: string) => string | undefined,
): GraphFreshnessView {
  const cache = new Map<string, string | null>();
  const memo = newViewMemo();
  let staleSnapshot: ReturnType<EdgeStore['getStaleRegionSnapshot']> | undefined;
  let staleFiles: Set<string> | undefined;
  const staleRegion = () => {
    if (!staleSnapshot) {
      staleSnapshot = store.getStaleRegionSnapshot();
      staleFiles = new Set(staleSnapshot.files);
    }
    return staleSnapshot;
  };
  const fileIsStale = (filePath: string) => {
    staleRegion();
    return staleFiles!.has(filePath);
  };
  return {
    nodeHash: (nodeId: string): string | undefined => {
      const node = store.getNode(nodeId);
      return node ? hashNodeSpan(rootPath, node, cache) : undefined;
    },
    resolveStableId: (stableId: string): { nodeId: string; contentHash: string } | undefined => {
      const node = store.getNodeByStableId(stableId);
      if (!node) return undefined;
      const contentHash = hashNodeSpan(rootPath, node, cache);
      return contentHash === undefined ? undefined : { nodeId: node.id, contentHash };
    },
    fileExists: (filePath: string): boolean => existsSync(join(rootPath, filePath)),
    fileHash: (filePath: string): string | undefined => {
      const content = readFileCached(rootPath, filePath, cache);
      return content === null ? undefined : hashSpan(content);
    },
    // A node lies in a stale region when its file was marked stale by a
    // budget-exceeded incremental update (fix-transitive-incremental-staleness).
    inStaleRegion: (nodeId: string): boolean => {
      const node = store.getNode(nodeId);
      return node ? fileIsStale(node.filePath) : false;
    },
    fileInStaleRegion: (filePath: string): boolean => fileIsStale(filePath),
    nodeSource: (nodeId: string) => {
      const node = store.getNode(nodeId);
      return node ? nodeSource(store, rootPath, node, cache, memo) : undefined;
    },
    staleRegionComposition: (filePath: string) =>
      fileIsStale(filePath) ? staleRegion().composition : undefined,
    renameOf,
  };
}

export class AnchorContext {
  private fileCache = new Map<string, string | null>();
  private viewMemo = newViewMemo();

  private constructor(
    private readonly store: EdgeStore,
    private readonly rootPath: string,
  ) {}

  /** Open the adapter, or return null when no analysis (edge store) exists yet. */
  static open(rootPath: string): AnchorContext | null {
    const dir = analysisDir(rootPath);
    if (!EdgeStore.exists(dir)) return null;
    try {
      const store = EdgeStore.open(EdgeStore.dbPath(dir));
      // A not-ready store (schema-mismatched / quarantined) cannot answer anchor
      // queries — recall degrades to "no analysis yet" rather than serving an empty
      // graph as authoritative (change: harden-index-store-lifecycle).
      if (store.notReady) {
        store.close();
        return null;
      }
      return new AnchorContext(store, rootPath);
    } catch {
      return null;
    }
  }

  close(): void {
    try { this.store.close(); } catch { /* ignore */ }
  }

  /**
   * Test-only: how many distinct files this adapter has read from disk.
   *
   * The observable that pins anchor resolution to the symbol's own file rather than
   * the whole repository. (change: optimize-serving-hot-path-caches)
   */
  _filesReadForTesting(): number {
    return this.fileCache.size;
  }

  private spanHash(node: FunctionNode): string | undefined {
    return hashNodeSpan(this.rootPath, node, this.fileCache);
  }

  /** Build resolvable {@link AnchorNode}s for every internal node in the given files. */
  anchorNodesForFiles(files: readonly string[]): AnchorNode[] {
    const out: AnchorNode[] = [];
    for (const file of new Set(files)) {
      for (const node of this.store.getNodesForFile(file)) {
        if (node.isExternal) continue;
        const contentHash = this.spanHash(node);
        if (contentHash === undefined) continue;
        out.push({ id: node.id, name: node.name, filePath: node.filePath, contentHash, ...(node.stableId ? { stableId: node.stableId } : {}) });
      }
    }
    return out;
  }

  /**
   * Whether the analysis indexed this file at its current content
   * (add-memory-anchor-verdicts): `true` when it did, `false` when the file changed
   * since, or no recorded key can show it did not; `undefined` when the file is
   * unreadable (a deleted file has no offsets left to be wrong about).
   */
  fileIndexedAsOnDisk(filePath: string): boolean | undefined {
    const content = readFileCached(this.rootPath, filePath, this.fileCache);
    if (content === null) return undefined;
    // A file whose symbols were all removed has no node to name its language.
    const node = this.store.getNodesForFile(filePath).find((n) => !n.isExternal)
      ?? ({ filePath, language: detectLanguage(filePath) } as FunctionNode);
    return offsetsCurrent(this.store, node, content, this.viewMemo);
  }

  /** Current whole-file content hash, or undefined when the file is gone. */
  fileContentHash(filePath: string): string | undefined {
    const content = readFileCached(this.rootPath, filePath, this.fileCache);
    return content === null ? undefined : hashSpan(content);
  }

  /** A {@link GraphFreshnessView} backed by this adapter's edge store + disk. */
  freshnessView(): GraphFreshnessView {
    return makeFreshnessView(this.store, this.rootPath);
  }

  /**
   * Build a grounding certificate for an anchor — the evidence behind a `fresh`
   * verdict (add-trust-calibrated-context-economy). For a symbol anchor it is the
   * node's symbol/file/line-span and the *current* span hash (the same hash the
   * freshness check compared); for a relocated symbol it follows the stable id;
   * for a file anchor it is the file path and whole-file hash. Returns undefined
   * when the anchored ground can no longer be located (caller only builds these
   * for `fresh` facts, where it resolves). No new extraction beyond the span hash
   * the freshness check already computes.
   */
  certificateForAnchor(anchor: StructuralAnchor): GroundingCertificate | undefined {
    if (anchor.nodeId) {
      const node = this.store.getNode(anchor.nodeId)
        ?? (anchor.stableId ? this.store.getNodeByStableId(anchor.stableId) : null);
      if (!node) return undefined;
      // A span anchor was verified by re-locating its text, so its evidence is that
      // text's lines and hash, not the whole symbol's (add-memory-anchor-verdicts).
      if (anchor.spanText !== undefined) return this.spanCertificate(node, anchor.spanText);
      const info = this.nodeSpanInfo(node);
      if (!info) return undefined;
      return { symbol: node.name, filePath: node.filePath, lineSpan: info.lineSpan, contentHash: info.contentHash };
    }
    // File-level anchor: whole-file evidence.
    const contentHash = this.fileContentHash(anchor.filePath);
    if (contentHash === undefined) return undefined;
    return { filePath: anchor.filePath, contentHash };
  }

  /** Evidence for a span anchor: the lines its unique occurrence covers and the span's hash. */
  private spanCertificate(node: FunctionNode, spanText: string): GroundingCertificate | undefined {
    const source = nodeSource(this.store, this.rootPath, node, this.fileCache, this.viewMemo);
    if (!source) return undefined;
    const hits = locateSpan(source.text, spanText, 2);
    if (hits.length !== 1) return undefined;
    const before = source.text.slice(0, hits[0]);
    const start = source.startLine + (before.match(/\n/g) ?? []).length;
    const newlines = (spanText.match(/\n/g) ?? []).length;
    const end = start + newlines - (spanText.endsWith('\n') ? 1 : 0);
    return { symbol: node.name, filePath: node.filePath, lineSpan: { start, end: Math.max(start, end) }, contentHash: hashSpan(spanText) };
  }

  /**
   * The current span hash AND 1-based inclusive line range of a node, computed
   * from its code-unit offsets against the live file (the edge store keeps
   * offsets, not lines). Reuses the same span — and the same {@link sliceNodeSpan}
   * — that the freshness hash covers, so `contentHash` here equals the hash the
   * freshness check compared, and the cited line range matches the hashed span.
   */
  private nodeSpanInfo(node: FunctionNode): { contentHash: string; lineSpan: { start: number; end: number } } | undefined {
    const content = readFileCached(this.rootPath, node.filePath, this.fileCache);
    if (content === null) return undefined;
    const spanText = sliceNodeSpan(content, node);
    const start = content.slice(0, node.startIndex).split('\n').length;
    const newlines = (spanText.match(/\n/g) ?? []).length;
    // A span ending in a newline shouldn't count the empty trailing line.
    const end = start + newlines - (spanText.endsWith('\n') ? 1 : 0);
    return { contentHash: hashSpan(spanText), lineSpan: { start, end: Math.max(start, end) } };
  }

  /**
   * Resolve anchors for a decision: symbol-level anchors for any function in the
   * affected files whose name is mentioned verbatim in the decision text, plus a
   * file-level anchor (with a captured baseline hash) for each affected file.
   */
  resolveDecisionAnchors(affectedFiles: readonly string[], text: string): StructuralAnchor[] {
    const nodes = this.anchorNodesForFiles(affectedFiles);
    const named = nodes.filter((n) => isNamedIn(text, n.name)).map((n) => n.name);
    const symbolAnchors = resolveSymbolAnchors(named, nodes, affectedFiles);
    const fileAnchors = [...new Set(affectedFiles)].map((f) => fileAnchor(f, this.fileContentHash(f)));
    // Keep both: file anchors give coarse coverage even where no symbol matched.
    return [...symbolAnchors, ...fileAnchors];
  }

  /**
   * Resolve caller-supplied anchor hints (for `remember`). Each hint may name a
   * symbol and/or a file. A symbol that resolves to exactly one node becomes a
   * symbol anchor; otherwise the file (if given) becomes a file anchor.
   */
  resolveInputAnchors(
    hints: ReadonlyArray<{ symbol?: string; file?: string; span?: string }>,
    spanNotRecorded?: (hintIndex: number, reason: SpanNotRecordedReason) => void,
  ): StructuralAnchor[] {
    const files = hints.map((h) => h.file).filter((f): f is string => !!f);
    // Candidate set. With a file hint, the file's nodes; WITHOUT one, only the nodes
    // that carry a hinted name — read through `idx_node_name`.
    //
    // The fallback used to materialize every internal node in the repository and hash
    // each one's source span, so `remember` with a symbol-only anchor read and hashed
    // the whole repo to resolve one symbol. Resolution matches names EXACTLY
    // (`resolveSymbolAnchors`), so a name-scoped candidate set is the same set for that
    // name — including when it holds several nodes, which is what makes the hint
    // ambiguous and is still detected. (change: optimize-serving-hot-path-caches)
    const toAnchorNode = (node: FunctionNode): AnchorNode | null => {
      const contentHash = this.spanHash(node);
      if (contentHash === undefined) return null;
      return { id: node.id, name: node.name, filePath: node.filePath, contentHash, ...(node.stableId ? { stableId: node.stableId } : {}) };
    };
    const nodes = files.length
      ? this.anchorNodesForFiles(files)
      : [...new Set(hints.map((h) => h.symbol).filter((s): s is string => !!s))]
          .flatMap((symbol) => this.store.getInternalNodesByName(symbol))
          .reduce<AnchorNode[]>((acc, node) => {
            const anchor = toAnchorNode(node);
            if (anchor) acc.push(anchor);
            return acc;
          }, []);

    const out: StructuralAnchor[] = [];
    const seen = new Set<string>();
    for (const [index, hint] of hints.entries()) {
      if (hint.symbol) {
        const resolved = resolveSymbolAnchors([hint.symbol], nodes, hint.file ? [hint.file] : undefined);
        if (resolved.length === 1) {
          let anchor = resolved[0];
          if (hint.span !== undefined) {
            const located = this.locateHintSpan(anchor.nodeId!, hint.span);
            if (located === 'unique') anchor = { ...anchor, spanText: hint.span };
            else spanNotRecorded?.(index, located);
          }
          // The same symbol with a different span is a different anchor.
          const key = anchor.spanText === undefined ? anchor.nodeId! : `${anchor.nodeId!}#${hashSpan(anchor.spanText)}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push(anchor);
          }
          continue;
        }
      }
      if (hint.span !== undefined) spanNotRecorded?.(index, 'no-symbol');
      if (hint.file) {
        const key = `file:${hint.file}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(fileAnchor(hint.file, this.fileContentHash(hint.file)));
        }
      }
    }
    return out;
  }

  /** Whether `span` occurs exactly once in the node's current body. */
  private locateHintSpan(nodeId: string, span: string): 'unique' | Exclude<SpanNotRecordedReason, 'no-symbol'> {
    const node = this.store.getNode(nodeId);
    if (!node) return 'unreadable';
    const content = readFileCached(this.rootPath, node.filePath, this.fileCache);
    if (content === null) return 'unreadable';
    if (!offsetsCurrent(this.store, node, content, this.viewMemo)) return 'index-stale';
    const source = nodeSource(this.store, this.rootPath, node, this.fileCache, this.viewMemo)!;
    const hits = locateSpan(source.text, span, 2).length;
    if (hits === 0) {
      // An LF span against a CRLF file: say so, rather than just "not found".
      return span.includes('\n') && !span.includes('\r\n') && source.text.includes('\r\n') ? 'line-endings' : 'not-found';
    }
    return hits === 1 ? 'unique' : 'ambiguous';
  }
}

/** Whole-word, case-sensitive mention test for a symbol name in free text. */
export function isNamedIn(text: string, name: string): boolean {
  if (name.length < 3) return false; // too short to be an unambiguous mention
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(text);
}
