# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ContractSchemasAreReadIntoANormalizedModel

`certify_service_contract` SHALL discover OpenAPI 3.x and Swagger 2.0 documents (YAML or JSON) in
the working tree and at the base revision through git, and read each into one normalized model of
operations, parameters, request-body properties, and success-response properties. Only local
`$ref`s SHALL be followed, a bounded number of hops; external `$ref`s, `callbacks`, and `webhooks`
SHALL be listed as outside the model. A document that looks like a specification but cannot be
parsed SHALL be listed as not assessed with the reason, never treated as empty or unchanged.

#### Scenario: Parse failure is not assessed, not empty

- **GIVEN** an OpenAPI document with a YAML syntax error in the working tree
- **WHEN** `certify_service_contract` runs with a base ref
- **THEN** the file is listed under `notAssessed` with the reason, and none of its operations is
  reported as removed

### Requirement: ContractVerdictsJoinConsumersConservatively

With a base ref, `certify_service_contract` SHALL classify each changed element against the
merge-base via a closed deterministic rule table (`breaking` | `dangerous` | `non-breaking`), and a
changed schema the table cannot read SHALL be `potentially-breaking`, which withholds the suggested
version bump. Each `breaking` or `dangerous` element SHALL list the client call sites in this
repository whose HTTP method and literal path match it, and SHALL be emitted as a registered
advisory `contract-breaking` finding. Callers in other repositories, through generated clients, or
with dynamic URLs SHALL be disclosed as a boundary, never implied absent. The tool SHALL be a
`conclusion` in family `change`, available only in the `full` preset.

#### Scenario: A breaking schema change names its consumers

- **GIVEN** a base ref where `DELETE /v1/orders/{id}` exists, a working tree where it is removed, and
  a client calling `DELETE /v1/orders/${id}`
- **WHEN** `certify_service_contract` runs with the base ref
- **THEN** the change is `operation-removed`, `breaking`, names the call site's file and line, and
  the boundary statement for other repositories is present

#### Scenario: Unprovable is potentially-breaking

- **GIVEN** a response schema changed to a `oneOf`
- **WHEN** the change is classified
- **THEN** it is `schema-unassessed`, `potentially-breaking`, and the suggested bump is withheld

### Requirement: ContractParityIsTwoWayAndScoped

Without a base ref, `certify_service_contract` SHALL return the declared operations and a two-way
parity report against the indexed route handlers: each operation no handler serves
(`contract-declared-unimplemented`) and each handler whose path a specification covers but does not
declare (`contract-implemented-undeclared`). A path SHALL be covered when its parent path equals a
declared operation's path or that operation's parent path, compared with and without the
specification's base path. A handler on an uncovered path SHALL NOT be reported; a handler with a
dynamic path SHALL be a disclosed boundary. Parity SHALL be reported as not assessed when no route
inventory exists or no server route is indexed.

#### Scenario: A declared operation with no handler is reported

- **GIVEN** a specification that declares `DELETE /v1/orders/{id}` and no handler for it
- **WHEN** `certify_service_contract` runs with no base ref
- **THEN** the operation is a `contract-declared-unimplemented` finding with the spec file and line

#### Scenario: A near-miss prefix is not covered

- **GIVEN** a specification declaring only `/v1/orders/{id}`, and handlers on `/v1/orders/export`,
  `/v1/ordersX`, and `/internal/health`
- **WHEN** parity runs
- **THEN** only `/v1/orders/export` is reported as `contract-implemented-undeclared`
