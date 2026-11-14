# agent-neutral-spec-reconciliation Specification

## Purpose
Defines the client-neutral Generate and Repair protocol for OpenLore specifications. One deterministic
evidence layer serves both the standalone generator and any MCP-compatible host agent, and semantic
authorship stays with the consumer.

## Requirements

### Requirement: Agent-Neutral Generate And Repair Protocol
OpenLore SHALL expose generation and repair evidence exclusively through provider- and client-neutral CLI and MCP contracts. Documentation SHALL identify the consumer as an MCP-compatible host agent and SHALL NOT require Claude Code, ACP, or any client-specific skill.

#### Scenario: A non-Claude MCP client repairs a spec
- **WHEN** an MCP-compatible host agent composes the documented repair tools for an existing domain spec
- **THEN** it receives the same deterministic observations and evidence available to every other MCP client
- **AND** no OpenLore API requires a Claude-specific integration

### Requirement: Generate And Repair Scope Boundary
OpenLore SHALL define Generate for a scope without a specification and Repair for a scope with an existing specification. Repair SHALL combine additions and corrections for one spec file in one pass.

#### Scenario: An existing domain has both a stale mapping and uncovered code
- **WHEN** the host agent reconciles the domain
- **THEN** the Repair workflow supplies evidence for both conditions in the same pass
- **AND** Generate does not separately write that domain spec

### Requirement: Shared Evidence Representation Across Consumers
OpenLore SHALL build one deterministic, domain-scoped evidence representation that is consumable by both the standalone generator and MCP-compatible host agents, including Pi. Generate and Repair SHALL compose only the task-specific subset of that representation they need, SHALL NOT require one identical evidence bundle, and SHALL NOT duplicate or independently rederive its structural facts.

#### Scenario: Generate creates a new domain spec
- **WHEN** an agent generates a specification for a scope with no existing spec
- **THEN** it composes structural inventory and code-context evidence needed to draft that scope
- **AND** it does not require mapping, drift or existing-spec evidence

#### Scenario: Standalone and agent-hosted generation address the same domain
- **WHEN** the standalone generator and an MCP-compatible host agent obtain evidence for the same analyzed domain
- **THEN** both consume the same deterministic domain representation
- **AND** the standalone generator delegates semantic synthesis to its configured LLM while the host agent performs that synthesis itself

#### Scenario: Repair needs additional spec-state evidence
- **WHEN** an agent repairs an existing specification
- **THEN** it augments the shared domain evidence with spec, mapping, coverage, drift and structural-change observations
- **AND** it does not create a separate code-analysis representation or require the Generate bundle

### Requirement: Deterministic Observations Remain Non-Semantic
OpenLore SHALL report structural observations such as covered functions, uncovered functions, stale mappings, orphan requirements and structural changes without inferring business intent or automatically deleting requirements.

#### Scenario: An uncovered function has no obvious matching requirement
- **WHEN** the coverage audit reports the function
- **THEN** OpenLore reports it as an uncovered structural observation
- **AND** the host agent decides whether a requirement is semantically missing
