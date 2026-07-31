# Tasks — fix-epistemic-lease-weights

## Implementation

- [x] Add the 27 missing entries to `TOOL_WEIGHTS` (epistemic-lease.ts:132-189) per the analogy
      table below — every weight is an existing entry's value, no new constants
- [x] Export `TOOL_WEIGHTS` (or a read-only accessor) so the completeness test can cross-check it;
      keep the `?? 1` fallback (epistemic-lease.ts:617) as defense in depth
      (exported as `TOOL_COGNITIVE_WEIGHTS`)

### Weight-by-analogy table (nearest weighted sibling, same traversal-depth class)

| Tool | Weight | Analogy (existing entry) |
|---|---|---|
| `find_path` | 8 | `trace_execution_path` (8) — point-to-point path traversal, documented near-twin |
| `select_tests` | 5 | `analyze_impact` (5) — backward reachability over the graph |
| `report_coverage_gaps` | 5 | `analyze_impact` (5) — whole-graph reachability (inverse of select_tests) |
| `find_dead_code` | 5 | `analyze_impact` (5) — whole-graph reachability sweep |
| `blast_radius` | 5 | `analyze_impact` (5) — callers/layers/tests briefing over the graph |
| `change_impact_certificate` | 5 | `generate_change_proposal` (5) — diff-scoped multi-source certificate |
| `plan_parallel_work` | 5 | `analyze_impact` (5) — footprint + hazard graph over task seeds |
| `map_in_flight_conflicts` | 5 | `plan_parallel_work` (5) — same hazard classifier, harvested inputs |
| `working_set_context` | 3 | `get_minimal_context` (3) — budgeted structural briefing |
| `structural_diff` | 3 | `detect_changes` (3) — diff-scoped structural read |
| `briefing_since` | 3 | `detect_changes` (3) — changed-symbols-since-ref read |
| `certify_public_surface` | 3 | `detect_changes` (3) — diff-scoped export verdict |
| `get_change_coupling` | 3 | `get_file_dependencies` (3) — repo-wide co-change read |
| `check_architecture` | 3 | `get_architecture_overview` (3) — architecture read |
| `suggest_insertion_points` | 3 | `get_minimal_context` (3) — structural placement analysis |
| `get_landmarks` | 3 | `get_critical_hubs` (3) — landmark/hub region read |
| `get_map` | 3 | `get_architecture_overview` (3) — region view |
| `get_health_map` | 3 | `get_architecture_overview` (3) — region health view |
| `get_surprising_connections` | 3 | `get_critical_hubs` (3) — cross-module edge read |
| `federation_status` | 1 | `get_external_packages` (1) — status/inventory read |
| `spec_store_status` | 1 | `get_external_packages` (1) — binding health read |
| `get_language_support` | 1 | `list_spec_domains` (1) — pure registry lookup |
| `get_style_fingerprint` | 2 | `get_signatures` (2) — precomputed per-file/region profile read |
| `verify_claim` | 2 | `recall` (2) — settle one fact against the graph/store |
| `approve_decision` | 1 | `record_decision` (1) — decision lifecycle write |
| `reject_decision` | 1 | `record_decision` (1) — decision lifecycle write |
| `sync_decisions` | 1 | `record_decision` (1) — decision lifecycle write |

## Verification
- [x] Completeness test mirroring tool-contract.test.ts:31-72: every `TOOL_DEFINITIONS` name has a
      `TOOL_WEIGHTS` entry; no `TOOL_WEIGHTS` key names an unregistered tool
      (added to `tool-contract.test.ts` beside the sibling completeness cross-checks)
- [x] Mutation check: remove one entry → test fails naming the tool
- [x] Existing lease threshold tests stay green (thresholds unchanged)
- [x] Full suite green (`npm run test:run`)

## Spec
- [x] `mcp-handlers` delta: ADD LeaseWeightTableIsComplete
