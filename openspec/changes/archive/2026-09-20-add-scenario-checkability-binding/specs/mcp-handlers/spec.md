# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ScenarioVerificationPathsAreComputedAndBounded

`audit_spec_coverage` SHALL label each scenario of a requirement with a resolvable symbol
anchor as `verification-path-exists` (at least one test reaches an anchored symbol via the
existing backward reachability, with the reaching tests named) or `no-reaching-test`; scenarios
of a requirement without a resolvable anchor SHALL be labeled `not-assessable` with the reason.
The response SHALL state the sound direction verbatim: a verification path existing means a
test reaches the anchored code, never that the test asserts the scenario's behavior. The label
vocabulary SHALL be closed, and the sibling link-status vocabulary (unwanted/predated) SHALL be
cross-referenced, not duplicated.

#### Scenario: A reaching test yields a named verification path

- **GIVEN** a requirement anchored to `chargeCard` and a test whose reachable set includes
  `chargeCard`
- **WHEN** `audit_spec_coverage` runs
- **THEN** each of the requirement's scenarios is labeled `verification-path-exists` naming
  that test, and the reachable-is-not-asserted sentence is present

#### Scenario: A missing anchor is not-assessable, never guessed

- **GIVEN** a requirement whose anchor does not resolve against the graph
- **WHEN** `audit_spec_coverage` runs
- **THEN** its scenarios are labeled `not-assessable` with the anchor reason, and no reaching
  test is claimed
