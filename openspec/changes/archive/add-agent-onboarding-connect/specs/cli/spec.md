# cli spec delta

> Delivered by enhancing the `openlore install` engine and adding a thin `openlore connect`
> front-end (PR #161). Requirements below describe the shipped behavior.

## ADDED Requirements

### Requirement: OneCommandAgentConnect

OpenLore SHALL provide an `openlore connect` command that integrates OpenLore into a coding agent in a
single invocation, delegating to the shared install engine. It SHALL support:

- `openlore connect <agent>` — connect the named agent.
- `openlore connect` (no agent) — an interactive multi-select over supported agents when run in a TTY,
  pre-checked from detection; in a non-interactive context it SHALL fall back to detection (equivalent
  to bare `openlore install`).
- `openlore connect list` — list every supported agent and its connection status (connected /
  detected-not-connected / not-connected) without modifying anything.
- `openlore connect remove [agent]` — disconnect the named agent (or all detected agents).

The command SHALL be deterministic and offline (file I/O over the install adapters; no LLM, no network).

#### Scenario: Connecting a supported agent

- **GIVEN** a repository with no OpenLore integration for agent A
- **WHEN** `openlore connect A` is run
- **THEN** A's managed footprint is written (guidance block, and — where supported — MCP server,
  session-start hook, and run permission), and the command reports what it changed

#### Scenario: Listing does not mutate

- **WHEN** `openlore connect list` is run
- **THEN** the command prints each supported agent with its status and writes nothing to disk

### Requirement: IdempotentManagedSectionInjection

`connect` (via the install engine) SHALL write OpenLore guidance into an agent's instruction file
between sentinel markers (`<!-- BEGIN OPENLORE … -->` / `<!-- END OPENLORE -->`) with a fingerprint
line. Re-running SHALL replace the managed block in place — never appending a duplicate and never
skipping a file merely because it exists. Content outside the markers SHALL be preserved. `remove`
SHALL strip only the managed block (and any managed JSON entry / hook / permission), deleting a file
only when OpenLore created it and it is now empty.

#### Scenario: Re-running connect is idempotent

- **GIVEN** agent A already connected
- **WHEN** `openlore connect A` is run again with the same inputs
- **THEN** every planned change is a no-op and the user's surrounding content is unchanged

#### Scenario: Existing instruction file is not skipped

- **GIVEN** agent A has a pre-existing instruction file with user content and no OpenLore block
- **WHEN** `openlore connect A` is run
- **THEN** the OpenLore block is injected into that file and the user's content is preserved

#### Scenario: Remove is surgical

- **GIVEN** agent A is connected
- **WHEN** `openlore connect remove A` is run
- **THEN** OpenLore's footprint is removed and all other user content is preserved

### Requirement: CapabilityGatedWiring

`connect` SHALL wire a session-start hook, MCP-server registration, and a `Bash(openlore:*)` run
permission only for agents whose adapter supports them (today: claude-code), and SHALL give agents
without those capabilities the guidance block (and any agent-appropriate config) only. Permission and
hook writes SHALL be idempotent and reversible: re-running adds no duplicate, and uninstall removes
only OpenLore's entries — preserving the user's other permissions and deleting a managed file only
when it was OpenLore-only.

#### Scenario: Capable agent gets hook + permission

- **WHEN** `openlore connect claude-code` is run
- **THEN** `.claude/settings.json` gains the OpenLore SessionStart hook and
  `.claude/settings.local.json` gains `Bash(openlore:*)` in `permissions.allow`, preserving any
  permissions already present

#### Scenario: Permission wiring is idempotent and reversible

- **GIVEN** claude-code already connected
- **WHEN** `openlore connect claude-code` is re-run, then `openlore connect remove claude-code`
- **THEN** the re-run adds no duplicate permission, and the remove strips `Bash(openlore:*)` while
  leaving any user-added permissions intact

### Requirement: PresetAwareConnect

`connect` / `install` SHALL accept `--preset <name>`, validated against the registered `TOOL_PRESETS`.
When set, adapters that register an MCP server SHALL wire `openlore mcp --preset <name>` so the agent
sees that curated tool surface; when unset, the full surface is registered (current behavior). An
unknown preset SHALL fail with a non-zero exit and write nothing.

#### Scenario: A preset is threaded into the registered server

- **WHEN** `openlore connect claude-code --preset memory` is run
- **THEN** the registered MCP server command is `openlore mcp --preset memory`

#### Scenario: Unknown preset fails safely

- **WHEN** `openlore connect claude-code --preset bogus` is run
- **THEN** the command exits non-zero and writes no files

### Requirement: ExtensibleAdapterRegistry

Supported agents SHALL be modeled as per-agent adapters that share the common injection, JSON-merge,
and presence-check helpers, so adding an agent is a contained change (a new adapter module) without
modifying the engine or the `connect` command. Each adapter SHALL expose a preset-insensitive
`isConnected` presence check (a managed markdown block or managed JSON entry), used by
`connect list` so that an agent wired with a different preset or an older template still reads as
connected.

#### Scenario: Status reflects presence, not config equality

- **GIVEN** claude-code connected with `--preset memory`
- **WHEN** `openlore connect list` is run
- **THEN** claude-code is reported as connected (the differing preset does not make it read as
  not-connected)
