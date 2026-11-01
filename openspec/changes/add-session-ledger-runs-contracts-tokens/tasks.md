# Tasks — add-session-ledger-runs-contracts-tokens

## Implementation
- [ ] Test-run recording from after-tools hook payloads: repo-declared test commands + closed runner
      list; time, exit status if present, edited-symbol hashes at that moment
- [ ] Before-stop fact: symbols edited after the last run + the tests that reach them; withheld
      with reason when no payloads were seen
- [ ] Delivered-fact record for hook dedupe
- [ ] Canonical-form SHA-256 for contract elements and IaC resources (sorted-key serialization of
      parsed fields); tracked in served/edited like code symbols
- [ ] `leaseToken` on `orient` and `recall`: digest of the served (address, hash) set, registered in
      `.openlore/session-ledger/tokens/` (bounded, expiring with the session)
- [ ] `status --json` session counts: body-only, signature-changed (disjoint), exports-changed,
      contract-elements-changed, iac-resources-changed; no thresholds

## Verification
- [ ] Reformatted OpenAPI YAML → no note; changed path in it → note naming the operation
- [ ] A `leaseToken` from session A resolves in a separate process; changed entries listed
- [ ] Session counts match a fixture diff; no percentage or threshold field exists
- [ ] Edit → `npm test` → edit again → before-stop names the second edit's symbols and their tests;
      edit → test with no later edit → nothing
- [ ] Full suite green

## Spec
- [ ] `mcp-handlers` delta: ADD EditsAfterTheLastTestRunAreNamed
- [ ] `mcp-handlers` delta: ADD ServedContractsAndResourcesCarryCanonicalHashes
- [ ] `mcp-handlers` delta: ADD LeaseTokensAndSessionCountsAreExposedAsData
