# Refine orient context budgeting: exact-fit payloads, cold-start breadth, seed-conditioned shaping

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

- **Exact-fit token budgeting:** when `tokenBudget` is set, orient binary-searches the number of
  included entries (across sections, in rank order) until the rendered payload fits the budget
  within a small tolerance — replacing both the fixed per-section caps and the greedy prefix.
  Deterministic: same graph + task + budget → same payload. Default (no budget) is unchanged.
- **Cold-start budget expansion:** when the caller supplies no seeds (no diff, no matched
  symbols above the relevance gate), the entry budget expands by a fixed multiplier so the first
  orientation is broader. The multiplier is NOT a new tuned float: it enters the same
  fixed-constants table PPR already uses (`constants.ts`, the `PAGERANK_*` discipline), with the
  cited Aider default (`map_mul_no_files = 2`) as its documented source.
- **Seed-quality weighting from existing signals only:** entries reachable from task-string
  identifier matches and symbols in the working diff (both signals orient already computes) are
  preferred when the budget forces a choice. Aider's measured multipliers are prior art for
  *which* signals matter; the implementation uses OpenLore's existing classifiers and the PPR
  restart distribution — if any value cannot be derived from an existing constant, it goes in the
  same fixed-constants table with the cited justification. No composite score is exposed.
- **Peripheral-first truncation with a receipt:** under budget pressure, whole low-ranked entries
  are dropped before any field is trimmed from a top-ranked entry, and the payload carries a
  truncation receipt (omitted count per section, per the `briefing_since` precedent), extending
  the existing `relevantFunctionsOmitted` note to every budgeted section.

Deliberately NOT borrowed from Aider: its map cache/refresh heuristics (OpenLore's watcher and
epistemic lease already own freshness), its rendered-tree text format (orient returns structured
JSON), and its empirically tuned per-signal multipliers as opaque floats (every constant here is
table-fixed and source-cited, never a knob).

## Scope as built

- **Built:** whole-payload fitting for `orient` (`src/core/services/mcp-handlers/budget-fit.ts`). With
  a `tokenBudget`, relevant functions and call paths come from a bounded 60-entry pool
  (`ORIENT_BUDGET_CANDIDATE_POOL`), and whole trailing entries are dropped across sections in a fixed
  peripheral-first order until the rendered payload fits; a call path is kept exactly when its function
  is. A binary search finds the fewest removals. On this repository a 3,000-token budget returns 12
  functions with their call paths (the default is 5).
  A `budget` receipt reports estimated tokens, whether the budget was met, and omitted counts per
  section. Governance context is never trimmed, and the no-budget default is unchanged.
- **Deferred — cold-start expansion and seed-conditioned shaping:** `orient` reads no working diff, so
  "no diff" is not a signal it has, and a task with no matched symbol already returns an explained
  empty result rather than a narrow one. Its only seed signal is the task match, which already orders
  the ranking (and restarts personalized PageRank in `rankBy: 'pagerank'`). A cold-start multiplier
  would have nothing to broaden.
- **Deferred — `get_minimal_context`:** its distance mode deliberately ignores `tokenBudget` so the
  default shape is never silently truncated (pinned by a test), and its PageRank mode already fits each
  neighbour list with an `omittedForBudget` receipt. Moving it to whole-payload fitting is a separate
  decision.
- **Fixed caps without a budget stay:** the per-section `.slice` caps still apply to sections derived
  per call (spec domains, insertion points, enrichment); only the function and call-path pool widens.

## Why this is in scope

Token-scoped retrieval is the north star's core promise (decision `c6d1ad07`: "retrieval stays
token-scoped and local-first"). This makes the existing budget parameter honest — an exact fit
instead of a hint — using only existing signals and the existing PPR constants discipline.

## Impact

- `src/core/services/mcp-handlers/orient.ts`, `progressive.ts` (exact-fit search, cross-section
  budgeting, receipts), `constants.ts` (fixed-constants table entries with cited sources),
  `get_minimal_context` (same budgeting path, per the PPR requirement's scope).
- Specs: `mcp-handlers` — 2 ADDED (ExactFitTokenBudgeting, SeedConditionedBudgetShaping).
- Risk: payload composition changes for budget-passing callers (mitigated: no-budget default is
  byte-identical to today); rendering cost of the binary search (bounded: it re-renders only the
  entry list, over an already-bounded candidate pool).
