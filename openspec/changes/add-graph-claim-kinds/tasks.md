# Tasks — add-graph-claim-kinds

## Implementation
- [ ] `decision-governed`: decisions/memories anchored to the symbol, with recall freshness; ships
      first (no dependency)
- [ ] `endpoint-implemented` over `implements_endpoint` (after `add-service-contract-certification`)
- [ ] `endpoint-consumed` over `consumes_endpoint` + `http_endpoint`, federation included; refuted is
      scoped to the indexed repositories with the external boundary stated
- [ ] `lease-current` over the ledger token store (after `add-session-structural-ledger`)
- [ ] Kind enum, input schema, docs table; receipts reuse the existing shape

## Verification
- [ ] Each kind: one confirmed, one refuted, one unverifiable fixture
- [ ] `endpoint-consumed` refuted text names the indexed scope and the external boundary
- [ ] `decision-governed` lists an orphaned memory as orphaned, not governing
- [ ] Existing kinds' outputs unchanged
- [ ] Full suite green

## Spec
- [ ] `mcp-handlers` delta: ADD ClaimKindsCoverContractsDecisionsAndLeases
