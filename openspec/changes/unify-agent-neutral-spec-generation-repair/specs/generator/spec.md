## ADDED Requirements

### Requirement: Domain-Aggregated Deterministic Generation Evidence
The generation pipeline SHALL build deterministic evidence bundles from `repoStructure.domains`, plus a deterministic fallback bundle for undomained files. Stages 1 through 4 SHALL process these bundles rather than independent files or arbitrary AST chunks.

#### Scenario: A domain spans multiple service files
- **WHEN** stage 3 generates services for the domain
- **THEN** it receives one reconciled domain bundle containing the participating files and signatures
- **AND** duplicate services are reconciled after aggregation rather than discarded by first-seen name

### Requirement: Structural Inventory Authority
Stages 1 through 4 SHALL derive file/domain membership, schema fields and types, function signatures, route method/path/handler identity, and generated locations from deterministic inventories. LLM output SHALL be limited to semantic descriptions, relationships, purposes and scenarios, and SHALL be reconciled against the authoritative bundle before downstream use.

#### Scenario: The LLM returns a route not present in the route inventory
- **WHEN** stage 4 reconciles its response
- **THEN** the unverified route is not emitted as an endpoint
- **AND** endpoints from the authoritative route inventory retain their detected method and path

### Requirement: Stable Downstream Pipeline Contract
The domain-aggregated stages SHALL continue to produce the existing survey, entity, service and endpoint result shapes required by stages 5–6 and existing formatting, mapping, ADR and RAG consumers.

#### Scenario: Architecture synthesis follows aggregated extraction
- **WHEN** stages 1 through 4 complete successfully
- **THEN** stage 5 receives the existing `PipelineResult` component shapes
- **AND** it executes as one aggregated synthesis call without stage-5 redesign

### Requirement: Mapping Artifact Provenance
The mapping artifact SHALL declare a version and deterministic source-analysis fingerprint for the inventory from which its requirement-to-function mappings were produced.

#### Scenario: Mapping is generated after a domain-aggregated run
- **WHEN** `MappingGenerator` writes `mapping.json`
- **THEN** the artifact contains its version, source-analysis fingerprint and existing mapping statistics
- **AND** each operation mapping refers to the reconciled service operation and exact function reference
