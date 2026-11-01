# mcp-handlers spec delta

## ADDED Requirements

### Requirement: VerifyChangeCarriesPayloadFindings

`verify_change` SHALL carry `contract-payload-missing-required` findings for call sites in the files
the diff changes, as receipt items and as findings `enforcement.policy` classifies, and SHALL state
how many request bodies there it could not read.

#### Scenario: A new call site without a required field

- **GIVEN** a diff that adds `fetch('/orders', { method: 'POST', body: JSON.stringify({ items }) })`
  for an operation requiring `customerId`
- **WHEN** `verify_change` runs
- **THEN** its receipt names the missing `customerId`
