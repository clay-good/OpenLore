# mcp-handlers spec delta

## ADDED Requirements

### Requirement: TraversalToolsShareOnePrecomputedRepresentation

All reachability-answering handlers (`select_tests`, `report_coverage_gaps`, `find_dead_code`,
`blast_radius`/`change_footprint`, `find_path`, and the graph traversal behind `get_subgraph` /
`analyze_impact` where the artifact graph is the source) SHALL traverse the single precomputed
condensation/adjacency structure loaded once per artifact generation, rather than rebuilding
per-call adjacency. Whole-graph reaches SHALL run on the condensation DAG. Every tool's
conclusion payload SHALL be unchanged: for any input, the served answer SHALL equal the answer
of the per-call BFS over the same artifact.

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
