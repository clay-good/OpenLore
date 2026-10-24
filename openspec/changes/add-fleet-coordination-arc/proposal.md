# Fleet coordination arc: shared verification memory that survives a moving base

> Status: PROPOSED (2026-10-24, roadmap direction ADR-0035). Completes the multi-agent coordination
> arc — `plan_parallel_work` (dispatch) → `map_in_flight_conflicts` (in flight) →
> `certify_merge` (landing, see `add-merge-semantic-certificate`) — by adding the one piece the arc
> is missing: a drift-aware shared verification memory so parallel agents do not re-verify what is
> still valid and never trust a verification the base has invalidated. Trend evidence: one worktree
> per agent is the dominant 2026 fleet pattern, merge resolution is still manual, and recent work
> ("artifact-anchored verification memory for coding agents under upstream drift") converges on
> exactly this primitive — which OpenLore already has the parts for (anchored memory + freshness
> lease + symbol-identity continuity)
> (https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace,
> https://arxiv.org/pdf/2608.04278).

## The gap

OpenLore's coordination conclusions cover three of the four phases of a parallel-agent run: who may
write what (`plan_parallel_work`), what collides right now (`map_in_flight_conflicts`), and — with
`add-merge-semantic-certificate` — what breaks at landing even when git merges cleanly. The phase
with no coverage is **continuity across a moving base**. When five agents each work in their own
worktree off `main`, and `main` advances under them, every verified fact they hold — "this blast
radius is clean", "this surface is stable", "this merge was certified compatible" — silently
becomes suspect, and nothing tells them *which* facts are still valid and which the drift killed.
Today each agent either re-verifies everything every turn (wasteful and slow) or trusts stale
verifications (unsafe). OpenLore already has the primitives to decide this per fact — anchored
memory, the freshness lease, and symbol-identity continuity — but there is no coordination-scoped
verification memory that records a verdict against the base it was proven on and re-points or
invalidates it when the base moves.

## What changes

A coordination-scoped verification memory + a composing `fleet_status` conclusion (opt-in
`coordination` preset) + `openlore fleet-status [--json]` CLI:

- **Record a verdict with its base**: a coordination verdict (a clean `blast_radius`, a stable
  `certify_public_surface`, a passed `certify_merge`) is recorded as an anchored fact carrying the
  exact base commit and the symbols it was proven over — not a free-text note, a typed verification
  record.
- **Re-point or invalidate on drift, deterministically**: when the base advances, the freshness
  lease plus symbol-identity continuity decide each record's fate — `still-valid` (nothing it
  depended on changed), `carried` (its symbols moved but are unchanged), or `invalidated` (a
  dependency changed), each with the invalidating commit as the receipt. No verdict is ever served
  as fresh once its base moved under it without this check.
- **`fleet_status` umbrella**: one conclusion that composes the arc for a set of in-flight branches
  — the dispatch plan, the current conflict map, the landing certificates, and which recorded
  verdicts are still valid — into a single readiness view, each line attributed to the phase and
  tool that produced it (`NoRedundantConclusions`: it references, never re-derives, its components).
- **Honest boundaries**: unindexed languages, dynamic-dispatch edges, and diff-fetch failures are
  disclosed as not-assessed; a verdict whose anchor was lost is `needs-reverification`, never
  silently dropped or silently trusted.

Deliberately NOT borrowed: the orchestrator itself — dispatching agents, ordering the merge queue,
and landing branches stay with the forge or the fleet tool. OpenLore provides the shared, drift-
aware verification memory and the readiness view they consult; it does not run the fleet.

## Why this is in scope

It is built entirely on shipped primitives — the anchored-memory store, the freshness lease, and
symbol-identity continuity — plus the existing coordination conclusions, composed; no LLM, local,
conclusion-shaped. It closes the one coordination phase the substrate does not cover and depends on
`add-merge-semantic-certificate` for the landing verdict it records (each cross-references the
other). It turns three independent coordination tools into a continuous arc that holds up while the
base moves — the exact failure the fleet era hits and the research is only now naming.

## Impact

- New: a typed coordination verification record (anchored fact carrying base + proven symbols) with
  deterministic drift re-pointing/invalidation; a `fleet_status` composing conclusion + `openlore
  fleet-status` CLI. Registered in `TOOL_CAPABILITY_FAMILY` (`coordinate`), classified `conclusion`,
  cross-referencing `plan_parallel_work`, `map_in_flight_conflicts`, and `certify_merge`;
  tools/list payload budget re-asserted or bumped.
- Specs: `mcp-handlers` — 1 ADDED requirement.
- Depends on: `add-merge-semantic-certificate` (the landing verdict this records).
- Risk: verification records drifting into unbounded store growth (mitigated: coordination-scoped,
  keyed to in-flight branches, expired when a branch lands or closes); a wrong `still-valid`
  (mitigated: the lease + continuity are the same machinery recall already trusts, and the
  conservative outcome is `needs-reverification`, never a silent fresh).
