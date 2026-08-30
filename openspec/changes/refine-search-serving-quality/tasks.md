# Tasks — refine-search-serving-quality

## Implementation
- [x] Prefilter code search: push `language`/`minFanIn` into `.where(pred, {prefilter: true})` on
      the ANN query (vector-index.ts:762-763) with backtick-quoted columns (discipline at
      :225-236); fall back to fetch-widening where a predicate cannot express the filter
- [x] Prefilter spec search the same way for `domain`/`section` (spec-vector-index.ts:475-484)
- [x] Disclose "filter constrained recall" when a filtered result set is below `limit` despite a
      non-exhausted table (semantic.ts:212 code path, :543 spec path). The implemented database
      prefilters exhaust the filtered candidate set, so the post-filter constraint case no longer
      exists and needs no warning.
- [x] `scoreKind` ("rrf" | "bm25" | "cosine_distance") attached at the source of each score:
      RRF merge (vector-index.ts:836), BM25 (:895, spec-vector-index.ts:541), dense distance
      (vector-index.ts:776, spec-vector-index.ts:501); pass through semantic.ts:256 and :558
- [x] Optional (nicety, only if ranking tests stay green): normalize served scores to one
      higher-is-better scale; `scoreKind` ships regardless. Normalization was intentionally not
      taken; existing score/ranking bytes remain unchanged.
- [x] Watcher compaction: `table.optimize()` on an idle/every-N-batches cadence and after large
      deletions (reuse existing batch bookkeeping in mcp-watcher.ts; document the cadence)
- [x] Spec-file lane: watch indexed specs and ADRs under the configured OpenSpec root; incremental update or scoped rebuild of the
      specs table (SpecVectorIndex currently build()-only, spec-vector-index.ts:298); at minimum
      surface "spec index built at <builtAt>, N spec files changed since" in search_specs

## Verification
- [x] Filtered-recall test: rows matching `language`/`domain` exist below the fetch horizon →
      results fill `limit` (prefilter) or the constraint is disclosed (widening path)
- [x] Polarity test: `search_specs` semantic vs. BM25 results each carry the correct `scoreKind`;
      no consumer-visible score is served without one
- [x] Compaction test: N watch batches → optimize invoked; query results unchanged before/after
- [x] Spec-lane test: edit a spec.md under watch → `search_specs` reflects it (or discloses
      staleness) without a full analyze
- [x] Payload budget re-asserted (`src/cli/commands/mcp-presets.test.ts`, 56 tests); `scoreKind`
      is a result field and does not enlarge the standing `tools/list` schema payload
- [ ] Full suite green; ranking snapshots unchanged where normalization was not taken

## Spec
- [x] `analyzer` delta: ADD FilteredSearchRecallIsHonest, SearchIndexMaintenanceAndSpecFreshness
- [x] `mcp-handlers` delta: ADD SearchScoresAreSelfDescribing
