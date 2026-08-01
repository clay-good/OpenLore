# Complete the epistemic-lease weight table and bind it to the tool registry

> Status: SHIPPED (2026-07-18, PR #232; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit). The lease's cognitive-load accounting silently
> under-counts 27 of 72 tools — every unlisted tool falls to the minimum weight via a `?? 1`
> fallback, including deep graph traversals on the *default* surface. Weights are assigned by
> analogy to existing entries (no new constants), and a completeness test binds the table to
> `TOOL_DEFINITIONS` the way `TOOL_OUTPUT_CLASS` and `TOOL_CAPABILITY_FAMILY` already are.
> Grounded in the honesty contract: a freshness signal computed from wrong inputs is a wrong
> signal delivered with authority.

## The gap

The epistemic lease tracks per-session cognitive load by weighting each tool call
(`epistemic-lease.ts:617`: `TOOL_WEIGHTS[toolName] ?? 1`). The table (`:132-189`) declares three
tiers (lightweight 1-2, structural 3-5, architectural 8) — but lists only **45 of the 72
dispatched tools**. The other 27 silently score the minimum:

- **Default-surface members are unweighted**: `find_path`, `blast_radius`, `verify_claim`,
  `suggest_insertion_points`, `get_landmarks`, `get_map` — six of the 13 `substrate` preset tools
  ride the fallback. The starkest inconsistency: `find_path` scores 1 while its documented
  near-twin `trace_execution_path` scores 8 (`:188`) — two point-to-point path traversals, an 8×
  accounting gap decided by table membership, not by work done.
- **Whole families are unweighted**: all of `coordinate` (`plan_parallel_work`,
  `map_in_flight_conflicts`), all of `federate`, and most of `change` (`structural_diff`,
  `change_impact_certificate`, `certify_public_surface`, `briefing_since`).
- **No guard**: unlike `TOOL_OUTPUT_CLASS` and `TOOL_CAPABILITY_FAMILY` — whose completeness
  `tool-contract.test.ts:31-72` cross-checks against the live `TOOL_DEFINITIONS` in both
  directions — nothing binds `TOOL_WEIGHTS` to the registry. Every one of the last ~14 new tools
  shipped without a weight, and nothing will stop the next one.

The consequence is not cosmetic: the lease's degrade/stale thresholds (`:195-198`) fire on
accumulated load. A session of heavy unlisted traversals (`find_path`, `blast_radius`,
`working_set_context`) accrues load as if it were doing cheap lookups, so the freshness note the
agent is told to trust arrives late or never.

## What changes

1. **Weight all 27 missing tools by analogy** — each gets the weight of its nearest weighted
   sibling in the same traversal-depth class, never a newly invented constant. The full
   tool-by-tool analogy table is in `tasks.md`; the anchor cases: `find_path` ←
   `trace_execution_path` (8); `select_tests` / `report_coverage_gaps` / `blast_radius` /
   `find_dead_code` ← `analyze_impact` (5, backward/whole-graph reachability);
   `structural_diff` / `briefing_since` / `certify_public_surface` ← `detect_changes` (3,
   diff-scoped); `get_map` / `get_health_map` / `get_landmarks` ← `get_architecture_overview` /
   `get_critical_hubs` (3, region reads); `verify_claim` ← `recall` (2, single-fact settle);
   `approve_decision` / `reject_decision` / `sync_decisions` ← `record_decision` (1, lifecycle
   writes); `get_language_support` ← `list_spec_domains` (1, registry lookup).
2. **A completeness test** mirroring `tool-contract.test.ts:31-72`: every registered tool has a
   weight entry, and no stale entry names an unregistered tool. A new tool without a weight fails
   CI — the same closed-table discipline the output-class and family tables already have. This
   requires exporting `TOOL_WEIGHTS` (or a lookup) for the test; the `?? 1` fallback stays as
   defense in depth but can no longer mask a registry gap.

## Why this is in scope

The lease is spec-bound to emit *neutral freshness facts* (`mcp-handlers`
EpistemicLeaseEmitsNeutralFreshnessFactsNotCoerciveImperatives). A fact computed from an input
table that silently under-counts 38% of the surface is not a fact — it is an estimate degrading
with every release. No behavior redesign, no new constants (doctrine: weights derive from existing
entries by stated analogy), no new tools.

## Impact

- `src/core/services/mcp-handlers/epistemic-lease.ts` (27 table entries, one export);
  `epistemic-lease.test.ts` or `tool-contract.test.ts` (completeness cross-check).
- Specs: `mcp-handlers` — 1 ADDED requirement (LeaseWeightTableIsComplete).
- Risk: sessions heavy on formerly-unlisted tools reach the degrade/stale thresholds sooner —
  that is the correction, not a regression. Thresholds (`:195-198`) are unchanged; no payload or
  tool-surface change, so the tools/list budget guardrail is untouched.
