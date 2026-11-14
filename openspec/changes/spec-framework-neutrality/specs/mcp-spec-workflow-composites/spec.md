## MODIFIED Requirements

### Requirement: Client-Neutral Specification Workflow Composites

OpenLore SHALL expose read-only Generate and Repair preparation tools through its public MCP contract. The tools SHALL NOT depend on a provider SDK, ACP, Pi, Claude Code, Codex, or any client-specific skill. The tools prepare evidence for OpenSpec-format domain specs; they SHALL NOT require the `openspec` CLI or an existing `openspec/` folder, and their descriptions SHALL say that the format they prepare is OpenSpec.

#### Scenario: A generic MCP host prepares specification generation

- **WHEN** an MCP-compatible host requests generation evidence for an analyzed domain
- **THEN** it receives the same deterministic composition available to supported first-party host integrations
- **AND** no client-specific adapter is required to reconstruct the composition

#### Scenario: A generic MCP host prepares specification repair

- **WHEN** an MCP-compatible host requests repair evidence for an existing specification
- **THEN** it receives the same repair observations available to supported first-party host integrations
- **AND** no client-specific reconciliation logic is executed by OpenLore

#### Scenario: Generation evidence in a repository with no OpenSpec folder

- **GIVEN** an analyzed repository with no `openspec/` folder and no `openspec` binary
- **WHEN** a host requests generation evidence for a domain
- **THEN** it receives the evidence, and the request creates no folder
