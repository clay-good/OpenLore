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

### Requirement: ContractElementsAreGraphNodesBoundToHandlers

The analyzer SHALL project each normalized contract element onto the existing graph primitives,
the same way infrastructure resources are projected: an operation, RPC, message, type, or field
becomes a node whose `language` names the schema format (`OpenAPI`, `Protobuf`, `GraphQL`) and
whose address is stable (`<METHOD> <path template>`, `<Service>.<Rpc>`, `<package>.<Message>.<field>`,
`<Type>.<field>`), with edges from an element to its fields and to the types it references. A
server route handler extracted by the existing HTTP route parser SHALL be linked to the OpenAPI
operation with the same HTTP method and normalized path template by an `implements_endpoint`
edge; an RPC implementation SHALL be linked only when a generated-server base class or
registration call names the RPC literally. Matching SHALL be literal — no name similarity, no
embeddings — and a handler or operation that matches nothing SHALL remain listed as unmatched
rather than dropped.

#### Scenario: A handler is bound to its declared operation

- **GIVEN** an OpenAPI document declaring `GET /v1/orders/{id}` and an Express handler registered
  on `GET /v1/orders/:id`
- **WHEN** the repository is analyzed
- **THEN** the graph holds an `OpenAPI` node addressed `GET /v1/orders/{id}` and an
  `implements_endpoint` edge from the handler to it

#### Scenario: Similar but different routes are not bound

- **GIVEN** a spec operation `GET /v1/orders/{id}` and a handler on `GET /v1/order/:id`
- **WHEN** the repository is analyzed
- **THEN** no `implements_endpoint` edge is created and both appear in the unmatched lists
