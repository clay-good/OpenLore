# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ContractConsumersNameTheirTests

With a base ref, each in-repo consumer of a `breaking` or `dangerous` element reported by
`certify_service_contract` SHALL carry the tests that reach the indexed function holding the call,
or the reason they were not computed; it SHALL never be shown as having no tests when they were not
computed.

#### Scenario: A breaking change names the tests to run

- **GIVEN** a removed operation `DELETE /v1/orders/{id}` called from `drop` in `src/client.ts`, and a
  test that calls `drop`
- **WHEN** `certify_service_contract` runs with a base ref
- **THEN** the call site carries that test

#### Scenario: Without an index

- **GIVEN** no analysis index
- **WHEN** the same check runs
- **THEN** each consumer says its tests were not computed and why
