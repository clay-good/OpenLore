# mcp-handlers spec delta

## MODIFIED Requirements

### Requirement: TraversalToolsShareOnePrecomputedRepresentation

All reachability-answering handlers (`select_tests`, `report_coverage_gaps`, `find_dead_code`,
`blast_radius`/`change_footprint`, `find_path`, `trace_execution_path`, `analyze_env_impact`, and
`verify_claim`'s reach kinds) SHALL traverse a single condensation/adjacency structure built or
loaded once per artifact generation, rather than rebuilding per-call adjacency. An unfiltered
whole-graph reach SHALL run as a topological sweep of the condensation DAG; a reach restricted to
directly-resolved edges runs an allocation-free CSR walk instead, because the condensation
describes the whole graph and a filtered graph can have strictly finer components. Every tool's
conclusion payload SHALL be unchanged: for any input, the served answer SHALL equal the answer of
the per-call BFS over the same artifact — including the ORDER-dependent parts of a payload (a
reconstructed `viaPath`, the first N paths a bounded enumeration returns), not merely the set of
results.

A persisted structure SHALL be accepted only when the graph digest it is stamped with matches the
one the served context carries, and SHALL still be refused when its own payload fails its
integrity or bounds checks. Currency is therefore decided by what the structure describes, not by
the bytes of the artifact it was written beside: an incremental flush that leaves the call graph
untouched SHALL NOT cost a rebuild, and no staleness heuristic over file timestamps SHALL stand
between a reader and that decision.

`get_subgraph` and `analyze_impact` traverse the SQLite edge store one batched query per BFS
level and never built per-call adjacency; they are therefore out of scope here, and this
requirement does not silently claim them.

#### Scenario: Answers are equivalent, only faster

- **GIVEN** a fixed analyzed graph and any `select_tests` / `find_dead_code` /
  `report_coverage_gaps` / `blast_radius` invocation
- **WHEN** the answer is served from the precomputed structure
- **THEN** it is element-for-element equal to the per-call BFS answer over the same artifact

#### Scenario: A stale structure is never served

- **GIVEN** an external `openlore analyze` that regenerated the artifacts while a daemon holds
  a loaded structure
- **WHEN** the next traversal tool call arrives
- **THEN** the daemon reloads the structure for the new generation before answering (same
  invalidation the context cache uses), never serving a traversal over the old graph

#### Scenario: A structure survives an edit the graph did not see

- **GIVEN** a warm repo whose watcher has flushed signature changes since the last full analyze
- **WHEN** a traversal tool is called from a fresh process
- **THEN** the persisted structure is loaded and served rather than rebuilt, because the flush
  did not change the graph it is keyed to

#### Scenario: Repeated conclusions over one graph pay the build once

- **GIVEN** a caller that computes many footprints over one graph in a single call
  (`plan_parallel_work`, `map_in_flight_conflicts`)
- **WHEN** each footprint's backward reachability runs
- **THEN** they share one structure for that graph rather than rebuilding adjacency per task
