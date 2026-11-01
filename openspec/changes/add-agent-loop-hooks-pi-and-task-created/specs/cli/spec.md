# cli spec delta

## ADDED Requirements

### Requirement: PiAndTaskCreationReceiveLoopReceipts

The Pi extension SHALL append the after-edit receipt to an `edit`, `write`, or `bash` tool result
without loading the analyzer in the Pi process, and SHALL give the handoff briefing before a
compaction. The team-task-created moment SHALL be wired only when a coordination finding code is
blocking.

#### Scenario: A Pi edit gets the after-edit receipt

- **GIVEN** a Pi session with OpenLore's extension
- **WHEN** an `edit` adds an unresolved import
- **THEN** the tool result the agent reads ends with the receipt naming it
