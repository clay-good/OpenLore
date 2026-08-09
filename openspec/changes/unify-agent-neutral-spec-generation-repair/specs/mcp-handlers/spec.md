## ADDED Requirements

### Requirement: Mapping Coverage Availability Disclosure
`audit_spec_coverage` SHALL disclose whether mapping-derived coverage is `available`, `missing`, `invalid`, or `stale`, including a machine-readable reason and the mapping artifact path.

#### Scenario: Mapping artifact is absent
- **WHEN** `audit_spec_coverage` runs without `mapping.json`
- **THEN** its mapping-coverage state is `missing`
- **AND** it does not report every function as uncovered
- **AND** it continues to report independently derived stale domains

#### Scenario: Mapping fingerprint does not match cached analysis
- **WHEN** `audit_spec_coverage` reads a valid mapping artifact whose source-analysis fingerprint differs from the current analysis
- **THEN** its mapping-coverage state is `stale`
- **AND** it withholds mapping-derived uncovered-function, hub-gap and orphan-requirement conclusions

### Requirement: Coverage Consumers Present Honest Degradation
The audit CLI and MCP response contracts SHALL present an unavailable mapping-coverage state as unavailable rather than as zero coverage or an empty gap set.

#### Scenario: An agent receives a degraded audit response
- **WHEN** the mapping-coverage state is not `available`
- **THEN** the response includes the state and reason needed to refresh or regenerate the artifact
- **AND** the agent can distinguish unavailable coverage evidence from a codebase with no gaps
