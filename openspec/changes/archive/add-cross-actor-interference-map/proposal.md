# Cross-actor interference map: one conflict graph over open PRs, branches, and in-flight agent tasks — within and across federated repos

> Status: SHIPPED (2026-06-24). Part of the `PARALLEL-WORK-COORDINATION.md` set (proposal 4, the team
> wedge). Generalizes the conflict graph from "N agent tasks I'm about to dispatch" to "every change
> in flight right now — human PRs, branches, and agent tasks alike — across the federation." This is
> the proactive-merge-conflict capability, made structural and cross-actor. Opt-in (`federation` +
> `coordination` presets). Stateless, advisory. Surface: new conclusion tool `map_in_flight_conflicts`
> (`src/core/services/mcp-handlers/interference-map.ts`). Dogfooded on this repo's branches + PRs.
> See `tasks.md` for the shipped checklist.

## Why

The single-machine swarm story (proposals 1–3) treats the in-flight work as a list the caller hands
over. But the highest-value version of this question is the one a *team* faces: many humans and many
agents, each on their own branch or PR, editing one shared codebase — often one *federation* of repos.
The conflict that costs a team a day is not "two of my agents collided," it is "my agent spent an hour
rewriting `resolveCallSite`, and so did Jane's open PR #210, and we find out at merge." Worktrees and
branch isolation cannot prevent this; they *cause* it, by design, then surface it late.

OpenLore is uniquely positioned to answer it before the cost is paid, because it already has the two
hard pieces nobody else composes: the **structural footprint** of a change (proposal 1, computable
from a branch's diff or a PR's changed files), and **federation** with stable cross-repo symbol IDs
and cross-repo reachability. Put them together and you get a conflict graph whose nodes are *actors'
changes* — human or agent, local branch or remote PR, this repo or a sibling repo — and whose edges
are the same hazard-typed verdicts the planner already speaks. This is Palantír's workspace-awareness
idea (warn about overlapping in-progress changes) rebuilt on a structural signal instead of textual
diff overlap, and without Crystal's speculative merge-and-build of every pair.

## What changes

1. **Footprints from in-flight changes, not just descriptors.** Derive a footprint (proposal 1) for
   each in-flight change from its *actual changed symbols*: a local branch's diff against its base, and
   — where a remote is configured — open PRs' changed files via the existing git/`gh` integration the
   PR-review surface already uses. Each becomes an actor-attributed node: `{ actor, ref (branch/PR#),
   repo, footprint }`. Agent tasks (proposal 2 descriptors) join the same graph as first-class nodes,
   so humans and agents are compared uniformly.

2. **One cross-actor conflict graph, federation-wide.** Run the pairwise hazard classifier across all
   in-flight nodes, using federation's stable cross-repo symbol resolution so a branch in repo A
   conflicts with a PR in repo B when their footprints intersect across the boundary. The output is a
   conclusion: per actor/change, the list of other in-flight changes it conflicts with, the hazard
   class, the witnessing symbols, and a suggested sequencing ("land #210 first; it shares
   `resolveCallSite`'s write-set"). Two refinements from the set's validation carry over directly:
   **ambient symbols** (ubiquitous infrastructure) are excluded from ordering edges so a shared
   `logger` touch does not flag every PR against every other; and because this map works from *actual*
   diffs rather than declared seeds, it applies **registry-collision resolution** itself — two PRs that
   each append a disjoint entry to the same registry/dispatcher are resolved-by-merge, not reported as a
   conflict (the `writeMode` declaration is unnecessary here; the diffs are observable).

3. **Read-only, stateless, no new graph.** The map is a pure function of current git state + the
   indexed graphs at call time; re-invoke to refresh. It introduces no new node/edge schema (footprints
   ride existing primitives), no persisted conflict store, and no watching/polling — it answers when
   asked. It reuses `spec_store_status`/federation health to know which targets are resolvable, and
   degrades to single-repo when no federation is configured.

4. **Honest about what it can see.** A PR whose diff is not locally fetchable, a target repo whose
   index is stale, or a change with no resolvable symbols yields a clearly-labeled "not assessed" entry
   rather than a false "no conflict." The standing disclosure applies: structural overlap predicts
   conflict probability, not certainty; semantically-coupled changes with no shared symbols are invisible;
   merge/integration remains ground truth.

5. **Surface shape — tool or extension, decided at implementation.** Either a sibling conclusion tool
   (`map_in_flight_conflicts`) or an opt-in mode of `plan_parallel_work` that, instead of caller-supplied
   descriptors, harvests in-flight changes. Either way it lands in the `federation` preset, never in the
   lean default, and is classified `conclusion`. Advisory by default; opt-in gating via
   `enforcement.policy` (e.g. a CI check that warns when a new PR's footprint collides with an open one).

## Decision

**Build the cross-actor conflict graph by deriving footprints from in-flight git changes (branches +
open PRs + agent task descriptors) and classifying hazards across the federation — read-only and
stateless.** We reuse the PR-review surface's existing git/`gh` access to enumerate in-flight changes
and federation's stable IDs for cross-repo matching; we do not add a watcher, a persisted conflict
store, or any polling. Human PRs and agent tasks are the *same kind of node*, because the whole point
is that they interfere with each other. The map answers on demand; the team's tooling (or a CI check)
decides what to do with the answer.

## Scope contract — do not break these things

This change must NOT:
- Watch, poll, or hold a background process. The map is computed on demand from current git + index
  state.
- Persist a conflict store or remember in-flight changes across calls. Stateless `render(state)`.
- Add a new node/edge schema. Footprints ride existing primitives; federation provides cross-repo IDs.
- Report "no conflict" for a change it could not actually assess. Unfetchable PRs, stale target
  indexes, and unresolvable symbols are labeled "not assessed," distinctly from "no conflict."
- Block a merge or PR by default. Advisory; gating is opt-in via `enforcement.policy`.
- Require a federation. With none configured it degrades to single-repo (branches + local PRs).
- Land in `MINIMAL_TOOLS` or the lean first-run default. `federation` preset only.

## Out of scope (deferred)

A background watcher that pushes conflict alerts (this set is pull-only); writing PR comments directly
(the existing PR-review surface composes the briefing — this provides the cross-actor finding it can
include); semantic/latent-invariant conflict detection (out of static reach); a learned conflict model;
and auto-sequencing/auto-rebasing of branches (the map *suggests* an order; humans and their CI act).

## Implementation status

Tracked in `tasks.md`. Verified by: two local branches whose diffs share a written symbol report a WAW
between their actors; an agent task descriptor and a branch sharing a symbol report a cross-actor WAW;
a federated fixture where a branch in repo A and a PR in repo B share a cross-repo symbol report a
cross-repo conflict; a PR whose diff cannot be fetched is labeled "not assessed," not "no conflict"; no
federation configured degrades cleanly to single-repo; the tool is `conclusion`, in the `federation`
preset, advisory by default; and the result is deterministic for a fixed git + index state and carries
the ground-truth disclosure.
