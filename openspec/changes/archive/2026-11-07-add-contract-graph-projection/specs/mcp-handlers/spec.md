# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ChangedSpecificationsAndFederatedConsumersSurface

`blast_radius` SHALL also list contract elements a changed specification file touches, and each
`breaking` or `dangerous` element reported by `certify_service_contract` SHALL carry consumers in
indexed federated repositories, matched by stable id.

#### Scenario: A spec edit in the diff

- **GIVEN** a diff that removes `DELETE /v1/orders/{id}` from `openapi.yaml`
- **WHEN** `blast_radius` runs
- **THEN** it names the removed operation
