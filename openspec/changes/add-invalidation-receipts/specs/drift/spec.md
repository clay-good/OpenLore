# drift spec delta

## ADDED Requirements

### Requirement: InvalidationCarriesACommitReceipt

When staleness detection finds that an anchored memory is no longer fresh, the system SHALL record
once the invalidating commit and a cause from the closed set `anchor-content-changed`,
`symbol-deleted`, `superseded-by <id>`. The commit SHALL be the first commit after the memory's
valid-from commit whose change to the anchored file breaks the anchor's content hash, found by a
bounded walk of local git history. When the commit cannot be identified, the receipt SHALL record
`unknown` with the reason and SHALL NOT contain a guessed identifier. `recall` SHALL attach the
receipt to drifted and orphaned results, and an as-of query SHALL report the closed validity
interval. A receipt SHALL NOT change which memories are stale, and a stored receipt SHALL NOT be
rewritten.

#### Scenario: An orphaned memory names the commit

- **GIVEN** a memory anchored to a symbol that commit C deleted
- **WHEN** staleness detection runs and the memory is recalled
- **THEN** it is served as orphaned with the receipt `symbol-deleted` at commit C

#### Scenario: Unknown history is stated, not guessed

- **GIVEN** a stale memory whose valid-from commit is outside the available git history
- **WHEN** the receipt is made
- **THEN** it records the cause, commit `unknown` and the reason, and no SHA

#### Scenario: An as-of query reports the closed interval

- **GIVEN** a memory valid from commit A and invalidated at commit C
- **WHEN** `recall` runs as of a ref between A and C, and again as of a ref after C
- **THEN** the first serves the memory as valid and the second reports the interval closed at C
  with its cause

#### Scenario: A receipt is written once

- **GIVEN** a memory with a stored receipt
- **WHEN** a later analyze or watcher pass runs
- **THEN** the stored receipt is unchanged
