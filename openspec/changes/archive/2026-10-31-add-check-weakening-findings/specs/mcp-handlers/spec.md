# mcp-handlers spec delta

## ADDED Requirements

### Requirement: CheckWeakeningIsReportedAgainstAFixedBaseline

`verify_change` and `structural_diff` SHALL report, as registered advisory governance findings,
each diff shape from a closed table that weakens a check: `test-removed`, `test-disabled`,
`assertions-reduced`, `expected-value-changed`, `suppression-added`, `error-swallowed`, and
`check-config-relaxed`. Shapes SHALL be computed against the baseline text at the resolved merge-base,
never against the agent's most recent commit. Each finding SHALL name the production symbols the affected test reached at the baseline.
`expected-value-changed` SHALL fire only when no production symbol reached by that test changed.
Messages SHALL state the fact neutrally. A file in a language or framework outside the table SHALL
be reported `not-assessed`, never as free of weakening.

#### Scenario: A skipped test names what it was guarding

- **GIVEN** a diff that changes `parseConfig` and adds `.skip` to the only test reaching it
- **WHEN** `verify_change` runs
- **THEN** a `test-disabled` finding names the test and `parseConfig` as the symbol it reached

#### Scenario: A weakening split across commits is still found

- **GIVEN** a branch whose first commit removes two assertions and whose second commit edits code
- **WHEN** `verify_change` runs against the merge-base
- **THEN** an `assertions-reduced` finding is reported for the test

#### Scenario: An expected value updated with the code is not reported

- **GIVEN** a diff that changes both an assertion's expected literal and the production function the
  test reaches
- **WHEN** the shapes are computed
- **THEN** no `expected-value-changed` finding is reported for that assertion
