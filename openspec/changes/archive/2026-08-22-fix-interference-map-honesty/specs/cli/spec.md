# cli spec delta

## ADDED Requirements

### Requirement: EnforcementJsonUsesVersionedSeverityVocabulary

`openlore enforce --json` SHALL identify its serialized contract as `schemaVersion: 2`. Every finding
in its `blocking`, `advisory`, and `off` arrays SHALL use the canonical severity vocabulary `info`,
`warning`, `error`, or `critical`. Version 2 SHALL replace the legacy warning spelling `warn` with
`warning` so consumers can migrate with an explicit envelope version.

#### Scenario: Enforcement JSON declares the normalized contract

- **GIVEN** an enforcement run that emits a warning-level governance finding
- **WHEN** the caller requests JSON output
- **THEN** the envelope reports `schemaVersion: 2`
- **AND** the finding severity is `warning`, not `warn`
