# cli spec delta

## ADDED Requirements

### Requirement: CodexProposalPreparationIsInstalledWithOpenLoreOrientation

The OpenLore installer SHALL register a Codex prompt-submission hook for proposal preparation and
the OpenLore MCP server needed to call `openlore_orient`. Installation SHALL preserve unrelated
Codex configuration and SHALL use Codex's normal hook trust and activation behavior.

#### Scenario: Codex receives proposal preparation and orientation capability

- **GIVEN** Codex is selected for OpenLore installation
- **WHEN** OpenLore writes the Codex configuration
- **THEN** it registers the OpenLore MCP server and a managed proposal hook
- **AND** the hook emits proposal guidance only for recognized OpenSpec proposal invocations

#### Scenario: Existing Codex configuration is preserved

- **GIVEN** Codex configuration contains unrelated MCP servers or prompt hooks
- **WHEN** OpenLore installs or uninstalls its managed integration
- **THEN** it preserves those unrelated entries

#### Scenario: Codex hook trust has not been granted

- **GIVEN** the managed Codex hook is installed but not trusted or activated by Codex
- **WHEN** the user starts a Codex session
- **THEN** OpenLore does not bypass Codex's trust requirements

### Requirement: PiDefaultsToOnDemandStructuralContext

The Pi extension SHALL omit the repository-wide architecture digest and spec-domain index from
standing context by default and SHALL keep task-specific structural evidence available through
`openlore_orient`. The `.openlore/config.json` setting `pi.contextMode: "full"` MAY restore the
existing digest-and-index injection on every turn. For a recognized OpenSpec `propose` invocation,
the extension SHALL inject only the concise proposal-preparation instruction in the default mode.

#### Scenario: Default Pi turns omit standing repository summaries

- **GIVEN** Pi is using its default context mode
- **WHEN** the extension prepares an ordinary turn
- **THEN** it does not append the repository architecture digest or spec-domain index
- **AND** the `openlore_orient` tool remains available for task-specific orientation

#### Scenario: Full Pi context is explicitly enabled

- **GIVEN** `.openlore/config.json` sets `pi.contextMode` to `full`
- **WHEN** the extension prepares a turn
- **THEN** it appends the architecture digest and spec-domain index as it does today

#### Scenario: A proposal turn receives only a concise instruction

- **GIVEN** Pi is in its default context mode and a supported OpenSpec `propose` invocation is
  recognized
- **WHEN** the extension prepares the turn
- **THEN** it injects the concise proposal-preparation instruction
- **AND** leaves intent synthesis and task-specific `openlore_orient` invocation to the agent
