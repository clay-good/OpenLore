# mcp-handlers spec delta

## ADDED Requirements

### Requirement: LiteralPayloadsAreCheckedAgainstRequiredProperties

For each in-repo client call site of an operation whose request body requires properties,
`certify_service_contract` SHALL report each required property a literal body (an object, or
`JSON.stringify` of one) lacks, and a call with no body, as an advisory
`contract-payload-missing-required` finding naming the call site and the operation. A body that is
not a literal SHALL be listed as not assessed, never reported as conforming.

#### Scenario: A missing required field is named

- **GIVEN** an operation `POST /orders` whose request body requires `customerId` and `items`, and a
  call site sending `JSON.stringify({ items })`
- **WHEN** `certify_service_contract` runs
- **THEN** a `contract-payload-missing-required` finding names the call site and `customerId`

#### Scenario: A built payload is not called conforming

- **GIVEN** a call site whose body is a variable built elsewhere
- **WHEN** the check runs
- **THEN** the call site is listed as not assessed
