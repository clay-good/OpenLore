# Add invalidation receipts: the commit that killed each belief, with its cause

> Status: PROPOSED (2026-07-27, ecosystem research sweep). When a memory or decision stops being
> fresh, pin the invalidating commit and the cause as a permanent record, so `recall --asOf`
> answers not just "what was believed then" but "when and why did this belief die." Prior art:
> bi-temporal fact invalidation in temporal knowledge graphs for agent memory
> (https://arxiv.org/abs/2501.13956).

## The gap

OpenLore is bitemporal on the way in and vague on the way out. A memory records
`validFromCommit` at write (`src/types/index.ts:838-842`), and `asOf`/`changedSince` queries work
— but the valid-time *endpoint* exists only for one cause: explicit supersession sets
`invalidatedAt`/`invalidatedByCommit` (`index.ts:843-846`). Every other death is implicit and
evidence-free: an anchor that drifted or orphaned is detected at read time as a present-tense
verdict ("orphaned now", `mcp-handlers/memory.ts:176`) with no record of *which commit* did it or
*why*. The result: a drifted memory tells the agent to distrust it but cannot say what changed,
`asOf` history shows beliefs winking out with no receipt, and two teammates' stores disagree
about staleness with no common evidence to reconcile against.

## What changes

- **Generalize the existing endpoint fields** — no new schema concept. Whenever staleness
  detection concludes a memory or decision is no longer fresh, it writes (once, immutably)
  `invalidatedByCommit` + a `cause` from a closed set: `anchor-content-changed`,
  `symbol-deleted`, `superseded-by <id>` (today's only writer), and `claim-refuted` (if
  `add-memory-claim-verdicts` ships; composes, does not block).
- **Pin the commit deterministically**: the detecting pass (analyze / watcher / read-path
  staleness) knows the last-fresh graph fingerprint and the first-stale one; the receipt commit
  is found by a bounded walk of the anchored file's history between the two fingerprints'
  commits — the first commit whose touch of the anchored span breaks the anchor's content hash.
  Unresolvable cases (force-pushed history, shallow clone) record `cause` with
  `commit: unknown` and the reason — never a guessed SHA.
- **Serve the receipt**: `recall` attaches it to `drifted`/`orphaned` results ("orphaned since
  `ab12cd34`: symbol deleted"), and `recall --asOf` reports closed validity intervals with both
  endpoints evidenced. Detection semantics change nowhere — the same memories are stale; they
  now carry proof.

Deliberately NOT borrowed from the temporal-KG lineage: LLM-driven contradiction detection at
ingestion (invalidation here is triggered only by the existing deterministic detectors) and
wall-clock validity decay (the cursor stays the commit, never time — house rule).

## Why this is in scope

Turns a bare verdict into a conclusion with evidence — the house shape ("no receipt, no claim").
It is cheap (the detectors already run; the walk is bounded and cached per anchor), additive, and
it upgrades `asOf` from a snapshot query into an honest belief history — the thing the substrate
uniquely can offer over every non-anchored memory system.

## Impact

- Touches: staleness detection paths (analyze-time continuity/orphan pass, watcher, read-path
  verdicts in `mcp-handlers/memory.ts`), the store types (additive `cause` field beside the
  existing endpoint fields), `recall` output.
- No new tool; no behavior change to which facts are stale.
- Specs: `drift` — 1 ADDED requirement.
- Risk: receipt-walk cost on churny files (mitigated: bounded to the inter-fingerprint range,
  computed once per invalidation and stored); disagreeing receipts across machines that observed
  different fingerprint gaps (acceptable: each receipt is honest about its observation window —
  the walk range is part of the evidence).
