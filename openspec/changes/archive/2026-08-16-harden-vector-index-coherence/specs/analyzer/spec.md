# analyzer spec delta

## ADDED Requirements

### Requirement: VectorIndexCacheCoherence

The vector index's process-lifetime caches (meta sidecar, BM25 corpus, LanceDB table handle) SHALL
be invalidated when the on-disk index has changed since the cache entry was populated, regardless
of which process performed the rebuild. Coherence SHALL be established structurally — by comparing
the meta sidecar's on-disk state (mtime / `builtAt` stamp) against the state captured at cache
population — not by a time-based expiry, and the watcher SHALL additionally clear the caches when
a background rebuild it spawned completes. A remediation the system prints (such as "run
`openlore analyze --force`") SHALL take effect in the live serving process once performed.
Full and incremental mutations SHALL be serialized across processes. A full build SHALL publish
its atomically replaced BM25 corpus before atomically publishing metadata as the coherence commit
point. An incremental row mutation whose metadata commit fails SHALL restore its prior rows.

#### Scenario: Out-of-process rebuild is picked up without restart

- **GIVEN** a live MCP server with warm vector-index caches
- **WHEN** a detached `analyze --force` child (or any other process) overwrites the LanceDB table
  and meta sidecar
- **THEN** the next search invalidates the stale per-dbPath caches and serves the rebuilt dataset,
  routing BM25-vs-dense on the fresh meta

#### Scenario: The printed remediation is honest

- **GIVEN** the watcher deferred a vector update and told the user to run `openlore analyze --force`
- **WHEN** the user (or the watcher's own background rebuild) completes that rebuild
- **THEN** the live server serves the rebuilt index without a process restart

#### Scenario: Publication failure preserves the prior coherent generation

- **GIVEN** an incremental update replaced its changed-file rows
- **WHEN** publishing the metadata coherence stamp fails
- **THEN** the system restores the prior rows, and other warm processes remain coherent with the
  unchanged metadata generation

### Requirement: IncrementalIndexUpdateNeverDropsRowsSilently

The incremental vector-index update SHALL NOT leave the index missing the changed files' rows when
its add step fails after the delete step: the update SHALL either stage-then-swap or restore the
deleted rows on add failure. If the index cannot be restored, the system SHALL record a degraded
marker and disclose "index degraded — re-run analyze" through the search tools' output — a
stderr-only log line SHALL NOT be the sole signal. A transient local-embedding extractor failure
SHALL NOT be memoized: a failed extractor load is retried on the next embed call rather than
replayed for the lifetime of the service instance.

#### Scenario: Add failure restores the deleted rows

- **GIVEN** an incremental update whose delete committed and whose add then fails
- **WHEN** the failure is handled
- **THEN** the previously-read rows are restored (or the delete never committed), and the changed
  functions remain findable via search

#### Scenario: Unrestorable failure is disclosed, not debug-logged

- **GIVEN** both the add and the restore fail
- **WHEN** the next search runs against that index
- **THEN** the result carries an "index degraded — re-run analyze" disclosure

#### Scenario: Extractor failure is retried, not replayed

- **GIVEN** a local embedding service whose first extractor load threw transiently
- **WHEN** a later embed call runs on the same instance
- **THEN** the extractor load is attempted again instead of rethrowing the memoized rejection
