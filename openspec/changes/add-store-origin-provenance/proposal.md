# Add store origin provenance: every memory and decision names where it came from

> Status: PROPOSED (2026-07-27, ecosystem research sweep). Stamp every anchored fact with an
> immutable origin class at write time; disclose it at every read; let `enforcement.policy` bind
> influence to origin. Imported facts are quarantined-advisory until re-earned. Prior art:
> origin-bound authority as the machine-checked defense against memory poisoning
> (https://arxiv.org/pdf/2606.24322; attack evidence: https://arxiv.org/abs/2601.05504).

## The gap

OpenLore's stores cannot tell a fact's provenance apart. A memory hand-approved by a human, one
recorded by an agent mid-session, and one that arrived inside an imported `.olbundle` are
indistinguishable records once stored — `AnchoredMemory` (`src/types/index.ts:823-849`) carries
no origin field at all. The memory-poisoning literature (OWASP ASI06; MINJA-style injection)
identifies exactly this as the vector: content that enters the store through a low-trust channel
inherits the authority of everything else in it. OpenLore already fixed the sibling problem twice
— decisions disclose auto-approved provenance (`AutoApprovedProvenanceIsAlwaysDisclosed`), and
repo config crossed a trust boundary in the security hardening pass — but the anchored-fact
stores, the substrate's core asset, still launder origin. `harden-bundle-import-trust` (open)
covers the *graph facts* a bundle carries; nothing covers the memories and decisions it carries.

## What changes

- **Write-time origin stamp**, immutable, from a closed set: `human-approved` (recorded or
  promoted through an explicitly human act), `agent-recorded` (the default for `remember` /
  `record_decision`), `imported-bundle`, `federated-remote`. Absent field on legacy records ⇒
  `agent-recorded` (the honest floor, disclosed as `assumed`).
- **Read-time disclosure everywhere**: `recall`, `verify_claim decision-current`, the commit
  gate, and injected briefings carry the origin class alongside the freshness verdict — one more
  column, not a new lane.
- **Quarantine for imported facts**: an `imported-bundle` / `federated-remote` memory is served
  advisory-only — never as clean authoritative context — until re-earned in this repo: its claims
  re-verify against the local graph (rides `add-memory-claim-verdicts` when present; anchors
  resolving locally is the floor otherwise) or a human promotes it (`add-team-memory-promotion`'s
  review path). Both escapes are deterministic and disclosed.
- **Policy binding, advisory by default**: a new registered finding code
  (`untrusted-origin-influence`) fires when a gated conclusion (the decisions gate, `enforce`)
  was materially informed by a non-`human-approved` fact; operators opt in to blocking via the
  existing `enforcement.policy` classes (`FINDING_CODE_REGISTRY`,
  `src/core/services/mcp-handlers/enforcement-policy.ts`).

Deliberately NOT borrowed: cryptographic signing of individual memories (overkill for a
local-first store; signatures stay with `add-attested-governance-artifacts` /
`harden-bundle-import-trust`, which this composes with rather than duplicates) and any LLM-scored
trust weighting (origin is a fact about the write event, never a judgment).

## Why this is in scope

Continues the 2026-07 security arc (repo-config trust boundary, bundle-trust hardening) to the
last unlaundered input: the fact stores themselves. Pure write-time metadata + read-time lookup —
no LLM, no service, no schema break (additive field, `AdditiveBitemporalMemorySchema` precedent).

## Impact

- Touches: memory store types + `remember`/`recall` (`mcp-handlers/memory.ts`), decision store
  writers (CAS paths unchanged — origin rides the record), bundle import (`index-bundle.ts` —
  stamps `imported-bundle` on ingest), federation ingest, `enforcement-policy.ts` (one new code).
- Specs: `mcp-handlers` — 1 ADDED requirement.
- Risk: over-quarantine annoying teams that trust their bundles (mitigated: the quarantine exit
  is cheap and automatic — anchors + claims re-verifying locally — and the policy class for the
  finding defaults to advisory).
