# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ContractConsumersCarryTheirTestsAndFederatedPeers

`blast_radius` SHALL also list contract elements a changed specification file touches, and each
`breaking` or `dangerous` element reported by `certify_service_contract` SHALL carry the tests that
reach each consumer, and consumers in indexed federated repositories, matched by stable id.

#### Scenario: A breaking change names the tests to run

- **GIVEN** a breaking change to `GET /v1/orders/{id}` with an in-repo client call site
- **WHEN** `certify_service_contract` runs with a base ref
- **THEN** the call site carries the tests that reach it

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
