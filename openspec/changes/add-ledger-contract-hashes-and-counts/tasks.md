# Tasks — add-ledger-contract-hashes-and-counts

- [ ] Canonical-form SHA-256 for OpenAPI operations (reuse the contract reader's Merkle hashes) and IaC resources; tracked in served/edited like symbols; background-change notes name them by address and file
- [ ] `status --json` session counts: body-only, signature-changed (disjoint), exports-changed, contract-elements-changed, iac-resources-changed; no thresholds
- [ ] Tests: reformatted OpenAPI YAML → no note; changed path → note naming the operation; counts match a fixture diff
- [ ] Spec: `mcp-handlers` ADD ServedContractsAndResourcesCarryCanonicalHashes, SessionCountsAreExposedAsData
