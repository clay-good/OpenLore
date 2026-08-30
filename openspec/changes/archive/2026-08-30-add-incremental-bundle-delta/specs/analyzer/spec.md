# analyzer spec delta

## ADDED Requirements

### Requirement: IncrementalBundleCatchUp

When an imported graph bundle passes the full validation ladder (format, byte-integrity, schema,
digest attestation) and its build commit is a verified ancestor of the working tree's HEAD, the
importer SHALL apply the bundle and then incrementally re-analyze exactly the delta: the files
named by `git diff --name-only <bundleCommit>..HEAD` intersected with the indexed set, plus
working-tree modifications, with deletions removed from the imported index. Catch-up SHALL run
through the same converge-or-flag incremental machinery the watcher uses — reverse-dependency
closure, added-symbol rebinding, bounded by the same work budget, with any over-budget remainder
marked explicitly stale, never served as fresh. A bundle whose commit is not an ancestor SHALL
still trigger a full local rebuild with its reason disclosed, and any validation failure SHALL
degrade to full rebuild before currency is considered. The import report SHALL disclose the path
taken (fresh, delta, or rebuild), the delta size, and any explicitly stale remainder, so a
caught-up import is never conflated with one verified current at build time.

#### Scenario: An ancestor bundle catches up instead of rebuilding

- **GIVEN** a validated bundle built 3 commits behind HEAD in a large repo
- **WHEN** `openlore import` runs
- **THEN** the bundle is applied and only the files changed since the bundle's commit (intersected
  with the indexed set) are re-analyzed with their reverse-dependency closure
- **AND** the report discloses the delta path and file count

#### Scenario: In-budget catch-up converges to the full-rebuild graph

- **GIVEN** a delta whose closure fits the work budget
- **WHEN** catch-up completes
- **THEN** the resulting graph is equivalent to the graph `analyze --force` would produce at HEAD

#### Scenario: An over-budget closure is flagged, not faked

- **GIVEN** a delta whose reverse-dependency closure exceeds the work budget
- **WHEN** catch-up completes
- **THEN** the unrecomputed remainder is marked explicitly stale, exactly as the watcher marks it
- **AND** the import report discloses the stale remainder

#### Scenario: A diverged bundle still rebuilds

- **GIVEN** a validated bundle whose build commit is not an ancestor of HEAD
- **WHEN** `openlore import` runs
- **THEN** a full local rebuild occurs with the diverged reason disclosed, as today
