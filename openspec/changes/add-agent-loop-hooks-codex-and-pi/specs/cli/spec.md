# cli spec delta

## ADDED Requirements

### Requirement: CodexAndPiReceiveLoopReceipts

`openlore install` SHALL wire Codex and Pi, only on events that can inject context, with the
before-edit, after-edit, before-stop, after-compact, and sub-agent start moments Claude Code has; the
team-task-created moment SHALL be wired only when a coordination finding code is blocking.

#### Scenario: A Codex edit gets the after-edit receipt

- **GIVEN** a repository installed for Codex
- **WHEN** Codex's `PostToolUse` hook runs on an edit that adds an unresolved import
- **THEN** the receipt names the unresolved import, as it does for Claude Code
