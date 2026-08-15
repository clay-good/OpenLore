# architecture spec delta

## ADDED Requirements

### Requirement: FullRebuildIsAtomicForConcurrentReaders

A full rebuild of the edge store SHALL be atomic with respect to concurrent readers: a
process reading the store while a rebuild is in progress SHALL observe either the complete
previous graph or the complete new graph, never a partial state (empty nodes, or nodes
without their edges). A rebuild interrupted by a crash SHALL leave the previous complete
graph intact, not a half-written store.

#### Scenario: A reader during rebuild never sees a partial graph

- **GIVEN** the MCP server answering `analyze_impact` while `openlore analyze` rebuilds the
  store in another process
- **WHEN** the read lands between the store clear and the final insert
- **THEN** it reads the complete prior graph (or the complete new one), never zero nodes or
  edge-less nodes, so it does not report a real symbol as dead or callerless

### Requirement: EdgeStoreRebuildIsIdempotentUnderConcurrency

A full rebuild SHALL be idempotent under concurrency: two rebuilds running at once, or a
retried rebuild, SHALL NOT double the edge set. This SHALL be enforced structurally (edge
uniqueness or a single-writer rebuild lock), not by convention.

#### Scenario: Cold-start bootstrap and a manual analyze do not double the graph

- **GIVEN** the cold-start bootstrap building the index while the user runs `openlore analyze`
- **WHEN** both rebuild the store
- **THEN** the resulting graph has single-count edges and correct fan-in, not doubled caller
  lists

### Requirement: WatcherLockContentionNeverSilentlyDropsWork

When a watcher write loses the store's write lock past the busy timeout, the watcher SHALL
retry with bounded backoff and, on continued contention, buffer the stale-mark until the
store is writable and disclose the deferred work — it SHALL NOT drop the batch with only a
stderr line, which would leave the graph silently stale for those files.

#### Scenario: A long rebuild lock does not strand stale files

- **GIVEN** a full-rebuild write holding the WAL lock longer than the busy timeout
- **WHEN** a watcher batch write contends and times out
- **THEN** the watcher retries or buffers the stale-mark and discloses it, so the affected
  files are eventually re-analyzed rather than left silently stale
