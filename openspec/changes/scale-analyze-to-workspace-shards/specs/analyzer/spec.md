# analyzer spec delta

## ADDED Requirements

### Requirement: WorkspaceShardsAreDetectedDeterministically

The analyzer SHALL detect workspace shards from package manifests already present in the
repository — including npm/pnpm/yarn workspace declarations, Cargo workspace members, Go modules,
Python project files, and Gradle/Maven module declarations — and SHALL represent each detected
package as a named shard with a declared root path and file set.

Detection SHALL be deterministic in both membership and ordering, SHALL be reported to the user,
and SHALL be overridable by an explicit configuration block. A repository with no detectable
package manifests SHALL resolve to exactly one shard covering the whole corpus, and its analysis
SHALL be byte-identical to the analysis produced before shards existed.

A file matching more than one shard root SHALL be assigned to the most specific root, and the
assignment rule SHALL be stated in the reported shard list rather than left implicit.

#### Scenario: A workspace monorepo resolves to its packages

- **GIVEN** a repository whose root manifest declares three workspace packages
- **WHEN** the repository is analyzed
- **THEN** three shards are reported with their roots and file counts, and every source file is
  assigned to exactly one shard

#### Scenario: A single-package repository is unchanged

- **GIVEN** a repository with no workspace declaration
- **WHEN** the repository is analyzed
- **THEN** exactly one shard covering the corpus is reported, and the resulting graph is
  byte-identical to the pre-change graph

#### Scenario: Configuration overrides detection

- **GIVEN** a repository with a workspace declaration and an explicit shard configuration
- **WHEN** the repository is analyzed
- **THEN** the configured shards are used, and the report states that detection was overridden

### Requirement: ShardScopedAnalyzeConvergesOrMarksStale

A shard-scoped analyze SHALL recompute the named shards' files and SHALL re-resolve the
cross-shard edge frontier — every edge whose caller or callee lies in a recomputed shard —
retaining all other stored graph content unmodified.

For the recomputed shards and their frontier, the resulting graph SHALL equal the graph a full
`analyze --force` would produce. Any region the scoped analyze cannot reconcile SHALL be marked
explicitly stale in the graph metadata; it SHALL NOT be left divergent and unmarked, and it SHALL
NOT be served as current. A shard-scoped analyze SHALL NEVER silently narrow the graph by
dropping symbols or edges belonging to shards it did not recompute.

Every shard-scoped analyze SHALL report the shards recomputed, the shards retained, the frontier
size, and any region marked stale, and per-shard freshness SHALL be visible in the substrate's
status surface. A full `analyze --force` SHALL remain the authoritative ground truth against
which shard convergence is defined and tested.

#### Scenario: A scoped analyze equals a full analyze over its scope

- **GIVEN** a three-package fixture where package `b` calls into package `a`, and a change
  confined to `b`
- **WHEN** `b` is analyzed shard-scoped
- **THEN** the graph over `b` and the `b`↔`a` frontier equals the `analyze --force` graph, and
  `a`'s internal edges are retained unmodified

#### Scenario: An unreconcilable frontier is flagged, not silently wrong

- **GIVEN** a scoped analyze whose frontier re-resolution cannot complete within its bounds
- **WHEN** the analyze finishes
- **THEN** the unreconciled region is marked explicitly stale, the report names it, and freshness
  verdicts over it are non-authoritative

#### Scenario: Scoping never amputates the graph

- **GIVEN** a repository where package `c` is not recomputed
- **WHEN** a scoped analyze of package `b` completes
- **THEN** `c`'s symbols and edges are still present in the store, and no call from `b` into `c`
  has been downgraded to an external edge merely because `c` was not recomputed
