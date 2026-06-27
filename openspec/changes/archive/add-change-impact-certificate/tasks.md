# Tasks — Change impact certificate

> Status: IMPLEMENTED (2026-06-21). All six sections shipped on branch `feat/change-impact-certificate`.
> Decision `187224b0` recorded the certificate shape + surface format + the differential edge-delta
> method (substituting for the unbuilt incremental dependency graph — see proposal header). Handler:
> `src/core/services/mcp-handlers/impact-certificate.ts` (+ `.test.ts`, 17 tests); CLI:
> `src/cli/commands/impact-certificate.ts`. Verified e2e in `DOGFOOD-change-impact-certificate.md`.

## 1. Declared covering surfaces
- [x] Support an optional, additive surface declaration: a named surface = a set of symbols, files, or
      published interfaces, with an optional severity. Declared in repo config and/or the bound store.
      → `src/core/services/config-manager.ts`, `src/types/index.ts`.
- [x] Resolve a declared surface to a concrete symbol-ID set over the (federated) graph; unresolved
      members degrade to a finding, never a throw.
- [x] Test: a surface declared by file + symbol resolves to the expected ID set; an unresolved member
      yields one finding.

## 2. Newly-opened-path detection (the differentiated core)
- [x] Compute reachability to each declared surface in the pre-change graph; derive the post-change
      graph by a bounded differential edge-delta over the changed files (the incremental dependency graph
      in the original draft is unbuilt — see header); report paths present only after.
      → new handler `src/core/services/mcp-handlers/impact-certificate.ts` (reachability diff over
      `analyze_impact` / `find_path`).
- [x] Name the shortest opening path per newly-opened surface (e.g. `A → B → surface`).
- [x] Test: a diff that adds an edge creating a 2-hop path into a surface reports exactly that
      newly-opened path; a diff touching only existing callers reports none.

## 3. Certificate assembly (conclusion-shaped)
- [x] Emit one certificate: blast radius (reuse `blast_radius`), newly-opened paths per surface, drifted
      specs (`check_spec_drift`), tests to run (`select_tests`). Single briefing, never a graph.
- [x] Each finding carries a stable code (e.g. `surface-newly-reached`, `spec-drift`,
      `surface-critical`) and, for surfaces, the surface name + severity.
- [x] Test: certificate is conclusion-shaped (`assertConclusionShape`); classification in
      `tool-contract.ts` holds.

## 4. Decay via the freshness lease
- [x] Anchor the certificate to the change and its touched symbols using the existing lease; mark it
      stale when the change grows or anchored symbols move.
      → reuse `add-code-anchored-memory-staleness` / `harden-memory-integrity-invariant`.
- [x] The spec-store health check (`add-spec-store-binding`) reports a stale certificate as a finding to
      re-fire; an expired certificate is treated as unverified, never silently still-true.
- [x] Test: editing an anchored symbol turns a previously-fresh certificate stale; the health check
      surfaces it.

## 5. Surfaces, advisory posture, machine contract
- [x] MCP tool `change_impact_certificate` classified `conclusion`; registered in `tool-dispatch.ts`,
      `TOOL_DEFINITIONS`, `tool-driver.ts`. Kept OUT of `minimal`/`navigation`/`memory` presets.
- [x] CLI `openlore impact-certificate [--change <id>] [--json] [--hook] [--install-hook]`, reusing the
      advisory-by-default hook posture of `blast-radius`; opt-in blocking only on configured
      high-severity findings (e.g. `surface.block: [critical]`).
      → `src/cli/commands/impact-certificate.ts`.
- [x] Test: default hook exits 0 (advisory); opt-in blocking fires only on its configured surface
      severity; infrastructure failure never blocks; `--json` codes are stable and documented.

## 6. Docs
- [x] Document covering surfaces, newly-opened-path detection, the certificate artifact, its decay, and
      the advisory-by-default posture in the `mcp-handlers` and `cli` specs and the CLAUDE.md tool table.
