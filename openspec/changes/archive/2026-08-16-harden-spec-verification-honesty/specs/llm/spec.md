# llm spec delta

## ADDED Requirements

### Requirement: DecisionsVerificationPersistenceIsPartitionSafe

The decisions verification persist step SHALL enforce a partition invariant over its input: every
decision submitted for verification SHALL land in exactly one of `verified`, `phantom`, or an
explicit `unassessed` remainder for decisions the LLM response did not mention. An unassessed
decision SHALL be retained with its draft status unchanged and disclosed in the command output —
never silently dropped from the store. A draft SHALL be marked `'rejected'` only when its
consolidated replacement was actually persisted or a human explicitly rejected it; `'rejected'`
SHALL never be a side effect of LLM omission.

#### Scenario: A decision the LLM omits survives

- **GIVEN** 5 draft decisions submitted to verification
- **AND** a well-formed LLM response listing only 4 of them
- **WHEN** the persist step runs
- **THEN** the fifth decision is retained as a draft with its status unchanged
- **AND** the command output discloses it as unassessed

#### Scenario: An unassessed draft stays visible to memory surfaces

- **GIVEN** a draft left unassessed by a verification run
- **WHEN** recall, orient, or decision projection reads the store
- **THEN** the draft is not hidden as inactive, because it was never marked `'rejected'`

#### Scenario: Rejection requires a persisted replacement or a human verdict

- **GIVEN** any verification run
- **WHEN** drafts are patched after persistence
- **THEN** every draft marked `'rejected'` either has its consolidated replacement in the
  persisted set or carries an explicit human rejection
