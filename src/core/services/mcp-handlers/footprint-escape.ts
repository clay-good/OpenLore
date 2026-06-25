/**
 * Footprint escape detection — the back-side safety net of
 * PARALLEL-WORK-COORDINATION (change: add-footprint-escape-detection, proposal 3).
 *
 * Proposals 1 and 2 plan a swarm from *predicted* (declared) write-footprints.
 * That prediction is advisory by construction: an agent can edit outside its
 * declared region. This module is the after-the-fact check that compares a task's
 * *declared* write-footprint against the symbols its diff *actually* modified, and
 * recomputes the peer conflicts the escape newly opens. It is the missing half of a
 * borrow checker that can only advise: OpenLore cannot reject a write, but it can
 * detect the escape and hand the verdict to whoever can act on it.
 *
 * Design invariants (mirror the proposal's Decision + Scope contract):
 * - **Pure and deterministic.** The escape set, the newly-opened conflicts, and the
 *   registry resolutions are a deterministic function of (actual modified symbols,
 *   declared footprint, supplied peer footprints). No persistence, no roster, no
 *   clock, no LLM.
 * - **Stateless.** OpenLore holds no roster of agents/tasks/in-flight footprints.
 *   The declared footprint and peer footprints are per-call *inputs* supplied by the
 *   caller; nothing survives the call.
 * - **Dormant by default.** With no declared footprint supplied, the feature does
 *   nothing — `structural_diff` is byte-identical to today (enforced upstream).
 * - **Advisory, not a block.** Escapes become {@link import('./enforcement-policy.js').GovernanceFinding}s;
 *   gating is opt-in via `enforcement.policy`; the harness enforces.
 * - **Honest about reach.** Detection is structural. An escape that creates only a
 *   *semantic* (non-call, non-write) conflict can still slip through; the disclosure
 *   says so.
 */

import type { GovernanceFinding } from './enforcement-policy.js';
import type { WriteMode } from './change-footprint.js';

/**
 * How a symbol's source actually changed in the diff. Computed by
 * `structural_diff` (which holds the old/new source); this module consumes it.
 *
 * - `added` — a brand-new symbol (no base version). A pure addition by nature.
 * - `removed` — a symbol deleted by the diff.
 * - `pure-addition` — an existing symbol whose body only *gained* lines (every base
 *   line preserved in order). A new switch case, a new registry element — the edit a
 *   git 3-way-merge resolves trivially.
 * - `modifies-existing` — an existing symbol where at least one base line was changed
 *   or removed. The edit that genuinely clobbers shared code.
 */
export type EditNature = 'added' | 'removed' | 'pure-addition' | 'modifies-existing';

/** A symbol the diff actually modified, with the nature of the edit. */
export interface ModifiedSymbol {
  /** Path-based node id (`file::name`) — the same id space declared footprints use. */
  id: string;
  name: string;
  filePath: string;
  editNature: EditNature;
}

/**
 * A declared footprint as supplied by the caller. A structural subset of proposal
 * 1's `Footprint` (caller may pass the full object; only these fields are read).
 * Validated/normalized at the boundary by {@link normalizeDeclaredFootprint}.
 */
export interface DeclaredFootprintInput {
  taskId?: string;
  writeSet?: Array<{ id?: unknown; filePath?: unknown; writeMode?: unknown }>;
  /** Symbol ids the task declared it would only *read*. */
  readSet?: unknown[];
}

/** A normalized declared footprint: clean id sets, ready for set algebra. */
export interface NormalizedFootprint {
  taskId: string;
  /** Declared write ids → declared write mode. */
  writeModeById: Map<string, WriteMode>;
  /** Files that contain at least one declared write symbol. */
  writeFiles: Set<string>;
  /** Declared read-only ids. */
  readIds: Set<string>;
}

/** How a modified symbol escaped its declared write-footprint. */
export type EscapeClass =
  /** Modified a symbol absent from the declared write-set, in a file never declared. */
  | 'out-of-scope-write'
  /** Modified a symbol that appeared only in the declared *read*-set. */
  | 'read-set-intrusion'
  /** Added/modified a symbol in a declared *file* but not the declared write-set (lower severity). */
  | 'scope-creep-within-file';

export interface EscapeItem {
  id: string;
  name: string;
  filePath: string;
  classification: EscapeClass;
  editNature: EditNature;
}

/** The verdict of comparing the actual diff against a peer's declared write on a shared symbol. */
export type ContentionVerdict = 'WAW' | 'resolved-by-merge';

export interface NewlyOpenedConflict {
  /** The shared symbol id. */
  symbol: string;
  name: string;
  filePath: string;
  /** The peer task whose declared write-set the escape landed in. */
  peerTaskId: string;
  verdict: ContentionVerdict;
  /** Plain-language reason for the verdict. */
  reason: string;
}

/** A registration-site collision the actual diff confirmed merges cleanly. */
export interface RegistryResolution {
  symbol: string;
  name: string;
  filePath: string;
  peerTaskId: string;
  reason: string;
}

/** A write declared `append` at plan time whose diff actually modified existing code. */
export interface MisDeclaredAppend {
  symbol: string;
  name: string;
  filePath: string;
}

export interface EscapeAnalysis {
  declaredTaskId: string;
  /** Symbols the diff modified outside the declared write-set, classified. Sorted by id. */
  escapes: EscapeItem[];
  /** New write-write conflicts an escape opened against a supplied peer. Sorted. */
  newlyOpenedConflicts: NewlyOpenedConflict[];
  /** Registration-site collisions the actual diff confirmed resolve by merge. Sorted. */
  registryResolutions: RegistryResolution[];
  /** Declared appends the diff actually violated. Sorted. */
  misDeclaredAppends: MisDeclaredAppend[];
  /** Governance findings for the enforcement policy (advisory by default). */
  findings: GovernanceFinding[];
  summary: {
    modifiedSymbols: number;
    escapes: number;
    outOfScopeWrites: number;
    readSetIntrusions: number;
    scopeCreep: number;
    newlyOpenedConflicts: number;
    registryResolutions: number;
    misDeclaredAppends: number;
  };
  disclosure: string;
}

export const ESCAPE_DISCLOSURE =
  'Escape detection is structural: it catches out-of-scope writes, read-set ' +
  'intrusions, and write-write conflicts an escape opens against a declared peer ' +
  'write-set. It cannot catch a purely semantic conflict (a shared invariant broken ' +
  'with no shared write or call edge). A resolved-by-merge verdict confirms THIS ' +
  "diff's edit is a pure addition and trusts the peer's *declared* append; true " +
  'non-overlap of two realized diffs requires running the check against both diffs. ' +
  'Detection narrows the soundness gap; it does not close it.';

/** Tolerant string coercion for an untrusted id/file field. */
function asId(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Normalize a caller-supplied declared footprint into clean id sets. Tolerant of
 * partial/foreign shapes (the caller may pass proposal 1's full `Footprint` or a
 * hand-built subset); malformed members are dropped, never thrown on.
 */
export function normalizeDeclaredFootprint(
  input: DeclaredFootprintInput | null | undefined,
  fallbackTaskId = 'declared',
): NormalizedFootprint {
  const writeModeById = new Map<string, WriteMode>();
  const writeFiles = new Set<string>();
  const readIds = new Set<string>();
  if (input && Array.isArray(input.writeSet)) {
    for (const w of input.writeSet) {
      const id = asId(w?.id);
      if (!id) continue;
      const mode: WriteMode = w?.writeMode === 'append' ? 'append' : 'modify';
      writeModeById.set(id, mode);
      const file = asId(w?.filePath);
      if (file) writeFiles.add(file);
    }
  }
  if (input && Array.isArray(input.readSet)) {
    for (const r of input.readSet) {
      const id = asId(r);
      if (id) readIds.add(id);
    }
  }
  return {
    taskId: asId(input?.taskId) ?? fallbackTaskId,
    writeModeById,
    writeFiles,
    readIds,
  };
}

/** Classify how a modified symbol escaped, given the declared regions. Pure. */
function classifyEscape(sym: ModifiedSymbol, declared: NormalizedFootprint): EscapeClass | null {
  if (declared.writeModeById.has(sym.id)) return null; // in scope — not an escape
  // Precedence: a read-only symbol that got written is the sharpest signal; then a
  // new/changed symbol inside a declared file (benign scope creep); else fully
  // out-of-scope (a file the task never declared at all).
  if (declared.readIds.has(sym.id)) return 'read-set-intrusion';
  if (declared.writeFiles.has(sym.filePath)) return 'scope-creep-within-file';
  return 'out-of-scope-write';
}

/** Whether the actual edit on a symbol is a clean addition (eligible for resolved-by-merge). */
function isPureAddition(nature: EditNature): boolean {
  return nature === 'added' || nature === 'pure-addition';
}

/** Stable byte-order compare so output is reproducible across locales. */
function byId<T extends { symbol?: string; id?: string }>(a: T, b: T): number {
  const ka = a.id ?? a.symbol ?? '';
  const kb = b.id ?? b.symbol ?? '';
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Compute the escape analysis for one actual diff against its declared footprint
 * and a set of peer footprints. Pure and deterministic: identical inputs yield a
 * byte-identical result.
 */
export function analyzeEscape(
  modifiedSymbols: readonly ModifiedSymbol[],
  declared: NormalizedFootprint,
  peers: readonly NormalizedFootprint[],
): EscapeAnalysis {
  // De-dup modified symbols by id (a symbol can surface from more than one diff
  // category); keep the strongest edit nature (modifies-existing > pure-addition).
  const bySymbol = new Map<string, ModifiedSymbol>();
  for (const m of modifiedSymbols) {
    const prev = bySymbol.get(m.id);
    if (!prev) { bySymbol.set(m.id, m); continue; }
    if (prev.editNature !== 'modifies-existing' && m.editNature === 'modifies-existing') {
      bySymbol.set(m.id, m);
    }
  }
  const modified = [...bySymbol.values()];

  // ── Escape set ──────────────────────────────────────────────────────────────
  const escapes: EscapeItem[] = [];
  for (const sym of modified) {
    const cls = classifyEscape(sym, declared);
    if (cls) {
      escapes.push({ id: sym.id, name: sym.name, filePath: sym.filePath, classification: cls, editNature: sym.editNature });
    }
  }
  escapes.sort(byId);
  const escapedIds = new Set(escapes.map(e => e.id));

  // ── Newly-opened conflicts + registry resolutions ───────────────────────────
  // A contention exists when a symbol THIS diff actually modified is also in a
  // peer's DECLARED write-set. We see our side's real edit; the peer's is declared.
  const newlyOpenedConflicts: NewlyOpenedConflict[] = [];
  const registryResolutions: RegistryResolution[] = [];
  for (const peer of peers) {
    if (peer.taskId === declared.taskId) continue; // a task never conflicts with itself
    for (const sym of modified) {
      const peerMode = peer.writeModeById.get(sym.id);
      if (!peerMode) continue; // peer does not declare a write here
      const ourPureAddition = isPureAddition(sym.editNature);
      if (ourPureAddition && peerMode === 'append') {
        // Both sides additive (ours confirmed by the diff, peer's declared) →
        // the registration-site collision merges. The back-side of shared-append.
        registryResolutions.push({
          symbol: sym.id, name: sym.name, filePath: sym.filePath, peerTaskId: peer.taskId,
          reason: `This diff adds to "${sym.name}" without modifying existing code and peer "${peer.taskId}" declared an append; the collision resolves by merge.`,
        });
        continue;
      }
      // A real write-write conflict. It is "newly opened" only when the symbol was
      // NOT in this task's own declared write-set (i.e. it is an escape). A symbol in
      // both declared write-sets was already known to the plan and is not re-reported
      // here as new — though the verdict still confirms it.
      if (!escapedIds.has(sym.id)) continue;
      const reason = ourPureAddition
        ? `Out-of-scope write to "${sym.name}" lands in peer "${peer.taskId}"'s write-set; peer declared a modify, so the additions are not known to merge.`
        : sym.editNature === 'removed'
          ? `Out-of-scope edit REMOVES "${sym.name}", which is in peer "${peer.taskId}"'s declared write-set — a freshly-created write-write conflict.`
          : `Out-of-scope edit modifies existing code in "${sym.name}", which is in peer "${peer.taskId}"'s declared write-set — a freshly-created write-write conflict.`;
      newlyOpenedConflicts.push({
        symbol: sym.id, name: sym.name, filePath: sym.filePath, peerTaskId: peer.taskId,
        verdict: 'WAW', reason,
      });
    }
  }
  newlyOpenedConflicts.sort((a, b) => byId(a, b) || (a.peerTaskId < b.peerTaskId ? -1 : a.peerTaskId > b.peerTaskId ? 1 : 0));
  registryResolutions.sort((a, b) => byId(a, b) || (a.peerTaskId < b.peerTaskId ? -1 : a.peerTaskId > b.peerTaskId ? 1 : 0));

  // ── Mis-declared appends ────────────────────────────────────────────────────
  // A symbol THIS task declared with writeMode `append`, whose diff actually
  // modified existing code. Independent of peers — a self-check on the declaration.
  const misDeclaredAppends: MisDeclaredAppend[] = [];
  for (const sym of modified) {
    if (declared.writeModeById.get(sym.id) === 'append' && sym.editNature === 'modifies-existing') {
      misDeclaredAppends.push({ symbol: sym.id, name: sym.name, filePath: sym.filePath });
    }
  }
  misDeclaredAppends.sort(byId);

  // ── Findings (advisory by default; opt-in blocking via enforcement.policy) ───
  const findings: GovernanceFinding[] = [];
  for (const e of escapes) {
    findings.push({
      code: 'footprint-escape',
      severity: e.classification === 'scope-creep-within-file' ? 'info' : 'warn',
      source: 'footprint-escape',
      subject: e.id,
      message: `Diff modified "${e.name}" (${e.filePath}) outside task "${declared.taskId}"'s declared write-footprint — ${e.classification}.`,
    });
  }
  for (const c of newlyOpenedConflicts) {
    findings.push({
      code: 'footprint-escape-new-conflict',
      severity: 'warn',
      source: 'footprint-escape',
      subject: c.symbol,
      message: `An out-of-scope write to "${c.name}" opened a new write-write conflict with peer task "${c.peerTaskId}".`,
    });
  }
  for (const m of misDeclaredAppends) {
    findings.push({
      code: 'mis-declared-append',
      severity: 'warn',
      source: 'footprint-escape',
      subject: m.symbol,
      message: `"${m.name}" was declared writeMode "append" but the diff modified existing code (mis-declared append).`,
    });
  }

  return {
    declaredTaskId: declared.taskId,
    escapes,
    newlyOpenedConflicts,
    registryResolutions,
    misDeclaredAppends,
    findings,
    summary: {
      modifiedSymbols: modified.length,
      escapes: escapes.length,
      outOfScopeWrites: escapes.filter(e => e.classification === 'out-of-scope-write').length,
      readSetIntrusions: escapes.filter(e => e.classification === 'read-set-intrusion').length,
      scopeCreep: escapes.filter(e => e.classification === 'scope-creep-within-file').length,
      newlyOpenedConflicts: newlyOpenedConflicts.length,
      registryResolutions: registryResolutions.length,
      misDeclaredAppends: misDeclaredAppends.length,
    },
    disclosure: ESCAPE_DISCLOSURE,
  };
}
