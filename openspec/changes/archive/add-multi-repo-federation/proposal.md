# Multi-repo federation: a deterministic index-of-indexes for repository fleets

> Status: IMPLEMENTED — groups 1–3 + 5 shipped on branch `feat/multi-repo-federation`; group 4
> (fleet-level anchored memory) shipped in PR #168 once its prerequisite landed. Registry + CLI
> (`openlore federation add|remove|list`), cross-repo resolution via stable-ID name descriptors,
> federation scope on `analyze_impact` / `find_dead_code` / `select_tests` / `find_path`, the opt-in
> `federation` preset + `federation_status` tool. Group 4 (fleet-level anchored memory) is DONE
> (PR #168, ADR-0019): its prerequisite bitemporal memory (`add-bitemporal-typed-memory-operations`,
> PR #163) is now in `main`, so the requirement was re-homed into the canonical `mcp-handlers` spec —
> a producer-repo memory OR decision anchored to a consumed interface surfaces in a consumer's
> `recall.fleetMemory` with its producer-side verdict (`src/core/federation/fleet-memory.ts`).
> Decisions: `bf5aff2d` (registry schema), `67ca60fe` (cross-repo resolution contract).
> Phase-2 set (build after the five memory + dispatch changes):
> `add-multi-repo-federation` · `add-confidence-boundary-disclosure` ·
> `add-structural-claim-verification` · `add-preflight-blast-radius-guard` ·
> `add-cross-agent-intent-handoff`. This change underpins the cross-repo aspects of the other four.

## Why

OpenLore's measured win is the large, unfamiliar codebase. The frontier beyond that is the agent —
or the organization — working across **many** large repos at once: a microservice constellation, a
set of vendored dependencies, a polyrepo product. No single context window holds them, and an agent
that greps repo-by-repo loses the one thing OpenLore exists to give it: a trustworthy answer to "what
*across the fleet* calls this, breaks if I change it, or already decided how this should work."

Today OpenLore is single-repo by construction: one `.openlore/` index per repo, no cross-repo symbol
resolution, no federated query, no fleet-level memory. The good news is that the hard primitive is
already shipped: **content-addressed stable symbol IDs** (`add-content-addressed-stable-symbol-ids`,
v2.0.19) are exactly the cross-repo identity key SCIP and Kythe use for monikers, and OpenLore already
has a SCIP exporter (`src/core/scip/export.ts`). Federation is the layer that puts those keys to work
across repos — without merging anything.

## The design constraint that keeps it deterministic and bounded

Two non-negotiables, both inherited from the north star:

1. **No merged mega-graph.** Each repo keeps its own deterministic, independently-rebuilt `.openlore/`
   index. Federation is a thin **index-of-indexes** — a registry plus cross-repo symbol resolution —
   never a global graph loaded into memory. A fleet of 1,000 repos is 1,000 local indexes and one
   small registry, not one 1,000× graph.
2. **Token-bounded, lazy queries.** A federated query loads only the per-repo indexes it actually
   needs, returns conclusions (a path, an impacted set, a verdict), and respects a token budget — the
   same conclusion-over-graph and budgeting discipline as `add-trust-calibrated-context-economy`. The
   agent never receives the union graph; it receives the answer.

## What changes

1. **Federation registry.** A manifest (`~/.openlore/federation.json` or a project-local file) listing
   indexed repos: local path or git remote, last-built fingerprint, schema version. Each repo indexes
   independently; the registry is an index-of-indexes, not a build artifact. Adding/removing a repo is
   a registry edit plus that repo's own local build — no global rebuild.

2. **Cross-repo symbol resolution via stable IDs.** A published symbol in repo A resolves to its
   consumers in repos B and C **deterministically**, using the existing content-addressed stable IDs /
   SCIP monikers — when those repos are indexed. Unindexed repos are reported as such, never guessed
   (this is where `add-confidence-boundary-disclosure` carries the honesty).

3. **Federation-scoped queries.** `analyze_impact`, `find_path`, `find_dead_code`, and `select_tests`
   gain an optional federation scope. "Who across the fleet calls this published API," "is this export
   dead across all consumers, not just here," "which tests across repos cover a change to this shared
   interface." Results are lazy (load per-repo indexes on demand) and budgeted, and they name which
   repos were and were not consulted.

4. **Fleet-level memory and decisions.** A memory or decision can anchor to a *published* interface via
   its stable ID and resurface in consumer repos: a note like "this upstream queue is at-least-once;
   keep consumers idempotent" surfaces when an agent edits a consumer, not only the producer. The
   federation memory store reuses the bitemporal + freshness machinery
   (`add-bitemporal-typed-memory-operations`, `harden-memory-integrity-invariant`), anchored to
   cross-repo stable IDs.

5. **Incremental and sharded by construction.** Each repo re-indexes on its own watcher/schedule;
   federation updates are per-repo deltas to the registry. Scaling to thousands of repos never
   requires a global rebuild — the property that makes fleet scale tractable.

## What does NOT change

- **No LLM anywhere** in resolution, query, or freshness. Cross-repo resolution is stable-ID matching;
  the north star (`overview/spec.md`, `c6d1ad07`) holds.
- **Per-repo determinism is preserved.** A single-repo session behaves exactly as today; federation is
  purely additive and opt-in.
- **No required cloud or team server.** The registry is a local (or shared-filesystem) file. Hosted /
  team sync is an explicit future, out of scope here — federation works fully local-first.
- **Stable IDs are reused, not reinvented.** This change consumes the existing content-addressed IDs
  and SCIP exporter; it does not change how symbols are identified.
- **Default and `minimal` tool surfaces stay constant.** Federation rides existing tools via an
  optional scope and an opt-in `federation` preset; no new default tool.

## Research basis

- **SCIP / Kythe / Glean** — cross-repo code intelligence built on stable monikers; Glean indexes a
  whole monorepo as independent shards queried on demand. OpenLore's stable IDs are the same key.
- **The differentiator** — these systems require a build step and/or a hosted index server. A
  *deterministic, build-free, local-first, token-bounded* federation with *self-invalidating memory*
  across repos is not something a comparable agent-context tool ships. This is where OpenLore stops
  being a single-repo helper and becomes fleet infrastructure.

## Application to OpenLore

- **Identity** reuses content-addressed stable IDs and `src/core/scip/export.ts`.
- **Per-repo indexes** are today's `.openlore/` directories unchanged; the registry references them.
- **Cross-repo memory** reuses the anchor + freshness + bitemporal machinery, with stable IDs as the
  anchor instead of a local `nodeId`.
- **Budgeted lazy query** reuses the conclusion-shaping and budgeting from the trust-economy change.

## Out of scope

- **Hosted / team-shared federation, auth, and sync mechanics.** A promising future; this change is
  local-first federation only.
- **Cross-repo semantic dedup or merge.** Federation resolves identity and routes queries; it does not
  reconcile or summarize across repos with an LLM.
- **Cross-language cross-repo bridging** beyond what stable IDs already span.
