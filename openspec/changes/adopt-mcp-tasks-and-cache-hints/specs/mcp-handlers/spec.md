# mcp-handlers spec delta

## ADDED Requirements

### Requirement: CacheHintsNeverOutrunTheLease

When cache hints (`ttlMs` / `cacheScope`) are emitted, they SHALL be derived from the freshness
lease's existing thresholds and SHALL never state a longer validity than the lease gives the same
response. The lease's prose note SHALL stay unchanged beside the hint. A result whose validity ends
on a repository change (a `recall` freshness verdict, an impact certificate) SHALL declare the
most conservative scope and no time-based validity.

#### Scenario: A hint is bounded by the lease

- **WHEN** a tool result is emitted with cache hints while the lease is degraded
- **THEN** the hinted validity does not exceed what the lease discloses, and the prose note is
  byte-identical to the behavior before hints

#### Scenario: Event-bound results decline time-based caching

- **WHEN** cache hints are attached to a `recall` result
- **THEN** the result declares the most conservative scope, so no client cache serves it past a
  repository change

### Requirement: LongOperationsAreTasksWhenNegotiated

When the client negotiates the MCP tasks capability, the full `analyze_codebase` build and the
first-run index build SHALL return task handles with progress and cancel, and a cancel SHALL leave
the index store uncorrupted. Without the capability, behavior SHALL be byte-identical to today. No
other tool SHALL become a task.

#### Scenario: A first-run build becomes observable

- **WHEN** a client with the tasks capability makes its first call against a repository that was
  never analyzed
- **THEN** the build is a task whose progress the client can read

#### Scenario: Cancel is safe

- **WHEN** the client cancels a running `analyze_codebase` task
- **THEN** the build stops, the store is at its earlier state or a flagged partial state, and the
  task reports canceled
