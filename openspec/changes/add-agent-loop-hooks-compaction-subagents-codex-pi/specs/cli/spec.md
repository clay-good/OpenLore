# cli spec delta

## ADDED Requirements

### Requirement: RemainingLoopMomentsReceiveReceipts

`openlore install` SHALL wire, for Claude Code, Codex, and Pi, and only on events that can inject
context, the moments after compaction (the handoff briefing), at sub-agent start (a task-scoped
`orient` plus peers' live footprints), and after any batch of tool calls (test runs seen for the
session ledger); the team-task-created moment SHALL be wired only when a coordination finding code
is blocking. Codex and Pi SHALL get the before-edit, after-edit, and before-stop moments Claude Code
has. The before-edit moment SHALL also grade the pending edit's references in memory.

#### Scenario: An invented import is stated before the write

- **GIVEN** a pending edit whose new text imports `formatDate` from `packages/utils`, which does not
  export it
- **WHEN** the before-edit hook runs on the edit tool's payload
- **THEN** it prints the unresolved-symbol fact, and the target file is unchanged by the hook

#### Scenario: Compaction gets the handoff briefing

- **GIVEN** a Claude Code session that is compacted
- **WHEN** the `SessionStart` hook with the `compact` matcher fires
- **THEN** the hook prints the handoff briefing for the in-flight change
