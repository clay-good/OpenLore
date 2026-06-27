# Task-scoped context injection: amortize the per-task orient round-trip to zero

> Status: IMPLEMENTED (2026-06-22, branch `feat/task-scoped-context-injection`). First and
> highest-leverage of three changes that close the one loss case OpenLore's own agent benchmark
> publishes (the other two: `default-to-lean-tool-surface`, `add-prove-shareable-scorecard` (PR #183)).
> Builds on the existing `SessionStart` orient hook (`src/cli/install/adapters/claude-code.ts`), the
> `orient` handler (`src/core/services/mcp-handlers/orient.ts`), and `orient --lean` (Spec 27). Adds no
> new MCP tool. Decisions: `27c4bb53` (inject shape + budget), `0fc964d3` (relevance gate), `1d35a27b`
> (hook wiring). Shipped: `orient --inject` CLI mode + deterministic gate
> (`src/cli/commands/orient-inject.ts`), `UserPromptSubmit` install wiring (claude-code),
> `contextInjection` config opt-out, docs + canonical cli/mcp-handlers specs. Verified e2e
> (strong/weak/empty/off/budget) and the full 4456-test unit suite passes.

## Why

OpenLore's published Value Scorecard (`docs/AGENT-BENCHMARKS.md`, README) is honest about a two-tier
result: on large/unfamiliar/deep tasks the substrate is a net win (−7%→−21% cost, −26% round-trips),
but on small/familiar/shallow tasks it *adds* overhead — and the README names the cause precisely:
**"the cost there is a sometimes-redundant `orient` round-trip, not tool-schema bytes."** A leaner
tool surface (the sibling `default-to-lean-tool-surface` change) does not close it, because the cost
is not bytes — it is a whole agent turn spent calling `orient` and waiting for the result before any
real work begins.

That round-trip is paid **once per task**, on every task, in every repo, whether or not the
orientation was needed. It is the single most broadly-applicable cost OpenLore imposes, and removing
it converts a task-dependent win into a near-universal one.

The fix is structural, not a new feature: OpenLore already knows the user's first message at the
moment a task begins, and it already has a `SessionStart` hook that injects whole-repo orientation
with no task. The missing piece is **task-scoped** injection — running `orient(<the user's first
prompt>)` *before* the agent's first turn and placing the result in context, so the orientation the
agent would have spent a round-trip to fetch is simply already there. The round-trip is not
optimized; it is amortized to zero by moving it off the agent's critical path and onto a hook the
harness runs for free.

A second, smaller cost is paid in repos where orientation has no value to add (small, model-already-
knows-it). For those, injecting a large orient payload is itself overhead. So injection carries a
deterministic **relevance gate**: when the graph-derived signal that orientation would help is weak,
the injected block degrades to a one-line pointer instead of a full briefing.

## What changes

1. **A task-scoped injection hook.** `openlore install` wires, in addition to the existing
   whole-repo `SessionStart` hook, a `UserPromptSubmit` hook (Claude Code) — and the equivalent
   first-prompt hook on every adapter that supports one — that runs `openlore orient --inject`
   against the user's submitted prompt and emits the result as additional context for that turn. The
   agent's first turn therefore begins already oriented to *this* task, with no orient round-trip
   spent.

2. **An `--inject` mode on the `orient` CLI.** A new `orient --inject` flag (reading the prompt from
   the hook's stdin payload, or `--task`) produces an injection-shaped, lean-by-default block:
   compact, clearly attributed to OpenLore, capped by a token budget, and prefixed with a one-line
   statement of what it is and that the agent may ignore it — the same facts-not-coercion posture as
   the Epistemic Lease (decision `8e95746d`). It reuses `orient --lean` (Spec 27) so injection skips
   the enrichment compute, not just its payload.

3. **A deterministic relevance gate.** Before emitting a full block, `--inject` computes a local,
   no-LLM **orientation-relevance signal** from the graph (e.g. number and fan-in of matched
   functions, match score, repo size / graph density). When the signal is below a documented
   threshold — the small/familiar/shallow case the benchmark shows OpenLore should stay out of —
   injection degrades to a single pointer line ("OpenLore is available; call `orient` if you need
   structural context") instead of a full briefing. The gate is the mechanism that stops injection
   from re-introducing overhead in exactly the arena the scorecard says OpenLore should not tax.

4. **Idempotent, marker-identified, reversible wiring.** The `UserPromptSubmit` group is marked with
   `_openlore: true` exactly like the existing `SessionStart` group, so re-running install replaces
   only our group in place (a stale OpenLore group self-heals; it is never duplicated), user-authored
   sibling hooks are left byte-identical, and `--uninstall` removes it cleanly. `--dry-run` previews
   it. No change to the merge-not-clobber install contract. (As with `SessionStart`, the
   marker-identified hook group is not fingerprint-protected: hand-edit refusal applies to the
   `CLAUDE.md` block and `.mcp.json`, not to the hook group, whose contents are OpenLore-owned.)

5. **Opt-out, and bounded.** Injection is on by the same default as the rest of `openlore install`,
   but a single config switch (`.openlore/config.json`) disables task-scoped injection while leaving
   the MCP server and SessionStart primer intact. The injected block is hard-capped by token budget
   so it can never dominate the context it is meant to economize.

## What does NOT change

- **No new MCP tool.** This is install wiring plus a flag on the existing `orient` CLI surface. The
  MCP tool count and every preset are unchanged. (`mcp-quality` minimize-tool-surface holds.)
- **No LLM.** The injected content is deterministic `orient` output; the relevance gate is a
  graph-derived signal. The north star (`c6d1ad07`) holds.
- **Facts, not commands.** The injected block informs and is explicitly ignorable; it never instructs
  the agent to act, matching the Epistemic Lease posture (decision `8e95746d`).
- **The existing SessionStart primer stays.** Whole-repo session-start orientation is unchanged;
  this adds the per-task layer beside it, it does not replace it.
- **Merge-not-clobber install contract holds.** Same marker-identified, idempotent, format-preserving
  wiring already used for `SessionStart` / `.mcp.json` / permissions (decision `df27e8ef`).
- **No mutation of the repo or graph.** Injection reads the graph and the prompt and emits text.

## Research basis

The amortization is the standard move of doing expensive context assembly off the critical path:
retrieval-augmented generation pre-fetches context into the prompt rather than letting the model
spend a tool-turn to request it; speculative / prefetch execution hides latency by doing predictable
work before it is asked for. The relevance gate is selective retrieval — the established finding that
unconditional context injection regresses quality and cost on queries that did not need it (the
"retrieve only when it helps" line of RAG-gating work), here made deterministic via the graph rather
than learned. The defensible combination is the two together: pre-fetch the task-scoped orientation
into the first turn, *but only when a deterministic graph signal says it will pay* — which is exactly
the two-tier boundary the OpenLore scorecard already measured.

## Application to OpenLore

- **The hook surface** reuses the marker-identified, idempotent group pattern already implemented for
  `SessionStart` in `src/cli/install/adapters/claude-code.ts` (`isOurSessionEntry` /
  `mergeSessionStart` / `stripOurSessionStart`); `UserPromptSubmit` is wired the same way, and the
  per-adapter equivalent (Cursor/Cline/Continue/AGENTS.md) follows each adapter's first-prompt
  mechanism or degrades to the instruction block where no such hook exists.
- **The injected content** reuses `handleOrient` (`src/core/services/mcp-handlers/orient.ts`) via
  `orient --lean` (Spec 27), so there is no second orientation code path to maintain.
- **The relevance signal** reuses fields the orient result already carries (matched-function count,
  fan-in, match score) plus graph size already known to the EdgeStore — no new analysis pass.
- **The posture** reuses the Epistemic Lease facts-not-coercion framing (decision `8e95746d`) and the
  install merge-not-clobber contract (decision `df27e8ef`).

## Relationship to the sibling changes

This change removes the per-task orient *round-trip* (a whole turn). `default-to-lean-tool-surface`
removes the per-session tool-schema *bytes*. `add-prove-shareable-scorecard` lets a user *measure*
the combined effect on their own repo. The three are independently shippable; together they target
every component the scorecard attributes the loss case to. This one is the largest single lever.

## Out of scope

- **Multi-turn / mid-session re-injection.** This injects at task start (first prompt). Continuous
  re-orientation as a session evolves is the Epistemic Lease's job and is not duplicated here.
- **Learned prediction of when to orient.** The relevance gate is a deterministic threshold on
  graph-derived signals, never a model. Tuning the threshold is allowed; learning it is out of scope.
- **Harnesses without any pre-turn hook.** Where an adapter exposes no first-prompt hook, this falls
  back to the existing instruction block; building a new injection channel for such a harness is out
  of scope.
- **Changing `orient`'s ranking or output schema.** `--inject` is a presentation+gating wrapper over
  existing `orient --lean` output; the orientation algorithm itself is untouched.
