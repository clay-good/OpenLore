# Tasks — fix-decision-status-transitions

## Implementation
- [x] Declare a source-level status-transition table over the existing vocabulary
      (draft/consolidated/verified/phantom/approved/**auto-approved**/rejected/synced): which
      statuses may move to `approved`, and that `rejected → approved` is legal ONLY via explicit
      re-record. Shipped as `PROMOTABLE_TO_APPROVED` + `illegalPromotionToApproved()` in
      `src/core/decisions/store.ts` (one shared table, imported by every promotion site)
- [x] `handleSyncDecisions` id path (`decisions.ts`): check the decision's current status against
      the table before promoting; `rejected`/`synced` → honest error naming the current status and
      the required human step, no promotion, no spec write
- [x] `handleApproveDecision` (`decisions.ts`): block approving a `rejected` decision the same way
      `synced` is blocked, surfacing the rejection's `reviewNote` so the agent can present the
      reversal to the human
- [x] Close the identical hole at the other two promotion doors — the embeddable API
      (`openloreSyncDecisions` ids path, `src/api/decisions.ts`) and the CLI `--approve`
      (`src/cli/commands/decisions.ts`) — with the same shared table (one lock, every door)
- [x] Keep the guard orthogonal to `harden-decision-consolidation`'s CAS change at the same site
      (guard decides legality; CAS commits) — legal paths byte-identical, no semantic conflict

## Verification
- [x] Test: reject a decision, then `sync_decisions(id)` → error naming status `rejected`; store
      unchanged; no spec file written (`syncApprovedDecisions` never called)
- [x] Test: reject a decision, then `approve_decision(id)` → error surfacing the review note and
      naming the `re-record` reversal step; the verdict is intact
- [x] Test: `sync_decisions(id)` on an already-`synced` decision → error, not a re-promotion
- [x] Test: the legal path (verified → approve → sync → synced) is unchanged, at every surface
      (store table unit test, MCP handler, API)
- [x] Full suite green (`npm run test:run`)

## Spec
- [x] `mcp-handlers` delta: ADD DecisionStatusTransitionsAreGuarded
