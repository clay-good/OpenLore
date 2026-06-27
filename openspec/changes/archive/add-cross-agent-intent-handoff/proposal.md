# Cross-agent intent handoff: brief the next agent on what was already decided

> Status: IMPLEMENTED (PR #168, 2026-06-19). All four requirements shipped; the two items previously
> marked DEFERRED in this header (the dedicated `recall` briefing mode and the federation
> cross-repo-constraint sub-item) were both built later in the same PR.
> - **ProactiveIntentBriefing (Req 1 / item 1) — already shipped** before this PR: `orient` surfaces
>   in-scope decisions and `remember` notes with freshness verdicts (`pendingDecisions` /
>   `staleDecisions` / `unreconciledMemories`), withholding orphaned and flagging drifted intent.
> - **ReversalAwareness (Req 2 / item 2) — built in PR #168 (ADR-0017).** `orient` AND `recall` now emit
>   an additive `reversals` field surfacing reverted/superseded intent as do-not-repeat warnings naming
>   the reverting commit and recorded reason, via the shared `reversals.ts` helper (`collectReversals` /
>   `renderReversalWarning`). The dedicated `recall` briefing mode (previously deferred) is DONE
>   (commit `9c6b075`). Unit tests in `orient-reversal-awareness.test.ts` + `memory.test.ts`; e2e dogfood
>   in `DOGFOOD-reversal-awareness.md`.
> - **Item 3 (cross-agent + freshness)** is satisfied by the existing cross-session briefing; the
>   federation cross-repo-constraint sub-item (previously deferred) is DONE — `FleetLevelAnchoredMemory`
>   (ADR-0019, commits `be0aa3d`/`1da69e4`): a producer-repo memory OR decision anchored to a consumed
>   interface surfaces in the consumer's `recall.fleetMemory` with its producer-side verdict, orphaned
>   withheld (`src/core/federation/fleet-memory.ts`).
> - **Item 4 (budget/docs)**: `reversals` and `fleetMemory` are bounded with explicit omission notes;
>   documented in the canonical `mcp-handlers` spec (ProactiveIntentBriefing + ReversalAwareness +
>   FleetLevelAnchoredMemory requirements).
>
> Builds on `add-bitemporal-typed-memory-operations` (supersession/reversal) and
> `harden-memory-integrity-invariant` (freshness).

## Why

When an agent starts a task on a file, it starts blind to history. It does not know that three agents
or humans before it established a constraint, and — most costly — it does not know that an approach was
*already tried and reverted*. So it re-litigates settled decisions and sometimes re-introduces a bug
that was deliberately removed. The information exists: the decisions store, and (after the bitemporal
change) the supersession and reversal record. What is missing is **proactive briefing at the moment of
orientation**, scoped to the code in hand.

This is a distinct class of mistake-prevention. The dispatch and freshness changes keep OpenLore from
being *wrong*; this change keeps the agent from *repeating history*. No code-intelligence tool does
it, because it requires exactly the code-anchored, bitemporal memory OpenLore is building.

## What changes

1. **An intent briefing at orient time.** For the symbols and files in a task's scope, `orient` (and a
   dedicated recall mode) proactively surfaces the relevant prior decisions and constraints as a
   conclusion-shaped briefing — not on explicit request, but as part of orientation, because the agent
   does not know to ask for history it is unaware of.

2. **Reversal and supersession awareness — the headline.** A superseded or reverted decision is
   surfaced as an explicit "do not re-attempt X; it was tried and reverted at commit Y — here is the
   recorded reason," reusing the bitemporal supersession record. This is the single highest-value
   anti-repeat signal: it stops the agent from re-introducing a deliberately removed approach.

3. **Cross-agent, not just cross-session.** Memories and decisions recorded by *any* agent (or human)
   that anchor to in-scope code surface here, each with its freshness verdict per the authoritative-
   recall invariant — so the briefing is multi-agent institutional memory, not just this agent's own
   trail. Under federation, briefings can include constraints recorded on a published interface in
   another repo.

4. **Scoped and budgeted.** The briefing is token-budgeted (reusing
   `add-trust-calibrated-context-economy`) and surfaces only fresh, in-scope intent — never a history
   dump. Stale (`drifted`) intent is flagged; orphaned intent is withheld.

## What does NOT change

- **No LLM.** Selection is the existing deterministic retrieval scoped to the task's symbols; reversal
  awareness reads the bitemporal supersession record. The north star (`c6d1ad07`) holds.
- **No new relevance model.** This surfaces existing memories/decisions through existing retrieval; it
  governs *when and how proactively* intent is shown, not *which* memory is relevant.
- **No new default tool.** It rides `orient` and `recall`; nothing new enters the minimal or first-run
  default surface.
- **The authoritative-recall invariant is honored.** Orphaned intent is never briefed as current;
  drifted intent carries a verify flag.

## Research basis

Institutional memory and Architecture Decision Records made *active* rather than passive; Zep/Graphiti's
temporal fact invalidation surfaced as "this was true, then reverted." The insight that preventing the
re-litigation of settled-and-reverted decisions is a high-value, distinct mistake class — one that
grows with team and agent count — and that only code-anchored, bitemporal memory can serve it
deterministically.

## Application to OpenLore

- **Selection** reuses `orient`'s deterministic retrieval scoped to in-scope symbols
  (`orient.ts:388-447`).
- **Reversal awareness** reuses the supersession/invalidation record from
  `add-bitemporal-typed-memory-operations`.
- **Freshness** reuses the authoritative-recall invariant from `harden-memory-integrity-invariant`.
- **Budgeting** reuses `add-trust-calibrated-context-economy`.
- **Cross-repo briefings** reuse `add-multi-repo-federation` stable-ID anchoring.

## Out of scope

- **Authoring** decisions/constraints — that is the existing `record_decision` / `remember` flow; this
  change only *surfaces* them at the right moment.
- **Summarizing** history with an LLM. The briefing presents recorded intent verbatim with verdicts.
- **Conflict resolution.** Contradictions are surfaced (`add-bitemporal-typed-memory-operations`), not
  resolved here.
