# Gryph runtime observability (deferred follow-up from PR #83)

> **STATUS (2026-07-18): BUILT — SHIPPED AND KEPT, no removal.** Reviewed in the 2026-07-18 scope
> audit and confirmed in scope: Gryph is a *fail-open guardrail signal source*, not a violation of
> OpenLore's identity. It stays as implemented. It honors the north star — it puts **no LLM in the
> hot path**, is a no-op when the `safedep/gryph` binary is absent, and its optional runtime signals
> only *enrich the deterministic guardrail/panic surface* that OpenLore serves to the coding agent
> (the customer). The shipped code (`src/cli/commands/gryph-watch.ts`,
> `mcp-handlers/gryph-bridge.ts`, the `panic-*` enrichment, `OPENLORE_GRYPH_*` env) is retained
> as-is. See [[project_openlore_vs_openspec_boundary]] for the sibling product-boundary record.

> **UPDATE (2026-06-21): BUILT in PR #175** — Gryph re-attached fail-open (no-op when the `gryph`
> binary is absent; `gryph-watch` exits silently on mode:'off'). The DEFERRED notes below are kept
> for design history.
>
> Status: BUILT (PR #175, merged; see the UPDATE banner above). Status line corrected 2026-06-25 — was a stale "DEFERRED". History: carved out of the agent-behavioral-governance adoption (PR #175) to land the
> deterministic core first. This proposal preserves @laurentftech's Gryph design (PR #83) so it is
> not lost. Build only after the observe-mode accuracy gate is cleared
> (see `adopt-agent-behavioral-governance`).

## Why it was deferred

Gryph is the part of PR #83 that carries the most cost and the widest maintenance surface: a new
external dependency (the `safedep/gryph` binary), a long-lived background process, PID-file singleton
management, and CAS multi-writer coordination. None of that should gate the deterministic core, and its
benefit (observing agents that work purely via Bash/Edit/Read, invisible to the MCP-path signal model)
is second-order and unproven until the core signal itself is validated.

## What it restores (Laurent's design, intact)

- `gryph-bridge.ts` — `queryGryphSignals()` / `applyGryphDelta()` / `startGryphPolling()` with fail-open
  absence semantics, PascalCase Gryph event mapping, `repetitiveRetryBurst` + `largePatchWhileStale`
  signals, passive decay in `applySnapshotDelta()`.
- `gryph-watch.ts` — standalone observer process (`openlore gryph-watch`), singleton via PID file,
  while-loop poller (no `setInterval` drift), SIGTERM/SIGINT/stdin-EOF exit, `_pollerRegistry` one-per-
  workspace guard.
- `panic-check.ts` Gryph enrichment block (query from `gryphWindowStart`, 2-min fallback).
- Env: `OPENLORE_GRYPH_TIMEOUT_MS`, `OPENLORE_GRYPH_POLL_INTERVAL_MS`.

The original files are recoverable from PR #83 (`feat/panic-response-layer`,
`gryph-bridge.ts` / `gryph-watch.ts` / `gryph-bridge.test.ts`).

## What is already in place (inert plumbing, shipped in PR #175)

These were intentionally kept dormant so this follow-up is a clean re-attach, not a re-architecture:

- `PanicState.gryphWindowStart` and `PanicState.revision` fields.
- `casWritePanicState()` (compare-and-swap write) in `panic-response.ts`.
- `GRYPH_*` constants in `panic-constants.ts`.
- The monotonic-revision invariant across writers (now enforced on the MCP write path), which the
  Gryph CAS poll relies on.

## Gate

Blocked on the observe-mode accuracy gate (`adopt-agent-behavioral-governance`): do not add a second
behavioral source until the first one is shown to be accurate. Re-evaluate the external-dependency cost
on its own merits at that point.

## Out of scope

- Bundling or vendoring the `safedep/gryph` binary. Gryph stays optional; absence is zero-impact.
