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

### Requirement: OrphanedAnchorToADeletedFileIsRetiredOnce

An anchored record whose file is absent from both the working tree and `HEAD` SHALL be retired: the store records a terminal disposition with the stable reason `anchor-file-deleted`, and subsequent drift runs SHALL NOT re-report it. Retirement SHALL NOT delete or rewrite the recorded text, and `recall` with `asOf` SHALL still serve the retired record with its retired disposition.

A file that is merely absent from the working tree but present in `HEAD` SHALL NOT be retired, since it may be an uncommitted deletion under review.

#### Scenario: Deleted anchor stops being re-reported

- **GIVEN** a decision anchored to a file deleted several commits ago
- **WHEN** drift runs twice
- **THEN** the first run retires the record with reason `anchor-file-deleted` and the second run reports no finding for it

#### Scenario: Uncommitted deletion is not retired

- **GIVEN** an anchored file deleted in the working tree but still present in `HEAD`
- **WHEN** drift runs
- **THEN** the record keeps its orphaned finding and is not retired

#### Scenario: A retired record stays queryable

- **GIVEN** a record retired for a deleted anchor
- **WHEN** `recall` is called with an `asOf` predating the deletion
- **THEN** the record is served with its original text and a retired disposition, never as authoritative current memory
