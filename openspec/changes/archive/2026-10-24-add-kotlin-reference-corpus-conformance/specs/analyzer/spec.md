# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinSupportIsProvenByAReferenceProjectLedger

The analyzer SHALL keep a realistic Kotlin reference project as a test fixture and a checked-in
ledger of expected facts about it: nodes, edges with their confidence, absent edges, routes,
schemas, environment reads, entry-point roots, exception escapes, and boundary sites. Each ledger
entry SHALL be either asserted or a known gap that names the change expected to close it. A
conformance test in the default test lane SHALL fail when an asserted entry does not hold, and SHALL
fail when a known-gap entry holds, until that entry is promoted to asserted. A second test SHALL
compare the Kotlin row of the language-support registry with a declared target that names every
capability still missing. The Kotlin section of the language-support documentation SHALL be
generated from the ledger and guarded against drift. The reference project SHALL be parsed only; the
test SHALL NOT require a Kotlin compiler or a build tool.

#### Scenario: An asserted fact regresses

- **GIVEN** a ledger entry that asserts an edge from a service function to a repository function
- **WHEN** a change removes that edge and the conformance test runs
- **THEN** the test fails and names the entry

#### Scenario: A known gap closes without being promoted

- **GIVEN** a known-gap entry for the absence of routes in the reference project
- **WHEN** route extraction starts to return those routes and the ledger is unchanged
- **THEN** the conformance test fails until the entry is promoted to asserted

#### Scenario: A wrong edge is a recorded absence

- **GIVEN** a ledger entry that expects no edge from a client call `client.get(...)` to an
  unrelated same-package method named `get`
- **WHEN** the analyzer emits that edge
- **THEN** the conformance test fails

#### Scenario: The capability target tracks the registry

- **GIVEN** a declared Kotlin capability target that lists `errorPropagation` as missing
- **WHEN** Kotlin begins to back `errorPropagation` and the target is unchanged
- **THEN** the capability-target test fails until the target is updated

#### Scenario: The documentation equals the ledger

- **GIVEN** the Kotlin section of the language-support documentation
- **WHEN** the documentation guard runs
- **THEN** its supported, known-gap, and out-of-scope lists equal the ledger's
