# Working-set context briefing: assemble the structural context a change actually needs

> Status: IMPLEMENTED (2026-06-21) — shipped on branch `feat/working-set-context-briefing`. Decision
> `e7c73f5d`. Second of three in `SPEC-STORE-INTEGRATION.md`. Builds on `add-spec-store-binding` (the
> targets), `orient`, and `add-trust-calibrated-context-economy` (token budgeting). Prerequisite for
> `add-change-impact-certificate`. See `tasks.md` → "Implementation status" and
> `DOGFOOD-working-set-context.md` for the real-index e2e.

## Why

When an external plan assembles a "working set" for an active change — the change plus the target
repositories it touches — the structural context that set hands to an agent is, today, inert: a list of
folders and declared paths. The agent still opens the change cold and re-derives the codebase by reading
dozens of files, burning its context window and drifting from what is actually true. The plan can say
*which* repositories matter; it cannot say *what in them* matters for this change.

OpenLore already answers exactly that question for a single repository. `orient` returns the relevant
functions, callers, specs, call paths, and insertion points for a task in one deterministic call,
token-scoped. What is missing is the ability to run that across the **targets of an active change** and
return one coherent, budgeted briefing — the working-set context — that an agent or an external
orchestrator can consume before any edit.

This is the capability that turns a declared working set into a working set that is *true*. It is also
the most direct answer to context-window pressure: deterministic, scoped structural context replaces
speculative file-by-file rediscovery.

## What changes

1. **A working-set briefing across targets.** Given a bound spec store and an active change (its
   intent text and, where present, the spec deltas or touched areas it declares), OpenLore assembles a
   single deterministic briefing spanning the change's target repositories: for each target, the
   relevant functions, callers, insertion points, governing specs, and the prior decisions/constraints
   anchored to the in-scope code. It is `orient`, generalized from one repo to the change's targets.

2. **Token-budgeted, never a dump.** The briefing reuses the trust-calibrated context economy: it is
   bounded to a budget, ranks by structural relevance to the change's scope, and explicitly notes what
   it omitted. It is context an agent reads in full, not a corpus it must triage.

3. **Conclusion-shaped and per-target attributed.** Every item names its target repository and its
   symbol, so the consumer knows not just "this function matters" but "this function in target *B*
   matters, with these callers." The briefing is a conclusion, never a raw graph.

4. **A stable machine contract.** Exposed as an MCP tool and a CLI command emitting documented `--json`,
   so an external system can request the working-set context for a named change and splice it into the
   brief it hands its agent.

## What does NOT change

- **No LLM.** The briefing is deterministic retrieval scoped to the change's targets and in-scope
  symbols; the north star (`c6d1ad07`) holds.
- **No new relevance model.** It reuses `orient`'s existing ranking and the context economy's budgeting;
  it governs *across how many targets* and *under what budget* orientation runs, not *which* symbol is
  relevant.
- **No new default tool.** It is opt-in for spec-store-bound environments; nothing enters the
  `minimal` / first-run default surface.
- **No mutation.** It reads the store's declared change and the targets' indexes and reports. It does
  not write to the store or the targets.

## Research basis

Task-scoped, deterministic code orientation (already shipped here) generalized from a single repository
to the declared targets of an out-of-tree plan; budgeted retrieval to keep assembled context within a
model's effective window rather than overflowing it; and per-source attribution so a multi-repository
briefing remains legible.

## Application to OpenLore

- **Per-target orientation** reuses `handleOrient` run against each resolved target in the binding's
  federation set (`add-spec-store-binding`).
- **Anchored intent** reuses the proactive intent briefing and freshness verdicts from
  `add-cross-agent-intent-handoff` / `harden-memory-integrity-invariant`, scoped to in-scope symbols.
- **Budgeting and omission notes** reuse `add-trust-calibrated-context-economy`.
- **Contract** reuses the `conclusion` classification and `--json` emission pattern.

## Out of scope

- **Certifying impact** (blast radius, newly-opened paths, drift) of the change — that is
  `add-change-impact-certificate`. This change assembles *context*; it does not assess *risk*.
- **Editing or sequencing** the change. OpenLore briefs; the agent acts.
- **Authoring** the change's intent. The intent comes from the external store; OpenLore consumes it.
