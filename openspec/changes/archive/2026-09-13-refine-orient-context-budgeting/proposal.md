# Refine orient context budgeting: whole-response token budget fitting

> Status: BUILT (2026-09-13), narrowed — see *Scope as built*. Originally PROPOSED (2026-07-03, e2e audit). Closes the gap between orient's existing budgeting
> plumbing and the Aider repo-map mechanism (prior art:
> https://aider.chat/docs/repomap.html) — deterministic, no LLM, no new tuning constants.

## The gap

The ranking half of the repo-map mechanism already exists and is NOT re-proposed here:
query-conditioned personalized PageRank (`src/core/analyzer/personalized-pagerank.ts`, consumed by
`orient` via the opt-in `rankBy: 'pagerank'` mode, `orient.ts:177`, `:655-691`; requirement
`PersonalizedPagerankAsQueryconditionedRetrievalRankingNotGlobalSalience`, analyzer spec, decision
`0bdd4319`). What is missing is the *budget-fitting* half:

1. **The budget can only shrink, never fit.** `applyTokenBudget` greedily keeps score-ordered items
   (`progressive.ts:35-46`) over a candidate pool pre-capped at `clampedLimit * 3` with
   `clampedLimit ≤ 20` (`orient.ts:203`, `:220`). A caller with a large budget gets at most 20
   entries; a caller with a small one gets a greedy prefix. Aider binary-searches the number of
   included entries until the *rendered* map fits the budget — exact fit in both directions.
2. **The budget covers one section.** `tokenBudget` applies only to `relevantFunctions`
   (`orient.ts:239-244`); call paths, specs, provenance, coupling, and landmarks are capped by
   fixed `.slice(0, N)` constants regardless of budget. The payload as a whole can overshoot a
   small budget or waste a large one.
3. **No cold-start breadth.** A first orientation with no working diff and no matched seed symbols
   returns the same-sized result as a well-seeded one. Aider's `map_mul_no_files` precedent:
   when the caller supplies no seeds, the budget multiplier expands so the first look is broader.
4. **Truncation trims uniformly, not peripherally.** When the budget bites, top-ranked entries keep
   all fields while whole peripheral entries should be dropped first (the SWE-Explore finding:
   line-level recall *inside the right files* is the agent gap — better to fully describe fewer,
   righter entries). Today only the omission count for functions is disclosed (`orient.ts:853-854`).

## What changes

As built, see *Scope as built*. The original items for cold-start expansion, seed-quality weighting, and
`get_minimal_context` are deferred there.

## Scope as built

- **Built:** whole-response fitting for `orient` (`src/core/services/mcp-handlers/budget-fit.ts`).
  - The top-`limit` answer is built exactly as without a budget, and every file-scoped section
    (decisions, provenance, coupling, parse health, insertion points) is computed for its files.
  - When it fits, functions ranked past `limit` come from a bounded 60-entry pool
    (`ORIENT_BUDGET_CANDIDATE_POOL`, a work bound, not a tuning weight) and are added with their call
    paths while the response still fits.
  - When it does not fit, whole lowest-ranked entries are dropped peripheral-first with the fewest
    removals that fit; a call path stays exactly with its function.
  - Costs are measured on the response as sent: pretty-printed JSON, the staleness note, and the
    `budget` receipt. Governance context, architecture violations, matching specs, and the file scope
    are never dropped. Non-finite or sub-1 budgets are rejected. The no-budget default is unchanged.
- **Measured on this repository:** see the PR table; a budget above the default answer keeps every
  default section and adds functions.
- **Deferred — cold-start expansion and seed-conditioned shaping:** `orient` reads no working diff, so
  "no diff" is not a signal it has, and a task with no matched symbol already returns an explained
  empty result. Its only seed signal is the task match, which already orders the ranking (and restarts
  personalized PageRank in `rankBy: 'pagerank'`).
- **Deferred — `get_minimal_context`:** its distance mode ignores `tokenBudget` so the default shape is
  never silently truncated (pinned by a test, not by a spec requirement), and its PageRank mode already
  fits each neighbour list with an `omittedForBudget` receipt.
- **Dropped from the original plan:** a documented tolerance (the fit is strict on the estimate), a pool
  bounded by the weightedBfs neighbourhood (a fixed pool bound instead), replacing the fixed per-section
  caps (they still shape the default answer), and changes to `progressive.ts`.

## Why this is in scope

Token-scoped retrieval is the north star's core promise (decision `c6d1ad07`: "retrieval stays
token-scoped and local-first"). This makes the existing budget parameter honest — an exact fit
instead of a hint — using only existing signals and the existing PPR constants discipline.

## Impact

- `src/core/services/mcp-handlers/orient.ts` (base answer, extension, trimming, receipt, validation),
  `src/core/services/mcp-handlers/budget-fit.ts` (the fitter), `src/constants.ts` (the pool bound),
  `src/cli/commands/orient.ts` (help text, human receipt), docs.
- Specs: `mcp-handlers` — ADDED ExactFitTokenBudgeting; `cli` — MODIFIED
  TokenbudgetParameterForOrientAndSearchcodeMcpTools (orient's budget fits instead of capping).
- Risk: budget-passing callers now receive a fitted response (more functions when room allows); the
  no-budget default is byte-identical.
