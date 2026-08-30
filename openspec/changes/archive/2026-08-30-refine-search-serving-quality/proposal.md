# Refine search serving quality: filters that filter, scores that say what they are, an index that stays fit

> Status: IN PROGRESS (2026-08-30). Four quality gaps in how search results are
> served: filters applied in JS after the top-N ANN fetch can return zero despite matching rows;
> the score field's meaning flips between retrieval modes with no per-result disclosure; no
> LanceDB compaction ever runs, so long-lived sessions accrete fragments; and the spec index has
> no incremental lane, so spec edits are invisible to `search_specs` while the code index stays
> live. Sibling changes own the tokenizer and cache/atomicity fixes — this change assumes them.

## The gap

- **[medium] Filters run in JS AFTER the top-N ANN fetch.** Code dense recall fetches `limit*5`
  (cap 500) candidates with no prefilter (`vector-index.ts:762-763`), then applies
  `language`/`minFanIn` in JS (`:765-769`; RRF merge `:839-843`); spec search does the same for
  `domain`/`section` (`spec-vector-index.ts:475-484`). A filtered query — `search_code` with
  `language` (`semantic.ts:212`), `search_specs` with `domain` (`:543`) — can return fewer than
  `limit`, or zero, even though matching rows exist just below the fetch horizon. Nothing
  discloses that the filter constrained recall.
- **[medium] Score semantics are mode-dependent and undisclosed — polarity FLIPS in
  `search_specs`.** Semantic spec search returns LanceDB cosine `_distance` (lower = better,
  `spec-vector-index.ts:501`) while BM25 mode returns higher = better (`:526`, `:541`), passed
  through verbatim (`semantic.ts:558`) with only `retrievalMode` disclosed (`:538-539`, `:550`).
  `search_code` avoids the flip but mixes scales (~0.008–0.03 RRF vs. unbounded BM25;
  `semantic.ts:256`, `vector-index.ts:836`, `:895`). The mode-dependence is documented — in a
  source comment on `SearchResult.score` (`vector-index.ts:49-56`) that no tool consumer ever
  sees; the dense-only raw-distance branch (`:772-776`) is latent (no production caller passes
  `hybrid: false`) but returns the flipped polarity to anyone who does.
- **[low] No LanceDB compaction ever.** Zero calls to `optimize`/`compactFiles`/
  `cleanupOldVersions` anywhere in `src` (verified by grep). Every watch batch tombstones + adds
  fragments; a long-lived session's query latency and disk footprint grow monotonically with no
  ceiling and no maintenance pass.
- **[medium] The spec index has no incremental lane.** `SpecVectorIndex` exposes only a full
  `build()` (`spec-vector-index.ts:298`); the watcher has zero references to it and does not
  watch `openspec/` (verified by grep). A spec edit is invisible to `search_specs` until the next
  full `analyze`, while the code index updates live — an asymmetry no user would expect, and
  nothing disclosed.

## What changes

1. **Prefiltered recall.** Push `language`/`minFanIn`/`domain`/`section` into LanceDB as a
   `.where(pred, {prefilter: true})` using the established backtick-quoting discipline
   (`filePathInPredicate`, `vector-index.ts:232-236`) — or, where a predicate cannot express the
   filter, widen the fetch until the filtered set fills `limit` or the table is exhausted. Either
   way, disclose in the result when a filter constrained recall below `limit`.
2. **Self-describing scores.** Every served search result gains a `scoreKind` field
   (`"rrf" | "bm25" | "cosine_distance"`) stating the number's meaning and polarity — the honesty
   fix is the requirement. Normalizing to one higher-is-better scale is the nicety, taken only if
   it does not disturb existing ranking tests; `scoreKind` ships regardless.
3. **Periodic compaction.** The watcher runs `table.optimize()` on an idle/every-N-batches cadence
   and after large deletions — reusing the watcher's existing batch bookkeeping, no new tuning
   constant beyond the cadence choice, which is documented and conservative.
4. **A spec-file lane.** The watcher tracks the exact indexed specs and ADRs under the configured
   OpenSpec root. At minimum, `search_specs` disclosures state "spec index built at <builtAt>, N
   authoritative files changed since" (the sidecar already stamps `builtAt`).

Cross-reference siblings: `fix-bm25-identifier-tokenization` owns the tokenizer (not touched
here); `harden-vector-index-coherence` owns cache invalidation and delete/add atomicity — this
change assumes those fixes and adds none of its own cache machinery.

## Why this is in scope

Search is the substrate's front door, and all four gaps are silent-degradation shapes: a filter
that quietly starves results, a score whose meaning the consumer cannot know, an index that slows
down by design, and a staleness asymmetry nobody disclosed. Every fix is deterministic, local,
and reuses established disciplines (backtick predicates, `builtAt` stamps, watcher lanes).

## Impact

- Files: `src/core/analyzer/vector-index.ts` and `spec-vector-index.ts` (prefilter/widen,
  `scoreKind`), `src/core/services/mcp-handlers/semantic.ts` (pass-through + recall-constrained
  disclosure), `src/core/services/mcp-watcher.ts` (compaction cadence, spec-file lane); tests per
  gap.
- Specs: `analyzer` — 2 ADDED requirements (FilteredSearchRecallIsHonest,
  SearchIndexMaintenanceAndSpecFreshness); `mcp-handlers` — 1 ADDED requirement
  (SearchScoresAreSelfDescribing).
- Tool surface: no new tool; `search_code`/`search_specs` results gain `scoreKind` and an
  occasional disclosure line — small per-result payload, measure against the budget ceiling in
  `src/cli/commands/mcp-presets.test.ts`.
- Risk: low-medium. Prefilter predicates must honor the backtick discipline (silent-no-op hazard
  is documented at `vector-index.ts:225-231`); compaction runs off the query path; `scoreKind` is
  additive metadata.
