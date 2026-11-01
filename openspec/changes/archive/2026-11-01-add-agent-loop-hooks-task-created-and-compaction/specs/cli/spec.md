# cli spec delta

## ADDED Requirements

### Requirement: PiResumesFromTheHandoffAfterCompaction

After Pi compacts a session in an OpenLore project, the Pi extension SHALL compute the handoff
briefing with `openlore hook after-compact` in a node child process and queue it as a message for
the next turn, so the agent resumes from the change's computed state. A silent hook, a failure,
`json` or `print` mode, or a directory outside an OpenLore project SHALL send nothing.

#### Scenario: Pi compacts a session

- **GIVEN** a Pi session in an OpenLore project with an in-flight change
- **WHEN** Pi compacts the session
- **THEN** the handoff briefing is queued as a message for the next turn
