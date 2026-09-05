# The default tools rebuild derived graph structures and re-parse multi-MB artifacts on every call, and re-scan the whole corpus per keyword search

> Status: PROPOSED (2026-07-03, e2e audit pass 4, scale track). The substrate's own default
> tools (`orient`, `select_tests`, `blast_radius`, `verify_claim`, `search_code`) recompute
> O(graph) derived structures from scratch on every invocation, re-parse multi-megabyte
> artifacts per call, and scan the entire keyword corpus per query — all from data that only
> changes on analyze/flush and is *already* cached at the context layer. At 50k functions the
> monolithic graph artifact is ~150-200MB; every cache miss parses it whole, and every tool
> that walks the graph rebuilds adjacency (~50k Set allocations) per call. These are the
> hot-path costs a warm daemon pays continuously. Overlaps deliberately excluded: the daemon's
> unbounded per-client-directory caches (`harden-daemon-lifecycle` d) and hash-based
> invalidation cutoff (`add-incremental-early-cutoff`).

## The gap

- **(a) The monolithic `llm-context.json` is an O(repo) tax on read and write.** Read:
  `mcp-handlers/utils.ts:321-331` full-`JSON.parse`s on every mtime miss and retains the whole
  object. Write: the watcher parses the *entire* artifact on every flush — even a one-file save
  — patches via linear `findIndex` (`mcp-watcher.ts:603`), and re-serializes pretty-printed
  (`:717`) non-atomically. Measured 10.6MB at 2,837 functions (callGraph = 7.2MB) → ~150-200MB
  at 50k; a single-symbol tool (`get_function_body`) pays the same load as `get_call_graph`.
- **(b) Adjacency + landmarks rebuilt per tool call.** `buildAdjacency` (`graph.ts:74-98`,
  O(N+E)) is called per invocation in 10 handlers (`change-footprint.ts:297` blast_radius,
  `claim-verification.ts:224` verify_claim, `coverage-gaps.ts:115`, `reachability.ts:189,211`,
  `env-impact.ts:197`, `graph.ts:1153`, `pathfind.ts:111,145`); orient additionally does ~4
  full-graph scans per call (`orient.ts:650-708`). These are pure functions of the artifact
  that only changes on analyze/flush.
- **(c) BM25 keyword path scans the whole corpus per query, re-tokenizes per update, and pins
  the unused vector column.** `vector-index.ts:783-803` loads all rows and scores every doc per
  search (the path every zero-config install hits); `patchBm25Cache` (`:213-220`) rebuilds the
  whole corpus per watcher batch despite its "surgically patch" docstring; the cache retains
  every row's Arrow `vector` (~300MB of never-used vectors at 50k×1536); and it invalidates only
  on same-process `build()`, so an external `openlore analyze` leaves a long-lived server
  searching a stale corpus.
- **(d) Multi-MB sibling artifacts + config re-read per call, some uncached.** `mappingCache`
  has zero invalidation (`utils.ts:554,560-563,599`) while its siblings mtime-check, so a
  `generate` rewrite is invisible to a long-lived server (stale spec links for the process
  lifetime). `get_file_dependencies` parses the whole `dependency-graph.json` to return one
  file's edges (`graph.ts:1054-1074`); orient re-reads it + runs `scanViolations` +
  style-fingerprint per call (`orient.ts:619-621,806-807`); `readOpenLoreConfig` is uncached and
  called 3× per orient (`:201,360,769`).
- **(e) Full-table scans + serialization churn.** `getProvenanceForFiles`/`getChangeCouplingForFiles`
  (`edge-store.ts:818-859`) `SELECT *` all rows to return one file's; `remember` with a
  symbol-only anchor loads every internal node and hashes source across the repo
  (`anchor-adapter.ts:247-254`); the output cap pretty-prints the full oversized result then
  re-serializes ~27× while binary-searching (`tool-guard.ts:100-129`); unbounded SQL `IN (…)`
  lists can exceed SQLite's variable limit at 50k-node scale (`edge-store.ts:362-377`); 11 BFS
  loops use O(n) `queue.shift()`.

## What changes

1. **Memoize derived structures beside the context cache.** Cache
   `{forward, backward, nodeMap, landmarkById}` under the same mtime key as `_contextCache`
   (pure functions of the artifact); `primeContextCache` carries them. mtime-key the
   `mappingCache`, `dependency-graph.json` reads, config, and per-orient fingerprint/violation
   scans; hoist the triplicate config read.
2. **Make the EdgeStore the primary graph source for handlers** (it already holds the same
   graph, indexed) and shard/lazy-load the JSON callGraph; index signatures by path so a
   single-symbol tool doesn't load the whole artifact; compact-JSON + tmp-rename the watcher
   write.
3. **Fix the BM25 path:** project columns excluding `vector`, patch df/length incrementally,
   top-k early termination, and an mtime/attestation check so an external analyze invalidates
   the server's corpus cache.
4. **Bound the tail costs:** `WHERE file_path = ?` (indexed) before any full scan in
   provenance/coupling; resolve `remember` anchors via the indexed name lookup and hash only
   candidates; estimate result size with a compact stringify before the cap's binary search;
   chunk `IN (…)` lists at ~900; index-pointer BFS queues.

## Why this is in scope

These are the per-call costs of the tools OpenLore puts in its default surface; at the scale it
advertises they turn sub-second conclusions into multi-hundred-ms (or multi-second) stalls and
pin gigabytes — from data that is already cached one layer up. Every fix is a caching/scoping
change with no conclusion-shape impact.

## Impact

- Files: `src/core/services/mcp-handlers/utils.ts` + `graph.ts` + `orient.ts` (derived-structure
  memo, artifact/config caching), `src/core/analyzer/vector-index.ts` (BM25 projection/patch/
  invalidation), `src/core/services/edge-store.ts` (indexed provenance/coupling, IN chunking),
  `src/core/decisions/anchor-adapter.ts` (indexed anchor resolve), `src/core/services/
  mcp-handlers/tool-guard.ts` (size estimate), `src/core/services/mcp-watcher.ts` (compact +
  atomic write). The non-atomic `llm-context.json` write also matches
  `harden-artifact-write-atomicity`'s scope — coordinate.
- Specs: `mcp-handlers` — 2 ADDED (DerivedGraphStructuresAreMemoizedPerAnalysis,
  ServingCachesInvalidateOnExternalAnalyze); `analyzer` — 1 ADDED
  (KeywordSearchDoesNotScanTheWholeCorpusPerQuery).
- No new tool. Risk: medium — cache invalidation correctness is the hazard; every memo keys on
  the same mtime/attestation the context cache already uses, and an external-analyze test pins
  that a stale corpus/mapping is refreshed. Verify: one orient after priming performs 0
  full-graph loads; a keyword search does not scale its work with corpus size beyond top-k; an
  external analyze invalidates the server caches.
