# Change set: structural coordination for parallel agents and teams

> Status: DRAFT (2026-06-24). Four independent change proposals that give OpenLore one new
> capability family: telling many agents (and many humans) **which work is safe to run at once**,
> computed deterministically from the call graph + specs + git history. No runtime, no lock service,
> no learned model. This file is the umbrella; each proposal directory is independently shippable.

## The motivating observation

The 2026 multi-agent coding stack — Conductor, Vibe Kanban, Claude Squad, Agent Teams, the whole
worktree-per-agent pattern — has converged on a *mechanism* for running many agents at once (branch
isolation, git worktrees, a shared task list). What none of it can answer is the *policy* question
that decides whether parallelism actually pays off: **given these N proposed tasks, which subset is
safe to edit concurrently, and which must be ordered?** Worktrees isolate during editing, but
conflicts only surface at *merge* — after the tokens are already spent. When the worker is an
expensive LLM rather than a human who context-switches cheaply, a task thrown away at merge is pure
loss. The highest-leverage moment to detect interference is therefore *before dispatch*, and that is
exactly the moment a textual tool cannot help, because no diff exists yet.

OpenLore already holds every primitive needed to answer the policy question deterministically: the
call graph (who depends on whom), `blast_radius` / `analyze_impact` (transitive reach of a change),
`get_change_coupling` (what historically changes together), community detection (`get_map`, the
min-cut partition of the graph), `structural_diff` (what a diff actually touched), and multi-repo
federation with stable cross-repo symbol IDs. The gap is that none of these is composed into the one
artifact a swarm orchestrator or a team lead needs: a **hazard-typed conflict graph over a set of
proposed changes**, plus the wave schedule and critical path that fall out of it.

## The frame: a borrow checker for the repository, not a lock

The unifying model for this set is **a borrow checker lifted from variables to repository regions.**
Every task declares (or OpenLore predicts) the region it will *mutate* — its write-footprint — plus
the region it *reads*. The coordination question is then exactly the borrow rule: no two
concurrently-running tasks may hold overlapping **mutable** borrows of the same region; read-sharing
is fine; write-sharing is the conflict.

This frame is load-bearing because it makes both the value and the honest limit precise:

- **The value is static analysis** — OpenLore's identity. The regions are blast radii; the
  dependencies are call edges; the conflict rule is set intersection. All deterministic, all local.
- **The limit is that OpenLore cannot *enforce* the borrow.** Rust's borrow checker is sound only
  because the compiler rejects code that violates a declared borrow. OpenLore analyzes; it cannot
  reject an agent's write. So OpenLore is a borrow checker that *advises* — it computes the plan and
  detects when an actual diff escaped its declared footprint, but the *enforcement* (refuse a diff
  that writes outside scope; refuse to dispatch a conflicting task) lives in the harness, CI, or git,
  never in OpenLore. This is the same seam OpenLore already respects everywhere: it computes
  conclusions; the agent or the gate acts on them.

## Policy versus mechanism — the line that keeps this in-substrate

This set deliberately builds only the **read side**. It is worth stating the line sharply, because
the obvious over-reach ("a state lock so each agent owns a region until it releases it") would turn
OpenLore into a stateful runtime service with a clock, a memory of who holds what, lease expiry,
liveness handling for dead agents, and fencing for stale writers — Kleppmann-grade distributed
systems, and a direct contradiction of the north star (decision `c6d1ad07`: *local-first plumbing
like tree-sitter/SCIP/LSP, stateless, grounded in static analysis*). It would also issue **unsound**
guarantees, because a lock derived from a *predicted* write-set gives false confidence exactly when
it matters.

The test that keeps every proposal here on the right side of the line:

> Does the feature require OpenLore to *remember or arbitrate across time*, or only to *compute given
> inputs*? Compute is in-substrate. Remember / arbitrate / hold a lease is a different product.

The conflict graph, the waves, the critical path, the escape check, the cross-actor map are all
**pure functions of the inputs**. State (which tasks are done, which diffs landed, who holds a
worktree) is held by the harness, which re-invokes OpenLore each round and gets a freshly rendered
plan — the same `render(state)` discipline as `change_impact_certificate`'s freshness lease. OpenLore
never grows a coordinator.

## The hazard model: "conflict" is three things, not one

"Two tasks touch the same file" is the textual tools' definition and it is too crude — it serializes
work that is actually independent. Because OpenLore has the call graph, this set classifies the
hazard the way CPU pipeline design does, which is what turns a flat conflict graph into a real
schedule:

| Hazard | Definition (over footprints) | Consequence in the plan |
|--------|------------------------------|-------------------------|
| **WAW** | `write(A) ∩ write(B) ≠ ∅`, at least one side in `modify` mode | True conflict → mutual exclusion (different waves) |
| **shared-append** | `write(A) ∩ write(B) ≠ ∅` but **both** sides touch the shared symbol in `append` mode | Low risk → may parallelize, advisory (see "registration hot-spots" below) |
| **RAW** | `write(A) ∩ read(B) ≠ ∅`, excluding ambient symbols | Ordering dependency → B after A (topological edge), not exclusion |
| **WAR / disjoint-region-same-file** | overlap only in read sets, or same file but disjoint symbols | Low risk → may parallelize, flagged |
| **Soft (coupling)** | files historically co-change above threshold, no static edge | Advisory warning → surface, do not hard-serialize |

Splitting "must-exclude" from "must-order" from "low-risk" is the single move that lets the planner
emit independent-set *waves* with a topological backbone, and that lets it compute a **critical
path** — the minimum wall-clock even with infinite agents (Amdahl's Law / Brooks's Law made
computable from structure).

### Registration hot-spots: the refinement the pressure test forced

A naive symbol-level WAW rule collapses *all* parallelism on a realistic codebase, because real
repos concentrate independent work at a few **registration sites** — a dispatcher (`dispatchTool` is
one 62-branch `if`-chain), an exported tool/registry array (`TOOL_DEFINITIONS` is a single `const`),
a preset list, a finding-code registry. Every new-tool task *writes the same symbol* there, yet those
edits are pure *appends* that git 3-way-merges trivially. Treating them as hard WAW serializes the
whole swarm (the validation below shows this set's four proposals collapsing from 2 waves to 4).

The fix is caller-declared, not inferred: a task seed MAY carry `writeMode: 'append' | 'modify'`
(default `modify`, the conservative assumption). A write-write overlap where **both** sides declare
`append` is classified **shared-append** — a low-risk advisory, not mutual exclusion. The agent knows
it is adding a case to a switch, not rewriting it, so it declares so; OpenLore still never guesses.
Proposal 3 closes the loop on the back-side: it confirms from the *actual* diffs whether two
append edits really landed disjointly (resolved-by-merge) or actually overlapped.

### Ambient symbols: stop-words for the dependency graph

A symbol everyone depends on — `logger` (imported by 97 files), `validateDirectory` (fan-in 64),
the call-graph primitives (imported by 121) — appears in nearly every task's read-set. Left
unchecked it makes any task that touches it RAW-upstream of the entire swarm, and it bloats every
read-set toward the whole graph. These **ambient symbols** (fan-in above a configurable percentile)
are excluded from generating RAW ordering edges and are capped out of the read-set — the
dependency-graph equivalent of IR stop-words. The call-distance bound on the read-set is therefore
load-bearing, not cosmetic.

## Research basis

The proactive-conflict half of this set descends directly from the collaboration-conflict
literature — Palantír (workspace awareness of overlapping in-progress changes), Crystal and WeCode
(speculative merge-build-test to find interfering changes early) — but with two upgrades those
systems never had: a **structural/semantic** signal (call-graph reachability) instead of textual
diff overlap, and **no speculative build** (Crystal's scaling killer was merging-and-building every
pair in the background; this set replaces it with a static footprint intersection that is orders of
magnitude cheaper). The scheduling half is the action-graph idea from build systems (Bazel/Buck
compute a dependency DAG and expose which actions are independent; they do not ship the executor) —
applied to agent tasks.

- L. Hattori & M. Lanza et al., *Proactive detection of collaboration conflicts* (Palantír lineage).
- C. Bird et al. / Kasi & Sarma, *Predicting merge conflicts* (speculative-merge: Crystal, WeCode).
- The hazard taxonomy (RAW/WAR/WAW) is the classical data-hazard model from pipelined-CPU design.

One deliberate non-borrow, exactly as the navigation set did with learned landmarks: the literature
increasingly *learns* a conflict-probability model from merge history. We do **not** serve a learned
model. The conflict graph and every feature it is built on stay 100% deterministic. A learned
*threshold calibration* trained on the repo's own merge outcomes is named in "Out of scope" below as
a future, clearly-fenced follow-up — never on the served path.

## The proposals

| # | Change | What it adds | Primary domain | Depends on (makes better, does not block) |
|---|--------|--------------|----------------|-------------------------------------------|
| 1 | `add-change-footprint-projection` **(SHIPPED — `feat/change-footprint-projection`)** | The borrow-analysis core: a deterministic per-task **footprint** (write-set / read-set / affected-set) and a **hazard classifier** over a pair of footprints. No new tool. | analyzer | — (foundation; reuses `blast_radius` / `analyze_impact` / `get_change_coupling`) |
| 2 | `add-parallel-work-plan` **(SHIPPED — `feat/parallel-work-plan`)** | One conclusion tool `plan_parallel_work`: takes N task descriptors, returns the hazard-typed conflict graph, the wave schedule, the critical path, and each task's footprint. | mcp-handlers | 1 |
| 3 | `add-footprint-escape-detection` **(SHIPPED — `feat/footprint-escape-detection`)** | The back-side safety net: extend `structural_diff` to flag symbols an actual diff modified **outside** its declared write-footprint, and recompute newly-opened conflicts with peer tasks. | mcp-handlers | 1 |
| 4 | `add-cross-actor-interference-map` **(SHIPPED — `feat/cross-actor-interference-map`; sibling tool `map_in_flight_conflicts`)** | The team wedge: treat open PRs / branches **and** in-flight agent task footprints as one conflict graph across the federation — "your task collides with PR #210's blast radius." | mcp-handlers | 1, 2 |

Recommended build order is 1 → 2 → 3 → 4, but each ships on its own. Ship 1 and 2 first; they are the
whole single-machine swarm story. 3 closes the soundness gap. 4 is the multi-human, multi-repo
payoff and is the most differentiated against the field.

## Design constraints inherited by every proposal in this set

- **Stateless and advisory.** No proposal adds a lock, a lease OpenLore holds, a coordinator, a
  queue, or any cross-invocation memory of agent/worktree state. Every output is a pure function of
  (graph state, task descriptors, git state) at call time. Enforcement and dispatch live in the
  harness / CI / git, never here. Outputs never *block* by default; a configured surface MAY opt into
  gating, consistent with `add-finding-enforcement-policy`.
- **Conclusion over graph** (`mcp-quality`). The planner returns the *schedule* (waves, ordering
  edges, critical path) — the computed answer — not a node-and-edge dump for the agent to BFS. New
  tools are classified in `tool-contract.ts` and fail the contract test until classified.
- **Determinism is a hard constraint.** No learned, statistical, or predictive model on the served
  path. Re-evaluation against a fixed (graph state, task set, git state) is byte-identical. The
  conflict graph is set intersection over deterministic footprints.
- **Honesty over coverage; the soundness limit is disclosed, not hidden.** Predicted footprints are
  *advisory* — an agent can edit outside them, and two tasks with no static or co-change edge can
  still share a latent invariant. The planner therefore claims "reduces conflict probability / shifts
  detection left," never "guarantees safe parallelism," and every output that asserts independence
  carries the known-unknowable disclosure that integration tests remain the ground truth
  (`confidence-boundary`). A footprint seeded below its evidence threshold returns "no signal," not a
  guess.
- **OpenLore schedules; the agent generates the work.** Turning "what needs doing" into atomic,
  well-bounded tasks is a planning step that is partly LLM-shaped and therefore out of substrate
  scope. The agent (or a human) supplies the task descriptors — an id, seed symbols/files, optional
  intent text; OpenLore only *scores, classifies, and schedules* them deterministically. Task
  *generation* never enters core.
- **Tool-surface discipline.** This set adds exactly **one** new MCP tool (`plan_parallel_work`) plus
  one extension to an existing tool (`structural_diff`) and one extension under federation
  (the cross-actor map MAY ride `plan_parallel_work` or land as a sibling — see proposal 4). New
  tools default opt-in: they land in a named preset (a new `coordination` preset, or `federation`
  for the cross-actor map), never in `MINIMAL_TOOLS` or the lean first-run default
  (`default-to-lean-tool-surface`).
- **Additive, no schema break.** Footprints and hazard metadata reuse existing `FunctionNode` /
  `CallEdge` primitives and existing edge-metadata conventions; no graph-schema change. New tool
  fields are optional; artifacts written before a change load without migration.

## Out of scope for the whole set (explicitly considered, deliberately excluded)

- **Any stateful lock, lease OpenLore holds, or coordinator/dispatcher.** This is the central
  non-goal. OpenLore computes plans; it never owns mutual exclusion, assigns a task to an agent,
  tells an agent to wait, or tracks who holds a worktree. Point users at git worktrees + their
  harness's Agent-Teams primitives for mechanism.
- **A learned conflict-probability model on the served path.** Excluded by the determinism
  constraint. A future, clearly-fenced follow-up MAY *calibrate the conflict threshold* offline from
  the repo's own merge history (did predicted-independent tasks actually merge clean?) — but the
  served conflict graph and its features stay deterministic; only a scalar threshold could ever be
  tuned, never the answer itself.
- **Soundness for semantic / latent-invariant conflicts.** Static analysis cannot see two tasks that
  share no call edge and no co-change history yet both depend on one unwritten invariant. The set
  reduces conflict probability and shifts detection left; it does not eliminate conflict. Integration
  tests remain ground truth and the docs say so plainly.
- **Task generation / decomposition.** OpenLore does not invent the task list from specs; it
  schedules a list the agent supplies. (Enumerating *candidate* work from `check_spec_drift`,
  `audit_spec_coverage`, `find_dead_code` is already possible with existing tools and is left to the
  agent to assemble into descriptors.)
- **Optimal scheduling.** The planner emits a correct, greedy wave schedule (maximal independent set
  honoring ordering edges) and a critical-path estimate; it does not solve for a globally optimal
  makespan or weight tasks by value. Greedy + topological is sufficient and deterministic.

## Validation: this set, run through its own planner (2026-06-24)

Before specifying code, we pressure-tested the design by hand-computing a plan for **the four
proposals in this set, treated as tasks**, using real graph data from this repository
(`analyze_impact` on `dispatchTool`; the on-disk shapes of `dispatchTool` and `TOOL_DEFINITIONS`;
the fan-in figures from `CODEBASE.md`). The exercise changed the design in four concrete ways, all
folded into the proposals below:

- **Registration hot-spots collapsed all parallelism (→ added `shared-append`).** T2 (`plan_parallel_work`),
  T3 (escape detection), and T4 (cross-actor map) all write the single `TOOL_DEFINITIONS` const; T2
  and T4 also both write the `dispatchTool` if-chain. Naive symbol-level WAW made them mutually
  exclusive, serializing the set to **four waves** — zero parallelism, the exact granularity failure
  predicted in the brainstorm. The `writeMode: append` declaration + `shared-append` class downgrades
  these to advisories, recovering **two waves**.
- **The critical path was already correct (→ kept, validated).** T2/T3/T4 each *read* T1's footprint
  module, so RAW correctly orders them after the foundation: `[T1] → [T2, T3, T4]`. The planner
  independently reproduced this set's recommended build order, which is the core value working.
- **Read-sets exploded through ambient hubs (→ added ambient-symbol exclusion).** T1's read-set runs
  through `call-graph.ts` (imported by 121), `logger` (97), `validateDirectory` (64). Without
  stop-word exclusion these would make any infra-touching task RAW-upstream of the entire swarm.
- **`affected-set` was computed but never used in classification (→ demoted to informational).** The
  hazard rules use only write/read sets; `affected-set` is retained as human-facing output, not a
  hazard input.

The exercise also surfaced a genuine design lever (proposal 4): if the cross-actor map *rides*
`plan_parallel_work` it RAW-depends on T2 (critical path 3); as an independent sibling it does not
(critical path 2). The planner makes that architecture choice visible — which is the tool doing its
job. **Usage guidance that follows:** scope the wire-up/registration step of a task as its *own* small
task so the unavoidable hot-spot serialization is isolated to something cheap, leaving the substantive
work parallel.

At implementation time, call `record_decision` before writing code for any proposal that introduces a
new tool, data structure, scoring rule, or on-disk format (per project `CLAUDE.md`). These spec files
themselves introduce no code and record no decision yet.
