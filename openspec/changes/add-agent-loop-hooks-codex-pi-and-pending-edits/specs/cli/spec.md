# cli spec delta

## ADDED Requirements

### Requirement: RemainingLoopMomentsReceiveReceipts

`openlore install` SHALL wire Codex and Pi, only on events that can inject context, with the
before-edit, after-edit, before-stop, after-compact, and sub-agent start moments Claude Code has; the
team-task-created moment SHALL be wired only when a coordination finding code is blocking. The
before-edit moment SHALL also grade the pending edit's references in memory.

#### Scenario: An invented import is stated before the write

- **GIVEN** a pending edit whose new text imports `formatDate` from `packages/utils`, which does not
  export it
- **WHEN** the before-edit hook runs on the edit tool's payload
- **THEN** it prints the unresolved-symbol fact, and the target file is unchanged by the hook
