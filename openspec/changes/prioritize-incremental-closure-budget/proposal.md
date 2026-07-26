# Spend the incremental budget on the files that matter: significance-ordered convergence, and a stale region that says how much it costs you

> Status: PROPOSED (2026-07-25, known-limitations closure #6 of 6). The converge-or-flag
> contract is shipped and sound: when a save's reverse-dependency closure exceeds
> `INCREMENTAL_CLOSURE_BUDGET` (40 files), the un-recomputed files are marked explicitly stale
> and a background rebuild is scheduled. What the contract does not say — and what the
> implementation therefore does not do — is **which 40 files** get the budget. Today the answer
> is arrival order. A hub with 75 callers spends its budget on whichever callers the closure
> walk enumerated first, and the caller that everything else routes through may be the one left
> stale. This change orders the budget by structural significance and makes the stale region
> **describe its own cost** instead of reporting a file count.

## The gap

- **The budget is spent in enumeration order.** `INCREMENTAL_CLOSURE_BUDGET = 40`
  (`src/constants.ts:694`) bounds the per-save closure; over-budget files are dropped and marked
  stale (`src/core/services/mcp-watcher.ts:641-651`). The shipped requirement
  (`IncrementalUpdateConvergesToFullAnalyzeOrMarksStale`) says the update "MAY mark more than the
  minimal dirty set as stale" — correct and sound, and completely silent on ordering. Nothing in
  the walk prefers a chokepoint over a leaf.
- **The consequence is that soundness is preserved while usefulness is randomized.** A stale
  marking is honest, but it is not free: `FreshnessVerdictsHonorTheStaleRegion` downgrades every
  memory anchored above a stale region to non-authoritative. So the *choice* of what stays stale
  determines how much of the agent's context goes non-authoritative — and that choice is
  currently arbitrary. Editing a 75-caller hub like `validateDirectory` can, on the same save
  with the same budget, either leave 40 leaves stale or leave the graph's busiest funnel stale.
  The product ships every input needed to tell those cases apart and does not use them.
- **The stale region is reported as a number.** The watcher's summary counts files
  (`mcp-watcher.ts:658-662`); `openlore status` reports state. Neither says *what* went stale, so
  a user cannot tell a stale region of 40 test files from a stale region containing three hubs —
  and cannot decide whether to run `analyze --force` now or ignore it.
- **The classifiers already exist and are already trusted.** `landmark-signals` computes
  hub / orchestrator / chokepoint labels and `change-significance` already ranks changed symbols
  into tiers from those same signals plus churn — shipped, deterministic, and reused across
  `orient`, `briefing_since`, and `report_coverage_gaps`. Reusing them here adds **no new score,
  no new weighting, and no new tuning constant**.

## What changes

**1. Significance-ordered budget spending.** Before the closure walk consumes the budget, its
candidate files are ordered by the existing structural signals — fan-in first, with the shipped
hub/chokepoint/orchestrator labels breaking ties, and a stable secondary sort on path so the
ordering is fully deterministic. The budget is then spent top-down. The budget value, the
convergence contract, and the stale-marking behavior are all unchanged: the same number of files
is recomputed and the same remainder is marked stale. **Only the choice of which files fall on
which side changes** — from arbitrary to "the ones the rest of the graph depends on."

**2. The stale region reports its structural cost.** The stale summary carries, alongside the
count, the number of hub / chokepoint symbols inside it and the highest-significance symbol it
contains — so the watcher line, `openlore status`, and the freshness disclosure can say "12 files
stale, including 2 hubs (`readCachedContext`)" rather than "12 files stale." The rendering reuses
the tier vocabulary `briefing_since` already established, so a user meets one significance
vocabulary in the product, not two.

**3. Rebuild urgency follows significance, not just the file count.** The debounced background
rebuild already fires on a stale region; its coalescing window is chosen by whether the stale
region contains high-significance symbols — a stale hub converges promptly, a stale leaf region
waits and coalesces. Both paths remain bounded, debounced, and at-most-once; nothing new is
spawned, and a repository whose stale regions are all low-significance sees strictly fewer
rebuilds than today.

**4. The ordering is testable and cannot silently regress.** The ordering function is a pure,
exported function over the candidate set. A test asserts that a fixture whose closure exceeds the
budget recomputes the hub and leaves leaves stale — the inverse of today's arbitrary outcome.

**Explicitly NOT built:** raising, lowering, or auto-tuning `INCREMENTAL_CLOSURE_BUDGET`
(a distinct question, with distinct evidence); weakening the convergence contract; a new
significance metric or weighting; any change to what "stale" means or to the freshness verdicts
it produces.

## Why this is in scope

This is the cheapest remaining improvement to the substrate's most-executed write path — it
touches ordering and reporting, not semantics — and it improves the property users actually feel:
how much of their context stays authoritative after a save. It also closes the one honest gap
left in the README's incremental-update bullet, which currently claims a full `analyze --force`
is what clears a stale region (superseded by the shipped
`StaleRegionsAreReconciledWithoutAManualFullAnalyze`) and says nothing about the region's
composition.

## Impact

- **Files:** `src/core/services/mcp-watcher.ts` (candidate ordering before budget consumption,
  stale summary composition, rebuild-window selection), reuse of `landmark-signals` /
  `change-significance` classifiers, the stale-region reporting path in `openlore status` and the
  freshness disclosure, and `docs/TROUBLESHOOTING.md`.
- **Specs:** `analyzer` — 2 ADDED (IncrementalBudgetIsSpentInSignificanceOrder,
  StaleRegionsReportTheirStructuralComposition).
- **Tool surface:** unchanged. The freshness disclosure gains composition fields it already has
  room for.
- **Performance:** one sort over the candidate set (bounded by the closure, already enumerated)
  per over-budget save; no additional parsing, no additional store reads — the signals are
  already resident.
- **Risk:** (a) *ordering instability across runs* — mitigated by a total, deterministic
  comparator with a path tie-break and a test asserting stability. (b) *a rebuild storm from
  significance-driven urgency* — mitigated by keeping the existing debounce, coalescing, and
  at-most-once guarantees, and by only ever *shortening* the window for high-significance regions
  within the existing bounds. (c) *reading prioritization as a soundness improvement* — mitigated
  by the spec stating that the convergence contract and the stale set's size are unchanged; this
  changes which files are stale, not whether staleness is disclosed.
