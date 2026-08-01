# validator spec delta

## ADDED Requirements

### Requirement: ValidationResultsReachTheReport

When the writer runs validation (`validateBeforeWrite`), the resulting errors and warnings
SHALL be recorded in the generation report (path-prefixed), not only logged. The report SHALL
NOT present an unconditionally clean validation result. Validation is advisory (specs still
write); the report SHALL reflect what validation actually found.

#### Scenario: An invalid spec is reported, not hidden

- **GIVEN** a generated spec that fails structural validation
- **WHEN** generation completes with validation enabled
- **THEN** `report.validationErrors` contains the failure (with its file path), rather than
  being empty
