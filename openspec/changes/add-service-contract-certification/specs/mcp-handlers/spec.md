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
