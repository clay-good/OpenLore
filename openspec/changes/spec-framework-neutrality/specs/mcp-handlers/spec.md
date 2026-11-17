## ADDED Requirements

### Requirement: AbsentSpecSourceIsDisclosedNotAnErrorOrASilentZero

When no spec source is found, every spec-dependent answer SHALL say `no spec source found`, give
the machine-readable reason `no-spec-source`, and list the source kinds it looked for. It SHALL NOT
return a bare empty list or a zero that reads as a measurement, and SHALL NOT tell the user to run
`openlore generate`. Existing response keys SHALL keep their names. Answers computed from code,
tests and decisions SHALL be returned in full.

#### Scenario: orient in a repository with no spec source

- **GIVEN** a repository with no spec source and a built index
- **WHEN** an agent calls `orient`
- **THEN** the response has its usual functions, callers and insertion points
- **AND** `specDomains` is empty and `specSources` reports `found: []` with the kinds looked for

#### Scenario: Scenario coverage is not reported as 0%

- **GIVEN** a repository with no spec source
- **WHEN** an agent calls `get_test_coverage`
- **THEN** `coveragePercent` is `null` with the reason `no-spec-source`, not `0`
- **AND** a `note` says `no spec source found` and names the kinds looked for

#### Scenario: Spec search and drift do not point at an LLM step

- **GIVEN** a repository with no spec source
- **WHEN** an agent calls `search_specs`, `list_spec_domains`, `get_spec` or `check_spec_drift`
- **THEN** each response carries the reason `no-spec-source`
- **AND** no response text contains `openlore generate`

#### Scenario: A repository with OpenSpec is unchanged

- **GIVEN** a repository with an `openspec/specs/` corpus
- **WHEN** the same tools are called
- **THEN** their responses are the same as before this requirement, with no `specSources` field
  added to `orient`
