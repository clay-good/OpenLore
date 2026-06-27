# Confidence-boundary disclosure: every answer says what it does not know

> Status: IMPLEMENTED 2026-06-18 — shipped on branch `feat/confidence-boundary-disclosure` (decision
> `08e71184`). Every conclusion handler now returns a deterministic `confidenceBoundary`; the spec
> deltas below are merged into `mcp-handlers` + `mcp-quality`. Pairs with
> `add-structural-claim-verification` (which consumes the `unverifiable` verdict this defines).

## Why

The most damaging thing a coding agent does is assert confidently across a blind spot — claim a
function is dead when it is reached by reflection, or trace a path that silently stops at a computed
dispatch. OpenLore already *knows* its blind spots: `reachability.ts` carries an "HONEST LIMITS"
header naming reflection, framework magic, and externally-consumed exports, and the dispatch changes
label every synthesized edge with its provenance. But that knowledge stays inside the engine. **At
query time the agent gets a clean-looking answer with no indication of which parts rest on direct
resolution, which lean on a heuristic, and which crossed a boundary OpenLore cannot see past.**

This is the single highest-leverage anti-mistake change, and it is also the adoption gate. An agent
that gets one confidently-wrong answer reverts to grep forever. But an answer *labeled* as crossing a
reflection boundary does not break trust — it *builds* it, because the agent learns OpenLore tells the
truth about its own limits. "Know what you don't know," made a first-class output, is what earns the
agent's trust durably.

## What changes

1. **A `confidenceBoundary` on every conclusion.** Reachability, impact, path, dead-code, and recall
   answers each carry a deterministic boundary describing their epistemic basis: which portion rests
   on directly-resolved edges, which on synthesized edges (with the `synthesizedBy` rule names already
   computed), and which is **known-unknowable** — the traversal crossed a reflection / computed-dispatch
   boundary, or (under federation) an unindexed repository.

2. **Proactive blind-spot flags.** When an answer depends on traversing a documented blind spot, the
   response says so in actionable terms: "this path crosses a reflection boundary at `dispatch()`; the
   true callee is not statically resolvable — verify before asserting." Derived deterministically from
   existing provenance plus the documented limit list; no LLM, no new heuristic.

3. **A staleness boundary.** If the index fingerprint is behind the working tree, answers carry
   "computed against the index built at commit X; N files changed since" — reusing the freshness
   machinery from `harden-memory-integrity-invariant`. The agent always knows whether it is reading a
   current answer or a slightly stale one.

4. **The no-false-completeness contract.** OpenLore SHALL NOT present a conclusion as complete when it
   knows the computation crossed a boundary. A bounded or boundary-crossing answer is always
   distinguishable from a complete one — the answer-level generalization of the dispatch changes'
   per-edge provenance and the trust-economy change's no-silent-truncation rule.

## What does NOT change

- **No LLM.** The boundary is computed from existing provenance, the documented limit list, and the
  index fingerprint. North star (`c6d1ad07`) preserved.
- **No new tuning score.** The boundary is labels and counts (direct / synthesized-by-rule /
  known-unknowable), not a blended confidence number.
- **No new default tool.** This enriches existing conclusion responses; it adds zero tools to consider.
- **Existing answers are a strict superset.** The boundary is additive metadata; a caller that ignores
  it sees today's answer unchanged.

## Research basis

OpenLore's own honesty contract (the README publishes loss cases) applied to every individual answer;
Joern's per-edge `DISPATCH_TYPE` provenance lifted to the conclusion level; the navigation set's
"labeled signals, not a blended score." The novel move is making the *negative space* — what the
analysis cannot know — a deterministic, first-class field, which no comparable agent-context tool
surfaces.

## Application to OpenLore

- Reuses `synthesizedBy` / `confidence` provenance from the dispatch changes and the
  `directResolvedOnly` plumbing.
- Reuses `reachability.ts`'s documented limits as the known-unknowable source.
- Reuses the index fingerprint and freshness machinery for the staleness boundary.

## Out of scope

- **Quantifying** uncertainty as a probability. The boundary is categorical (direct / synthesized /
  known-unknowable / stale), never a learned confidence score.
- **Resolving** blind spots — that is the dispatch changes' job; this one *discloses* what remains.
