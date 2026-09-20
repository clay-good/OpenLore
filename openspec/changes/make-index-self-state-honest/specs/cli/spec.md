# Spec Delta

## ADDED Requirements

### Requirement: DoctorReportsTheRetrievalModeActuallyServed

`openlore doctor` SHALL report the retrieval mode the repository's index actually serves, derived
from the on-disk index rather than from configuration or endpoint reachability alone. An embedding
endpoint check SHALL NOT be presented as evidence that semantic retrieval is available: the two
SHALL be distinct lines with distinct verdicts.

When a semantic provider is resolvable (configured endpoint, `EMBED_*` environment, or the local
provider) and the on-disk index carries no vectors, `doctor` SHALL raise a finding stating that the
configured expectation is unrealized, naming the remedy that rebuilds the index. A repository with
no embedding provider configured SHALL NOT produce that finding — its keyword index is the
first-class default and reports a passing verdict.

#### Scenario: A reachable endpoint with a keyword index is a finding, not a pass

- **GIVEN** a repository whose configuration names a reachable embedding endpoint
- **AND** an on-disk index built without vectors
- **WHEN** `openlore doctor` runs
- **THEN** the endpoint line reports reachable, and a separate finding states the served retrieval
  mode is keyword while a semantic provider is configured, naming the rebuild remedy

#### Scenario: An unconfigured repository passes

- **GIVEN** a repository with no embedding provider configured and a keyword index
- **WHEN** `openlore doctor` runs
- **THEN** the served mode is stated as the keyword default and no finding is raised

#### Scenario: A realized semantic index passes

- **GIVEN** a repository whose index carries vectors from its configured provider
- **WHEN** `openlore doctor` runs
- **THEN** the served mode is reported as the semantic mode in use, with no mismatch finding

### Requirement: IndexSelfStateIsQueryableInOneCommand

The CLI SHALL provide a command that reports the index's own state for the current repository
without rebuilding it: the retrieval mode served, when the index was built, whether it is behind the
working tree, and — when the served mode is keyword — which of the two causes applies (no provider
configured, or a configured provider whose vectors are absent). The command SHALL be read-only, SHALL
exit non-zero only when it cannot read the index, and SHALL offer a `--json` form carrying the same
fields.

#### Scenario: The served mode and its cause are stated

- **GIVEN** a repository whose configuration names an embedding provider and whose index has no vectors
- **WHEN** the user runs the status command
- **THEN** the output states the keyword mode served, the configured provider, and that the configured
  provider is unrealized in the current index

#### Scenario: Reading the state never mutates it

- **GIVEN** any repository with an index
- **WHEN** the status command runs
- **THEN** no index file, lock, or receipt is written, and the index's build stamp is unchanged

#### Scenario: A missing index is reported, not crashed

- **GIVEN** a repository with no analysis directory
- **WHEN** the status command runs
- **THEN** it states that no index exists and names the command that builds one

### Requirement: IndexBuildFailureIsVisibleOutsideTheDaemonLog

A failure to build the semantic index when a provider was resolved — an unreachable endpoint, a
provider error, or contention on the index's mutation lock — SHALL be recorded in the index receipt
that `doctor`, the status command, and the agent-facing freshness lease read. Recording the failure
only in a daemon log file SHALL NOT satisfy this requirement.

#### Scenario: A watcher-side embed failure reaches the agent surface

- **GIVEN** a background watcher whose embedding requests to a configured endpoint fail
- **WHEN** the next `doctor` or status command runs
- **THEN** the failure is reported from the receipt, naming the configured endpoint and the time of
  the failure

#### Scenario: A recovered build clears the report

- **GIVEN** a recorded embed failure and a subsequent successful index build
- **WHEN** the same surfaces are consulted
- **THEN** no stale failure is reported
