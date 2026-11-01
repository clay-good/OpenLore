# cli spec delta

## ADDED Requirements

### Requirement: CodexReceivesLoopReceipts

In a repository install, `openlore install` SHALL wire Codex's `.codex/hooks.json` with the
before-edit (`PreToolUse` on `apply_patch`), after-edit (`PostToolUse` on `apply_patch` and `Bash`),
before-stop (`Stop`), and after-compact (`SessionStart`, `compact`) moments, keeping every other
hook and removing only its own on uninstall. An `apply_patch` payload SHALL be read as the files
its patch touches, never as a shell command.

#### Scenario: A Codex patch onto a generated file is stated before it lands

- **GIVEN** a repository installed for Codex and a generated file `src/gen.ts`
- **WHEN** Codex's `PreToolUse` hook runs on an `apply_patch` that updates `src/gen.ts`
- **THEN** the receipt names `src/gen.ts` as generated

#### Scenario: Uninstall keeps the user's hooks

- **GIVEN** a `.codex/hooks.json` with the user's own `PreToolUse` hook and OpenLore's moments
- **WHEN** OpenLore is uninstalled
- **THEN** only the user's hook remains
