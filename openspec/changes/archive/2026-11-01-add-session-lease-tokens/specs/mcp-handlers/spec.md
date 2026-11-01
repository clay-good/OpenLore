# mcp-handlers spec delta

## ADDED Requirements

### Requirement: LeaseTokensAreReturnedWithServedContext

`orient` and `recall` SHALL return a `leaseToken` that identifies the set of (symbol or file, content
hash) pairs they served and that any process on the same clone can resolve for a bounded time. A
response that served nothing SHALL carry no token.

#### Scenario: A sub-agent checks its parent's lease

- **GIVEN** a `leaseToken` returned to a parent agent by `orient`, and a later edit to one of the
  served symbols
- **WHEN** a sub-agent in another process asks `verify_claim` whether that lease is current
- **THEN** the verdict is refuted and names the changed symbol

### Requirement: LeaseTokensAreVerifiableClaims

`verify_claim` SHALL accept the kind `lease-current` with a `leaseToken` as the subject, and SHALL
return `confirmed` when every (address, hash) in the token still matches, `refuted` listing each
entry that changed, and `unverifiable` when the token is unknown or expired.

#### Scenario: A changed served symbol refutes the lease

- **GIVEN** a `leaseToken` from an `orient` call that served `parseConfig`, and a later edit to it
- **WHEN** `verify_claim` runs with kind `lease-current` on the token
- **THEN** the verdict is refuted and names `parseConfig`
