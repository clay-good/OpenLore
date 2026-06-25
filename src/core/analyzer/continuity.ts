/**
 * Symbol identity continuity — deterministic rename/move detection between two
 * adjacent indexed states. (change: add-symbol-identity-continuity)
 *
 * The memory moat rests on anchoring: a memory/decision is pinned to a symbol by
 * `{ nodeId, stableId, symbolName, filePath, contentHash }` and recall refuses to
 * serve an orphaned anchor as authoritative. A pure RENAME (`computeTax` →
 * `calculateTax`) changes the symbol's name → changes its `stableId` → the anchor
 * orphans, even though the function still exists and the note is still true. This
 * module recovers that case: between the symbols that DISAPPEARED and the symbols
 * that APPEARED across a re-analysis, it matches `(old → new)` pairs on strong,
 * unambiguous evidence so a caller can carry the old symbol's anchors forward.
 *
 * It is intentionally pure: it operates on minimal node views, so the matching
 * logic is unit-tested without disk or the edge store. The disk-backed carry-
 * forward that applies these pairs to the persisted stores lives in
 * `../decisions/continuity-carry-forward.ts`.
 *
 * Discipline (mirrors the proposal's Decision):
 *  - Carry forward only on `exact-body` (byte-identical span) or `exact-signature`
 *    (identical normalized parameter shape) matches, and only when the match is
 *    strictly ONE-TO-ONE (exactly one disappeared and one appeared candidate).
 *  - Anything ambiguous yields NO pair — the disappeared symbol is surfaced with
 *    its candidate destinations, never silently re-attached to a guess.
 *  - No similarity score, no threshold, no tuning constant, no clock, no model.
 *    The result is a pure, byte-identical function of the two state views.
 */

import type { ContinuityReason, ContinuityBasis } from '../../types/index.js';

/** A symbol that was present in the old state and is no longer resolvable. */
export interface DisappearedSymbol {
  /** Old call-graph node id (the anchor's `nodeId`). */
  nodeId: string;
  /** Old content-addressed stable id, when the symbol had one. */
  stableId?: string;
  name: string;
  filePath: string;
  /** The anchor's recorded baseline span hash (used for `exact-body` matching). */
  contentHash?: string;
  /** Normalized parameter shape of the old symbol (used for `exact-signature`). */
  signatureShape: string;
}

/** A symbol present in the new state that did not exist in the old state. */
export interface AppearedSymbol {
  id: string;
  stableId?: string;
  name: string;
  filePath: string;
  /** Current span hash of the new symbol. */
  contentHash: string;
  /** Normalized parameter shape of the new symbol. */
  signatureShape: string;
}

/** A confident `(old → new)` continuity match. */
export interface ContinuityPair {
  from: DisappearedSymbol;
  to: AppearedSymbol;
  reason: ContinuityReason;
  basis: ContinuityBasis;
}

/** A disappeared symbol with more than one equally-plausible destination. */
export interface AmbiguousContinuity {
  from: DisappearedSymbol;
  /** Candidate new locations, sorted; surfaced for human/agent reconciliation. */
  candidates: Array<{ id: string; name: string; filePath: string }>;
}

export interface ContinuityResult {
  /** Confident one-to-one matches, sorted by `from.nodeId`. */
  pairs: ContinuityPair[];
  /** Disappeared symbols left ambiguous (no carry-forward), sorted by `from.nodeId`. */
  ambiguous: AmbiguousContinuity[];
}

function reasonFor(from: DisappearedSymbol, to: AppearedSymbol): ContinuityReason {
  const renamed = from.name !== to.name;
  const moved = from.filePath !== to.filePath;
  if (renamed && moved) return 'renamed-and-moved';
  return renamed ? 'renamed' : 'moved';
}

/** A disappeared symbol's chosen candidate set at its strongest available basis. */
interface Candidacy {
  from: DisappearedSymbol;
  basis: ContinuityBasis;
  candidates: AppearedSymbol[];
}

/**
 * Pick the candidate appeared symbols for one disappeared symbol, preferring the
 * stronger `exact-body` basis and falling back to `exact-signature`. Returns the
 * empty-candidate `exact-signature` candidacy when neither basis matches (the
 * symbol simply has no continuation) — callers drop those.
 */
function candidacyFor(from: DisappearedSymbol, appeared: readonly AppearedSymbol[]): Candidacy {
  // exact-body: byte-identical span. Only meaningful when the old baseline hash is
  // known (it is, for any real anchor).
  if (from.contentHash) {
    const body = appeared.filter((a) => a.contentHash === from.contentHash);
    if (body.length > 0) return { from, basis: 'exact-body', candidates: body };
  }
  // exact-signature: identical normalized parameter shape. An empty shape ('' — no
  // parameter group captured) is too weak to match on, so it never pairs.
  if (from.signatureShape !== '') {
    const sig = appeared.filter((a) => a.signatureShape === from.signatureShape);
    if (sig.length > 0) return { from, basis: 'exact-signature', candidates: sig };
  }
  return { from, basis: 'exact-signature', candidates: [] };
}

/**
 * Compute the continuity map between two adjacent indexed states.
 *
 * `disappeared` are old symbols whose anchors no longer resolve; `appeared` are
 * new symbols absent from the old state. A pair is admitted only when the match is
 * MUTUALLY one-to-one: the disappeared symbol has exactly one candidate AND that
 * candidate is the candidate of exactly one disappeared symbol. Every other case
 * (zero candidates → no continuation; multiple candidates on either side →
 * ambiguous) yields no pair. Deterministic and order-independent.
 */
export function computeContinuity(
  disappeared: readonly DisappearedSymbol[],
  appeared: readonly AppearedSymbol[],
): ContinuityResult {
  // Phase 1 — each disappeared symbol picks its candidate set at its best basis.
  const candidacies = disappeared.map((d) => candidacyFor(d, appeared));

  // Phase 2 — count how many disappeared symbols claim each appeared symbol, so we
  // can enforce mutual uniqueness (an appeared symbol matched by two disappeared
  // ones is not a confident destination for either).
  const claimsByAppeared = new Map<string, number>();
  for (const c of candidacies) {
    if (c.candidates.length === 1) {
      const id = c.candidates[0].id;
      claimsByAppeared.set(id, (claimsByAppeared.get(id) ?? 0) + 1);
    }
  }

  const pairs: ContinuityPair[] = [];
  const ambiguous: AmbiguousContinuity[] = [];
  for (const c of candidacies) {
    if (c.candidates.length === 0) continue; // no continuation — stays orphaned, no disclosure
    const uniqueOnThisSide = c.candidates.length === 1;
    const uniqueOnOtherSide = uniqueOnThisSide && claimsByAppeared.get(c.candidates[0].id) === 1;
    if (uniqueOnThisSide && uniqueOnOtherSide) {
      const to = c.candidates[0];
      pairs.push({ from: c.from, to, reason: reasonFor(c.from, to), basis: c.basis });
    } else {
      ambiguous.push({
        from: c.from,
        candidates: c.candidates
          .map((a) => ({ id: a.id, name: a.name, filePath: a.filePath }))
          .sort((x, y) => x.id.localeCompare(y.id)),
      });
    }
  }

  pairs.sort((a, b) => a.from.nodeId.localeCompare(b.from.nodeId));
  ambiguous.sort((a, b) => a.from.nodeId.localeCompare(b.from.nodeId));
  return { pairs, ambiguous };
}
