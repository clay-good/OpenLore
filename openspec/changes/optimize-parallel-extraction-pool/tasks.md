# Tasks — optimize-parallel-extraction-pool

> Status: BUILT. Measured on this repo (macOS, 10 cores, pool size 8):
> call-graph build **19.1s → 7.3s** (2.6×); full `openlore analyze --no-embed` **24.6s → 18.1s**.
> Pass 1 was 14.3s of the 20.2s serial build (71%) before the change.

## Implementation
- [x] Worker entry module (`src/core/analyzer/extraction-worker.ts`): receives the build's file
      record and runs the SAME `dispatchFileExtract` the serial lane runs (per-worker parser
      singletons come free from the per-thread module registry; the Lua/Dart WASM grammars keep
      their isolated-module discipline per worker), then posts plain fact objects (nodes, raw
      edges, CFG, style, parse-health)
- [x] Deviation from the proposal, deliberate: workers receive the file's CONTENT, not just its
      path. `build`'s input content is authoritative and is not always what is on disk — HTML
      pages arrive inline-script-blanked, the incremental path passes in-memory content, and test
      builds pass synthetic files — so a worker-side re-read would change facts, not just I/O
- [x] Startup parse probe in the worker: the extractors return EMPTY (they do not throw) when a
      grammar is unavailable, so a worker proves it can parse one known snippet before it accepts
      work; an unhealthy worker is dropped rather than silently contributing nothing
- [x] Worker→parent log relay: grammar-unavailable warnings are posted to the parent and deduped
      there, so an unavailable language is disclosed once per run, not once per worker
- [x] Pool lane in `CallGraphBuilder.build`: Pass 1 split into an EXTRACT step (pooled or serial)
      and a MERGE step that walks `files` by index — completion order can never reach the graph
- [x] Pool sizing constants in `src/constants.ts` (`EXTRACTION_POOL_MAX`,
      `EXTRACTION_POOL_MIN_FILES`, `EXTRACTION_POOL_STARTUP_TIMEOUT_MS`); size =
      `min(availableParallelism() - 1, EXTRACTION_POOL_MAX, fileCount)`; pool created once per
      build, terminated after Pass 1
- [x] Fail-soft ladder: per-file worker death → serial re-extract of that file on the main thread;
      an extractor that THROWS inside a worker is recorded as that file's parse failure (identical
      to the serial lane, no retry); no healthy worker / unresolvable worker entry /
      `OPENLORE_NO_WORKERS=1` → wholesale serial; a worker that never reports ready is dropped on
      a startup timeout instead of hanging analyze. Every degraded outcome is disclosed on the
      build result (`CallGraphResult.extractionLane`) and warned in the analyze output
- [x] Serial path kept as the reference implementation — it is also the fallback executor, and the
      pool module contains no extraction logic at all

## Verification
- [x] Byte-equality oracle: `openlore analyze` on a clean checkout of this repo, pooled and with
      `OPENLORE_NO_WORKERS=1` — every content artifact byte-identical (llm-context, repo-structure,
      dependency-graph, style-fingerprint, parse-health, all inventories, CODEBASE/ARCHITECTURE).
      The four artifacts that do differ (SUMMARY.md, fingerprint.json, refactor-priorities.json,
      vector-index-meta.json) differ ONLY in a wall-clock timestamp, and differ identically
      between two SAME-lane runs — pre-existing, not lane-dependent
- [x] Order-independence test: a stub pool that answers later files FIRST (asserting the
      completion order really was inverted) still yields a byte-identical serialized graph,
      including the colliding-symbol case where merge order decides which node survives
- [x] Worker-crash test: one worker dies mid-file, and separately all workers die — every file is
      accounted for, facts identical to serial, fallback disclosed
- [x] WASM-in-worker test: Lua and Dart fixtures interleaved with TypeScript extract identically
      on real threads and on the main thread (asserted non-empty, so the comparison cannot pass by
      both lanes finding nothing)
- [x] Real-thread test: `worker_threads` workers spawn, probe, extract, and match serial byte for
      byte (`extraction-pool-threads.test.ts`)
- [x] Wall-clock measured and reported above; no unmeasured speedup claims anywhere in docs
- [x] Full suite green (321 files / 6137 tests), lint + typecheck clean

## Spec
- [x] `analyzer` delta: ADD ExtractionPoolPreservesDeterministicOutput
