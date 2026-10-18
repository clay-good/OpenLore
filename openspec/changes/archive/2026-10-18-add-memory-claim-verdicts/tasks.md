# Tasks — add memory claim verdicts

## Implementation
- [x] Reuse the claim evaluator: `memory-claims.ts` calls `handleVerifyClaim` itself (same verdict
      and receipt; no logic fork), loaded lazily so the prompt-hook path stays light
- [x] `remember`: optional `claims[]` (max 10) validated against the closed claim kinds; verify
      each at write time; refuse the whole memory when a claim is not `confirmed`, returning every
      verdict (`claimVerdicts`); persist `recordedIndexCommit` from the receipt
- [x] `recall`: check claims on returned, non-orphaned, non-invalidated notes; attach
      `evidence-holds | evidence-refuted | evidence-unverifiable` per claim; refuted →
      `evidenceRefuted`, uncheckable → `evidenceUnverifiable`; neither is authoritative nor
      `verifiedCurrent`. Deviation: unverifiable gets its own lane instead of `needsReanchoring`,
      because the anchor is fine and "re-anchor" would be the wrong remedy
- [x] Verdict reuse within one call: a claim shared by several memories is checked once.
      DEFERRED: a cross-call cache keyed by (claim, graph fingerprint) — only returned notes are
      checked, so the cost is bounded by `limit` × 10 claims
- [x] Additive schema: `AnchoredMemory.claims?`; legacy memories load unchanged; a malformed
      stored claim makes the note malformed (skipped), like any other malformed field
- [x] Claims are not checked under `asOf`/`changedSince` (the current graph cannot answer a
      question about the past); the response says so

## Verification (`memory-claims.test.ts`)
- [x] Write-time refusal: a claim false at record time is rejected with the verdicts; nothing stored
- [x] Rot detection: "orphan is dead" → add a caller → recall serves `evidence-refuted` while
      anchor freshness stays `fresh`
- [x] Unverifiable: remove the claim's subject → `evidence-unverifiable`, memory not authoritative
- [x] Within-call reuse: two memories with the same claim → one graph load
- [x] Legacy: a memory without claims serves exactly as before

## Deferred
- Pushed memories (`orient` / `blast_radius` `injectedMemories`, prompt hook) do not check claims
- A `memory-evidence-refuted` governance finding

## Spec
- [x] `mcp-handlers` delta: ADD MemoriesCarryReVerifiableClaims
