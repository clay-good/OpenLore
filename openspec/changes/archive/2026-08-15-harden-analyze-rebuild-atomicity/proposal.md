# The full edge-store rebuild is not atomic — concurrent readers see empty/partial/doubled graphs, and a >5s lock silently drops watcher work

> Status: PROPOSED (2026-07-03, e2e audit pass 4). `writeEdgesToSQLite` clears the store and
> then commits nodes, edges, classes, and CFG in **separate** transactions. WAL gives
> snapshot isolation per transaction, so a second process (the MCP server, or another agent)
> that reads mid-rebuild sees a committed-but-partial state — zero nodes, or nodes with no
> edges — and serves "X is dead / has no callers" as authoritative. Two concurrent full
> analyzes (realistic since PR #216's cold-start bootstrap auto-builds while the user runs
> `openlore analyze`) double every edge, because `edges` has no uniqueness constraint. And a
> full-rebuild write that holds the WAL lock past the 5s `busy_timeout` throws in the watcher,
> which drops the batch with only a stderr line — re-opening the exact staleness that
> `fix-transitive-incremental-staleness` closed. Distinct from `harden-index-store-lifecycle`
> (version-bump DROP, corruption quarantine) and `harden-daemon-lifecycle` (double-daemon
> start): this is steady-state cross-process store integrity.

## The gap

- **(a) Non-atomic rebuild.** `artifact-generator.ts:1341-1344+` runs `store.clearAll()` as
  its own statement, then `insertNodes` / `insertEdges` / `insertClasses` / CFG each in a
  separate `runTransaction` (`edge-store.ts:29-58`). A reader between the clear and the last
  insert sees an empty or edge-less graph. A crash mid-rebuild leaves the store permanently
  half-empty. The direct `EdgeStore` readers in the MCP handlers have no integrity gate — the
  attestation check lives on the `readCachedContext` JSON path (`mcp-handlers/utils.ts:362`),
  not the SQL path.
- **(b) No edge uniqueness → doubled graph under concurrent rebuild.** `edges` has no primary
  key or unique constraint (`edge-store.ts:104-115`) and `insertEdges` is plain `INSERT`
  (`:403-426`), while nodes use `INSERT OR REPLACE`. Two interleaved `clearAll`+insert
  sequences double every edge — doubled caller lists, inflated fan-in, wrong blast radius in
  every conclusion tool, with no error. There is no repo-level analyze lock.
- **(c) A >5s write lock silently drops watcher work.** `busy_timeout` is 5s
  (`edge-store.ts:22`), but one `insertEdges` on a large repo (~16k+ rows here, far more at
  scale) can hold the WAL write lock longer. The losing watcher write throws and is dropped
  by the watcher's broad catches (`mcp-watcher.ts:325,330,398`); `markFilesStale` can't
  compensate — it targets the same locked store. The graph is then silently stale for those
  files. Secondary: `DatabaseSync` is synchronous, so a contended write freezes the MCP
  server's event loop for up to 5s.

## What changes

1. **Make the rebuild atomic.** Wrap the whole clear+insert sequence in one transaction (WAL
   readers keep seeing the old graph until commit) OR build into a temp DB file and atomically
   rename over the live one. Either way a reader sees the complete previous graph or the
   complete new one — never a partial.
2. **Guarantee edge idempotence / a single-writer rebuild.** Add a uniqueness key to `edges`
   (or an analyze lockfile so only one full rebuild runs at a time), so a concurrent or
   retried rebuild cannot double the graph.
3. **Handle `SQLITE_BUSY` in the watcher honestly.** Retry with bounded backoff; on continued
   contention, buffer the stale-mark in memory until the store is writable and disclose a
   dropped/deferred batch instead of a stderr-only line — the graph must never be silently
   stale after a lock timeout.

## Why this is in scope

Every conclusion the substrate emits reads this store; a partial or doubled graph makes the
deterministic answers wrong while still looking authoritative — the deepest form of the
honesty failure the project exists to avoid. The cold-start bootstrap shipped in PR #216 made
the concurrent-rebuild race a live default-path scenario, not a theoretical one.

## Impact

- Files: `src/core/analyzer/artifact-generator.ts` (single-transaction or temp+rename
  rebuild), `src/core/services/edge-store.ts` (edge uniqueness / lock), `src/core/services/
  mcp-watcher.ts` (SQLITE_BUSY retry + buffered stale-mark + disclosure).
- Specs: `architecture` — 3 ADDED (FullRebuildIsAtomicForConcurrentReaders,
  EdgeStoreRebuildIsIdempotentUnderConcurrency, WatcherLockContentionNeverSilentlyDropsWork).
- No new tool. Risk: medium — the single-transaction rebuild changes the write path's lock
  profile (one longer write lock instead of several short ones); the temp+rename variant
  avoids that and matches the dep-graph artifact's existing tmp+rename. Test with two
  processes: a reader during a rebuild must never observe an empty/edge-less graph; two
  concurrent rebuilds must not double edges; a forced >5s lock must not drop the watcher's
  stale-mark.
