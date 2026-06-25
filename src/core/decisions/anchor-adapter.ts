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
import { join, resolve, sep } from 'node:path';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
} from '../../constants.js';
import { EdgeStore } from '../services/edge-store.js';
import type { FunctionNode } from '../analyzer/call-graph.js';
import type { StructuralAnchor, GroundingCertificate } from '../../types/index.js';
import {
  hashSpan,
  resolveSymbolAnchors,
  fileAnchor,
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
      return node ? store.isFileStale(node.filePath) : false;
    },
    fileInStaleRegion: (filePath: string): boolean => store.isFileStale(filePath),
    renameOf,
  };
}

export class AnchorContext {
  private fileCache = new Map<string, string | null>();

  private constructor(
    private readonly store: EdgeStore,
    private readonly rootPath: string,
  ) {}

  /** Open the adapter, or return null when no analysis (edge store) exists yet. */
  static open(rootPath: string): AnchorContext | null {
    const dir = analysisDir(rootPath);
    if (!EdgeStore.exists(dir)) return null;
    try {
      return new AnchorContext(EdgeStore.open(EdgeStore.dbPath(dir)), rootPath);
    } catch {
      return null;
    }
  }

  close(): void {
    try { this.store.close(); } catch { /* ignore */ }
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
      const info = this.nodeSpanInfo(node);
      if (!info) return undefined;
      return { symbol: node.name, filePath: node.filePath, lineSpan: info.lineSpan, contentHash: info.contentHash };
    }
    // File-level anchor: whole-file evidence.
    const contentHash = this.fileContentHash(anchor.filePath);
    if (contentHash === undefined) return undefined;
    return { filePath: anchor.filePath, contentHash };
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
    hints: ReadonlyArray<{ symbol?: string; file?: string }>,
  ): StructuralAnchor[] {
    const files = hints.map((h) => h.file).filter((f): f is string => !!f);
    const nodes = files.length
      ? this.anchorNodesForFiles(files)
      : this.store.getAllInternalNodes().reduce<AnchorNode[]>((acc, node) => {
          const contentHash = this.spanHash(node);
          if (contentHash !== undefined) {
            acc.push({ id: node.id, name: node.name, filePath: node.filePath, contentHash, ...(node.stableId ? { stableId: node.stableId } : {}) });
          }
          return acc;
        }, []);

    const out: StructuralAnchor[] = [];
    const seen = new Set<string>();
    for (const hint of hints) {
      if (hint.symbol) {
        const resolved = resolveSymbolAnchors([hint.symbol], nodes, hint.file ? [hint.file] : undefined);
        if (resolved.length === 1) {
          if (!seen.has(resolved[0].nodeId!)) {
            seen.add(resolved[0].nodeId!);
            out.push(resolved[0]);
          }
          continue;
        }
      }
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
}

/** Whole-word, case-sensitive mention test for a symbol name in free text. */
export function isNamedIn(text: string, name: string): boolean {
  if (name.length < 3) return false; // too short to be an unambiguous mention
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(text);
}
