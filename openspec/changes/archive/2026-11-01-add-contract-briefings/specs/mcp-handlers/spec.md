# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ContractOperationsSurfaceInTheBriefings

`orient` SHALL include, as an additive `contracts` field, the OpenAPI operations served by indexed
routes in the files of its relevant functions or in route files that name one of them, and
`blast_radius` SHALL include the same for routes in the files the diff changes. Each entry SHALL
name the operation address, `operationId`, specification file and line, serving route, required
parameters and body properties, and deprecation. A route SHALL match by method and full path, or
without the base path only when unique and not all-parameter; nothing is added otherwise.

#### Scenario: orient shows the contract of the handler being edited

- **GIVEN** a task whose relevant functions are in `src/orders.ts`, which has an indexed
  `POST /orders` route, and an OpenAPI document declaring `POST /v1/orders` with required body
  properties `sku` and `qty`
- **WHEN** `orient` returns
- **THEN** `contracts` names `POST /v1/orders`, the spec file and line, and `sku` and `qty`

#### Scenario: No handler in scope

- **GIVEN** a task whose files have no indexed route
- **WHEN** `orient` returns
- **THEN** there is no `contracts` field and no specification is read
