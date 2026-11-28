# cli spec delta

## ADDED Requirements

### Requirement: StandingInstructionsStayShort

The instruction text of the block `openlore install` manages (between the markers, not counting the
fingerprint line) SHALL be 8 lines and 700 bytes or fewer, and SHALL name no OpenLore tool the wired preset does not expose. A generated `CLAUDE.md`
SHALL NOT `@`-import the full `CODEBASE.md` when the prompt hook delivers the slim digest; it SHALL
name the path in one line. Its workflow section SHALL be 10 lines or fewer. Every MCP tool
description SHALL be 800 characters or fewer.

#### Scenario: A fresh install loads little text

- **GIVEN** a repository with no `CLAUDE.md` and an index with a slim digest
- **WHEN** `openlore install` runs
- **THEN** the generated `CLAUDE.md` holds the managed block of 8 lines or fewer and no `@`-import
  of `CODEBASE.md`

#### Scenario: The slim digest does not reach the agent

- **GIVEN** an index with no `CODEBASE.slim.md`, or no wired prompt hook, or context injection off
- **WHEN** a `CLAUDE.md` is generated
- **THEN** it keeps the `@`-import, so the agent still gets repository shape

#### Scenario: A user line is not touched

- **GIVEN** a `CLAUDE.md` with an `@.openlore/analysis/CODEBASE.md` line outside the managed markers
- **WHEN** `openlore install` runs again
- **THEN** that line is unchanged
- **AND** `openlore status` names the line and its size once, and does not edit the file
- **AND** it says nothing while the slim digest does not reach the agent

#### Scenario: A pointer with no digest behind it

- **GIVEN** a generated `CLAUDE.md` that names the full digest instead of importing it
- **WHEN** a setting the user chose stops the slim digest (`contextInjection.mode` is `"off"` or
  `hooks.prompt-submitted` is false), and no line imports the digest
- **THEN** `openlore status` names the line and that setting, and says to restore the import

#### Scenario: A preset without orient

- **GIVEN** the wired preset is `configuration`, which has no `orient` tool
- **WHEN** the managed block or a `CLAUDE.md` is generated
- **THEN** it names `openlore orient "<task>"`, not the `orient` tool

#### Scenario: A long tool description fails the guard

- **WHEN** a tool description in `TOOL_DEFINITIONS` is longer than 800 characters
- **THEN** the tool-contract test fails and names the tool
