# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ContractElementsSurfaceInTheBriefings

`orient` SHALL include the bound contract element for a handler in its scope, and `blast_radius`
SHALL list the contract elements a diff touches (a changed schema file, or a changed bound handler),
both as budgeted additive fields. Each `breaking` or `dangerous` element reported by
`certify_service_contract` SHALL also carry the tests that reach each consumer, and consumers in
indexed federated repositories, matched by stable id.

#### Scenario: orient shows the contract of the handler being edited

- **GIVEN** a task that orients on a handler bound to `POST /v1/checkout`
- **WHEN** `orient` returns
- **THEN** the briefing names the operation address, its required parameters, and the spec
  file:line

### Requirement: LiteralPayloadsAreCheckedAgainstRequiredProperties

For each client call site bound to an operation whose request body is an object literal, or a
`JSON.stringify` of one, the system SHALL report each required request-body property the literal
does not contain as a registered advisory `contract-payload-missing-required` finding naming the call
site, the operation, and the missing property. A call site whose body is not a literal SHALL be
disclosed as not assessed, never reported as conforming.

#### Scenario: A missing required field is named

- **GIVEN** an operation `POST /v1/orders` whose request body requires `customerId` and `items`, and a
  bound call site sending `JSON.stringify({ items })`
- **WHEN** `certify_service_contract` or `verify_change` runs
- **THEN** a `contract-payload-missing-required` finding names the call site and `customerId`

#### Scenario: A built payload is not called conforming

- **GIVEN** a bound call site whose body is a variable built elsewhere
- **WHEN** the check runs
- **THEN** the call site is listed as not assessed for payload conformance
