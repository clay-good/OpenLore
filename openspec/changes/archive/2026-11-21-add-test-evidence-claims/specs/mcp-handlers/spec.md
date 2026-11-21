# mcp-handlers spec delta

## ADDED Requirements

### Requirement: VerifyClaimSupportsTheTestedKind

`verify_claim` SHALL support a `tested` claim kind whose subject is a symbol. The verdict SHALL be
`confirmed` only when an `asserts-on` relationship exists, with the test file, test name, and
assertion line in the receipt. It SHALL be `refuted` only when a reachable symbol has no test
relationship of any class. It SHALL be `unverifiable` when the strongest class is `exercises` or
`reaches`, or when the framework's assertions were not recognized, and SHALL name which.

#### Scenario: An assertion-backed symbol is confirmed

- **WHEN** a `tested` claim is verified for a symbol whose output an assertion consumes
- **THEN** the verdict is `confirmed` and cites the test file, test name, and assertion line

#### Scenario: Reachability alone is not confirmed

- **WHEN** a `tested` claim is verified for a symbol its tests only reach
- **THEN** the verdict is `unverifiable` and names the class `reaches`

#### Scenario: An unrecognized framework is not refuted

- **WHEN** a `tested` claim is verified for a symbol whose tests use unrecognized assertions
- **THEN** the verdict is `unverifiable` and names the framework gap

### Requirement: ChangeAnswersCarryTestEvidence

`blast_radius` and `verify_change` SHALL report the evidence class of each test they list and the
strongest class for each changed symbol, without changing which tests are selected. `verify_change`
SHALL raise the advisory finding `changed-symbol-no-asserting-test` for a changed symbol whose
tests are in a recognized framework and none of which is `asserts-on`. The finding SHALL NOT be
raised when the framework is unrecognized.

#### Scenario: A changed symbol with only reaching tests

- **WHEN** `verify_change` runs on a diff that changes a symbol whose Vitest tests only reach it
- **THEN** the answer carries `changed-symbol-no-asserting-test` for that symbol as an advisory finding
- **AND** the tests to run are the same as before this change

#### Scenario: An unrecognized framework raises nothing

- **WHEN** the changed symbol's tests use a framework with no recognizer
- **THEN** no `changed-symbol-no-asserting-test` finding is raised and the gap is stated
