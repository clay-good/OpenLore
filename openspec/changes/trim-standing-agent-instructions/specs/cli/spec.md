# cli spec delta

## ADDED Requirements

### Requirement: StandingInstructionsStayShort

The instruction block that `openlore install` manages SHALL be 8 lines or fewer and SHALL name no
OpenLore tool that the wired preset does not expose. A `CLAUDE.md` that OpenLore generates SHALL NOT
`@`-import the full `CODEBASE.md` when the slim digest exists; it SHALL name the full digest's path
in one line instead. Every MCP tool description SHALL be 800 characters or fewer.

#### Scenario: A fresh install loads little text

- **GIVEN** a repository with no `CLAUDE.md` and an index with a slim digest
- **WHEN** `openlore install` runs
- **THEN** the generated `CLAUDE.md` holds the managed block of 8 lines or fewer and no `@`-import
  of `CODEBASE.md`

#### Scenario: No slim digest yet

- **GIVEN** an index that has `CODEBASE.md` and no `CODEBASE.slim.md`
- **WHEN** a `CLAUDE.md` is generated
- **THEN** it keeps the `@`-import, so the agent still gets repository shape

#### Scenario: A user line is not touched

- **GIVEN** a `CLAUDE.md` with an `@.openlore/analysis/CODEBASE.md` line outside the managed markers
- **WHEN** `openlore install` runs again
- **THEN** that line is unchanged
- **AND** `openlore status` names the line and its size once

#### Scenario: A long tool description fails the guard

- **WHEN** a tool description in `TOOL_DEFINITIONS` is longer than 800 characters
- **THEN** the tool-contract test fails and names the tool
