# cli spec delta

## ADDED Requirements

### Requirement: RemainingHarnessEventsReceiveReceipts

The team-task-created moment SHALL be wired only when a coordination finding code is blocking, and
Codex sub-agents SHALL get the task-scoped briefing once their task is available to the hook.

#### Scenario: A blocking coordination code at task creation

- **GIVEN** a repository whose `enforcement.policy` makes `parallel-work-conflict` blocking
- **WHEN** a team task is created whose footprint conflicts with a live peer
- **THEN** the task-created receipt names the conflict
