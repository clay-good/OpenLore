# mcp-handlers spec delta

## ADDED Requirements

### Requirement: LeaseDistinguishesStructuralMovement

The freshness lease SHALL tell repository movement that changed extracted structure apart from
movement that did not. When HEAD moved and every changed file cut off at the fact digest, the note
SHALL state "repo moved; extracted structure unchanged" and the freshness state SHALL NOT be
lowered for that movement. The note SHALL always state that HEAD moved. Movement that changed any
extracted fact SHALL behave as before this change.

#### Scenario: A comment-only commit does not degrade freshness

- **WHEN** a session has oriented and a commit of only comment and formatting edits follows
- **THEN** the freshness state stays as it was
- **AND** the note says the repository moved with extracted structure unchanged

#### Scenario: A structural commit still counts

- **WHEN** a session has oriented and a commit that changed one extracted fact follows
- **THEN** `repoMovedSinceOrient` is true and the state moves from `fresh` to `degraded` as before
