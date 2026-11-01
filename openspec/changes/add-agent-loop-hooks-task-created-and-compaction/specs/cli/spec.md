# cli spec delta

## ADDED Requirements

### Requirement: RemainingHarnessMomentsReceiveReceipts

The Pi extension SHALL give the handoff briefing before a compaction; the team-task-created moment
SHALL be wired only when a coordination finding code is blocking; Codex sub-agents SHALL get the
task-scoped briefing once their task is available to the hook.

#### Scenario: Pi resumes from computed state

- **GIVEN** a Pi session with an in-flight change
- **WHEN** Pi compacts the session
- **THEN** the handoff briefing is part of what the agent keeps
