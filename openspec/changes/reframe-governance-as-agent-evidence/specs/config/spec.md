## ADDED Requirements

### Requirement: SourceDefaultsNeverBlock

Every code in the finding-code registry SHALL declare the source default class `advisory`. A
finding SHALL resolve to `blocking` or `frozen` only when the repository's `enforcement.policy`, or
the legacy `block` sugar that lowers onto it, names its code. A repository with a declared policy
SHALL get the same class as before for every code the policy names. A CI test SHALL guard the
registry.

#### Scenario: No policy means no block

- **GIVEN** a repository with no `enforcement.policy` and a corpus reference that does not resolve
- **WHEN** `openlore enforce --hook` runs
- **THEN** the `corpus-reference-unresolved` finding is reported as advisory and the command does not fail the commit

#### Scenario: A declared policy still blocks

- **GIVEN** an `enforcement.policy` that maps `corpus-reference-unresolved` to `blocking`
- **WHEN** `openlore enforce --hook` runs on the same repository
- **THEN** the finding is blocking and the commit fails

#### Scenario: The registry cannot regress

- **GIVEN** a new finding code registered with the default class `blocking`
- **WHEN** the registry test runs in CI
- **THEN** the test fails and names the code
