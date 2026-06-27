# mcp-quality spec delta

## ADDED Requirements

### Requirement: NoFalseCompleteness

The system SHALL NOT present a conclusion as complete when the computation is known to have crossed a
boundary — a synthesized-edge reliance, a reflection / computed-dispatch blind spot, an unindexed
repository, or a stale index. A boundary-crossing or bounded answer SHALL always be distinguishable
from a complete one. This is the answer-level generalization of per-edge provenance and no-silent-
truncation: a caller can always tell "this is everything" from "this is everything I could see."

#### Scenario: Incomplete is never dressed as complete

- **GIVEN** a conclusion whose computation crossed a known blind spot
- **WHEN** the response is produced
- **THEN** it is marked boundary-crossing and is not presented as a complete result
