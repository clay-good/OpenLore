# architecture spec delta

## ADDED Requirements

### Requirement: AdditiveBitemporalMemorySchema

The memory record schema SHALL be extended additively with optional bitemporal fields:
`validFromCommit` (commit SHA at record time), `invalidatedAt`, and `invalidatedByCommit`, plus an
optional `type` from a fixed closed set (defaulting to `note`). All SHALL be optional so that memory
stores written before this change load without migration and behave as always-valid,
never-invalidated, and typed as `note`. The valid-from marker SHALL be derived deterministically from
git `HEAD`, never from an LLM or a clock-only value, so that recall history is reproducible for a
fixed repository state. The `type` SHALL be a caller-supplied label, never inferred.

#### Scenario: Legacy memory loads without migration

- **GIVEN** a memory store written before bitemporal fields existed
- **WHEN** the store is loaded
- **THEN** every memory loads successfully and is treated as authoritative (never invalidated), with
  no migration step required

#### Scenario: Valid-from is reproducible

- **GIVEN** the same repository at the same commit
- **WHEN** a memory is recorded twice in that state
- **THEN** both records carry the same `validFromCommit`
