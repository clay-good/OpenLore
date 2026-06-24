# Parallel work plan: one conclusion tool that turns N task descriptors into a hazard-typed conflict graph, a wave schedule, and a critical path

> Status: SHIPPED (2026-06-24) on branch `feat/parallel-work-plan` (stacked on
> `feat/change-footprint-projection`, PR #199). Part of the `PARALLEL-WORK-COORDINATION.md` set
> (proposal 2). Adds a single opt-in MCP tool, `plan_parallel_work`, that composes the footprint +
> hazard classifier (proposal 1) into the artifact a swarm orchestrator needs: which tasks are safe
> to run at once, which must be ordered, and the minimum wall-clock even with infinite agents.
> Stateless, advisory, conclusion-over-graph.
>
> Implementation: `src/core/services/mcp-handlers/plan-parallel-work.ts` (+ co-located test). Registered
> in the new opt-in `coordination` preset only. Dogfood: `DOGFOOD-parallel-work-plan.md`.

## Why

An orchestrator running many agents — or a developer about to fan work out across worktrees — faces
exactly one decision OpenLore can answer and nothing else in the stack can: **of these proposed
tasks, which subset is safe to edit concurrently?** Worktrees and branch isolation are the
*mechanism* for running agents in parallel, but they surface conflicts only at merge, after the
expensive part (the LLM tokens) is already spent. The cheap, high-leverage moment to detect
interference is *before dispatch*, and at that moment there is no diff to compare — only structure.
OpenLore has the structure.

Proposal 1 gives the primitives (footprint, hazard classifier). This proposal composes them into the
one conclusion an agent should ask for: a **plan**. It is the borrow checker's verdict, rendered for a
swarm — not a graph to traverse, but the schedule itself.

## What changes

1. **A new opt-in conclusion tool `plan_parallel_work`.** Input: a directory and a list of task
   descriptors `[{ id, seedSymbols?, seedFiles?, intent?, writeMode? }]` (the agent supplies the task
   list and declares which seeds are `append`-mode registration touches; OpenLore does not invent
   either). Output is the computed plan, not a graph dump:
   - the **footprint** of each task (write/read/affected/coupling), from proposal 1;
   - the **conflict graph** — for every task pair, the hazard verdict (WAW / shared-append / RAW / WAR
     / soft) with witnessing symbols and, for RAW, direction;
   - the **wave schedule** — an ordered list of waves, where each wave is a maximal set of tasks with
     no WAW conflict among them and all RAW predecessors already in earlier waves (shared-append, WAR,
     and soft-coupling do not split a wave; they ride along as advisories). Wave 1 is "safe to dispatch
     now to N agents"; later waves name the specific predecessors they wait on;
   - the **critical path** — the longest chain of RAW-ordered tasks, i.e. the minimum number of
     sequential rounds even with unlimited agents, with a one-line read ("this milestone is at most K
     rounds deep; beyond M concurrent agents buys nothing");
   - **advisories** — soft-coupling pairs and WAR/low-risk same-file pairs surfaced as warnings, plus
     the standing known-unknowable disclosure that footprints are predicted and integration tests
     remain ground truth.

2. **Stateless `render(state)` contract.** The tool holds no state between calls. To re-plan after a
   wave completes, the caller re-invokes with the remaining tasks (and, optionally, the *actual*
   footprints of completed tasks from proposal 3's escape check); OpenLore renders a fresh plan. There
   is no lease, no "release," no memory of which agent took which task. State lives in the harness.

3. **Scheduling is correct-and-greedy, not optimal.** Waves are computed by greedy maximal independent
   set over the WAW conflict graph, constrained by the RAW topological order; the critical path is the
   longest RAW chain. This is deterministic and sufficient. The tool does not solve for a globally
   optimal makespan, does not weight tasks by business value, and says so.

4. **Advisory by default; gating is opt-in.** The plan never blocks anything on its own. A repo MAY,
   via the existing `enforcement.policy` seam (`add-finding-enforcement-policy`), opt a specific
   finding (e.g. "a dispatched wave contains an unresolved WAW") into blocking in its own CI — but the
   default is pure advice, consistent with every other OpenLore conclusion.

5. **Tool-surface discipline.** `plan_parallel_work` lands in a new opt-in `coordination` preset (or
   is folded into an existing breadth preset at implementation time), never in `MINIMAL_TOOLS` or the
   lean first-run default. It is classified `conclusion` in `tool-contract.ts` (it returns the
   schedule, not a node-and-edge graph), which the contract test enforces.

## Decision

**One conclusion tool returning a wave schedule + critical path, computed by greedy independent-set
over a hazard-typed conflict graph; stateless and advisory.** We return the *answer* (the schedule),
not the conflict graph for the agent to color by hand — multi-hop reasoning inside the model degrades,
and graph coloring is exactly the kind of deterministic computation that belongs server-side. We do
not build a stateful planner that remembers waves or holds task assignments; the tool is a pure
function re-invoked each round. We choose greedy + topological over optimal scheduling because it is
deterministic, explainable, and sufficient, and because optimality would invite value-weighting and
other non-structural judgment calls that are out of substrate scope.

## Worked example (the validation that shaped this proposal)

Hand-computing a plan for **this coordination set's own four proposals** against real repository data
exposed the failure mode the `shared-append` class now prevents. Each later proposal adds an MCP tool
or finding, so all three write the single `TOOL_DEFINITIONS` const array, and two also write the
62-branch `dispatchTool` if-chain — all *appends*:

| Tasks | Naive (all writes = WAW) | With `writeMode: append` → shared-append |
|-------|--------------------------|------------------------------------------|
| T1 footprint (foundation) | wave 1 | wave 1 |
| T2 plan tool, T3 escape, T4 cross-actor | waves 2, 3, 4 (fully serialized on the registry symbols) | **wave 2, in parallel** (RAW-ordered after T1 only) |
| **Critical path** | **4 rounds** | **2 rounds** |

The naive plan reports zero useful parallelism; the append-aware plan recovers the real shape — a
foundation wave then a parallel wave — which is exactly this set's recommended build order, derived
mechanically. Two usage notes fall out and belong in the docs:

- **Declare `append` for registration touches.** A task that adds a tool should mark its
  `dispatchTool` / `TOOL_DEFINITIONS` / preset seeds `append`; otherwise the conservative `modify`
  default will (correctly, but unhelpfully) serialize it.
- **Scope wire-up as its own small task** when possible, so the unavoidable registration contention is
  isolated to something cheap and the substantive work stays parallel.

## Scope contract — do not break these things

This change must NOT:
- Hold state across calls, issue or track a lease, assign a task to a named agent, or tell an agent to
  wait. The tool is `render(state)`; the harness owns state and dispatch.
- Invent the task list, decompose a spec into tasks, or expand a task's write-set beyond its declared
  seeds (that is proposal 1's contract, inherited here).
- Return a node-and-edge graph as the primary payload. The primary payload is the schedule
  (waves + critical path); the conflict graph is included as supporting evidence with witnesses, not
  as a structure to traverse.
- Block any operation by default. Gating is opt-in via `enforcement.policy` only.
- Land in `MINIMAL_TOOLS` or the lean first-run default. Opt-in preset only.
- Claim the schedule guarantees conflict-free parallelism. Every plan carries the disclosure that
  footprints are predicted and integration tests remain ground truth.

## Out of scope (deferred)

Optimal / value-weighted scheduling; a learned conflict-probability model (the conflict graph stays
deterministic set-intersection, per the set's determinism constraint); persisting plans or diffing one
plan against the next across calls (the harness can do this from two stateless renders); the
cross-actor (open-PR / cross-repo) conflict graph (proposal 4); and any dispatch, worktree, or
lock mechanism (the whole set's central non-goal).

## Implementation status

Tracked in `tasks.md`. Verified by: three disjoint tasks plan into one wave; two tasks sharing a
written symbol plan into separate waves (WAW); a task that reads a symbol another writes is ordered
after it (RAW) and the critical path reflects the chain; same-file-disjoint-symbol tasks stay in one
wave with a low-risk advisory; soft-coupling pairs are surfaced as advisories without serializing; the
output is classified `conclusion` and passes `tool-contract.test.ts`; the tool appears only in the
opt-in preset; re-invoking with a subset re-plans deterministically; and the plan carries the
ground-truth disclosure.
