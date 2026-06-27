# drift spec delta

## ADDED Requirements

### Requirement: MemoryStalenessDetection

The system SHALL detect when a persisted, code-anchored memory no longer matches the code it
describes, and SHALL report it as a drift finding alongside the existing spec-drift classes. Two new
finding kinds SHALL be produced:

- **`memory-drifted`** — an anchored memory whose subject symbol still exists but whose `contentHash`
  changed since the memory was recorded.
- **`memory-orphaned`** — an anchored memory whose subject symbol no longer exists (and is not a
  confidently detected rename).

Memory-staleness detection SHALL ride the same incremental graph rebuild that already recomputes
spec drift, SHALL be deterministic, and SHALL NOT use an LLM. A finding SHALL identify the memory and
the anchor that triggered it so the agent can act on it.

#### Scenario: Deleting an anchored function surfaces memory-orphaned

- **GIVEN** a decision anchored to a function
- **WHEN** that function is deleted and drift is recomputed
- **THEN** a `memory-orphaned` finding identifies the decision and the orphaned anchor

#### Scenario: Editing an anchored function surfaces memory-drifted

- **GIVEN** a memory anchored to a function
- **WHEN** that function's body is modified and drift is recomputed
- **THEN** a `memory-drifted` finding identifies the memory and the changed anchor

#### Scenario: Fresh memory produces no finding

- **GIVEN** a memory whose every anchor is `fresh`
- **WHEN** drift is recomputed
- **THEN** no memory-staleness finding is produced for it

#### Scenario: Confident rename is not reported as orphaned

- **GIVEN** a memory anchored to a function that is renamed, with a confident rename mapping from
  `structural_diff`
- **WHEN** drift is recomputed
- **THEN** the finding is `memory-drifted` referencing the new location, not `memory-orphaned`
