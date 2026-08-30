/**
 * Code-anchored memory — deterministic anchoring + freshness engine.
 * (change: add-code-anchored-memory-staleness)
 *
 * A persisted memory (an architectural decision or a `remember` note) is bound to
 * the code it describes by one or more {@link StructuralAnchor}s. At recall time
 * a freshness verdict is computed against the *current* call graph using only
 * boolean inputs — symbol existence and content-hash equality — with no tunable
 * threshold and no weighted score. This is what lets recall be bullet-proof: a
 * memory whose anchored code moved or died is labeled, never served silently.
 *
 * This module is intentionally pure: it operates on a minimal node view and a
 * {@link GraphFreshnessView} of lookups, so the resolution/verdict logic is unit
 * tested without touching disk or the edge store. The disk-backed adapter that
 * supplies the views lives in `anchor-adapter.ts`.
 */

import { createHash } from 'node:crypto';
import type {
  StructuralAnchor,
  AnchorVerdict,
  MemoryFreshness,
  PendingDecision,
  StaleRegionComposition,
} from '../../types/index.js';

/** Stable, reproducible hash of a source span (or whole file). Unnormalized. */
export function hashSpan(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Minimal node view the anchor engine needs to resolve a symbol to an anchor. */
export interface AnchorNode {
  id: string;
  name: string;
  filePath: string;
  /** Current hash of the node's source span. */
  contentHash: string;
  /** Content-addressed stable id, when the symbol has a derivable one. */
  stableId?: string;
}

/** Current-state lookups used to compute freshness against the live graph. */
export interface GraphFreshnessView {
  /** Current content hash for a node id, or `undefined` if the node is gone. */
  nodeHash(nodeId: string): string | undefined;
  fileExists(filePath: string): boolean;
  /** Current whole-file content hash, or `undefined` if the file is gone. */
  fileHash(filePath: string): string | undefined;
  /**
   * Resolve a symbol by its content-addressed stable id when its `nodeId` no
   * longer matches (the symbol was moved/renamed-file but otherwise survives).
   * Returns the relocated node's id + current span hash, or `undefined` when no
   * unambiguous node carries that stable id. Optional — absent on legacy views.
   * (change: add-content-addressed-stable-symbol-ids)
   *
   * Resolution is unique-only: because `stableId` is name+parameter-shape (a
   * homonym — a genuinely different symbol with the same name and signature —
   * shares it), the resolver returns a node only when exactly one carries the id,
   * never guessing between candidates. A residual false-`fresh` is still possible
   * if a homonym is the sole survivor AND its span hash happens to equal the
   * recorded one; the content-hash equality check in `anchorFreshness` is the
   * guard that makes any *changed* survivor read `drifted` instead. During an
   * incremental cross-file move the old and new rows can briefly both carry the id
   * (ambiguous → `undefined` → falls through to `orphaned`); the state self-heals
   * once the batch finishes and is corrected by the next full analyze.
   */
  resolveStableId?(stableId: string): { nodeId: string; contentHash: string } | undefined;
  /**
   * Confident rename mapping: given an absent node id, the new location label
   * (e.g. `newFile.ts::newName`) when `structural_diff` mapped it, else undefined.
   * Optional — when absent, a missing symbol is always `orphaned`.
   */
  renameOf?(nodeId: string): string | undefined;
  /**
   * True when the node lies in an explicitly-marked stale region — its
   * surrounding topology was NOT recomputed by a budget-exceeded incremental
   * update (fix-transitive-incremental-staleness). A symbol whose own span is
   * unchanged can still sit in a stale region; this lets the verdict reflect
   * that the topology around it may have diverged. Optional — absent on legacy
   * views, where nothing is ever stale-by-region.
   */
  inStaleRegion?(nodeId: string): boolean;
  /**
   * True when the FILE is in an explicitly-marked stale region — the file-level
   * counterpart of {@link inStaleRegion}, used for file-level anchors that carry
   * no `nodeId` (fix-transitive-incremental-staleness).
   */
  fileInStaleRegion?(filePath: string): boolean;
  /** Persisted structural context for a stale file's region. */
  staleRegionComposition?(filePath: string): StaleRegionComposition | undefined;
}

/**
 * Resolve symbol names to symbol-level anchors deterministically. A name resolves
 * only when it matches exactly one internal node — optionally narrowed to the
 * given `preferFiles` first. Ambiguous or unknown names are skipped (no guessing);
 * callers fall back to file-level anchoring for those.
 */
export function resolveSymbolAnchors(
  symbolNames: readonly string[],
  nodes: readonly AnchorNode[],
  preferFiles?: readonly string[],
): StructuralAnchor[] {
  const out: StructuralAnchor[] = [];
  const seen = new Set<string>();
  const prefer = preferFiles ? new Set(preferFiles) : null;

  for (const name of new Set(symbolNames)) {
    let matches = nodes.filter((n) => n.name === name);
    if (prefer && matches.length > 1) {
      const narrowed = matches.filter((n) => prefer.has(n.filePath));
      if (narrowed.length >= 1) matches = narrowed;
    }
    if (matches.length !== 1) continue; // unknown or ambiguous — do not guess
    const node = matches[0];
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push({
      nodeId: node.id,
      ...(node.stableId ? { stableId: node.stableId } : {}),
      symbolName: node.name,
      filePath: node.filePath,
      contentHash: node.contentHash,
    });
  }
  return out;
}

/** Build a file-level anchor, capturing the file content hash when available. */
export function fileAnchor(filePath: string, contentHash?: string): StructuralAnchor {
  return contentHash === undefined ? { filePath } : { filePath, contentHash };
}

/**
 * Compute the freshness verdict for a single anchor against the current graph.
 * Inputs are booleans only — no threshold, no score.
 */
export function anchorFreshness(
  anchor: StructuralAnchor,
  view: GraphFreshnessView,
): AnchorVerdict {
  // Symbol-level anchor.
  if (anchor.nodeId) {
    const current = view.nodeHash(anchor.nodeId);
    // nodeId takes precedence: a still-resolving node is decided here, never via
    // stableId (add-content-addressed-stable-symbol-ids).
    if (current !== undefined) {
      // The symbol still exists. If its own span changed it is `drifted` already.
      // If it is UNCHANGED but sits in an explicitly-marked stale region, the
      // surrounding topology was not recomputed — do NOT report `fresh`; downgrade
      // to `drifted` so it is never served as authoritative
      // (fix-transitive-incremental-staleness, FreshnessVerdictsHonorTheStaleRegion).
      if (current === anchor.contentHash && view.inStaleRegion?.(anchor.nodeId)) {
        return {
          anchor,
          freshness: 'drifted',
          staleRegion: true,
          staleRegionComposition: view.staleRegionComposition?.(anchor.filePath),
        };
      }
      return { anchor, freshness: current === anchor.contentHash ? 'fresh' : 'drifted' };
    }
    // nodeId miss — the symbol may have moved/renamed-file. Re-resolve by its
    // content-addressed stable id: a relocated-but-unchanged symbol is `fresh`,
    // a relocated-and-changed one is `drifted` — no longer `orphaned`.
    if (anchor.stableId) {
      const relocated = view.resolveStableId?.(anchor.stableId);
      if (relocated) {
        return {
          anchor,
          freshness: relocated.contentHash === anchor.contentHash ? 'fresh' : 'drifted',
          relocatedTo: relocated.nodeId,
        };
      }
    }
    // Last resort — the existing heuristic rename map, then orphaned.
    const relocatedTo = view.renameOf?.(anchor.nodeId);
    return relocatedTo
      ? { anchor, freshness: 'drifted', relocatedTo }
      : { anchor, freshness: 'orphaned' };
  }

  // File-level anchor.
  if (!view.fileExists(anchor.filePath)) {
    return { anchor, freshness: 'orphaned' };
  }
  // A file in an explicitly-marked stale region is not authoritative even when
  // its content hash matches — its topology was not recomputed. Mirror the
  // symbol-level rule: downgrade only the otherwise-`fresh` outcomes, so a file
  // that genuinely changed stays plain `drifted`
  // (fix-transitive-incremental-staleness, FreshnessVerdictsHonorTheStaleRegion).
  const stale = view.fileInStaleRegion?.(anchor.filePath) ?? false;
  // A truly legacy anchor has no baseline hash — existence is all we can prove.
  if (anchor.contentHash === undefined) {
    return stale ? {
      anchor,
      freshness: 'drifted',
      staleRegion: true,
      staleRegionComposition: view.staleRegionComposition?.(anchor.filePath),
    } : { anchor, freshness: 'fresh' };
  }
  const current = view.fileHash(anchor.filePath);
  if (current === anchor.contentHash) {
    return stale ? {
      anchor,
      freshness: 'drifted',
      staleRegion: true,
      staleRegionComposition: view.staleRegionComposition?.(anchor.filePath),
    } : { anchor, freshness: 'fresh' };
  }
  return { anchor, freshness: 'drifted' };
}

const FRESHNESS_RANK: Record<MemoryFreshness, number> = {
  fresh: 0,
  drifted: 1,
  orphaned: 2,
};

/**
 * A memory's overall verdict is the worst of its anchors' verdicts
 * (orphaned > drifted > fresh). An unanchored memory is `fresh` — there is
 * nothing to invalidate; callers report `anchored: false` separately.
 */
export function aggregateFreshness(verdicts: readonly AnchorVerdict[]): MemoryFreshness {
  let worst: MemoryFreshness = 'fresh';
  for (const v of verdicts) {
    if (FRESHNESS_RANK[v.freshness] > FRESHNESS_RANK[worst]) worst = v.freshness;
  }
  return worst;
}

/** Compute per-anchor verdicts and the aggregate for a whole memory. */
export function memoryFreshness(
  anchors: readonly StructuralAnchor[],
  view: GraphFreshnessView,
): { freshness: MemoryFreshness; verdicts: AnchorVerdict[]; anchored: boolean } {
  const verdicts = anchors.map((a) => anchorFreshness(a, view));
  return {
    freshness: aggregateFreshness(verdicts),
    verdicts,
    anchored: anchors.length > 0,
  };
}

/**
 * True when a memory's non-`fresh` aggregate is due ONLY to the explicit stale
 * region — every drifted anchor is a stale-region downgrade and nothing is
 * orphaned or genuinely content-drifted (fix-transitive-incremental-staleness).
 * The anchored code is byte-identical; its surrounding topology simply was not
 * recomputed by a budget-exceeded incremental update and will self-heal. Callers
 * use this to label it honestly ("not yet reconciled") instead of asserting the
 * code changed, and the drift detector uses it to NOT report a false code-drift.
 */
export function isStaleRegionOnly(verdicts: readonly AnchorVerdict[]): boolean {
  let sawStaleRegionDrift = false;
  for (const v of verdicts) {
    if (v.freshness === 'orphaned') return false;
    if (v.freshness === 'drifted') {
      if (!v.staleRegion) return false; // a genuine content drift is present
      sawStaleRegionDrift = true;
    }
  }
  return sawStaleRegionDrift;
}

// ── contradiction surfacing (add-bitemporal-typed-memory-operations) ──────────

/** A memory reduced to what deterministic contradiction detection needs. */
export interface AnchoredItem {
  id: string;
  anchors: readonly StructuralAnchor[];
  /** Aggregate freshness — only `fresh` items participate. */
  freshness: MemoryFreshness;
  /** When true (superseded/invalidated) the item is excluded. */
  invalidated?: boolean;
}

/** Two or more authoritative memories that all anchor to the same symbol. */
export interface UnreconciledGroup {
  /** The shared resolved symbol key (`stableId` ?? `nodeId`). */
  symbol: string;
  /** The symbol's name, when known (for display). */
  symbolName?: string;
  /** The symbol's file, when known (for display). */
  filePath?: string;
  /** Ids of the authoritative memories sharing this symbol (sorted, ≥ 2). */
  memberIds: string[];
}

/**
 * Detect `unreconciled` pairs: when two or more authoritative (`fresh`,
 * non-invalidated) memories resolve to the SAME symbol anchor, they may contradict
 * and the agent should reconcile or supersede one. This is a pure set intersection
 * over symbol-level anchors — no LLM decides which wins, and "same file" is too coarse
 * to count (file-level anchors are ignored). Deterministic and order-independent.
 */
export function findUnreconciled(items: readonly AnchoredItem[]): UnreconciledGroup[] {
  const byKey = new Map<string, { symbolName?: string; filePath?: string; ids: Set<string> }>();
  for (const it of items) {
    if (it.invalidated || it.freshness !== 'fresh') continue;
    for (const a of it.anchors) {
      if (!a.nodeId) continue; // symbol-level only
      const key = a.stableId ?? a.nodeId;
      const entry = byKey.get(key) ?? { symbolName: a.symbolName, filePath: a.filePath, ids: new Set<string>() };
      entry.ids.add(it.id);
      byKey.set(key, entry);
    }
  }
  const out: UnreconciledGroup[] = [];
  for (const [symbol, entry] of byKey) {
    if (entry.ids.size >= 2) {
      out.push({ symbol, symbolName: entry.symbolName, filePath: entry.filePath, memberIds: [...entry.ids].sort() });
    }
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * The anchors to check freshness against for a decision: its explicit structural
 * anchors when present, otherwise existence-only file-level anchors derived from
 * `affectedFiles` (legacy decisions recorded before anchoring). Shared by recall,
 * orient, and the drift detector so they agree on what a decision is bound to.
 */
export function decisionAnchors(
  d: Pick<PendingDecision, 'anchors' | 'affectedFiles'>,
): StructuralAnchor[] {
  if (d.anchors?.length) return d.anchors;
  return d.affectedFiles.map((filePath) => ({ filePath }));
}
