## Purpose

Provides efficient, client-neutral MCP compositions that prepare deterministic evidence for host-authored specification generation and repair without duplicating analysis logic in host integrations.

## ADDED Requirements

### Requirement: Client-Neutral Specification Workflow Composites

OpenLore SHALL expose read-only Generate and Repair preparation tools through its public MCP contract. The tools SHALL NOT depend on a provider SDK, ACP, Pi, Claude Code, Codex, or any client-specific skill.

#### Scenario: A generic MCP host prepares specification generation

- **WHEN** an MCP-compatible host requests generation evidence for an analyzed domain
- **THEN** it receives the same deterministic composition available to supported first-party host integrations
- **AND** no client-specific adapter is required to reconstruct the composition

#### Scenario: A generic MCP host prepares specification repair

- **WHEN** an MCP-compatible host requests repair evidence for an existing specification
- **THEN** it receives the same repair observations available to supported first-party host integrations
- **AND** no client-specific reconciliation logic is executed by OpenLore

### Requirement: Task-Specific Generation Composition

The Generate preparation tool SHALL return the selected reconciled domain, defining and supporting file roles, deterministic structural inventories, code signatures, relationships, provenance, and completeness information needed to author a new specification. It SHALL NOT require existing-spec, mapping, coverage, or drift state.

#### Scenario: Generation evidence is complete within the response budget

- **WHEN** the selected domain evidence fits within the response budget
- **THEN** the tool returns a complete generation composition in one invocation
- **AND** the completeness receipt states that no evidence partitions were omitted

#### Scenario: Generation evidence exceeds the response budget

- **WHEN** the selected domain evidence cannot fit within one response
- **THEN** the tool returns a deterministic bounded partition and an explicit continuation cursor
- **AND** it reports which evidence remains rather than silently truncating it

### Requirement: Task-Specific Repair Composition

The Repair preparation tool SHALL compose the existing specification, reconciled current-domain evidence when available, mapping provenance, coverage availability, drift, structural changes, covered functions, uncovered functions, stale mappings, and orphan requirements. OpenLore SHALL report observations without deciding whether specification prose is semantically missing, stale, or safe to delete.

#### Scenario: Repair reconciles additions and corrections together

- **WHEN** an existing domain has both stale correspondence and uncovered implementation
- **THEN** one Repair preparation response includes both observation classes
- **AND** the host agent can reconcile the one specification file in one pass

#### Scenario: Mapping-derived evidence is unavailable

- **WHEN** mapping coverage is missing, invalid, stale, or scoped incompatibly
- **THEN** Repair returns the machine-readable availability state and remediation
- **AND** it does not present withheld mapping-derived conclusions as empty or authoritative

### Requirement: Orphan And Historical Path Preservation

Repair SHALL remain available when an existing specification has no current analyzed domain. Its structural scope SHALL combine current domain files with historical source paths recoverable from the existing specification and mapping, and SHALL disclose when no structural footprint can be recovered.

#### Scenario: Existing specification has no current domain

- **WHEN** Repair targets a specification whose domain no longer appears in current analysis
- **THEN** the tool still returns the existing specification, audit, mapping, and drift observations
- **AND** it identifies the absent current-domain evidence as a possible orphan condition

#### Scenario: A former domain file was deleted or moved

- **WHEN** a historical source path is present in the specification or mapping but absent from current domain membership
- **THEN** the path participates in the structural-difference scope
- **AND** removed or moved functions are not hidden solely because the path left the current domain

### Requirement: Explicit Completeness And Provenance Receipt

Every composite response SHALL identify its analysis provenance and SHALL report whether the composition is complete, partial, or unavailable. A partial response SHALL identify omitted sections and provide either a continuation cursor or specific atomic MCP follow-up tools.

#### Scenario: Host receives partial evidence

- **WHEN** a response omits evidence because of a deterministic bound or unavailable artifact
- **THEN** the receipt names the omitted or unavailable evidence and its reason
- **AND** the host can continue without guessing which primitive to call

### Requirement: Host Agent Retains Semantic Authorship

The composite tools SHALL only prepare evidence. The host agent SHALL remain responsible for interpreting business meaning, authoring specification prose, choosing reconciliation actions, and writing files through its ordinary editing capabilities.

#### Scenario: Generate prepares evidence

- **WHEN** the generation composition is returned
- **THEN** OpenLore has not generated or written specification prose
- **AND** the host agent authors the specification from the returned evidence

#### Scenario: Repair observes a possibly orphaned requirement

- **WHEN** Repair reports an orphan-requirement observation
- **THEN** OpenLore does not automatically remove the requirement
- **AND** the host agent decides its semantic disposition

### Requirement: Thin Host Integration Parity

Supported host skills and Pi entry points SHALL invoke the public MCP composite tools and SHALL NOT independently rederive domains, inventories, coverage, drift, or structural-change composition. Host instructions MAY control authoring and editing workflow but SHALL NOT be the source of deterministic evidence logic.

#### Scenario: Pi and a generic MCP client target the same domain

- **WHEN** both request the same Generate or Repair preparation
- **THEN** both consume the same public composite contract and domain membership
- **AND** parity does not depend on copying Pi implementation logic into another client

#### Scenario: A host skill needs deeper evidence

- **WHEN** the composite receipt identifies a partial or ambiguous section
- **THEN** the skill calls the indicated atomic MCP tool for that section
- **AND** it does not routinely replay the entire primitive sequence
