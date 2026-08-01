# Harden decision consolidation: fail-closed spawns, CAS status promotion, coalesced runs

> Status: SHIPPED (2026-07-18, PR #231; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit). Closes three robustness gaps in the decision
> lifecycle: an unhandled background-spawn error that can kill the long-lived MCP server, a success
> message returned even when the spawn failed, and a status promotion that bypasses the
> compare-and-swap discipline every sibling handler follows. Pure hardening of existing mechanisms
> — no new tool, dependency, or LLM. Grounded in the honesty contract and the `mcp-handlers`
> ConcurrentMemoryWriteSafety / AuthoritativeRecallInvariant discipline.

## The gap

Every `record_decision` fires a detached background consolidation
(`decisions.ts:169` → `spawnConsolidateBackground`, `:28-50`). Three defects:

1. **An ENOENT can kill the MCP server.** The spawn (`decisions.ts:43-48`) is `detached`,
   `stdio: 'ignore'`, `unref()` — and registers **no `child.on('error')` listener**. When binary
   resolution falls through to the bare `'openlore'` on PATH (`:41`) and the binary is absent
   (global install missing, PATH-stripped environment), Node emits `error` on the child; with no
   listener that is an **uncaught exception in the long-lived MCP server process**. The one
   failure mode most likely in the field (npx-only users, CI sandboxes) is the one that crashes
   the host.
2. **Dishonest success.** `handleRecordDecision` returns `"Consolidation running in background"`
   unconditionally (`decisions.ts:171-174`) — the message is emitted before the spawn outcome is
   knowable and even when it failed. The agent (and the CLAUDE.md workflow that promises "calling
   `record_decision` proactively keeps every commit instant") is told consolidation is underway
   when the next commit will actually hit the slow-extraction path.
3. **`sync_decisions` promotes status outside CAS.** `handleSyncDecisions` patches a
   locally-loaded store (`decisions.ts:307-311`: `store = patchDecision(store, id, { status:
   'approved' })`) with no `updateDecisionStore` compare-and-swap re-check — unlike
   `approve_decision`/`reject_decision`, which commit through CAS and verify the patch landed
   (`:235-245`, `:270-278`). A draft recorded concurrently between the load and the sync's
   eventual write can be clobbered.
4. **Concurrent spawns fan out.** Rapid `record_decision` calls each spawn a consolidator. The
   existing decisions lock prevents store corruption, but N processes racing one lock is
   unobserved thrash — nothing reuses an in-flight run.

## What changes

- **Fail-closed spawn with honest disclosure.** `spawnConsolidateBackground` registers
  `child.on('error')` and resolves the earlier of `spawn`/`error` (bounded); it returns the
  outcome instead of `void`. `handleRecordDecision` reports it: started → today's message; failed
  → the decision is still recorded (the store write already committed via CAS, `:163-166`) and the
  response says consolidation **could not be started** with the recovery command (`openlore
  decisions --consolidate`) — never a false "running in background".
- **CAS-checked promotion in sync.** The `id` promotion in `handleSyncDecisions` moves inside
  `updateDecisionStore` with the same patch-then-verify shape as approve/reject; a concurrent
  removal/change yields an honest error, not a clobber.
- **Coalesced consolidation.** Before spawning, check the **existing decisions consolidation
  lock** (the one the consolidator already takes — no new mechanism): if a run is in flight, do
  not spawn another; the response discloses "consolidation already running" and the recorded
  draft is picked up by it or the next run.
- **A crash-proof test.** A test drives `spawnConsolidateBackground` at a nonexistent binary and
  asserts the process survives and the returned outcome is `failed` — the regression test for
  defect 1.

## Why this is in scope

The decision store is the substrate's governance write path; CLAUDE.md instructs every agent to
call `record_decision` before writing code. A handler that can crash the whole MCP server on a
routine environment gap, or that reports success it cannot know, is the exact class of silent
unreliability the honesty contract exists to prevent — and the CAS gap contradicts the
concurrency discipline the sibling handlers already implement.

## Impact

- `src/core/services/mcp-handlers/decisions.ts` (spawn hardening, response honesty, sync CAS,
  coalescing); tests in `decisions.test.ts` (spawn-ENOENT survival, failed-spawn response shape,
  concurrent-draft sync safety).
- Specs: `mcp-handlers` — 2 ADDED requirements (BackgroundConsolidationFailsClosed,
  DecisionStatusPromotionIsCasChecked).
- Risk: low. `record_decision` gains a bounded await on spawn outcome (one event tick, not run
  completion) — commit-gate latency is unchanged. No schema change; the response message text
  changes only in the failure/coalesced cases.
