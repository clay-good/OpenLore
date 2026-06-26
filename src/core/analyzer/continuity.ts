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
 *  - `exact-body` — the new span is byte-identical to the old one (a pure move; the
 *    name did not change).
 *  - `exact-signature` — the new span is identical to the old one EXCEPT the
 *    symbol's own name changed (a rename). This is verified by substituting the
 *    candidate's new name back to the old name and checking the span hashes to the
 *    old baseline — NOT a mere parameter-shape match. This matters: a same-shape
 *    newcomer with a *different* body (e.g. an unrelated `(req, res)` handler that
 *    appeared the same run an anchored handler was deleted) does NOT pair, so a
 *    genuinely deleted symbol is never re-anchored onto an unrelated newcomer.
 *  - Carry forward only on a strict ONE-TO-ONE match, AND only when the normalized
 *    (name-independent) body is unique among all new symbols, so two identical-body
 *    clones never produce a confident single match.
 *  - Anything ambiguous yields NO pair — the disappeared symbol is surfaced with
 *    its candidate destinations, never silently re-attached to a guess.
 *  - No similarity score, no threshold, no tuning constant, no clock, no model.
 *    The result is a pure, byte-identical function of the two state views.
 */

import { createHash } from 'node:crypto';
import type { ContinuityReason, ContinuityBasis } from '../../types/index.js';

/**
 * Stable span hash. MUST match `decisions/anchor.ts` `hashSpan` (sha256, first 16
 * hex chars) so the substitution check below compares against the same baseline the
 * freshness engine recorded. Asserted equal in the tests.
 */
function spanHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** A sentinel that cannot occur in source — used to name-normalize a body. */
const NAME_SENTINEL = '\uFFFF'; // U+FFFF noncharacter — cannot occur in source identifiers, ASCII-safe in this file

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Identifier-character class for whole-word boundaries. Unicode-aware (`\p{L}\p{N}`)
 * so a name adjacent to a non-ASCII identifier char (e.g. `taxé`, or a Unicode
 * function name in Python/Ruby) is correctly treated as part of a larger identifier
 * and left alone — an ASCII-only class would mis-split `taxé` into `tax` + `é`.
 */
const IDENT_CHAR = '[\\p{L}\\p{N}_$]';

/**
 * Replace whole-identifier occurrences of `from` with `to` in source text. A name
 * embedded in a larger identifier (ASCII or Unicode) is left alone. Used to test
 * body-identity-modulo-name. Requires the `u` flag for the Unicode property escapes.
 */
export function renameIdentifier(text: string, from: string, to: string): string {
  if (!from) return text;
  return text.replace(new RegExp(`(?<!${IDENT_CHAR})${escapeRegExp(from)}(?!${IDENT_CHAR})`, 'gu'), to);
}

/**
 * The name-independent body hash of a span: its own declared name replaced by a
 * fixed sentinel, then hashed. Two functions that differ ONLY in their name share
 * this hash. Used for the new-side uniqueness guard.
 */
export function normalizedBodyHash(spanText: string, name: string): string {
  return spanHash(renameIdentifier(spanText, name, NAME_SENTINEL));
}

/**
 * True when `appearedSpan` is the old symbol's body with ONLY the symbol's own name
 * changed: substitute the new name back to the old name and check the span hashes to
 * the old baseline. Requires a real rename (`appearedName !== oldName`); a same-name
 * span is the `exact-body` case, handled separately.
 */
export function bodyMatchesModuloName(
  appearedSpan: string,
  appearedName: string,
  oldName: string,
  oldContentHash: string,
): boolean {
  if (appearedName === oldName) return false;
  // Guard: if the OLD name ALREADY appears as a whole-word token in the new span,
  // we cannot cleanly attribute the body to a rename — the newcomer references (or
  // mentions) the old symbol, so substituting newName→oldName could spuriously
  // reconstruct the old span (e.g. an unrelated `b()` that calls the deleted `a()`).
  // A genuine full rename removes every occurrence of the old name, so this never
  // rejects a real rename; it only declines an ambiguous coincidence (safe: no carry).
  if (renameIdentifier(appearedSpan, oldName, NAME_SENTINEL) !== appearedSpan) return false;
  return spanHash(renameIdentifier(appearedSpan, appearedName, oldName)) === oldContentHash;
}

/** A symbol that was present in the old state and is no longer resolvable. */
export interface DisappearedSymbol {
  /** Old call-graph node id (the anchor's `nodeId`). */
  nodeId: string;
  /** Old content-addressed stable id, when the symbol had one. */
  stableId?: string;
  name: string;
  filePath: string;
  /** The anchor's recorded baseline span hash (the old body). Required to match. */
  contentHash?: string;
}

/** A symbol present in the new state that did not exist in the old state. */
export interface AppearedSymbol {
  id: string;
  stableId?: string;
  name: string;
  filePath: string;
  /** Current span hash of the new symbol. */
  contentHash: string;
  /** Current source span text of the new symbol (for the modulo-name check). */
  spanText: string;
  /** Name-independent body hash of the new symbol (for the uniqueness guard). */
  normBodyHash: string;
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
 * stronger `exact-body` basis and falling back to `exact-signature` (body identical
 * modulo the name). Returns an empty `exact-signature` candidacy when neither basis
 * matches — callers drop those.
 *
 * `newNormBodyCount` counts how many of ALL new symbols share a given normalized
 * (name-independent) body; an `exact-signature` candidate is admitted only when its
 * normalized body is unique across the new graph, so identical-body clones never
 * yield a confident match.
 */
function candidacyFor(
  from: DisappearedSymbol,
  appeared: readonly AppearedSymbol[],
  newNormBodyCount: ReadonlyMap<string, number>,
): Candidacy {
  // Without a recorded baseline body hash there is no evidence to match on.
  if (!from.contentHash) return { from, basis: 'exact-signature', candidates: [] };

  // exact-body — byte-identical span (a pure move; the name did not change).
  const body = appeared.filter((a) => a.contentHash === from.contentHash);
  if (body.length > 0) return { from, basis: 'exact-body', candidates: body };

  // exact-signature — same body, only the symbol's own name changed (a rename),
  // verified by name substitution (NOT a mere parameter-shape match).
  const sig = appeared.filter((a) => bodyMatchesModuloName(a.spanText, a.name, from.name, from.contentHash!));
  if (sig.length === 0) return { from, basis: 'exact-signature', candidates: [] };

  // Uniqueness guard: every matching candidate shares one normalized body. If that
  // normalized body ALSO occurs in a new symbol that is NOT a candidate here (a
  // pre-existing clone, or a clone in another file), the body is not identifying —
  // reject entirely rather than risk carrying onto the wrong one. When the only
  // occurrences ARE the candidates, a single candidate pairs and multiple
  // candidates surface as ambiguous (handled by the caller).
  const normHash = sig[0].normBodyHash;
  const occurrences = newNormBodyCount.get(normHash) ?? sig.length;
  const candidatesWithNorm = sig.filter((a) => a.normBodyHash === normHash).length;
  if (occurrences > candidatesWithNorm) return { from, basis: 'exact-signature', candidates: [] };

  return { from, basis: 'exact-signature', candidates: sig };
}

/**
 * Compute the continuity map between two adjacent indexed states.
 *
 * `disappeared` are old symbols whose anchors no longer resolve; `appeared` are new
 * symbols absent from the old state. `newNormBodyCount` is the count of each
 * normalized (name-independent) body across ALL new internal symbols (not just the
 * appeared subset), used to reject identical-body clones. A pair is admitted only
 * when the match is MUTUALLY one-to-one: the disappeared symbol has exactly one
 * candidate AND that candidate is the candidate of exactly one disappeared symbol.
 * Every other case (zero candidates → no continuation; multiple candidates on
 * either side → ambiguous) yields no pair. Deterministic and order-independent.
 */
export function computeContinuity(
  disappeared: readonly DisappearedSymbol[],
  appeared: readonly AppearedSymbol[],
  newNormBodyCount: ReadonlyMap<string, number>,
): ContinuityResult {
  // Phase 1 — each disappeared symbol picks its candidate set at its best basis.
  const candidacies = disappeared.map((d) => candidacyFor(d, appeared, newNormBodyCount));

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
