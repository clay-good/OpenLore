# Change impact certificate: certify what a proposed change touches, before it touches it

> Status: IMPLEMENTED (2026-06-21) — shipped on branch `feat/change-impact-certificate`, stacked on
> `feat/working-set-context-briefing` (PR #180). All five "What changes" items and all six task
> sections are built; spec deltas below are merged into `mcp-handlers` + `cli`. Decision: `187224b0`.
> Third of three in `SPEC-STORE-INTEGRATION.md`. Builds on `add-working-set-context-briefing` (binding +
> change resolution), `blast_radius` (`add-preflight-blast-radius-guard`, reused verbatim for blast
> radius / tests / drift), reachability (`analyze_impact`, `find_path`), declared covering surfaces
> (new, below), and the code-anchored freshness lease (`add-code-anchored-memory-staleness`).
>
> **One scoped deviation from the draft, recorded under decision `187224b0`:** the post-change graph is
> derived by a bounded *differential edge-delta over the changed files* (the same primitive
> `structural_diff` uses), NOT via the incremental dependency graph
> (`add-watch-incremental-dependency-graph`), which is still a DRAFT/unbuilt. A new call edge can only
> originate from a changed file, so re-parsing only the changed files at base vs working tree and
> adjusting the canonical adjacency both ways (post = canonical + added − removed, pre = canonical −
> added + removed) detects every newly-opened path without a full rebuild and without that dependency.
> The deviation is a *mechanism* substitution; every requirement below holds. Verified e2e against this
> repo: a controlled edit opening a path into a `critical` surface produced the expected
> `surface-critical` finding, the hook blocked under `block: ["critical"]` and stayed advisory (exit 0)
> without it, and editing an anchored symbol turned a persisted certificate stale (see
> `DOGFOOD-change-impact-certificate.md`).

## Why

Knowing *which* code a change touches is necessary but not sufficient. The expensive, late-caught
mistakes are the ones where a change in one corner of a system quietly affects a boundary that someone
else owns — a client surface, a data-handling surface, a regulated interface — and nobody realizes until
far downstream. Ownership-by-file-glob does not catch this, because the dangerous case is not "you
edited a file that boundary owns." It is "your edit makes some module **newly able to reach** that
boundary, through two hops, where it could not before." That path did not exist until this change
created it.

OpenLore holds the one thing needed to see this deterministically: the call/dependency graph, over which
reachability is exact. By computing reachability **differentially** — before the change versus after —
it can surface the paths a change *opens* into a declared boundary, not merely the boundary's existing
callers. This is the structural signal that catches cross-boundary impact at design time, and it is
uniquely available to a tool that holds the graph.

Equally important is *how* the assessment is delivered. A one-time comment rots the moment the change
grows. So the assessment is emitted as a **certificate**: a checkable, code-anchored artifact carrying a
freshness lease. When the change expands or the underlying graph moves, the certificate goes stale and
the health check re-fires it. Point-in-time review becomes continuously re-validated review, with no
LLM and no new infrastructure — the lease already exists.

## What changes

1. **Declared covering surfaces.** A repository (or a bound spec store) MAY declare named **covering
   surfaces**: sets of symbols, files, or published interfaces that represent a semantic or governance
   boundary (for example, a client surface, a data-handling surface, a regulated interface). A surface
   is a declared boundary, not a directory glob, and it is the unit a change is assessed against.

2. **Newly-opened-path detection.** Given a proposed change, OpenLore computes reachability to each
   declared surface in the pre-change graph and in the post-change graph (the latter derived by a
   bounded differential edge-delta over the changed files — see the header deviation; the originally
   proposed incremental dependency graph is unbuilt), and reports the paths that exist only after the
   change — the paths the change *opens* into the surface. This is distinct from, and additive to, the
   surface's existing callers.

3. **A conclusion-shaped impact certificate.** OpenLore emits one certificate for the change:
   blast radius (callers and layers, reusing `blast_radius`), newly-opened paths into each declared
   surface (with the shortest opening path named), the specs the change drifts, and the tests to run.
   It is a briefing an owner acts on — "this change opens a new path into the *client* surface through
   `A → B`; two specs drift; run these tests" — never a raw graph.

4. **The certificate decays.** The certificate is anchored to the change and its touched symbols via the
   existing freshness lease. When the change grows or the graph moves, the certificate becomes stale and
   the spec-store health check (`add-spec-store-binding`) re-fires it, so an assessment is never trusted
   past the state it was computed against.

5. **A stable machine contract.** Exposed as an MCP tool and a CLI command emitting documented `--json`
   with stable surface and path codes, so an external orchestrator can attach the certificate to a
   change and re-request it when the lease expires.

## What does NOT change

- **No LLM.** Reachability, the differential, blast radius, drift, and test selection are all
  deterministic graph computation. The north star (`c6d1ad07`) holds.
- **Advisory by default.** The certificate informs; it does not block. A repository MAY opt into
  blocking for specific high-severity findings (for example, opening a new path into a surface marked
  critical), exactly as `add-preflight-blast-radius-guard` made blocking opt-in and never the default.
- **Certify, don't assert.** The impact conclusion is delivered as a checkable, leased artifact, not a
  bare claim; an expired certificate is treated as unverified, never as silently still-true.
- **No mutation of the store or targets.** OpenLore reads declared surfaces and the proposed change and
  emits a certificate. It does not write to the store or the code.
- **No default-surface growth.** The certificate tool stays out of the `minimal` / first-run default
  preset; it is opt-in for spec-store-bound environments.

## Research basis

Static change-impact analysis and regression test selection (Legunsen et al., STARTS, FSE 2016) brought
to the design-time moment; reachability/points-to analysis applied **differentially** to detect
newly-introduced paths rather than existing callers; covering-surface monitoring from policy-as-code,
in which a declared semantic or governance boundary is watched for crossings rather than mapped to file
owners; and the continuous-compliance shift from point-in-time attestation to a continuously
re-validated artifact, realized here through OpenLore's existing code-anchored freshness lease. The
defensible combination is the four together: design-time, on declared surfaces, by newly-opened path,
as a decaying certificate — none of which the file-ownership or existing-caller tools provide.

## Application to OpenLore

- **Blast radius / tests / drift** reuse `blast_radius` (`add-preflight-blast-radius-guard`), which
  already composes `analyze_impact`, `select_tests`, and `check_spec_drift`.
- **Reachability** reuses `analyze_impact` / `find_path` / `get_subgraph`; the **post-change graph** is
  derived by a bounded differential edge-delta over the changed files (the incremental dependency graph
  `add-watch-incremental-dependency-graph` named in the original draft is unbuilt — see header deviation).
- **Cross-target surfaces** reuse the binding's federation set (`add-spec-store-binding`) and
  published-interface consumer resolution (`add-multi-repo-federation`).
- **Decay** reuses the freshness lease (`add-code-anchored-memory-staleness`,
  `harden-memory-integrity-invariant`) and is re-fired by the spec-store health check.
- **Contract + advisory posture** reuse the `conclusion` classification, the `--json` emission pattern,
  and the opt-in-blocking hook posture of `blast_radius`.

## Out of scope

- **Runtime / behavioral verification** of the change's effects. This certifies *structural* impact
  over the graph, not test-outcome or execution behavior.
- **Auto-remediation.** The certificate informs the owner; it does not fix the change.
- **Authoring surfaces for a team.** OpenLore consumes declared surfaces; helping a team *write* its
  surface declarations is adjacent product work, not part of this change.
- **Notification delivery** (digests, chat, ticket sync). The certificate is the artifact; routing it
  is a thin downstream consumer, out of scope here.
