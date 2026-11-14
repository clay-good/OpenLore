# verifier spec delta

## ADDED Requirements

### Requirement: CoverageDistinguishesShallowFromDeep

Each requirement the spec link index reports as `linked` SHALL carry a coverage depth: `deep` when
a test reaches the linked symbol, `shallow` when none does, and `not-assessed` when reachability
cannot be computed. The depth SHALL reuse the existing test reachability and SHALL apply to any
requirement source the index reads. When a change touches a symbol whose linked requirement is
`shallow`, drift output SHALL include the advisory finding `spec-coverage-shallow`.

#### Scenario: Linked code that no test reaches is shallow

- **WHEN** the link index is resolved for a requirement whose linked symbol no test reaches
- **THEN** the requirement is `linked` with depth `shallow`, distinct from one a test reaches

#### Scenario: A change to shallow-covered code is reported

- **WHEN** a diff changes a symbol linked to a `shallow` requirement
- **THEN** `verify_change` and `blast_radius` carry `spec-coverage-shallow` with the requirement
  name and the symbol

#### Scenario: Depth is not guessed

- **WHEN** the linked symbol is in a language without test detection
- **THEN** the depth is `not-assessed`
