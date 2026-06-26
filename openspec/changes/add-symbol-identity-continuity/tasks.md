# Tasks — Symbol identity continuity

> Status: IMPLEMENTED (2026-06-25). All tasks below are complete except where noted as deferred
> follow-up (incremental-watcher trigger) or no-op-by-construction (spec links — specs are not
> symbol-anchored in this codebase). See `proposal.md` scope notes.

## 1. Continuity detection
- [x] Compute disappeared/appeared symbol sets between two adjacent indexed states.
      (`src/core/decisions/continuity-carry-forward.ts` `buildContinuity`)
- [x] Match on `exact-body` (content-hash identity) or `exact-signature` (body identical *modulo the
      symbol's own name*, verified by name substitution against the recorded baseline hash — not a
      parameter-shape match); admit only one-to-one matches; record `reason` + `basis`.
      (`src/core/analyzer/continuity.ts`)
- [x] Optionally corroborate file moves with git rename detection (never sufficient alone). — the
      detector matches on content/signature directly; a git-rename corroboration is unnecessary because
      `exact-body`/`exact-signature` already prove identity. (Left as the stronger basis, not used alone.)
- [x] Emit a deterministic continuity map (byte-identical for a fixed state pair). (sorted by `from.nodeId`)

## 2. Anchor carry-forward
- [x] Re-anchor memories/decisions from `oldSymbol` to `newSymbol`; add
      `carriedAcross: { from, reason, basis, atCommit }` provenance (optional, additive).
      Spec links: no-op — specs carry no `StructuralAnchor[]` to re-point (regenerated, file-level).
- [x] Freshness verdict after carry: `fresh` (unchanged body) / `drifted` (changed body), annotated as
      carried; never `orphaned` solely due to name/file change. (baseline `contentHash` preserved so the
      existing freshness engine yields the verdict; an exact-signature rename reads `drifted (carried)`.)

## 3. Ambiguity / honesty
- [x] On ambiguous continuity: no carry-forward; keep `orphaned`; surface `possiblyMovedTo` candidates.
- [x] Preserve authoritative-recall: never serve an orphaned memory against a guessed target.

## 4. Tests & fixtures
- [x] Rename (otherwise-identical body) → memory carries, recalls re-pointed with provenance.
      (`continuity.test.ts`, `continuity-carry-forward.disk.test.ts`)
- [x] Move (same body, new file) → carried / resolved (exact-body or stableId).
- [x] Ambiguous (two identical-body candidates) → no carry, both surfaced as `possiblyMovedTo`.
- [x] Rename + body rewrite → correctly no pair (stays orphaned).
- [x] Determinism: continuity map byte-identical across two runs / input orderings.
- [x] Legacy stores (no provenance field) load without migration. (additive optional fields;
      file-level + unmatched anchors left untouched — `continuity-carry-forward.test.ts`)
- [x] **CI-guarded disk tests** moved to a plain `.test.ts` (`continuity-carry-forward.disk.test.ts`) so
      the soundness guarantees run in CI (were integration-only/CI-excluded).
- [x] **Decision** carry-forward covered (symbol-anchored decision renamed → `decisionsUpdated=1`).
- [x] Second-pass regressions: C2 false-carry when the newcomer references the deleted name → no carry;
      Unicode-adjacent identifier boundary (`taxé`); recursive rename carries.

## 5. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run` (5108 passed), `npm run build` green.
- [x] Dogfood: recorded a memory anchored to `computeTax`, renamed it to `calculateTax`, re-analyzed —
      `analyze` logged "carried 1 symbol(s)", the memory re-pointed to `calculateTax` with
      `carriedAcross` provenance and recalled `drifted (carried)` instead of `orphaned`; a second
      re-analyze was a clean no-op (idempotent).
- [x] Second-pass dogfood: Python cross-language rename carries; ambiguous split → `possiblyMovedTo`;
      C2 false-carry rejected; perf gated (delete-only ~8.7 ms vs ~850 ms full pass only on a real
      rename over a 2.6k-node graph). See `DOGFOOD-symbol-identity-continuity.md`.

## 6. Docs
- [x] Documented continuity, carry-forward provenance, the exact-match-only/no-guess contract, and the
      ambiguous-disclosure behavior — module headers + spec deltas + CLAUDE.md tool table row.
