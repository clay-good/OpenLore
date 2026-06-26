/**
 * Disk-backed carry-forward of anchored memory/decisions across a rename/move.
 * (change: add-symbol-identity-continuity)
 *
 * After a re-analysis, a symbol that was renamed or moved would orphan every
 * memory and decision anchored to it — accumulated, still-true knowledge silently
 * lost exactly when the codebase is being actively refactored. This module closes
 * that gap: it computes the deterministic continuity map between the symbols that
 * disappeared (anchors that no longer resolve) and the symbols that appeared (new
 * nodes absent before), then re-points the surviving anchors to their new symbol,
 * recording `carriedAcross` provenance so the move is auditable.
 *
 * Discipline:
 *  - Carry forward ONLY on the unambiguous one-to-one matches from
 *    {@link computeContinuity} (`exact-body` / `exact-signature`); ambiguity is
 *    surfaced as `possiblyMovedTo`, never resolved by guessing.
 *  - The anchor's `contentHash` baseline is preserved, NOT re-stamped: an
 *    exact-body carry then recalls `fresh`, an exact-signature carry (the rename
 *    changed the span) recalls `drifted` — both annotated as carried. This keeps
 *    the existing freshness engine the single source of truth.
 *  - Specs are not symbol-anchored in this codebase (they are regenerated, file-
 *    level artifacts), so there is nothing to carry forward for them — out of scope
 *    by construction, not by omission.
 *  - Pure detection lives in `../analyzer/continuity.ts`; this module only does the
 *    disk read/match/write. The re-anchor transform ({@link reanchorAnchors}) is a
 *    pure function so it is unit-tested without disk.
 */

import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../constants.js';
import { EdgeStore } from '../services/edge-store.js';
import type {
  StructuralAnchor,
  ContinuityProvenance,
} from '../../types/index.js';
import { hashSpan } from './anchor.js';
import { nodeSpanText } from './anchor-adapter.js';
import {
  computeContinuity,
  normalizedBodyHash,
  bodyMatchesModuloName,
  type DisappearedSymbol,
  type AppearedSymbol,
  type ContinuityPair,
  type AmbiguousContinuity,
} from '../analyzer/continuity.js';
import { loadMemoryStore, updateMemoryStore } from './memory-store.js';
import { loadDecisionStore, updateDecisionStore } from './store.js';
import { getHeadCommit } from './git-time.js';

/** Minimal view of an old (pre-re-analysis) node, snapshotted before the rebuild. */
export interface OldNodeSnapshot {
  id: string;
  stableId?: string;
  name: string;
  filePath: string;
}

export interface CarryForwardSummary {
  /** Confident `(old → new)` pairs whose anchors were carried. */
  carried: ContinuityPair[];
  /** Disappeared anchored symbols left ambiguous (disclosed via `possiblyMovedTo`). */
  ambiguous: AmbiguousContinuity[];
  memoriesUpdated: number;
  decisionsUpdated: number;
}

const EMPTY_SUMMARY: CarryForwardSummary = {
  carried: [],
  ambiguous: [],
  memoriesUpdated: 0,
  decisionsUpdated: 0,
};

function analysisDir(rootPath: string): string {
  return join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
}

/**
 * Snapshot the minimal old-node view from a persisted graph BEFORE it is rebuilt.
 * Call this just before re-analysis overwrites the store; the result is the
 * `oldNodes` input to {@link carryForwardContinuity}. Returns `[]` when no prior
 * graph exists (the first analysis — nothing to carry from).
 */
export function snapshotOldNodes(storeDir: string): OldNodeSnapshot[] {
  if (!EdgeStore.exists(storeDir)) return [];
  let store: EdgeStore;
  try {
    store = EdgeStore.open(EdgeStore.dbPath(storeDir));
  } catch {
    return [];
  }
  try {
    return store.getAllInternalNodes().map((n) => ({
      id: n.id,
      ...(n.stableId ? { stableId: n.stableId } : {}),
      name: n.name,
      filePath: n.filePath,
    }));
  } catch {
    return [];
  } finally {
    try { store.close(); } catch { /* ignore */ }
  }
}

/** Stable key identifying the old symbol an anchor points at. */
function fromKey(nodeId: string): string {
  return nodeId;
}

/**
 * Re-point anchors across the continuity map (PURE). For each anchor that resolves
 * to a pair's `from` symbol, rewrite its identity fields to the `to` symbol and
 * stamp `carriedAcross` provenance (the `contentHash` baseline is preserved). For
 * each anchor whose old symbol was ambiguous, attach `possiblyMovedTo` candidates.
 * Returns the new anchor list and whether anything changed.
 */
export function reanchorAnchors(
  anchors: readonly StructuralAnchor[],
  pairByFrom: ReadonlyMap<string, ContinuityPair>,
  ambiguousByFrom: ReadonlyMap<string, AmbiguousContinuity>,
  atCommit?: string,
): { anchors: StructuralAnchor[]; changed: boolean } {
  let changed = false;
  const next = anchors.map((a) => {
    if (!a.nodeId) return a;
    const pair = pairByFrom.get(fromKey(a.nodeId));
    if (pair) {
      changed = true;
      const provenance: ContinuityProvenance = {
        from: { ...(a.symbolName ? { symbolName: a.symbolName } : {}), filePath: a.filePath },
        reason: pair.reason,
        basis: pair.basis,
        ...(atCommit ? { atCommit } : {}),
      };
      return {
        ...a,
        nodeId: pair.to.id,
        ...(pair.to.stableId ? { stableId: pair.to.stableId } : {}),
        symbolName: pair.to.name,
        filePath: pair.to.filePath,
        // contentHash baseline preserved on purpose (see module header).
        carriedAcross: provenance,
        // a carried anchor is no longer "possibly moved" — clear any prior hint.
        ...(a.possiblyMovedTo ? { possiblyMovedTo: undefined } : {}),
      } as StructuralAnchor;
    }
    const amb = ambiguousByFrom.get(fromKey(a.nodeId));
    if (amb) {
      const labels = amb.candidates.map((c) => `${c.filePath}::${c.name}`);
      // Idempotent: skip if already identical.
      const prior = a.possiblyMovedTo ?? [];
      if (prior.length === labels.length && prior.every((p, i) => p === labels[i])) return a;
      changed = true;
      return { ...a, possiblyMovedTo: labels } as StructuralAnchor;
    }
    return a;
  });
  return { anchors: next, changed };
}

/**
 * Build the disappeared / appeared symbol sets and compute the continuity map.
 *
 * `disappeared` are the DISTINCT old symbols (by old nodeId) referenced by some
 * persisted anchor that no longer resolve in the new store. `appeared` are the new
 * internal NON-TEST nodes absent from the old snapshot (a memory is never carried
 * onto a test helper). `newNormBodyCount` counts each name-independent body across
 * ALL new internal nodes (including pre-existing and test nodes) so an
 * `exact-signature` carry is rejected when an identical body exists elsewhere.
 */
function buildContinuity(
  rootPath: string,
  store: EdgeStore,
  oldNodes: readonly OldNodeSnapshot[],
  anchoredSymbols: ReadonlyMap<string, { nodeId: string; stableId?: string; contentHash?: string }>,
): ReturnType<typeof computeContinuity> {
  const cache = new Map<string, string | null>();
  const oldById = new Map(oldNodes.map((n) => [n.id, n]));
  const oldIds = new Set(oldNodes.map((n) => n.id));
  const oldStableIds = new Set(oldNodes.map((n) => n.stableId).filter((s): s is string => !!s));

  // Disappeared: an anchored old symbol whose nodeId is gone AND whose stableId
  // does not uniquely resolve in the new store (so it is genuinely orphaned, not a
  // move the stableId resolver already handles).
  const disappeared: DisappearedSymbol[] = [];
  for (const sym of anchoredSymbols.values()) {
    if (store.getNode(sym.nodeId)) continue; // survived under the same id
    if (sym.stableId && store.getNodeByStableId(sym.stableId)) continue; // resolved by stable id
    const old = oldById.get(sym.nodeId);
    if (!old) continue; // no old snapshot for it (e.g. first analysis) — cannot match
    disappeared.push({
      nodeId: sym.nodeId,
      ...(sym.stableId ? { stableId: sym.stableId } : {}),
      name: old.name,
      filePath: old.filePath,
      ...(sym.contentHash ? { contentHash: sym.contentHash } : {}),
    });
  }
  if (disappeared.length === 0) return { pairs: [], ambiguous: [] };

  const allNew = store.getAllInternalNodes();

  // Pass 1 (cheap): read + hash spans ONLY for the appeared (new, non-test) nodes —
  // the carry candidates. On a rename this is a handful of nodes, not the whole graph.
  const appeared: AppearedSymbol[] = [];
  for (const node of allNew) {
    if (node.isTest) continue; // never carry a memory onto a test symbol
    if (oldIds.has(node.id)) continue;
    if (node.stableId && oldStableIds.has(node.stableId)) continue;
    const spanText = nodeSpanText(rootPath, node, cache);
    if (spanText === undefined) continue;
    appeared.push({
      id: node.id,
      ...(node.stableId ? { stableId: node.stableId } : {}),
      name: node.name,
      filePath: node.filePath,
      contentHash: hashSpan(spanText),
      spanText,
      normBodyHash: normalizedBodyHash(spanText, node.name),
    });
  }

  // The name-independent-body uniqueness guard is only consulted for an
  // `exact-signature` (rename) candidate that has no `exact-body` (move) match.
  // Computing it requires normalizing EVERY new node's body — expensive on a large
  // graph — so do it ONLY when such a candidate actually exists (a real rename),
  // never on the common no-rename / move-only / delete-only path.
  const needsFullCount = disappeared.some(
    (d) =>
      d.contentHash !== undefined &&
      !appeared.some((a) => a.contentHash === d.contentHash) && // no exact-body match
      appeared.some((a) => bodyMatchesModuloName(a.spanText, a.name, d.name, d.contentHash!)),
  );
  const newNormBodyCount = new Map<string, number>();
  if (needsFullCount) {
    for (const node of allNew) {
      const spanText = nodeSpanText(rootPath, node, cache); // cached from Pass 1 where overlapping
      if (spanText === undefined) continue;
      const normBodyHash = normalizedBodyHash(spanText, node.name);
      newNormBodyCount.set(normBodyHash, (newNormBodyCount.get(normBodyHash) ?? 0) + 1);
    }
  }

  return computeContinuity(disappeared, appeared, newNormBodyCount);
}

/**
 * Carry anchored memory + decisions forward across renames/moves detected between
 * the pre-re-analysis `oldNodes` snapshot and the freshly persisted graph. Safe to
 * call on every `openlore analyze`: a cheap no-op when there are no anchored
 * symbols or no prior snapshot. Read-only on the call graph; writes only the
 * memory/decision stores, and only when something actually moved.
 */
export async function carryForwardContinuity(
  rootPath: string,
  oldNodes: readonly OldNodeSnapshot[],
  storeDir: string = analysisDir(rootPath),
): Promise<CarryForwardSummary> {
  if (oldNodes.length === 0) return EMPTY_SUMMARY;

  const [memStore, decisionStore] = await Promise.all([
    loadMemoryStore(rootPath),
    loadDecisionStore(rootPath),
  ]);

  // Collect the distinct symbol-level anchors across both stores. (File-level
  // anchors have no symbol identity to carry.)
  const anchoredSymbols = new Map<string, { nodeId: string; stableId?: string; contentHash?: string }>();
  const collect = (anchors: readonly StructuralAnchor[] | undefined): void => {
    for (const a of anchors ?? []) {
      if (!a.nodeId) continue;
      if (!anchoredSymbols.has(a.nodeId)) {
        anchoredSymbols.set(a.nodeId, { nodeId: a.nodeId, stableId: a.stableId, contentHash: a.contentHash });
      }
    }
  };
  for (const m of memStore.memories) collect(m.anchors);
  for (const d of decisionStore.decisions) collect(d.anchors);
  if (anchoredSymbols.size === 0) return EMPTY_SUMMARY;

  if (!EdgeStore.exists(storeDir)) return EMPTY_SUMMARY;
  let store: EdgeStore;
  try {
    store = EdgeStore.open(EdgeStore.dbPath(storeDir));
  } catch {
    return EMPTY_SUMMARY;
  }

  let result: ReturnType<typeof computeContinuity>;
  try {
    result = buildContinuity(rootPath, store, oldNodes, anchoredSymbols);
  } finally {
    try { store.close(); } catch { /* ignore */ }
  }

  if (result.pairs.length === 0 && result.ambiguous.length === 0) return EMPTY_SUMMARY;

  const pairByFrom = new Map(result.pairs.map((p) => [fromKey(p.from.nodeId), p]));
  const ambiguousByFrom = new Map(result.ambiguous.map((a) => [fromKey(a.from.nodeId), a]));
  const atCommit = await getHeadCommit(rootPath);

  let memoriesUpdated = 0;
  let decisionsUpdated = 0;

  // Persist memory re-anchors.
  if (memStore.memories.some((m) => m.anchors?.some((a) => a.nodeId && (pairByFrom.has(a.nodeId) || ambiguousByFrom.has(a.nodeId))))) {
    await updateMemoryStore(rootPath, (store_) => ({
      ...store_,
      memories: store_.memories.map((m) => {
        const { anchors, changed } = reanchorAnchors(m.anchors, pairByFrom, ambiguousByFrom, atCommit);
        if (changed) memoriesUpdated++;
        return changed ? { ...m, anchors } : m;
      }),
    }));
  }

  // Persist decision re-anchors (only decisions that carry explicit anchors).
  if (decisionStore.decisions.some((d) => d.anchors?.some((a) => a.nodeId && (pairByFrom.has(a.nodeId) || ambiguousByFrom.has(a.nodeId))))) {
    await updateDecisionStore(rootPath, (store_) => ({
      ...store_,
      decisions: store_.decisions.map((d) => {
        if (!d.anchors?.length) return d;
        const { anchors, changed } = reanchorAnchors(d.anchors, pairByFrom, ambiguousByFrom, atCommit);
        if (changed) decisionsUpdated++;
        return changed ? { ...d, anchors } : d;
      }),
    }));
  }

  return { carried: result.pairs, ambiguous: result.ambiguous, memoriesUpdated, decisionsUpdated };
}
