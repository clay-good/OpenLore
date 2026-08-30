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
- **The stale region is reported as a number, and barely reported at all.** The watcher's summary
  counts files (`mcp-watcher.ts:658-662`) and is debug-gated; the only other consumer reads the
  count solely to decide whether to trigger a background repair, so it reaches no user. (There is
  no `openlore status` — PR #224 never landed on `main`.) Nothing says *what* went stale, so a
  reader cannot tell a stale region of 40 test files from one containing three hubs.
- **The raw signal is already resident on the hot path.** The update already loads the internal
  node table to seed cross-file resolution, and every row carries `fanIn`/`fanOut` — the same
  counters the shipped hub/orchestrator/chokepoint labels are defined over. Ordering by them adds
  **no new score, no new weighting, no new tuning constant, and no new query**. (The label
  *classifiers* themselves are not usable here — one needs a serialized graph, the other needs
  per-file git churn — so this change orders from the counters and uses the labels only to
  describe the result.)

## What changes

**1. Significance-ordered budget spending, within each phase.** The closure is discovered in two
phases (direct callers, then the prior non-callers a newly-added symbol rebinds), and phase two
is not enumerable until phase one is built — so ordering applies *within* a phase, never across
them, and the existing budget split is untouched. Candidates are ordered by a strict
lexicographic tuple: descending fan-in, descending fan-out, ascending path. The hub/chokepoint
labels are used for *reporting*, not as tie-breaks — each is a monotone function of those same
counters, so a label can never break a tie the counters did not already break. The budget value, the
convergence contract, and the stale-marking behavior are all unchanged: the same number of files
is recomputed and the same remainder is marked stale. **Only the choice of which files fall on
which side changes** — from arbitrary to "the ones the rest of the graph depends on."

**2. The stale region reports its structural cost.** The stale summary carries, alongside the
count, the number of hub / chokepoint symbols inside it and the highest-significance symbol it
contains — so the watcher summary and the per-anchor freshness marker can say "12 files stale,
including 2 hubs (`readCachedContext`)" rather than "12 files stale." The rendering reuses the
tier vocabulary `briefing_since` already established, so a user meets one significance vocabulary
in the product, not two. This constrains the *shape* of an existing report; it adds no new
command or tool.

**3. Rebuild urgency follows significance — monotonically.** The coalescing window may be chosen
from the stale region's composition, but a later trigger may only ever **lengthen** an
already-armed window, never shorten it. Shortening is what breaks coalescing: a HEAD-change arms
the bulk-operation settle window, a hub-region trigger 200 ms later re-arms a shorter one, and the
rebuild fires into a half-applied pull — producing two full re-analyzes where one sufficed.

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
  the raw fan-in/fan-out already carried on the loaded node table, the stale-region reporting path
  on the watcher summary and the per-anchor freshness marker, and `docs/TROUBLESHOOTING.md`.
  (NOT `openlore status`, which is not on `main`; and NOT `computeLandmarkSignals` /
  `labelChangeSignificance`, which need a serialized graph and git churn respectively — neither
  belongs on a per-save hot path.)
- **Specs:** `analyzer` — 2 ADDED (IncrementalBudgetIsSpentInSignificanceOrder,
  StaleRegionsReportTheirStructuralComposition).
- **Tool surface:** unchanged — no new tool and no new command. The composition rides the stale
  marking and the existing per-anchor freshness marker.
- **Performance:** one sort over the candidate set (bounded by the closure, already enumerated)
  per over-budget save; no additional parsing, no additional store reads — the signals are
  already resident.
- **Known pre-existing defect this change sits on:** the node reader drops `is_hub`, and the
  watcher re-inserts every edited file's nodes with `is_hub = 0` and a *subset-local* fan-in — so
  an over-budget hub edit deflates the very signal that would have prioritized it next time. Either
  fix the deflation or bind the ordering to disclosed-lower-bound semantics; do not build on the
  signal without doing one of the two.
- **Risk:** (a) *ordering instability across runs* — mitigated by a total, deterministic
  comparator with a path tie-break and a test asserting stability. (b) *a rebuild storm from
  significance-driven urgency* — mitigated by keeping the existing debounce, coalescing, and
  at-most-once guarantees, and by never shortening an already-armed window. (c) *reading
  prioritization as a soundness improvement* — mitigated
  by the spec stating that the convergence contract and the stale set's size are unchanged; this
  changes which files are stale, not whether staleness is disclosed.
