/**
 * The conclusion-over-graph tool contract (spec domain: `mcp-quality`).
 *
 * OpenLore's value proposition is that the *server* does graph traversal so the
 * *agent* never has to. A tool that returns a raw node-and-edge list silently
 * pushes the BFS back onto the model — the exact failure mode (multi-hop context
 * exhaustion, edge confabulation) the substrate exists to prevent.
 *
 * This module turns that convention into a checked invariant:
 *   - {@link TOOL_OUTPUT_CLASS} classifies every dispatched MCP tool as either
 *     `conclusion` (returns a path / ranked list / set / metric / verdict that
 *     directly answers the query) or `explicit-topology` (intentionally returns
 *     a node-and-edge graph).
 *   - {@link assertConclusionShape} enforces that a `conclusion` tool's response
 *     does not regress into a graph dump.
 *
 * The companion `tool-contract.test.ts` cross-checks the table against the live
 * `TOOL_DEFINITIONS` registration so a newly added tool that forgets to declare
 * a class fails CI.
 */

import { MAX_PROVENANCE_EDGES } from '../../../constants.js';

export type ToolOutputClass = 'conclusion' | 'explicit-topology';

/**
 * Every dispatched MCP tool (see `dispatchTool` in
 * `src/core/services/tool-dispatch.ts`) and its output class.
 *
 * Only two tools are `explicit-topology` — they exist to expose graph-level
 * structure and are exempt from the conclusion predicate:
 *   - `get_subgraph`   — a true `nodes[]` + `edges[]` neighbourhood dump.
 *   - `get_call_graph` — a graph-level summary (stats, hub/entry lists, layer
 *      violations). It currently returns bounded lists rather than raw edges,
 *      but stays `explicit-topology` so the "exactly two graph tools" model
 *      holds for future authors and so widening it back to raw topology needs
 *      no reclassification.
 *
 * Everything else is `conclusion`. Adding a tool without an entry here makes the
 * completeness test fail, forcing the author to declare a class.
 */
export const TOOL_OUTPUT_CLASS: Record<string, ToolOutputClass> = {
  // --- explicit-topology (the only intentional graph emitters) ---
  get_subgraph: 'explicit-topology',
  get_call_graph: 'explicit-topology',

  // --- conclusion ---
  orient: 'conclusion',
  analyze_codebase: 'conclusion',
  get_architecture_overview: 'conclusion',
  get_refactor_report: 'conclusion',
  get_signatures: 'conclusion',
  trace_execution_path: 'conclusion',
  get_mapping: 'conclusion',
  analyze_impact: 'conclusion',
  select_tests: 'conclusion',
  find_dead_code: 'conclusion',
  structural_diff: 'conclusion',
  get_change_coupling: 'conclusion',
  check_architecture: 'conclusion',
  get_low_risk_refactor_candidates: 'conclusion',
  get_leaf_functions: 'conclusion',
  get_critical_hubs: 'conclusion',
  get_duplicate_report: 'conclusion',
  get_function_skeleton: 'conclusion',
  get_god_functions: 'conclusion',
  check_spec_drift: 'conclusion',
  blast_radius: 'conclusion',
  search_code: 'conclusion',
  suggest_insertion_points: 'conclusion',
  search_specs: 'conclusion',
  search_unified: 'conclusion',
  list_spec_domains: 'conclusion',
  get_spec: 'conclusion',
  get_function_body: 'conclusion',
  get_file_dependencies: 'conclusion',
  generate_change_proposal: 'conclusion',
  annotate_story: 'conclusion',
  get_route_inventory: 'conclusion',
  get_middleware_inventory: 'conclusion',
  get_schema_inventory: 'conclusion',
  get_ui_components: 'conclusion',
  get_env_vars: 'conclusion',
  get_external_packages: 'conclusion',
  audit_spec_coverage: 'conclusion',
  generate_tests: 'conclusion',
  get_test_coverage: 'conclusion',
  get_minimal_context: 'conclusion',
  get_cluster: 'conclusion',
  get_landmarks: 'conclusion',
  get_map: 'conclusion',
  find_path: 'conclusion',
  federation_status: 'conclusion',
  spec_store_status: 'conclusion',
  working_set_context: 'conclusion',
  change_impact_certificate: 'conclusion',
  detect_changes: 'conclusion',
  get_health_map: 'conclusion',
  get_surprising_connections: 'conclusion',
  record_decision: 'conclusion',
  list_decisions: 'conclusion',
  approve_decision: 'conclusion',
  reject_decision: 'conclusion',
  sync_decisions: 'conclusion',
  remember: 'conclusion',
  recall: 'conclusion',
  verify_claim: 'conclusion',
  plan_parallel_work: 'conclusion',
  map_in_flight_conflicts: 'conclusion',
  get_language_support: 'conclusion',
  report_coverage_gaps: 'conclusion',
  certify_public_surface: 'conclusion',
};

/** The tools intentionally allowed to emit raw topology, sorted for stable assertions. */
export const EXPLICIT_TOPOLOGY_TOOLS: readonly string[] = Object.entries(TOOL_OUTPUT_CLASS)
  .filter(([, cls]) => cls === 'explicit-topology')
  .map(([name]) => name)
  .sort();

/** Thrown when a `conclusion` tool's response violates the contract. */
export class ToolContractViolationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly violation: string,
  ) {
    super(`Tool "${toolName}" violates the conclusion-over-graph contract: ${violation}`);
    this.name = 'ToolContractViolationError';
  }
}

/**
 * An "id-reference edge" is an edge object that points at nodes by id and so
 * requires a separate node table to interpret — the signature of a graph the
 * agent must join/traverse. We deliberately match only these id-reference
 * shapes, NOT resolved `{caller,callee}` name-pairs: a resolved edge list is
 * self-describing and is a legitimate conclusion shape (e.g. `structural_diff`'s
 * `{caller,callee,file}` added/removed changelog, or a `trace_execution_path`
 * chain). The join-requiring `nodes[]`+`edges[]` case is handled separately.
 */
function isIdReferenceEdge(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return ('from' in o && 'to' in o) || ('callerId' in o && 'calleeId' in o) || ('source' in o && 'target' in o);
}

function isIdReferenceEdgeArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every(isIdReferenceEdge);
}

/**
 * Assert that a tool's response satisfies the conclusion-over-graph contract.
 *
 * - `explicit-topology` tools are exempt (they may return raw topology).
 * - An unclassified tool name throws — the contract refuses to silently pass a
 *   tool that has not declared its class.
 * - A `conclusion` tool's response is rejected when it either:
 *   (a) contains a top-level array of id-reference edge objects longer than
 *       {@link MAX_PROVENANCE_EDGES} (a raw adjacency/edge dump), or
 *   (b) carries both a top-level `nodes[]` and a top-level `edges[]`, so the
 *       answer is only reconstructable by joining the two (a graph dump).
 *
 * "Top-level" means the response object's own enumerable values (or the
 * response itself when it is an array). Bounded provenance under the limit is
 * fine — a conclusion may cite a few edges to explain *why* it concluded.
 */
export function assertConclusionShape(toolName: string, response: unknown): void {
  const cls = TOOL_OUTPUT_CLASS[toolName];
  if (cls === undefined) {
    throw new ToolContractViolationError(toolName, 'tool is not classified in TOOL_OUTPUT_CLASS');
  }
  if (cls === 'explicit-topology') return;

  // Error/guidance responses (a bare { error } string) carry no topology.
  if (response === null || typeof response !== 'object') return;

  // (b) nodes[] + edges[] join-required graph dump.
  const obj = response as Record<string, unknown>;
  if (Array.isArray(obj.nodes) && Array.isArray(obj.edges)) {
    throw new ToolContractViolationError(
      toolName,
      'returns both a top-level nodes[] and edges[] — the answer requires joining a graph; return the computed result instead',
    );
  }

  // (a) a top-level array of id-reference edges over the provenance bound.
  const topLevelValues = Array.isArray(response) ? [response] : Object.values(obj);
  for (const value of topLevelValues) {
    if (isIdReferenceEdgeArray(value) && value.length > MAX_PROVENANCE_EDGES) {
      throw new ToolContractViolationError(
        toolName,
        `returns ${value.length} raw edge objects (> MAX_PROVENANCE_EDGES=${MAX_PROVENANCE_EDGES}); return the traversal result, not the graph`,
      );
    }
  }
}
