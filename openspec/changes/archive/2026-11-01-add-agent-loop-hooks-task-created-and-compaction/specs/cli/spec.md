# cli spec delta

## ADDED Requirements

### Requirement: PiResumesFromTheHandoffAfterCompaction

After Pi compacts a session in an OpenLore project, the Pi extension SHALL compute the handoff
briefing with `openlore hook after-compact` in a node child process without holding the compaction
open, and SHALL add the latest compaction's briefing to the next prompt as a conversation message,
so the agent resumes from the change's computed state. A silent hook, a failure, `json` or `print`
mode, `hooks.after-compact: false`, or a directory outside an OpenLore project SHALL add nothing.

#### Scenario: Pi compacts a session

- **GIVEN** a Pi session in an OpenLore project with an in-flight change
- **WHEN** Pi compacts the session
- **THEN** the next prompt carries the latest handoff briefing as a conversation message, once
