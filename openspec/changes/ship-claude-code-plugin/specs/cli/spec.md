# Spec Delta

## ADDED Requirements

### Requirement: ClaudeCodePluginInstallsALeanRuntimeOnFirstUse

The Claude Code plugin SHALL ship no npm dependencies at its root. On first use its launcher SHALL
install the pinned `openlore` package once into `${CLAUDE_PLUGIN_DATA}`, without the packages the
plugin does not use (local embeddings and the graph viewer). A hook SHALL NOT wait for this install
and SHALL exit 0; only the MCP server SHALL wait for it.

#### Scenario: The first prompt after install returns at once

- **GIVEN** a fresh plugin install with no runtime yet
- **WHEN** the prompt hook runs
- **THEN** it exits 0 within seconds, says the runtime is installing, and one detached install starts

#### Scenario: Windows installs within its limits

- **GIVEN** a Windows machine
- **WHEN** the plugin is installed and first used
- **THEN** Claude Code's own install step has nothing to install, and the runtime install completes in the background

### Requirement: ClaudeCodePluginStepsBackFromCliWiring

When hooks written by `openlore install` exist in the user's or the project's Claude settings, the
plugin's hooks SHALL produce no output, so each hook moment runs once.

#### Scenario: A CLI user installs the plugin

- **GIVEN** user settings carrying OpenLore-marked hooks
- **WHEN** a plugin hook runs
- **THEN** it exits 0 with no output

### Requirement: ClaudeCodePluginWorksWithoutASpecFramework

The plugin SHALL deliver briefings and MCP answers in a repository with no `openspec/` folder and no
`openspec` CLI installed.

#### Scenario: A plain repository

- **GIVEN** a git repository with code and tests and no spec framework
- **WHEN** the plugin is used
- **THEN** the prompt hook returns a briefing naming the relevant functions once the index is built
