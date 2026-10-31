# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ContractVerdictsJoinConsumersConservatively

`certify_service_contract` SHALL classify each changed schema element via a closed deterministic
rule table (`breaking` | `dangerous` | `non-breaking`), with any change the table cannot prove
compatible reported `potentially-breaking` — never silently safe. Each `breaking` or `dangerous`
element SHALL be joined to its in-index consumers via the cross-service HTTP projection
(federated repositories included by stable id) and declared generated-client imports, each
consumer carrying file:line and its reaching tests; external or unindexed consumers SHALL be
disclosed as a known-unknowable boundary, never implied absent. The tool SHALL be a `conclusion`
in family `change`, available only in the `full` preset, cross-referencing
`certify_public_surface` (code-contract shape) and `change_impact_certificate` (paths into
surfaces) as adjacent siblings.

#### Scenario: A breaking schema change names its stranded consumers

- **GIVEN** a base ref where an OpenAPI operation exists and a working tree where it is removed,
  with one indexed client call site bound to that route
- **WHEN** `certify_service_contract` runs with the base ref
- **THEN** the element is classified `breaking`, the consumer is named with file:line and
  reaching tests, and the external-consumer boundary statement is present

#### Scenario: Unprovable is potentially-breaking

- **GIVEN** a type change the rule table has no compatibility rule for
- **WHEN** the diff is classified
- **THEN** the element is `potentially-breaking` with the unmatched rule class disclosed, and
  the summary restates the conservative construction

### Requirement: ContractParityIsTwoWayAndScoped

`certify_service_contract` invoked without a base ref SHALL return the discovered contract
surface and a two-way parity report: `declared-unimplemented` for each schema operation with no
bound handler, and `implemented-undeclared` for each indexed handler whose path a discovered spec covers but
does not declare. A path SHALL be covered when, compared segment by segment after the spec's base
path, its parent path equals a declared operation's path or that operation's parent path. A handler
on an uncovered path SHALL NOT be reported, and a handler whose path is built dynamically SHALL be
a disclosed boundary, not a finding. Each parity item SHALL be emitted as a registered advisory
governance finding (`contract-declared-unimplemented`, `contract-implemented-undeclared`). `orient`
SHALL include the bound contract element for a handler in its scope, and `blast_radius` SHALL list
the contract elements a diff touches (a changed schema file, or a changed bound handler), both as
budgeted additive fields.

#### Scenario: A declared operation with no handler is reported

- **GIVEN** a spec that declares `DELETE /v1/orders/{id}` and no handler registered for it
- **WHEN** `certify_service_contract` runs with no base ref
- **THEN** the operation is listed as `declared-unimplemented` with the spec file and line

#### Scenario: An internal route in an unspecified area is not a finding

- **GIVEN** a spec covering `/v1/orders` and a handler on `/internal/health`
- **WHEN** parity runs
- **THEN** `/internal/health` is not reported as `implemented-undeclared`

#### Scenario: A near-miss prefix is not covered

- **GIVEN** a spec declaring only `/v1/orders/{id}`, and handlers on `/v1/orders/export` and
  `/v1/ordersX`
- **WHEN** parity runs
- **THEN** `/v1/orders/export` is reported as `implemented-undeclared` and `/v1/ordersX` is not

#### Scenario: orient shows the contract of the handler being edited

- **GIVEN** a task that orients on a handler bound to `POST /v1/checkout`
- **WHEN** `orient` returns
- **THEN** the briefing names the operation address, its required parameters, and the spec
  file:line
