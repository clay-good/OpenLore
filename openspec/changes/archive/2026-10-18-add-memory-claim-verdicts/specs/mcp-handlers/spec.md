# mcp-handlers spec delta

## ADDED Requirements

### Requirement: MemoriesCarryReVerifiableClaims

The `remember` tool SHALL accept at most 10 optional structural claims expressed in the closed
`verify_claim` grammar, SHALL verify each claim at write time against the current graph with the
`verify_claim` evaluator itself, and SHALL refuse to store the memory when any claim does not verify
`confirmed`, returning every claim's verdict and receipt. The `recall` tool SHALL check each stored
claim of a returned, non-orphaned, non-invalidated note against the current graph and attach a
per-claim verdict of `evidence-holds`, `evidence-refuted`, or `evidence-unverifiable`, each with
the `verify_claim` reason and receipt. A memory with any `evidence-refuted` claim SHALL be served in
an `evidenceRefuted` lane, and otherwise a memory with any `evidence-unverifiable` claim in an
`evidenceUnverifiable` lane; neither lane is authoritative, neither carries `verifiedCurrent`, and
both are distinct from anchor `drifted` and `orphaned`. Claim verification SHALL be deterministic
graph lookup only — no LLM. One recall SHALL check a claim shared by several memories once. Under
`asOf` or `changedSince` claims SHALL NOT be checked, and the response SHALL say so. The schema
addition SHALL be additive: memories without claims behave exactly as before.

#### Scenario: A false-at-write claim is refused with a receipt

- **GIVEN** a `remember` call carrying the claim `{ kind: "dead", subject: "handler" }`
- **WHEN** the current graph has a caller of `handler`
- **THEN** the memory is not stored and the response carries each claim's verdict, with the
  reason and receipt `verify_claim` would return

#### Scenario: Content rot is caught while the anchor stays fresh

- **GIVEN** a stored memory claiming `orphan` is dead, anchored to an unchanged symbol
- **WHEN** the graph gains a caller of `orphan` and `recall` runs
- **THEN** the memory's anchor freshness is `fresh` but the claim verdict is `evidence-refuted`
- **AND** the memory is served in `evidenceRefuted`, not in `authoritative`

#### Scenario: An unresolvable claim subject is unverifiable, not silently held

- **GIVEN** a stored claim whose subject symbol no longer resolves in the index
- **WHEN** `recall` runs
- **THEN** that claim's verdict is `evidence-unverifiable` with the non-resolution disclosed
- **AND** the memory is served in `evidenceUnverifiable`, not in `authoritative`

#### Scenario: Claimless memories are unaffected

- **GIVEN** a memory recorded before this change, with no claims
- **WHEN** `recall` runs
- **THEN** it is served under the existing anchor-freshness verdicts only, with no claim lane
