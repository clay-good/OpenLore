# mcp-handlers spec delta

## ADDED Requirements

### Requirement: MemoriesCarryReVerifiableClaims

The `remember` tool SHALL accept optional structural claims expressed in the closed `verify_claim`
grammar, SHALL verify each claim at write time against the current graph, and SHALL refuse to
store a claim that does not verify true — returning the counter-receipt. The `recall` tool SHALL
re-verify each stored claim against the current graph and attach a per-claim verdict of
`evidence-holds`, `evidence-refuted`, or `evidence-unverifiable`, each with its receipt. A memory
with any `evidence-refuted` claim SHALL NOT be served as clean authoritative context: it is
disclosed with the failing claim and counter-receipt, as a lane distinct from anchor `drifted` and
`orphaned`. Claim verification SHALL be deterministic graph lookup only — no LLM — and verdicts
MAY be cached keyed by claim and graph fingerprint, re-verifying whenever the fingerprint moves.
The schema addition SHALL be additive: memories without claims behave exactly as before.

#### Scenario: A false-at-write claim is refused with a receipt

- **GIVEN** a `remember` call carrying the claim `{ kind: "calls", subject: "a", object: "b" }`
- **WHEN** the current graph contains no such edge
- **THEN** the memory is not stored with that claim and the response carries the same receipt
  shape `verify_claim` would return for the refuted claim

#### Scenario: Content rot is caught while the anchor stays fresh

- **GIVEN** a stored memory claiming a symbol has exactly one caller, whose anchor is unchanged
- **WHEN** the graph gains a second caller and `recall` runs
- **THEN** the memory's anchor freshness is `fresh` but the claim verdict is `evidence-refuted`
  with a receipt naming the new caller
- **AND** the memory is not served as clean authoritative context

#### Scenario: An unresolvable claim subject is unverifiable, not silently held

- **GIVEN** a stored claim whose subject symbol no longer resolves in the index
- **WHEN** `recall` runs
- **THEN** that claim's verdict is `evidence-unverifiable` with the non-resolution disclosed

#### Scenario: Claimless memories are unaffected

- **GIVEN** a memory recorded before this change, with no claims
- **WHEN** `recall` runs
- **THEN** it is served under the existing anchor-freshness verdicts only, with no claim lane
