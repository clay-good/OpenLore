# architecture spec delta

## ADDED Requirements

### Requirement: SpecDrivenDevelopmentDelegatedToOpenSpec

OpenLore is a distinct product from OpenSpec and SHALL NOT reimplement OpenSpec's spec-driven-
development lifecycle. OpenSpec (`@fission-ai/openspec`) is OpenLore's spec-driven-development
framework: it owns authoring change proposals and the change→archive lifecycle, folding a change's
spec deltas into the main corpus (`openspec archive`), and listing / validating / showing changes
and specs (`openspec list`, `openspec validate`, `openspec show`, `openspec status`).

OpenLore's product surface SHALL be confined to deterministic, locally-computed structural memory
over code: the call graph, reachability and impact, symbol-anchored memory and decisions, code↔spec
drift detection, and generating OpenSpec-format specs from code. OpenLore therefore:

- SHALL delegate change-lifecycle operations to the OpenSpec CLI and SHALL NOT ship an
  `openlore change`, `openlore archive`, or `openlore validate-changes` command, nor an MCP tool,
  that folds spec deltas or manages the change→archive lifecycle.
- MAY read the OpenSpec corpus and generate OpenSpec-format specs (the integration surface), and
  MAY govern its own decision records within that corpus (see
  [openspec: DecisionSyncWritesOneOwningDomain](../openspec/spec.md)).

Every proposed capability SHALL be justified against this boundary: if a capability's value is
change-lifecycle management, it belongs to OpenSpec, not OpenLore.

#### Scenario: A lifecycle capability is delegated, not rebuilt

- **GIVEN** a need to fold a shipped change's spec deltas into the main corpus and archive it
- **WHEN** the work is scoped
- **THEN** it is performed with `openspec archive` and OpenLore adds no equivalent command, fold
  engine, or MCP tool

#### Scenario: A proposal that rebuilds OpenSpec is rejected as out of scope

- **GIVEN** a proposal to add an `openlore change list` / `openlore change archive` surface
- **WHEN** it is reviewed against this requirement
- **THEN** it is rescoped to consume the OpenSpec CLI, retaining only genuinely OpenLore-native
  structural or decision-governance work
