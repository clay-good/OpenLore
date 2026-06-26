# Symbol identity continuity: carry anchored memory across a rename or move instead of orphaning it

> Status: IMPLEMENTED (2026-06-25, PR feat/symbol-identity-continuity). Part of the
> `FEATURE-UPDATES.md` set. Adds deterministic rename/move detection between two indexed states and a
> carry-forward of code anchors (memory, decisions) across an unambiguous rename, so accumulated
> knowledge survives benign refactors. No graph-schema change, no LLM, no clock, no new MCP tool.
>
> **What shipped:** the pure continuity detector (`src/core/analyzer/continuity.ts`) +
> disk-backed carry-forward (`src/core/decisions/continuity-carry-forward.ts`), wired into
> `openlore analyze` (snapshot the prior graph before rebuild → diff → re-anchor). `recall` surfaces
> the `carriedAcross` provenance and `possiblyMovedTo` disclosure on each anchor.
>
> **Scope notes (honest):**
> - **Trigger = full `openlore analyze`** (a "build whose predecessor is known"). The incremental
>   watcher path — re-anchoring inside `McpWatcher.handleBatch` as files change — is a natural
>   follow-up but was deliberately deferred: the watcher does not touch the memory/decision stores
>   today, and adding store writes to its hot path is a larger, riskier change. Renames carry at the
>   next full analyze.
> - **Spec links are a no-op by construction.** Specs in this codebase are regenerated, file-level
>   artifacts and carry NO `StructuralAnchor[]` to re-point (only memories and decisions do). The
>   architecture requirement names "spec links" as the durable contract; it carries automatically the
>   day specs become symbol-anchored. Nothing to do for them now.

## Why

OpenLore's memory moat rests on anchoring: every memory, decision, and spec is pinned to a concrete
symbol with structural identity (`{ nodeId, symbolName, filePath, contentHash }`), and recall returns a
freshness verdict — `fresh`, `drifted`, or `orphaned` — refusing to serve an orphaned memory as
authoritative (`add-code-anchored-memory-staleness`). That invariant is correct and it is the reason
OpenLore's memory is trustworthy where a competitor's free-text project blob is not.

But it has a sharp, silent failure mode: **a pure rename or a file move orphans everything anchored to
the symbol.** Rename `computeTax` to `calculateTax`, or move it from `billing.ts` to `tax.ts`, and the
old anchor no longer resolves — `symbolName` (or `filePath`) changed — so every memory, decision, and
spec that an agent carefully recorded about that function drops to `orphaned` and is no longer surfaced
as fact. The knowledge is still true; the function still exists; only its name moved. Refactoring is
constant, and renames/moves are among the most common refactors, so the steady-state effect is that
**accumulated memory silently evaporates exactly when the codebase is being actively improved** — the
worst possible time to lose context. A peer system that re-stamps a moved symbol's validity preserves
the *symbol's* history but still loses the human-authored *notes* anchored to it; OpenLore can do
better precisely because it has those anchors.

The fix is deterministic and bounded. Between two indexed states, a symbol that *disappeared* and a
symbol that *appeared* are the **same symbol under a new name/location** when their bodies are identical
(same content hash) or their normalized signatures match and no other symbol competes for the match.
Detecting that lets OpenLore carry the old symbol's anchors forward to the new one — turning "orphaned"
into "fresh (carried across rename)" — without ever guessing.

## What changes

1. **Deterministic rename/move detection between two indexed states.** When analysis produces a new
   graph over a prior one (an incremental update, or a build whose predecessor is known), the system
   computes a **continuity map**: pairs `(oldSymbol → newSymbol)` where a symbol present before and
   absent after is matched to a symbol absent before and present after. A match is admitted only on
   strong, unambiguous evidence:
   - **exact-body** — identical content hash (the body moved to a new file but is byte-identical; the
     name did not change), or
   - **exact-signature** — the body is identical EXCEPT the symbol's own name changed (a rename),
     verified by substituting the candidate's new name back to the old name and confirming the span
     hashes to the old baseline. This is a true body-identity-modulo-name check, **not** a parameter-shape
     match: an unrelated newcomer that merely shares a parameter shape (and appeared the same run the old
     symbol was deleted) does **not** match, so a genuinely deleted symbol is never re-anchored onto an
     unrelated symbol.
   and only when the match is **one-to-one** (exactly one disappeared candidate and one appeared
   candidate satisfy it) and, for `exact-signature`, only when the name-independent body is not shared by
   any other new symbol (an identical-body clone elsewhere makes the body non-identifying → no pair).
   Git's own rename detection MAY corroborate a file move but is never sufficient alone. The reason
   (`renamed` | `moved` | `renamed-and-moved`) and the basis (`exact-body` | `exact-signature`) are
   recorded on each continuity pair.

2. **Anchor carry-forward (the payoff).** For each continuity pair, anchors that resolve to `oldSymbol`
   — memories and decisions pinned to its structural identity (spec links carry automatically if/when
   specs become symbol-anchored; today they are file-level and carry nothing) — are **re-anchored** to
   `newSymbol`, with provenance (`carriedAcross: { from: { symbolName?, filePath }, reason, basis,
   atCommit? }`). The anchor's `contentHash` baseline is **preserved**, so the existing freshness engine
   reports the verdict: `fresh` for a byte-identical `exact-body` move, or `drifted` for an
   `exact-signature` rename (whose declaration span changed), both annotated as carried — rather than
   `orphaned`. The carry-forward is additive and reversible: the provenance records where the anchor came
   from, so the move is auditable and a wrong carry can be traced.

3. **Ambiguity is never resolved by guessing (honesty).** When more than one appeared symbol could match
   a disappeared one (e.g. a function split into two, or two near-identical helpers), **no carry-forward
   occurs**: the anchor stays `orphaned`, and the candidate new symbols are surfaced as a disclosure
   (`possiblyMovedTo: [...]`) for a human or agent to reconcile. This preserves the authoritative-recall
   invariant — an orphaned memory is never silently re-attached to a guessed target — while still
   pointing at the likely destinations.

4. **Bounded, not a history reconstruction.** Continuity is computed only between adjacent indexed states
   (the change at hand), not by mining the full git history. It answers "did these symbols just get
   renamed/moved?", deterministically, from the two graphs plus the diff. It does not attempt to track a
   symbol across its entire lifetime (that is the bitemporal store's job) and does not invent identity
   where the body genuinely changed shape.

5. **Determinism.** The continuity map is a pure function of the two indexed states and the git diff
   between them — byte-identical for a fixed pair of states. No model, no clock, no sampling.

## Decision

**Carry forward only on exact-body or exact-signature one-to-one matches; orphan-and-disclose on
anything ambiguous.** The bar for re-anchoring durable memory must be high, because a wrong carry-
forward attaches a true note to the wrong code — a subtler error than a clean orphan. So the matcher is
deliberately conservative: it recovers the common, unambiguous rename/move (which is the bulk of the
real-world loss) and explicitly declines the ambiguous case rather than reaching for a similarity
threshold that would introduce a tuning constant and a guess. This keeps the feature inside the
determinism and authoritative-recall invariants while recovering most of the value.

## Scope contract — do not break these things

This change must NOT:
- Re-anchor a memory on a similarity score, a threshold, or any ambiguous match. Exact-body or
  exact-signature, one-to-one, or no carry-forward.
- Change the graph schema. Continuity is a derived map over two existing graph states; carry-forward
  adds optional provenance to the existing anchor records.
- Violate authoritative recall. An orphaned memory is never silently served against a guessed symbol;
  ambiguity yields disclosure, not attachment.
- Mine full git history or attempt lifetime symbol tracking. Adjacent-state only.
- Use a model or a clock. The continuity map is deterministic.

## Out of scope (deferred)

Split/merge continuity (one symbol becoming two, or two becoming one) beyond surfacing candidates;
cross-file *content-changed* moves (a symbol both moved and had its body meaningfully rewritten —
treated as delete+add, correctly orphaning, since identity is genuinely uncertain); full-history symbol
lineage (the bitemporal store's domain); and carry-forward of anchors across a *federation* repo
boundary (a later change).

## Implementation status

Tracked in `tasks.md`. Verified by: a rename fixture (renamed with an otherwise-identical body → carried,
recalls `drifted (carried)`), a move fixture (byte-identical body, new file → carried, recalls `fresh
(carried)`), an ambiguity fixture (two identical-body candidates → no carry, both surfaced as
`possiblyMovedTo`), a body-rewrite fixture (renamed *and* rewritten → correctly orphaned), a determinism
test, and the **soundness-regression fixtures added in PR review** (a deleted symbol + an unrelated
same-parameter-shape newcomer → NOT carried; an identical-body clone elsewhere → NOT carried; a memory is
never carried onto a test symbol). All four adversarial scenarios were also confirmed end-to-end against
the real `openlore analyze` pipeline — see `DOGFOOD-symbol-identity-continuity.md`.

> **Soundness hardening (PR #206 review 1).** The first cut matched `exact-signature` on the parameter
> *shape* alone, which could re-anchor a deleted symbol's memory onto an unrelated newcomer that merely
> shared a shape (e.g. another `(req, res)` handler). That was caught by an adversarial e2e test and
> fixed: `exact-signature` now requires the candidate's body to equal the old body *modulo the symbol's
> own name* (verified by name substitution against the recorded baseline hash) AND the name-independent
> body to be unique among new symbols. Test symbols are excluded as carry targets. No tuning constant was
> introduced.
>
> **Second-pass hardening (PR #206 review 2).** A deeper adversarial pass found and fixed three more
> issues: (1) the identifier-substitution boundary was ASCII-only and mis-split a name adjacent to a
> Unicode character (`taxé`) — now Unicode-aware (`\p{L}\p{N}`); (2) `exact-signature` could still
> false-match when the newcomer's body *referenced* the deleted symbol's name (substituting could
> reconstruct the old span) — now rejected when the old name appears as a whole-word token in the new
> span; (3) the name-independent-body uniqueness pass hashed *every* node on every disappeared-symbol
> analyze (~850 ms on a 2.6k-node graph) — now gated to run ONLY when a real rename candidate exists, so
> the no-rename / move-only / delete-only paths are ~8 ms. Also: the disk-level carry-forward tests were
> moved into a plain `.test.ts` so CI guards them (the soundness regressions were previously
> integration-only and CI-excluded), DECISION carry-forward gained explicit test coverage, and `recall`
> now surfaces `possiblyMovedTo` only while the anchor is still orphaned (a stale hint is not shown once
> the anchor resolves). Recursive and Unicode-named renames are confirmed to carry. **Known limitation:**
> a carried memory keeps its original `id` (a stable reference), so re-recording the *identical* note on
> the renamed symbol via `remember` would create a second record (the dedup id is content+anchor-derived);
> surfaced by the `unreconciled` detector, not data loss.
