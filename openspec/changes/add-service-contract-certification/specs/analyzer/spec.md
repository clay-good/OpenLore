# analyzer spec delta

## ADDED Requirements

### Requirement: ContractSchemasAreDiscoveredAndNormalized

The analyzer SHALL deterministically discover interface-schema files in the analyzed corpus
(OpenAPI documents by root key, protobuf definitions, GraphQL SDL) and parse each into one
normalized element model (operations, messages/types, fields, enum values) suitable for
rule-table diffing. Discovery scope SHALL be visible: discovered files and contract-like
candidates that were not parsed are both listed. A file that fails to parse, or an element
class outside the supported dialect subset, SHALL be recorded as unassessed with the reason —
never silently omitted from the model.

#### Scenario: Discovery scope is visible

- **GIVEN** a repository containing one OpenAPI document, one `.proto` file, and one YAML file
  that resembles but is not an OpenAPI document
- **WHEN** contract discovery runs
- **THEN** the two schemas appear as discovered and parsed, and the third is listed as an
  unparsed candidate with the reason it was excluded

#### Scenario: Parse failure is unassessed, not empty

- **GIVEN** a `.proto` file with a syntax error
- **WHEN** the reader runs
- **THEN** the file's elements are recorded as unassessed with the parse failure disclosed,
  and no diff over that file can report "no changes"
