# Clone query tool: ask "does a near-duplicate of THIS already exist?" before writing it

> Status: IMPLEMENTED (2026-06-26, branch `feat/clone-query-tool`). `find_clones` MCP tool +
> `openlore find-clones` CLI shipped; one-vs-all `findClones` query exported from
> `duplicate-detector.ts` (reuses the existing normalization/shingling/Jaccard/thresholds — no new
> algorithm or constant); opt-in full-surface only; classified `conclusion`. Tool count 69→70,
> payload budget 78k→81k. Dogfooded end-to-end on this repo (see `DOGFOOD-clone-query.md`) — the
> dogfood caught and fixed an htmlExcluded mislabel. Net-new, drawn from the standing follow-up named
> twice in the competitive-survey planning docs: *"expose near-clones of a symbol as a conclusion
> tool"*
> (`STRUCTURAL-CONTEXT-PATTERNS.md`, Out of scope) and *"Exposing the existing near-clone detector
> as a conclusion tool. Still worth doing… a thin exposure of `duplicate-detector.ts`"*
> (`FEATURE-UPDATES.md`, Deliberately considered). This change builds exactly that thin exposure.
> Grounded in the north star (`overview/spec.md`, decision `c6d1ad07`): deterministic,
> locally-computed structural context, conclusion over graph.

## The gap

OpenLore already ships a near-clone detector (`src/core/analyzer/duplicate-detector.ts` — Type 1
exact / Type 2 structural / Type 3 near via Jaccard on token n-grams, pure static analysis, no LLM)
and already exposes it through one MCP tool, `get_duplicate_report`. But that tool answers only the
*whole-repo audit* question — "here is every clone group in the codebase" — by reading a precomputed
`duplicates.json`. It cannot answer the question an agent actually has at the moment of writing code:

> "I am about to write (or have just written) **this** function — does a near-duplicate already
> exist that I should reuse or extend instead of reinventing?"

That question is **scoped to one thing**: a single symbol the agent is editing, or a single snippet
the agent is about to add. The whole-repo report is the wrong shape for it (the agent must scan a
large group list and find the relevant one by hand — a node-and-edge-style traversal the
conclusion-over-graph contract exists to prevent), and for a *snippet that is not yet in the repo* the
whole-repo report cannot help at all, because the code is not indexed.

There is one more concrete limit `get_duplicate_report` inherits and a query tool removes: the
whole-repo near-clone (Type 3) pass is `O(n²)` and is therefore **skipped entirely** on large repos
(`MAX_NEAR_FUNCTIONS = 400` ungrouped candidates). A one-vs-all *query* is `O(n)`, so it can compute
near-clones of the one query against the whole codebase even where the whole-repo pass declined to.

## What changes

A new opt-in MCP conclusion tool, **`find_clones`**, plus an `openlore find-clones` CLI front-end.
It takes one of two queries and returns the existing clones of it, ranked:

1. **`symbol` mode** — name (or `name::path`) of a function already in the indexed call graph.
   OpenLore extracts that function's body from its persisted byte range and compares it against every
   other indexed function.
2. **`snippet` mode** — a raw code string the agent is about to write. OpenLore normalizes and
   compares it against every indexed function — answering the pre-write question the whole-repo report
   structurally cannot.

The result is a **conclusion**: a ranked match list (`exact` → `structural` → `near`, then similarity
descending), each match naming the file, function, class, line range, clone type, and similarity — the
canonical existing implementation to reuse. Not a graph.

All the clone math is the existing detector's, reused — this change adds **no new similarity
algorithm, threshold semantics, or tuning constant**. It exports a one-vs-all `findClones(query, …)`
query function from `duplicate-detector.ts` (sharing the exact same normalization, shingling, Jaccard,
and thresholds as the whole-repo `detectDuplicates`) and a thin handler that loads the cached call
graph, reads the source it spans, and calls it.

## What does NOT change

- **No new algorithm or constant.** `find_clones` reuses `normalizeType1/2`, the 5-gram shingles,
  Jaccard, and the same `MIN_LINES` / `MIN_TOKENS` / `NEAR_THRESHOLD` evidence thresholds as the
  existing detector. The caller MAY raise/lower the *near* floor for one query (clamped), but the
  default is the detector's `NEAR_THRESHOLD` and the floor is reported in the result.
- **No persisted-artifact change, no schema migration.** The tool computes live from the already
  persisted call graph (whose nodes carry `startIndex`/`endIndex`) plus a re-read of the source it
  spans — the same live-recompute posture as `find_dead_code` / `analyze_impact`. Nothing new is
  written during `analyze`; older indexes work unchanged.
- **No new always-on surface.** `find_clones` is full-surface-only (opt-in), never in
  `MINIMAL_TOOLS`, the lean first-run default, or any curated preset — same posture as
  `get_style_fingerprint` and `briefing_since` (`default-to-lean-tool-surface`, `mcp-quality`).

## Honesty constraints (north-star invariants)

- A `symbol` that is not in the index returns an explicit *not found* error (with near-miss
  candidates), never an empty "no clones" that an agent would read as "this is unique."
- A query below the evidence floor (`< MIN_LINES` lines or `< MIN_TOKENS` normalized tokens) returns a
  `belowThreshold` signal — "too small to compare," not "no clones found."
- `near` matches appear only at or above the (reported) similarity floor; `exact`/`structural` are
  always included. The query never matches itself.
- HTML inline-script symbols are excluded from comparison and the exclusion is disclosed, because
  their persisted byte ranges were computed against transformed (blanked) HTML content and would
  misalign a live re-read — honesty over a silently wrong slice.
- The result is deterministic: re-running against a fixed repository state and query is byte-identical
  (stable tie-break by file then start line).

## Out of scope

- **Cross-language clones.** Comparison is over normalized tokens; it does not attempt to match a
  Python function to a Go one. (The detector's normalization is language-agnostic but the value is in
  same-language reuse; no cross-language claim is made.) Because the normalization *can* nonetheless
  produce a cross-language `near` match, each match carries its `language` and the query carries its
  own, so a consumer can see and disregard a cross-language hit — the limitation is disclosed and
  actionable, not silent.
- **Refactor synthesis.** The tool reports the canonical existing implementation; it does not propose
  or apply a deduplicating refactor. That remains the agent's job.
- **A new persisted fingerprint index.** Considered (it would make repeated queries cheaper) but
  rejected for this change to stay thin and avoid a schema addition; live `O(n)` recompute is fast
  enough for an interactive query and matches the existing live-recompute tools.

At implementation time, call `record_decision` before writing code (per project `CLAUDE.md`): one
decision for the new MCP tool + its `conclusion` contract, and one for the reused-detector / no-new-
constant query design.
