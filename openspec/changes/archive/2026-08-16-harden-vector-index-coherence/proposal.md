# Harden vector index coherence: a rebuilt index must never be served through stale process caches

> Status: IMPLEMENTED (2026-08-16). The live MCP server caches the vector index's
> meta sidecar, BM25 corpus, and LanceDB table handle for the process lifetime — but the watcher
> heals a stale graph by spawning a DETACHED `analyze --force` child that overwrites the table in
> another process, so the server keeps serving the pre-rebuild dataset until restart. Two smaller
> integrity holes ride along: a non-atomic delete-then-add that can silently drop rows, and a
> memoized rejected extractor promise that turns one transient failure into a permanent one.

## The gap

- **[high] Cross-process rebuild leaves the live server's caches stale.** `vector-index.ts` keeps
  three process-lifetime module caches keyed by dbPath — `_metaCache` (`:83`), `_bm25Cache`
  (`:193`), `_tableCache` (`:198`) — invalidated only by same-process `build()`/`updateFiles()`
  (`:423-425`, `:520-522`; plus a test-only reset, `:201`). `readMeta` (`:95-106`) returns the
  cached value forever without checking the file. But the watcher's self-heal
  (`mcp-watcher.ts:669-673`) spawns a **detached** `analyze --force --no-embed` child that
  rebuilds the LanceDB table via `createTable {mode:'overwrite'}` (`vector-index.ts:411-414`,
  `:509`) in another process. Afterwards the server's cached table handle, meta, and corpus
  describe the overwritten dataset: `search()` routes on stale meta (`:738-743`) — it may take
  the dense path against a table that no longer has a vector column — and serves stale rows or
  silently degrades until restart. Worse, the model-changed message tells the user to run
  `analyze --force` (`mcp-watcher.ts:805-811`) — a remediation that cannot take effect in the
  live server that issued it.
- **[medium] `updateFiles` delete-then-add is non-atomic.** The embedded path deletes the changed
  files' rows (`:682`) then adds the rebuilt ones (`:683-685`); the BM25 path is the same shape
  (`:633-635`). A failed `add()` after the committed delete silently drops those functions from
  the index. (The embed call is safely BEFORE the delete, `:666-671` — this is add-failure
  specific.) The watcher caller writes one stderr line (`mcp-watcher.ts:819-821`) and moves on:
  no retry, no restore, no signal in any tool output — the functions vanish from `search_code`
  until the file happens to change again.
- **[low] `LocalEmbeddingService` memoizes a REJECTED extractor promise.** `getExtractor`
  (`local-embedding-service.ts:74-109`) caches the loader promise; if the dynamic
  `import('@huggingface/transformers')` or `pipeline()` throws, every later `embed()` on that
  instance rethrows with no retry. Bounded today because `resolveEmbedder` constructs a fresh
  instance per call (`embedder.ts:39-45`), but within one multi-batch `build`/`updateFiles` run a
  transient failure (first-download network blip) is permanent for the whole run.

**Retained as solid (verified, not touched):** backtick predicate quoting everywhere
(`filePathInPredicate`, `vector-index.ts:232-236`; `text-line-index.ts:113-118`), the
model-switch incremental deferral (`:563-572`) and dim-mismatch BM25 degrade (`:758-760`), and
delete/rename row hygiene via the watcher (`mcp-watcher.ts:1031-1058`).

## What changes

1. **Stat-checked cache coherence.** The meta sidecar already carries `builtAt` (`:78`, written
   at `:420`/`:515`) — `readMeta` gains a cheap stat check (sidecar mtime / `builtAt` vs. the
   value captured when the cache entry was populated) and invalidates all three per-dbPath caches
   when the on-disk index changed since population. The watcher additionally clears the caches
   when its background rebuild completes, so the healed graph is served without waiting for the
   next stat-triggered miss. The model-changed remediation message becomes true: a completed
   out-of-process rebuild is picked up by the live server.
2. **Restore-on-failure for `updateFiles`.** The rows to delete are read (the embedded path
   already reads them for vector reuse, `:645-655`); on `add()` failure, restore the deleted rows
   (or stage-then-swap so the delete never commits first). If restore also fails, write a
   degraded marker into the meta sidecar and surface "index degraded — re-run `openlore analyze`"
   through search results' existing disclosure channel — never only a stderr line.
3. **Reset the extractor memo on failure.** `getExtractor` sets `extractorPromise = null` before
   rethrowing, so the next `embed()` retries instead of replaying the first failure. Error
   messages unchanged.

## Why this is in scope

The watcher's self-heal and the live server are one product: a rebuild the server itself
triggered, whose results the server then cannot see, is silent staleness of exactly the class the
honesty contract exists to kill — and it invalidates the remediation OpenLore prints. All three
fixes are deterministic, local, constant-free (the stat check is a structural fact, not a
threshold), and touch no hot-path semantics on the happy path.

## Impact

- Files: `src/core/analyzer/vector-index.ts` (stat-checked `readMeta`, per-dbPath invalidation,
  restore-on-failure in `updateFiles`, degraded marker), `src/core/services/mcp-watcher.ts`
  (cache clear on rebuild completion; surface add-failure degradation),
  `src/core/analyzer/local-embedding-service.ts` (memo reset); tests for cross-process
  invalidation, add-failure restore, and extractor retry.
- Specs: `analyzer` — 2 ADDED requirements (VectorIndexCacheCoherence,
  IncrementalIndexUpdateNeverDropsRowsSilently); `mcp-handlers` — 1 ADDED requirement
  (SearchDisclosesDegradedVectorIndex).
- Tool surface: unchanged (no new tool; `search_code` output gains a disclosure only in the
  degraded case — negligible payload, re-assert the budget in
  `src/cli/commands/mcp-presets.test.ts`).
- Risk: low. One extra `stat` per cold-ish read path; restore path exercised only on failure;
  no behavior change when the index is coherent.
