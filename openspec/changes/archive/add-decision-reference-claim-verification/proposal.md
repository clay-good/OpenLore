# Decision-reference claim verification: let an agent verify a decision is still authoritative before citing it

> Status: IMPLEMENTED (2026-06-24). Shipped on branch `feat/verify-claim-decision-reference`. Closes the
> one scoped deferral left by `add-finding-enforcement-policy` (the `verify_claim` clause of
> `StaleDecisionReferenceSurfacedThroughExistingTools`). Additive: extends an existing opt-in tool, no new
> MCP tool and no default-surface growth. Grounded in the north star (`c6d1ad07`): deterministic,
> locally-computed, no LLM.

## Why

`verify_claim` exists so an agent about to assert a fact to a human ("X is dead", "Y calls Z", "this is
safe to change") can first get a deterministic verdict + a citable receipt, converting the agent's
confident-wrong failure mode into checked-or-flagged. But agents assert a second kind of fact just as
confidently: **governance citations** — "decision X governs this, so the approach is settled" / "ADR
abc12345 says this layer is decoupled, so it's safe to change." When the cited decision has since been
**superseded**, that citation is stale, and nothing caught it.

OpenLore already tracks decision supersession and, in `add-finding-enforcement-policy`, made a live
artifact that references a *retired* decision a first-class deterministic finding
(`stale-decision-reference`). That finding is surfaced **passively**: `recall` flags a memory it happens
to return, and the gate flags a commit. The missing surface is the **active** one — an agent that wants
to check a decision it is *about to cite*, on demand, the same way it checks a structural fact. That
clause was named in the original enforcement-policy proposal and deferred, with a specific reason: the
claim model was structural-only (`calls`/`reaches`/`dead`/`impacts`/`safe-to-change`), so a
decision-reference claim had nothing to rest on, and forcing one would contort the structural verifier.

This change adds the rest it needs — a cleanly separated decision-store verification path — so the
deferral can close without that contortion.

## What changes

1. **A new `verify_claim` kind: `decision-current`.** The claim asks "is decision `<subject>` still
   authoritative?" where `subject` is an 8-character decision id. It returns the same
   `{ verdict, reason, receipt?, confidenceBoundary }` contract as the structural kinds.

2. **Verdicts are a pure read of the decision store, sharing the retirement graph.** `confirmed` when the
   id resolves to a recorded decision that is neither superseded nor rejected; `refuted` when it has been
   superseded (the reason naming the live terminal superseder to cite instead) or was rejected;
   `unverifiable` when the id is malformed or no such decision is recorded here. The supersession test
   reuses `buildRetirementGraph` — the SAME walk the `stale-decision-reference` finding uses — so the
   active (`verify_claim`) and passive (`recall` / gate) surfaces can never disagree about what counts as
   retired, including following a supersession chain `A←B←C` to the live terminal `C`.

3. **The structural verifier is left untouched.** The decision kind branches before the call-graph load
   and computes only over the decision store; the call-graph verifiers (`verifyCalls` / `verifyReach` /
   `verifyDead` / `verifySafeToChange`) are not modified. This is exactly the separation the original
   deferral was protecting.

## What does NOT change

- **No new MCP tool, no default-surface growth.** `verify_claim` stays in the opt-in `verify` preset; the
  lean default surface is unchanged.
- **No LLM.** The verdict is a deterministic decision-store read; the north star (`c6d1ad07`) holds.
- **Conclusion-shaped.** A verdict + a bounded decision receipt, never a graph to traverse.
- **One source of truth for retirement.** Supersession is read from the same decision store
  (`loadDecisionStore` → `buildRetirementGraph`) the finding walks; this change introduces no second
  notion of "retired."

## Application to OpenLore

- **The claim kind + verdict** live in `mcp-handlers` (`claim-verification.ts`), as a sibling
  `verifyDecisionCurrent` path next to the structural verifiers, reusing `buildRetirementGraph` from
  `stale-decision-reference.ts` and `loadDecisionStore` from `core/decisions/store.ts`.
- **The tool schema** (`src/cli/commands/mcp.ts`) gains `decision-current` in the `kind` enum and a
  `subject`-is-a-decision-id note; the dispatch (`tool-dispatch.ts`) is unchanged (it already forwards
  `kind`/`subject`).
- **The spec** updates `StructuralClaimVerification` to document the kind and closes the deferral note on
  `StaleDecisionReferenceSurfacedThroughExistingTools`.

## Out of scope

- **Symbol-anchored governance claims** ("decision X governs *symbol* Y"). This change verifies a
  decision's authority by id; tying a claim to a specific symbol's governing decisions is a possible later
  refinement, deliberately excluded to keep the verdict a pure id→authority read.
- **Authority levels beyond superseded/rejected.** A recorded-but-not-yet-approved (`draft`) decision is
  reported `confirmed` with its status in the reason; modeling "approved vs draft" as distinct authority
  tiers is separate from the retirement question this change answers.
- **Auto-remediation.** The verdict reports the superseder to cite; it does not rewrite the agent's text.
