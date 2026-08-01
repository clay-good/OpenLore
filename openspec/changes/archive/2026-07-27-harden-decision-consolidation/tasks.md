# Tasks — harden-decision-consolidation

## Implementation
- [x] `spawnConsolidateBackground` registers `child.on('error')`; resolves the earlier of
      `spawn`/`error` events (bounded — one tick, not run completion); returns
      `{ outcome: 'started' | 'failed' | 'coalesced', detail? }` instead of `void`
- [x] `handleRecordDecision` response reflects the outcome: `started` → current message; `failed`
      → decision recorded + "consolidation could NOT be started — run `openlore decisions
      --consolidate`"; never an unconditional "running in background"
- [x] Coalescing: reuse the existing decisions consolidation lock as the in-flight sentinel — if
      held, skip the spawn and disclose `coalesced` (no pidfile, no new mechanism)
- [x] `handleSyncDecisions` id-promotion moves inside `updateDecisionStore` (CAS) with the
      patch-then-verify shape of approve/reject (decisions.ts:235-245); concurrent change → honest
      error, no clobber

## Verification
- [x] Test: spawn at a nonexistent binary → process survives (no uncaught exception), outcome
      `failed`, response discloses the recovery command
- [x] Test: sync with a concurrently-recorded draft → draft survives (CAS re-applied), promoted
      decision syncs
- [x] Test: two rapid `record_decision` calls while the lock is held → exactly one spawn, second
      response discloses coalescing
- [x] Full suite green (`npm run test:run`)

## Spec
- [x] `mcp-handlers` delta: ADD BackgroundConsolidationFailsClosed,
      DecisionStatusPromotionIsCasChecked
