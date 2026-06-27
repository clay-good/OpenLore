# Tasks — decision-reference claim verification

> Status: IMPLEMENTED 2026-06-24. Closes the `verify_claim` clause deferred by
> `add-finding-enforcement-policy`. Surgical and additive: one new claim kind on an existing opt-in tool,
> a cleanly separated decision-store path that does not touch the structural verifiers, the schema enum,
> and tests. No new MCP tool; dispatch unchanged.

## A. The `decision-current` claim kind

- [x] Add `'decision-current'` to `ClaimKind` + `CLAIM_KINDS`, with a `DECISION_KINDS` set and an
      8-hex `DECISION_ID_RE` validator → `claim-verification.ts`.
- [x] Branch `decision-current` BEFORE the call-graph load in `handleVerifyClaim`, so the structural
      verifier path and its `readCachedContext`/symbol-resolution are untouched → verified by the
      structural tests still passing unchanged.
- [x] Implement `verifyDecisionCurrent(absDir, subject)`: load the decision store, resolve the id, build
      the retirement graph, and return `confirmed` / `refuted` / `unverifiable` on the shared
      `{ verdict, reason, receipt?, confidenceBoundary }` contract → `claim-verification.ts`.

## B. Shared retirement source (no second notion of "retired")

- [x] Reuse `buildRetirementGraph` from `stale-decision-reference.ts` and `loadDecisionStore` from
      `core/decisions/store.ts` — the SAME source the finding walks — so the active and passive surfaces
      agree, including following a supersession chain `A←B←C` to the live terminal `C` → verified:
      `follows a supersession chain` test.

## C. Verdict semantics

- [x] `refuted` for a superseded decision, the reason naming the live superseder to cite instead, the
      receipt carrying `supersededBy` → verified: `refutes a superseded decision` test.
- [x] `refuted` for a `rejected` decision (not authoritative) → verified: `refutes a rejected decision`.
- [x] `unverifiable` for a well-formed id with no recorded decision, and when no store exists → verified:
      two `unverifiable` tests.
- [x] `unverifiable` for a malformed (non-8-hex) id, with a "pass the id, not the title" hint; ids are
      normalized to lowercase → verified: malformed + uppercase tests.
- [x] `confirmed` for a recorded, non-superseded, non-rejected decision, with a decision receipt
      (id/title/status/recordedAt) → verified: `confirms a recorded decision` test.

## D. Tool surface + docs

- [x] Add `decision-current` to the `verify_claim` `kind` enum and update the description + `subject`
      doc (8-char decision id for this kind) → `src/cli/commands/mcp.ts`. Dispatch unchanged.
- [x] Update spec: `StructuralClaimVerification` documents the kind + two scenarios; close the
      `verify_claim` deferral note on `StaleDecisionReferenceSurfacedThroughExistingTools` →
      `openspec/specs/mcp-handlers/spec.md`.

## E. Verification

- [x] Unit tests (9 new) in `claim-verification.test.ts`; full suite green (`vitest run src examples`:
      234 files, 4681 passed).
- [x] Typecheck + lint + build clean.
- [x] Dogfood through the real dispatch path (`dispatchTool('verify_claim', …)`) against this repo's own
      decision store: a current decision → `confirmed` with a real receipt; an unknown id → `unverifiable`;
      a malformed id → `unverifiable`; a synthetic superseded pair → `refuted` naming the superseder.
