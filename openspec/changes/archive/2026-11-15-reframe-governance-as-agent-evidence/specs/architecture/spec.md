## ADDED Requirements

### Requirement: NewCapabilityArrivesAtAMomentNotAsATool

A new agent-facing capability SHALL reach the agent as evidence at a hook moment, or as a field or
finding on an existing answer (`orient`, `blast_radius`, `verify_change`, `verify_claim`, `recall`).
It SHALL NOT add an MCP tool, and existing tools SHALL keep their names with no aliases. This rule
governs delivery only; the capability SHALL still attach to the one graph, fact store and freshness
lease that `UnifiedStructuralSubstrate` requires.

#### Scenario: A new check is delivered at a moment

- **GIVEN** a proposed check that finds a new kind of problem in a diff
- **WHEN** it is designed
- **THEN** it is delivered as a finding at a hook moment or on an existing answer
- **AND** the number of registered MCP tools does not change

#### Scenario: An existing tool becomes an evidence source under its own name

- **GIVEN** an existing tool whose result a hook moment starts to use
- **WHEN** the moment calls its handler
- **THEN** the tool keeps its name and stays callable wherever it was callable before
