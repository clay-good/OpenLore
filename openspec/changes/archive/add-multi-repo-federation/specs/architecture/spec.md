# architecture spec delta

## ADDED Requirements

### Requirement: FederationIsAnIndexOfIndexes

The system SHALL support federating multiple repositories as an index-of-indexes: each repository
retains its own independently-built, deterministic `.openlore/` index, and a federation registry
references those indexes by path/remote, fingerprint, and schema version. The system SHALL NOT
construct a merged cross-repository graph in memory; federated queries SHALL load only the per-repo
indexes they need, on demand. Adding or removing a repository SHALL require editing the registry and
building that repository's own index only — never a global rebuild.

#### Scenario: Adding a repo does not trigger a global rebuild

- **GIVEN** a federation registry of N indexed repositories
- **WHEN** a new repository is added
- **THEN** only the new repository is indexed and the registry is updated; the other N indexes are
  untouched

#### Scenario: A federated query loads indexes lazily

- **GIVEN** a federated query scoped to a subset of repositories
- **WHEN** the query runs
- **THEN** only the per-repo indexes required to answer it are loaded, and no merged union graph is
  materialized

### Requirement: CrossRepoIdentityViaStableIds

Cross-repository symbol resolution SHALL use the existing content-addressed stable symbol IDs (SCIP
monikers), with exact-match only and no inference. A published symbol SHALL resolve to its consumers
in other repositories only when those repositories are indexed; unindexed or stale repositories SHALL
be reported as not-consulted, never guessed.

#### Scenario: Resolution is exact and honest about coverage

- **GIVEN** a symbol exported by repo A and consumed by indexed repo B and unindexed repo C
- **WHEN** cross-repo consumers are resolved
- **THEN** repo B's consumers are returned by stable-ID match and repo C is reported as not-consulted
