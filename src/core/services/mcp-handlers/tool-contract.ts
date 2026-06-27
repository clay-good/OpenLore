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
  find_clones: 'conclusion',
  analyze_error_propagation: 'conclusion',
  analyze_env_impact: 'conclusion',
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
  get_style_fingerprint: 'conclusion',
  briefing_since: 'conclusion',
};

/** The tools intentionally allowed to emit raw topology, sorted for stable assertions. */
export const EXPLICIT_TOPOLOGY_TOOLS: readonly string[] = Object.entries(TOOL_OUTPUT_CLASS)
  .filter(([, cls]) => cls === 'explicit-topology')
  .map(([name]) => name)
  .sort();

/* ===========================================================================
 * Capability families (spec domain: `mcp-quality`, requirement
 * CapabilityFamilyTaxonomy; architecture: UnifiedStructuralSubstrate).
 *
 * OpenLore is one structural substrate with two faces — a READ face that
 * navigates the graph and a WRITE/CHECK face that anchors facts and gates
 * changes. The surface has grown to ~70 flat tools, several answering adjacent
 * questions, which degrades an agent's selection accuracy. The fix is not to
 * merge distinct conclusions (see ADJACENT_TOOL_GROUPS) but to give the surface
 * a *taxonomy*: every tool declares exactly one of a small, closed set of
 * capability families, the way it already declares `conclusion` vs
 * `explicit-topology` above. An agent then chooses among ~6 families and a
 * handful of tools per family, never among the whole undifferentiated registry.
 *
 * The set is CLOSED: a new tool joins an existing family, or the change must
 * justify and add a new family here. `tool-contract.test.ts` fails CI if any
 * registered tool is missing a family or declares one outside this set.
 * =========================================================================== */

export type CapabilityFamily =
  | 'navigate' // read the structural/spec graph, return a conclusion about existing structure
  | 'change' // reason about a specific diff or change set (your pending work)
  | 'remember' // record / recall durable, code-anchored facts (memory + decision lifecycle)
  | 'verify' // settle a claim or a decision's currency against the graph before a human sees it
  | 'coordinate' // schedule or deconflict parallel work across agents/actors
  | 'federate'; // cross-repo / spec-store conclusions

/** The closed, source-declared family set, in presentation order. */
export const CAPABILITY_FAMILIES: readonly CapabilityFamily[] = [
  'navigate',
  'change',
  'remember',
  'verify',
  'coordinate',
  'federate',
];

/** One-line human label per family, for grouped rendering in docs and `--help`. */
export const CAPABILITY_FAMILY_LABELS: Record<CapabilityFamily, string> = {
  navigate: 'Navigate — read the structural graph, return a conclusion',
  change: 'Change — reason about a specific diff or change set',
  remember: 'Remember — record & recall durable, code-anchored facts',
  verify: 'Verify — settle a claim before it reaches a human',
  coordinate: 'Coordinate — schedule & deconflict parallel work',
  federate: 'Federate — cross-repo / spec-store conclusions',
};

/**
 * Every dispatched MCP tool and its capability family. Parallel to
 * {@link TOOL_OUTPUT_CLASS}: adding a tool without an entry here makes the
 * completeness test fail, forcing the author to declare a family.
 */
export const TOOL_CAPABILITY_FAMILY: Record<string, CapabilityFamily> = {
  // --- navigate: read the structural/spec graph, return a conclusion ---
  get_subgraph: 'navigate',
  get_call_graph: 'navigate',
  orient: 'navigate',
  analyze_codebase: 'navigate',
  get_architecture_overview: 'navigate',
  get_refactor_report: 'navigate',
  get_signatures: 'navigate',
  trace_execution_path: 'navigate',
  get_mapping: 'navigate',
  analyze_impact: 'navigate',
  select_tests: 'navigate',
  find_dead_code: 'navigate',
  get_change_coupling: 'navigate',
  check_architecture: 'navigate',
  get_low_risk_refactor_candidates: 'navigate',
  get_leaf_functions: 'navigate',
  get_critical_hubs: 'navigate',
  get_duplicate_report: 'navigate',
  find_clones: 'navigate',
  analyze_error_propagation: 'navigate',
  analyze_env_impact: 'navigate',
  get_function_skeleton: 'navigate',
  get_god_functions: 'navigate',
  search_code: 'navigate',
  suggest_insertion_points: 'navigate',
  search_specs: 'navigate',
  search_unified: 'navigate',
  list_spec_domains: 'navigate',
  get_spec: 'navigate',
  get_function_body: 'navigate',
  get_file_dependencies: 'navigate',
  generate_change_proposal: 'navigate',
  annotate_story: 'navigate',
  get_route_inventory: 'navigate',
  get_middleware_inventory: 'navigate',
  get_schema_inventory: 'navigate',
  get_ui_components: 'navigate',
  get_env_vars: 'navigate',
  get_external_packages: 'navigate',
  audit_spec_coverage: 'navigate',
  // check_spec_drift reads the existing spec↔code graph for parity (like its sibling
  // audit_spec_coverage), not a specific diff's contents — so it sits with the spec reads,
  // not in `change`. detect_changes (genuinely diff-scoped) stays in `change`.
  check_spec_drift: 'navigate',
  generate_tests: 'navigate',
  get_test_coverage: 'navigate',
  get_minimal_context: 'navigate',
  get_cluster: 'navigate',
  get_landmarks: 'navigate',
  get_map: 'navigate',
  find_path: 'navigate',
  get_health_map: 'navigate',
  get_surprising_connections: 'navigate',
  get_language_support: 'navigate',
  report_coverage_gaps: 'navigate',
  get_style_fingerprint: 'navigate',

  // --- change: reason about a specific diff or change set ---
  structural_diff: 'change',
  blast_radius: 'change',
  change_impact_certificate: 'change',
  certify_public_surface: 'change',
  briefing_since: 'change',
  detect_changes: 'change',

  // --- remember: durable, code-anchored facts (memory + decision lifecycle) ---
  remember: 'remember',
  recall: 'remember',
  record_decision: 'remember',
  list_decisions: 'remember',
  approve_decision: 'remember',
  reject_decision: 'remember',
  sync_decisions: 'remember',

  // --- verify: settle a claim/decision currency before a human sees it ---
  verify_claim: 'verify',

  // --- coordinate: schedule / deconflict parallel work ---
  plan_parallel_work: 'coordinate',
  map_in_flight_conflicts: 'coordinate',

  // --- federate: cross-repo / spec-store conclusions ---
  federation_status: 'federate',
  spec_store_status: 'federate',
  working_set_context: 'federate',
};

/** The capability family of a tool, or `undefined` if it is unclassified. */
export function capabilityFamily(name: string): CapabilityFamily | undefined {
  return TOOL_CAPABILITY_FAMILY[name];
}

/**
 * Adjacent tool groups (NoRedundantConclusions, `mcp-quality`). Each group is a
 * set of tools IN THE SAME FAMILY whose purposes could be read as answering the
 * same question. These are deliberately NOT merged — each returns a separately
 * useful conclusion — so the contract instead requires each member's description
 * to name a near-sibling, making the distinction legible to a selecting agent.
 * `tool-contract.test.ts` fails if a member does not cross-reference its group.
 */
export const ADJACENT_TOOL_GROUPS: ReadonlyArray<readonly string[]> = [
  // Same graph, four diff conclusions: advisory briefing vs. graph delta + stale
  // callers vs. paths newly opened into a covering surface.
  ['blast_radius', 'structural_diff', 'change_impact_certificate'],
  // Same hazard classifier, different input: caller-supplied tasks vs. harvested
  // in-flight branches/PRs.
  ['plan_parallel_work', 'map_in_flight_conflicts'],
  // Same detector, different shape: pre-write one-vs-all query vs. whole-repo audit.
  ['find_clones', 'get_duplicate_report'],
  // Exact inverses: untested code vs. the reaching tests.
  ['report_coverage_gaps', 'select_tests'],
];

/**
 * Group a tool list by capability family, preserving {@link CAPABILITY_FAMILIES}
 * order and dropping empty families. Used to render the full surface grouped by
 * family (docs / `--help`) instead of as a flat list (CapabilityFamilyTaxonomy).
 */
export function groupToolsByFamily<T extends { name: string }>(
  tools: T[],
): Array<{ family: CapabilityFamily; label: string; tools: T[] }> {
  return CAPABILITY_FAMILIES.map(family => ({
    family,
    label: CAPABILITY_FAMILY_LABELS[family],
    tools: tools.filter(t => capabilityFamily(t.name) === family),
  })).filter(group => group.tools.length > 0);
}

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
