# Tasks — add-session-lease-tokens

- [ ] Canonical-form SHA-256 for contract elements and IaC resources (sorted-key serialization of parsed fields); tracked in served/edited like code symbols
- [ ] `leaseToken` on `orient` and `recall`: digest of the served (address, hash) set, registered in `.openlore/session-ledger/tokens/` (bounded, expiring with the session)
- [ ] `verify_claim` kind `lease-current` (confirmed / refuted listing changed entries / unverifiable for unknown or expired)
- [ ] `status --json` session counts: body-only, signature-changed (disjoint), exports-changed, contract-elements-changed, iac-resources-changed; no thresholds
- [ ] Tests: reformatted OpenAPI YAML → no note, changed path → note; token from process A resolves in B; counts match a fixture diff
- [ ] Spec: `mcp-handlers` ADD ServedContractsAndResourcesCarryCanonicalHashes, LeaseTokensAndSessionCountsAreExposedAsData, LeaseTokensAreVerifiableClaims
