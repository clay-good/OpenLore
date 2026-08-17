## ADDED Requirements

### Requirement: V2 Audit Summary Remains Source Compatible

The public v2 `AuditReport.summary` contract SHALL retain numeric fields for covered functions,
coverage percentage, uncovered functions, hub gaps, and orphan requirements. Consumers SHALL use
`mappingCoverage.state` as the authoritative availability signal; compatibility zeros in an
unavailable public-API report SHALL NOT be presented as observed coverage by OpenLore's CLI, MCP,
or composite surfaces.

#### Scenario: Existing TypeScript consumer still compiles

- **GIVEN** a v2 consumer that assigns an audit summary metric to a `number`
- **WHEN** it compiles against the updated package declarations
- **THEN** the assignment remains valid without a nullable migration

#### Scenario: Agent-facing degradation remains honest

- **GIVEN** the public audit API reports unavailable mapping coverage with compatibility zeros
- **WHEN** the report is served through the CLI, MCP, or a specification composite
- **THEN** the surface presents coverage as unavailable and mapping-dependent MCP/composite values
  are `null`, never as an observed zero
