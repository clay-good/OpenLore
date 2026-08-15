## ADDED Requirements

### Requirement: MemoryFindingsFollowTheScopeUnderReview

When drift detection runs with a scope — a diff, an explicit changed-file set, or a file pattern — memory staleness findings SHALL enumerate only anchors whose files intersect that scope. Out-of-scope drifted anchors SHALL be reported as a count with the reason `out-of-scope`, never as individual findings. An unscoped run SHALL keep repository-wide enumeration.

Scoping SHALL NOT change any verdict: an anchor's freshness is computed the same way whether it is enumerated or counted.

#### Scenario: A scoped run does not enumerate untouched anchors

- **GIVEN** seventeen drifted anchors of which two are anchored to files in the current diff
- **WHEN** drift runs scoped to that diff
- **THEN** the two in-scope anchors are enumerated and the remaining fifteen appear only as an out-of-scope count

#### Scenario: An unscoped run is unchanged

- **GIVEN** the same repository
- **WHEN** drift runs with no scope
- **THEN** every drifted anchor is enumerated as it is today

### Requirement: DriftInspectionDoesNotMutateAnchoredRecords

Drift detection SHALL NOT modify decision or memory stores. An orphaned anchor SHALL remain a finding on repeated runs unless an explicit lifecycle operation changes the record. A committed deletion or rename on the branch under review SHALL NOT permanently change how that record is treated on another branch.

This read-only guarantee SHALL apply equally to uncommitted changes, committed branch-local changes, and repositories without resolvable history.

#### Scenario: Branch-local deletion remains an observation

- **GIVEN** a decision anchored to a file deleted on the branch under review
- **WHEN** drift runs twice
- **THEN** both runs report the same orphaned finding and the decision store remains byte-for-byte unchanged

#### Scenario: Returning to the base branch restores the current verdict

- **GIVEN** an anchored file renamed or deleted only on a review branch
- **WHEN** the caller returns to the base branch and refreshes analysis
- **THEN** the original record is evaluated against that branch without any persisted disposition from the review branch
