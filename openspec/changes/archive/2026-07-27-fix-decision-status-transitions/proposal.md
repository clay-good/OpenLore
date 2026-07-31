# Guard decision status transitions: sync must never resurrect a rejected decision

> Status: SHIPPED (2026-07-19). Implemented as one shared status-transition table
> (`PROMOTABLE_TO_APPROVED` + `illegalPromotionToApproved()`) in `src/core/decisions/store.ts`,
> adopted at ALL FOUR promotion-to-`approved` doors — the two MCP handlers (`handleApproveDecision`,
> `handleSyncDecisions` id path), the embeddable API (`openloreSyncDecisions` ids path), and the CLI
> `--approve`. A `rejected` decision now yields an honest error naming its status and the explicit
> `re-record` reversal step (disclosing the prior review note); an already-`synced` decision is not
> re-promoted; illegal transitions leave the store and spec files untouched. The scope was widened
> beyond the proposal's original single-file target because the API and CLI carried the identical
> resurrection hole — locking one of four doors would have been the exact silent-degradation
> anti-pattern this audit exists to close. Legal lifecycle paths are byte-identical. Tests:
> `store.test.ts` (the table), `decisions.test.ts` (MCP approve + sync), `api/decisions.test.ts`
> (API door). Composes with `harden-decision-consolidation`'s CAS change at the same site (guard
> decides legality; CAS commits). Originally proposed 2026-07-03 (e2e audit follow-up):
> `sync_decisions` with an explicit `id` promoted ANY decision to `approved` — including one a
> human explicitly rejected — and wrote it into the specs, defeating the approve/reject governance
> gate through its own sync tool.

## The gap

- **Sync promotes with no status guard.** `handleSyncDecisions` with an `id` runs
  `store = patchDecision(store, id, { status: 'approved' })` after only an existence check
  (`decisions.ts:307-311`) — no look at the decision's *current* status. A decision a human
  explicitly REJECTED via `reject_decision`, or one already `synced`, is silently promoted to
  `approved` and handed to `syncApprovedDecisions` (`:313-318`), which writes it into the spec
  files. One tool call resurrects a governance verdict.
- **`approve_decision` itself is only half-guarded.** It blocks re-approving a `synced` decision
  (`decisions.ts:233`) but nothing else — approving a `rejected` decision succeeds without any
  acknowledgment that a human verdict is being reversed.
- **The invariant already exists in prose, not code.** The CLAUDE.md gate workflow and
  `adopt-mcp-protocol-conformance` (its defect 4: the human-authorization invariant for
  approve/reject, carried by elicitation) both treat approve/reject as human-only authority. The
  handlers never enforce which transitions are legal, so an agent following the "sync then retry
  commit" recovery path can launder a rejection into the specs without ever presenting it.

**Cross-reference:** the sibling `harden-decision-consolidation` touches this exact promotion
(`decisions.ts:307-311`) but ONLY for the CAS-clobber concern — its
`DecisionStatusPromotionIsCasChecked` requirement governs *how* a promotion commits
(compare-and-swap, patch-then-verify), not *which* transitions are legal. The rejected→approved
resurrection survives that proposal intact; this change adds the orthogonal transition guard. Both
land at the same call site and compose (the guard decides legality, CAS commits it).

## What changes

- **An explicit transition table.** One small, source-declared map over the existing status
  vocabulary (`draft`/`consolidated`/`verified`/`phantom`/`approved`/`rejected`/`synced`) stating
  which statuses may move to `approved` and by which actor path. Deterministic, no new states.
- **`sync_decisions` promotes only promotable statuses.** The `id` path promotes a decision whose
  current status is legally promotable (e.g. `verified`, `approved` no-op); a `rejected` or
  `synced` decision yields an honest error naming the current status and the required step
  (`approve_decision` after explicit human reversal) — never a silent promotion.
- **`approve_decision` blocks `rejected` the way it blocks `synced`.** Reversing a rejection is a
  deliberate act: the error names the rejection (and its `reviewNote` if present) so the agent
  presents it to the human instead of retrying blind.
- **Tests pin the resurrection path closed:** reject → `sync_decisions(id)` → error, store
  unchanged, no spec write; reject → `approve_decision` → error; the legal `verified → approved →
  synced` path unchanged.

## Why this is in scope

The decision store is the governance write path; approve/reject is the one place a human verdict
is recorded. A tool that silently overrides that verdict is the sharpest instance of the
silent-degradation class this audit exists to close — and the fix is a constant-free, surgical
guard on transitions the handlers already name.

## Impact

- `src/core/services/mcp-handlers/decisions.ts` (transition table + guards in
  `handleSyncDecisions` and `handleApproveDecision`); tests in `decisions.test.ts`.
- Specs: `mcp-handlers` — 1 ADDED requirement (DecisionStatusTransitionsAreGuarded).
- Risk: low. Legal paths are byte-identical; only previously-silent illegal promotions now return
  errors. Composes with (does not depend on) `harden-decision-consolidation`'s CAS change at the
  same site.
