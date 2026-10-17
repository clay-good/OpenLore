## ADDED Requirements

### Requirement: Specification Workflow Tool Registration

The MCP server SHALL register `prepare_spec_generation` and `prepare_spec_repair` as read-only tools with machine-readable input schemas, structured responses, and read-only tool annotations. They SHALL be available in the full surface and in the ordinary default surface used by an unqualified OpenLore MCP server; the navigation-only escape preset MAY omit them.

#### Scenario: Client connects to the default MCP surface

- **WHEN** a client starts OpenLore MCP without selecting a preset
- **THEN** both specification preparation tools are discoverable
- **AND** their annotations do not claim destructive or write behavior

#### Scenario: Client requests the navigation-only surface

- **WHEN** a client explicitly selects the navigation-only preset
- **THEN** OpenLore may omit the specification workflow tools to preserve that preset's narrow purpose

### Requirement: Composite Handlers Reuse Canonical Evidence Services

The composite handlers SHALL reuse the same domain-evidence, mapping, audit, drift, and structural-difference services as their atomic MCP counterparts. They SHALL NOT invoke an LLM or maintain a second client-specific implementation of those observations.

#### Scenario: Atomic and composite observations are compared

- **WHEN** the same analyzed repository and domain are queried through a composite and its corresponding atomic tools
- **THEN** equivalent observations have identical provenance and domain membership
- **AND** no observation differs because it was re-inferred in the composite handler

### Requirement: Composite Argument And Error Contracts

Generation SHALL reject an unknown requested domain with available-domain guidance. Repair SHALL accept an existing specification even when its current analyzed domain is absent, and SHALL distinguish absent specifications, unavailable analysis, stale artifacts, and bounded partial results with stable machine-readable states.

#### Scenario: Generation domain is unknown

- **WHEN** `prepare_spec_generation` receives a domain that is not present in reconciled analysis
- **THEN** it returns a typed unknown-domain response with available domains
- **AND** it does not silently substitute undomained or repository-wide evidence

#### Scenario: Repair specification does not exist

- **WHEN** `prepare_spec_repair` targets a name for which no specification exists
- **THEN** it returns a typed absent-specification response
- **AND** it does not reinterpret the request as Generate
