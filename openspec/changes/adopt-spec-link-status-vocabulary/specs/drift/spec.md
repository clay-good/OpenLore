# drift spec delta

## ADDED Requirements

### Requirement: SpecLinkStatusNamesUnwantedAndPredated

Drift detection SHALL report, as registered advisory finding codes, `spec-coverage-unwanted` for a
decision or memory that cites a requirement no requirement source contains, and
`spec-citation-predated` for a cited decision or requirement that exists on disk but not in the
index. Both SHALL be computed from the spec link index and the stores only, for any requirement
source the index reads, and SHALL carry the citing record and the requirement name as proof.

#### Scenario: A citation to a deleted requirement is unwanted

- **WHEN** drift is checked and a decision cites a requirement that was removed from its source
- **THEN** the result includes `spec-coverage-unwanted` naming the decision and the requirement

#### Scenario: A citation the index has not seen is predated

- **WHEN** a cited decision exists on disk but is not in the indexed store
- **THEN** the result includes `spec-citation-predated`, and `verify_claim` returns `unverifiable`
  with the reason `predated`

#### Scenario: A repository with no spec framework is silent

- **WHEN** drift is checked in a repository that has no requirement source
- **THEN** neither finding is reported and no error is raised
