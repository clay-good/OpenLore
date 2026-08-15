# Tasks — harden-analyze-rebuild-atomicity

## Implementation
- [x] Atomic rebuild in artifact-generator.ts writeEdgesToSQLite: wrap clear+insert in ONE
      transaction, or build a temp DB and atomically rename (matching the dep-graph
      tmp+rename at mcp-watcher.ts:923-925)
- [x] Edge idempotence: add a uniqueness key to the edges table OR a repo-level analyze
      lockfile so only one full rebuild runs at a time; concurrent/retried rebuild cannot
      double edges
- [x] Watcher SQLITE_BUSY handling: bounded backoff retry; on continued contention buffer
      the stale-mark in memory until writable and disclose a deferred/dropped batch (not a
      stderr-only line)

## Verification
- [x] Concurrency test: a reader issuing analyze_impact/find_dead_code during a full rebuild
      never observes an empty or edge-less graph (sees old-complete or new-complete)
- [x] Idempotence test: two concurrent full rebuilds produce the correct single-count edge
      set, not doubled fan-in
- [x] Crash test: a rebuild interrupted before completion leaves the previous complete graph,
      not a half-empty store
- [x] Lock test: a forced >5s write lock causes the watcher to retry/buffer-and-disclose,
      never a silent stale graph
- [x] Full suite green

## Spec
- [x] `architecture` delta: ADD FullRebuildIsAtomicForConcurrentReaders,
      EdgeStoreRebuildIsIdempotentUnderConcurrency,
      WatcherLockContentionNeverSilentlyDropsWork
