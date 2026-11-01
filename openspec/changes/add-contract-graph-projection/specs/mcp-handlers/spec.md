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

### Requirement: VerifyChangeCarriesPayloadFindings

`verify_change` SHALL carry `contract-payload-missing-required` findings for call sites the diff
adds or changes.

#### Scenario: A new call site without a required field

- **GIVEN** a diff that adds `fetch('/orders', { method: 'POST', body: JSON.stringify({ items }) })`
  for an operation requiring `customerId`
- **WHEN** `verify_change` runs
- **THEN** its receipt names the missing `customerId`
