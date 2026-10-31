# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ClaimKindsCoverContractsDecisionsAndLeases

`verify_claim` SHALL accept the kinds `endpoint-implemented` and `endpoint-consumed` (subject: a
contract operation address), `decision-governed` (subject: a symbol), and `lease-current` (subject: a
lease token), and SHALL return the existing verdicts and receipt shape for each. A refuted
`endpoint-consumed` verdict SHALL be scoped to the indexed repositories and SHALL name external
callers as an unknowable boundary. `decision-governed` SHALL apply the recall freshness rules, so an
orphaned memory is never counted as governing. A subject the evaluator cannot assess SHALL yield
`unverifiable` with the reason.

#### Scenario: An unimplemented operation is refuted

- **GIVEN** a spec declaring `DELETE /v1/orders/{id}` and no bound handler
- **WHEN** `verify_claim` runs with kind `endpoint-implemented` on that address
- **THEN** the verdict is refuted and names the spec file and line

#### Scenario: No indexed caller is not "no caller"

- **GIVEN** an operation `POST /v1/webhooks/stripe` with no consumer in the indexed repositories
- **WHEN** `verify_claim` runs with kind `endpoint-consumed`
- **THEN** the verdict is refuted, scoped to the indexed repositories, and states that external callers
  are not visible

#### Scenario: Removing a governed symbol names the decision

- **GIVEN** an authoritative decision anchored to `DeprecatedHandler`
- **WHEN** `verify_claim` runs with kind `decision-governed` on `DeprecatedHandler`
- **THEN** the verdict is confirmed and the receipt names the decision id and its freshness
