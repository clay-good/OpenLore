# mcp-handlers spec delta

## ADDED Requirements

### Requirement: OrientAndBlastRadiusCarrySymbolHistory

`orient` and `blast_radius` SHALL carry an additive `history` field on the functions they list:
the introducing commit, the last non-bulk commit that changed the symbol, and the number of
renames followed. The introducing commit SHALL be asserted only when the scan reached the bottom
of history; otherwise the field SHALL read "introduced no later than `<sha>`". No new tool SHALL
be added for this answer.

#### Scenario: A function's history arrives with orientation

- **WHEN** `orient` lists a function that was changed in several commits, one through a squash-merged PR
- **THEN** its `history` names the introducing commit and the last change with raw subject, author and PR number

#### Scenario: A shallow clone gives no birth date

- **WHEN** the repository history is cut off before the symbol was introduced
- **THEN** `history` reads "introduced no later than" the oldest scanned commit and the boundary is disclosed

#### Scenario: A rename does not cut the history

- **WHEN** a listed function was renamed and an identity chain bridges the rename
- **THEN** commits from before the rename are included and `followedRenames` is 1

#### Scenario: A bulk commit is not the last change

- **WHEN** the newest commit that touched the symbol also touched more files than the bulk threshold
- **THEN** that commit is labeled `bulk` and `lastChanged` names the newest non-bulk commit
