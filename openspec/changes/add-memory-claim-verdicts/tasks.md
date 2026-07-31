# Tasks — add memory claim verdicts

## Implementation
- [ ] Export a reusable claim evaluator from `claim-verification.ts` (same verdict + receipt
      shapes; no logic fork)
- [ ] `remember`: optional `claims[]` validated against the closed `ClaimKind` set; verify each at
      write time; refuse a false-at-write claim with the counter-receipt; persist record-time
      receipts (graph fingerprint + verdict) on the memory
- [ ] `recall`: re-verify claims per memory; attach `evidence-holds | evidence-refuted |
      evidence-unverifiable` per claim; a refuted memory is served non-authoritative and disclosed
      (unreconciled-style), never as clean fresh context
- [ ] Verdict cache keyed by (claim hash, graph fingerprint); invalidated by fingerprint motion
- [ ] Additive schema: `AnchoredMemory.claims?` + receipts; legacy memories load unchanged

## Verification
- [ ] Write-time refusal: a claim false at record time is rejected with a receipt
- [ ] Rot detection: record "single caller" claim → add a second caller → re-analyze → recall
      serves `evidence-refuted` with the counter-receipt while anchor freshness stays `fresh`
- [ ] Unverifiable: delete the claim's subject → `evidence-unverifiable`, memory not authoritative
- [ ] Cache: unchanged fingerprint re-serves the cached verdict (no traversal); changed
      fingerprint re-verifies
- [ ] Legacy store round-trip: pre-change `notes.json` loads and serves with no claim lane

## Spec
- [ ] `mcp-handlers` delta: ADD MemoriesCarryReVerifiableClaims
