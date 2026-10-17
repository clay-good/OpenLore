## ADDED Requirements

### Requirement: Mapping Coverage Availability Disclosure
`audit_spec_coverage` SHALL disclose mapping-derived coverage as `available` or `unavailable`. An unavailable response SHALL include a stable machine-readable reason such as `mapping-not-generated`, `invalid-json`, `incompatible-provenance`, or `fingerprint-mismatch`, plus the mapping artifact path. This requirement is refined by `harden-spec-workflow-lifecycle`; the reason carries the former missing/invalid/stale distinction without creating a conflicting state machine.

#### Scenario: Mapping artifact is absent
- **WHEN** `audit_spec_coverage` runs without `mapping.json`
- **THEN** its mapping-coverage state is `unavailable` with reason `mapping-not-generated`
- **AND** it does not report every function as uncovered
- **AND** it continues to report independently derived stale domains

#### Scenario: Mapping fingerprint does not match cached analysis
- **WHEN** `audit_spec_coverage` reads a valid mapping artifact whose source-analysis fingerprint differs from the current analysis
- **THEN** its mapping-coverage state is `unavailable` with reason `fingerprint-mismatch`
- **AND** it withholds mapping-derived uncovered-function, hub-gap and orphan-requirement conclusions

### Requirement: Coverage Consumers Present Honest Degradation
The audit CLI and MCP response contracts SHALL present an unavailable mapping-coverage state as unavailable rather than as zero coverage or an empty gap set.

#### Scenario: An agent receives a degraded audit response
- **WHEN** the mapping-coverage state is not `available`
- **THEN** the response includes the state and reason needed to refresh or regenerate the artifact
- **AND** the agent can distinguish unavailable coverage evidence from a codebase with no gaps
