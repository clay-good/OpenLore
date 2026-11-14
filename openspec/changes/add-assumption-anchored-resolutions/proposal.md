# Let the agent answer a disclosed gap, and say so in every answer that uses it

> Priority: P3 · Not built
> Reaches the agent through: `blast_radius`, `verify_claim`, `recall` (recorded with the existing `remember`)
> Why it helps the agent: a known gap in the graph is answered once, with proof, instead of being disclosed again on every call.

## Problem

OpenLore discloses what it cannot resolve: a dynamic dispatch, an external callee that may throw.
That is honest, but the gap stays forever. Often the agent or the human knows the answer ("this
dispatch table only registers `handleFoo`"). Today that knowledge can only go into a prose memory
that no tool can use. Every later answer discloses the same gap again.

## What changes

- A new memory type `assumption` in `MEMORY_TYPES` (`src/types/index.ts`), recorded with the
  existing `remember` tool. It is anchored to the symbol that encloses the gap, so it goes stale
  when that symbol changes, like every anchored memory.
- The content is structured, not free text: the site (`file:line` inside the anchor) and one of two
  resolutions: `dispatch-target: <symbol>` or `no-throw`. `remember` refuses a malformed one with a
  hint.
- At answer time, a fresh assumption extends the walk:
  - `dispatch-target` adds the stated edge in `blast_radius`, `analyze_impact`, `find_dead_code`
    and the `dead` / `impacts` kinds of `verify_claim`.
  - `no-throw` removes that callee from the unknown list in `analyze_error_propagation`.
- Every answer that used one carries `assumptions: [id, …]` next to its confidence boundary.
- `recall` with `type: "assumption"` lists them for review.

## What does not change

- No new tool. `remember` and `recall` keep their names; the `type` enum gains one value.
- The stored graph is never written. An assumption is read at answer time only.
- Nothing records an assumption automatically. No resolver, heuristic or model writes one.
- A stale, orphaned or superseded assumption is never used. To revoke one, supersede it.
- Local only. Works without OpenSpec.

## Limits we disclose

- A wrong assumption gives a wrong answer. The `assumptions` list makes that answer traceable to it.
- Two resolutions only. More need a later spec change.
- `remember` and `recall` are in the opt-in `memory` preset, so a default install cannot record one.

## Depends on

Shipped: anchored memory, freshness verdicts, supersession, the confidence boundary.
