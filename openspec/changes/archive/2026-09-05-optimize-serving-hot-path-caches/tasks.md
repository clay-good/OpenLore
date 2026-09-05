# Tasks — optimize-serving-hot-path-caches

The proposal was written 2026-07-03. Four of its claims were re-verified against the code at
implementation time and had already been closed by later work; they are recorded below as
**already fixed** rather than silently dropped, so the delta between proposal and build is
readable.

## Already fixed before this change (verified, not rebuilt)

- [x] (b) `buildAdjacency` per tool call — closed by `optimize-reachability-precompute`; the
      traversal index serves every handler and `buildAdjacency` has no production caller.
      A guard test now pins that it stays that way.
- [x] (c2) `patchBm25Cache` rebuilding the corpus per watcher batch — it patches df/length
      incrementally today.
- [x] (c4) An external `openlore analyze` leaving the server on a stale BM25 corpus — closed by
      the `vector-index-meta.json` stamp check in `readMeta`.
- [x] (a2-iv) The non-atomic `llm-context.json` write — closed by
      `harden-artifact-write-atomicity`; the watcher uses `atomicWriteFile` under the analysis
      lock, with its own guard test.

## Implementation

- [x] Stamp-key the `mappingCache` on `mapping.json` (`dev:ino:mtimeNs:size`) — an external
      `generate` was invisible for the process lifetime, so a daemon served the previous
      generation's spec links forever
- [x] Add the shared `artifactStamp` / `readJsonArtifactCached` sibling-artifact cache and route
      `dependency-graph.json` (`get_file_dependencies`, `orient`) and the style-fingerprint
      artifact through it
- [x] Hoist orient's triplicate `readOpenLoreConfig` to the one read it already does
- [x] Route `get_function_body`'s unfocused path through `readCachedContext` — a single-symbol
      tool was parsing the whole artifact outside the cache, without its size ceiling or
      generation check
- [x] BM25: score only the documents a query term can reach (per-corpus postings index), and
      drop the never-read embedding column from the rows the keyword cache retains
- [x] Tail costs: index-answered provenance/coupling reads; indexed anchor resolve in
      `remember`; exact prefix-sum truncation cut instead of ~24 full re-serializations;
      chunked SQL `IN (…)` lists; head-index BFS drains on the graph-sized queues; one
      path→position index for the watcher's per-batch signature patch

## Deliberately not built (scope, recorded so the next reader does not re-derive it)

- Sharding / lazy-loading the monolithic `llm-context.json`, and making the EdgeStore the
  primary graph source for handlers. Both are structural rewrites of the artifact contract
  with their own correctness surface (the watcher's `graphDigest` round-trip invariant, the
  generation-manifest binding); they do not belong in a caching change.
- Compact (non-pretty) serialization of `llm-context.json`. Byte-for-byte artifact
  determinism is separately pinned; changing the encoding is its own change.
- `bfs()` in `mcp-handlers/graph.ts` keeps its `shift()` drain: it is the frozen reference the
  traversal index is pinned against, not a serving path.

## Verification

- [x] Guard test: `buildAdjacency` has no production caller; orient reads config once and its
      sibling artifacts through the stamp-keyed cache; `get_function_body` reads through the
      shared context cache
- [x] Search test: the candidate set equals the documents that score above zero, and does not
      grow with corpus size for a fixed match count
- [x] Invalidation test: a `mapping.json` rewritten by another process is picked up on the next
      read; an unchanged one is parsed once; a deleted one stops being served; the stamp
      separates two writes inside the same millisecond
- [x] Scope test: per-file provenance/coupling reads return exactly what the tolerant full-scan
      comparator returned (exact, leading-slash, both suffix directions, LIKE metacharacters,
      no match); `remember` with a symbol-only anchor reads only that symbol's file
- [x] Correctness: the truncation cut is byte-exact and maximal for every JSON escape class
      (quote, backslash, short/long control, 2/3/4-byte UTF-8, lone surrogate) and never splits
      an astral character
- [x] Scale test: a 2,500-id frontier crosses the SQLite bound-variable ceiling in one call
- [x] Full suite green

## Spec

- [x] `mcp-handlers` delta: ADD DerivedGraphStructuresAreMemoizedPerAnalysis,
      ServingCachesInvalidateOnExternalAnalyze
- [x] `analyzer` delta: ADD KeywordSearchDoesNotScanTheWholeCorpusPerQuery
