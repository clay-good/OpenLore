/**
 * Spec-09 — tool driver registry.
 *
 * Maps every name in TOOL_DEFINITIONS to (a) a classification and (b) an
 * arg-builder that derives realistic inputs from a repo's own analysis. The
 * integration suite drives each tool through the shared `dispatchTool` entry
 * point with these args; the static coverage gate (a plain unit test) asserts
 * the registry covers TOOL_DEFINITIONS so a newly-added tool fails CI until it
 * has a driver entry. THIS IS THE HEADLINE ANTI-ROT MECHANISM (spec-09 §6).
 *
 * Behavior-neutral: this module only constructs args. It never modifies a
 * handler, TOOL_DEFINITIONS, or dispatch.
 */

import { TOOL_DEFINITIONS } from '../../../../cli/commands/mcp.js';

/**
 * read    — deterministic, side-effect-free; full invariant treatment.
 * mutating — writes state into the cached repo's gitignored .openlore (decisions);
 *            safe but ordered (approve/reject need an id from a prior record).
 * llm      — needs a model; driven only when OPENLORE_LIVE_LLM=1 (or via a no-LLM
 *            dry-run path where the tool supports one). Otherwise SKIP-llm, still
 *            counted as covered by the static registry.
 */
export type ToolKind = 'read' | 'mutating' | 'llm';

/** Deterministic facts derived from a repo's analysis, used to build tool args. */
export interface RepoFacts {
  /** Absolute path to the analyzed cached repo. */
  directory: string;
  /** A real function/symbol name from the repo (e.g. a top hub). */
  functionName?: string;
  /** A second real function name, for from→to / entry→target tools. */
  secondFunction?: string;
  /** A real repo-relative source file path. */
  filePath?: string;
  /** A search term known to exist in the repo. */
  searchTerm?: string;
  /** A real spec domain, if the repo has specs (cloned OSS repos usually do not). */
  specDomain?: string;
  /** A decision id captured from a prior record_decision run (mutating tools). */
  decisionId?: string;
}

export interface ToolPlan {
  kind: ToolKind;
  /**
   * Build args for `dispatchTool(name, args, directory)`. Return `null` when the
   * facts needed to drive this tool realistically are unavailable on this repo
   * (e.g. no spec domain) — the runner records that as a derive-skip, distinct
   * from a missing driver entry.
   */
  buildArgs: (f: RepoFacts) => Record<string, unknown> | null;
}

const dirOnly = (f: RepoFacts): Record<string, unknown> => ({ directory: f.directory });
const needFn =
  (build: (f: RepoFacts, fn: string) => Record<string, unknown>) =>
  (f: RepoFacts): Record<string, unknown> | null =>
    f.functionName ? build(f, f.functionName) : null;
const needFile =
  (build: (f: RepoFacts, file: string) => Record<string, unknown>) =>
  (f: RepoFacts): Record<string, unknown> | null =>
    f.filePath ? build(f, f.filePath) : null;
const needQuery =
  (build: (f: RepoFacts, q: string) => Record<string, unknown>) =>
  (f: RepoFacts): Record<string, unknown> | null =>
    f.searchTerm ? build(f, f.searchTerm) : null;

export const TOOL_REGISTRY: Record<string, ToolPlan> = {
  // ── directory-only read tools ────────────────────────────────────────────
  analyze_codebase: { kind: 'read', buildArgs: (f) => ({ directory: f.directory, force: false }) },
  get_architecture_overview: { kind: 'read', buildArgs: dirOnly },
  get_refactor_report: { kind: 'read', buildArgs: dirOnly },
  get_call_graph: { kind: 'read', buildArgs: dirOnly },
  get_duplicate_report: { kind: 'read', buildArgs: dirOnly },
  get_route_inventory: { kind: 'read', buildArgs: dirOnly },
  get_middleware_inventory: { kind: 'read', buildArgs: dirOnly },
  get_schema_inventory: { kind: 'read', buildArgs: dirOnly },
  get_ui_components: { kind: 'read', buildArgs: dirOnly },
  get_env_vars: { kind: 'read', buildArgs: dirOnly },
  get_external_packages: { kind: 'read', buildArgs: dirOnly },
  list_spec_domains: { kind: 'read', buildArgs: dirOnly },
  list_decisions: { kind: 'read', buildArgs: dirOnly },
  get_landmarks: { kind: 'read', buildArgs: dirOnly },
  get_map: { kind: 'read', buildArgs: dirOnly },
  get_health_map: { kind: 'read', buildArgs: dirOnly },
  get_surprising_connections: { kind: 'read', buildArgs: dirOnly },
  detect_changes: { kind: 'read', buildArgs: dirOnly },
  get_critical_hubs: { kind: 'read', buildArgs: dirOnly },
  get_leaf_functions: { kind: 'read', buildArgs: dirOnly },
  get_god_functions: { kind: 'read', buildArgs: dirOnly },
  get_low_risk_refactor_candidates: { kind: 'read', buildArgs: dirOnly },
  audit_spec_coverage: { kind: 'read', buildArgs: dirOnly },
  get_change_coupling: { kind: 'read', buildArgs: dirOnly },
  check_architecture: { kind: 'read', buildArgs: dirOnly },
  get_signatures: { kind: 'read', buildArgs: dirOnly },
  get_mapping: { kind: 'read', buildArgs: dirOnly },
  check_spec_drift: { kind: 'read', buildArgs: dirOnly },
  structural_diff: { kind: 'read', buildArgs: dirOnly },
  get_test_coverage: { kind: 'read', buildArgs: dirOnly },
  find_dead_code: { kind: 'read', buildArgs: dirOnly },
  select_tests: { kind: 'read', buildArgs: dirOnly },
  blast_radius: { kind: 'read', buildArgs: dirOnly },

  // ── function/symbol tools ────────────────────────────────────────────────
  get_subgraph: {
    kind: 'read',
    buildArgs: needFn((f, fn) => ({ directory: f.directory, functionName: fn, direction: 'downstream', maxDepth: 2 })),
  },
  analyze_impact: { kind: 'read', buildArgs: needFn((f, fn) => ({ directory: f.directory, symbol: fn, depth: 2 })) },
  get_minimal_context: { kind: 'read', buildArgs: needFn((f, fn) => ({ directory: f.directory, functionName: fn })) },
  get_cluster: { kind: 'read', buildArgs: needFn((f, fn) => ({ directory: f.directory, functionName: fn })) },
  trace_execution_path: {
    kind: 'read',
    buildArgs: needFn((f, fn) => ({
      directory: f.directory,
      entryFunction: fn,
      targetFunction: f.secondFunction ?? fn,
      maxDepth: 5,
    })),
  },
  find_path: {
    kind: 'read',
    buildArgs: needFn((f, fn) => ({ directory: f.directory, from: fn, to: f.secondFunction ?? fn })),
  },
  federation_status: { kind: 'read', buildArgs: dirOnly },
  spec_store_status: { kind: 'read', buildArgs: dirOnly },
  working_set_context: { kind: 'read', buildArgs: dirOnly },
  change_impact_certificate: { kind: 'read', buildArgs: dirOnly },
  plan_parallel_work: {
    kind: 'read',
    buildArgs: needFn((f, fn) => ({
      directory: f.directory,
      tasks: f.secondFunction && f.secondFunction !== fn
        ? [{ id: 'a', seedSymbols: [fn] }, { id: 'b', seedSymbols: [f.secondFunction] }]
        : [{ id: 'a', seedSymbols: [fn] }],
    })),
  },
  map_in_flight_conflicts: {
    kind: 'read',
    // Drive on the cached repo's own branches/PRs; a cloned OSS repo with no
    // in-flight changes yields an empty (but valid) map — still a covered read.
    buildArgs: (f) => ({ directory: f.directory, includePullRequests: false }),
  },
  get_language_support: {
    kind: 'read',
    // Repo-mode coverage matrix over the cached repo's detected languages.
    buildArgs: (f) => ({ directory: f.directory }),
  },
  report_coverage_gaps: {
    kind: 'read',
    // Whole-repo structural coverage gaps over the cached repo's graph.
    buildArgs: (f) => ({ directory: f.directory }),
  },
  get_function_body: {
    kind: 'read',
    buildArgs: (f) =>
      f.functionName && f.filePath
        ? { directory: f.directory, filePath: f.filePath, functionName: f.functionName }
        : null,
  },

  // ── file tools ───────────────────────────────────────────────────────────
  get_function_skeleton: { kind: 'read', buildArgs: needFile((f, file) => ({ directory: f.directory, filePath: file })) },
  get_file_dependencies: { kind: 'read', buildArgs: needFile((f, file) => ({ directory: f.directory, filePath: file })) },

  // ── query/NL tools ───────────────────────────────────────────────────────
  orient: { kind: 'read', buildArgs: needQuery((f, q) => ({ directory: f.directory, task: q, limit: 5 })) },
  search_code: { kind: 'read', buildArgs: needQuery((f, q) => ({ directory: f.directory, query: q, limit: 10 })) },
  search_specs: { kind: 'read', buildArgs: needQuery((f, q) => ({ directory: f.directory, query: q, limit: 10 })) },
  search_unified: { kind: 'read', buildArgs: needQuery((f, q) => ({ directory: f.directory, query: q, limit: 10 })) },
  suggest_insertion_points: {
    kind: 'read',
    buildArgs: needQuery((f, q) => ({ directory: f.directory, description: q, limit: 5 })),
  },

  // ── domain tool ──────────────────────────────────────────────────────────
  get_spec: { kind: 'read', buildArgs: (f) => (f.specDomain ? { directory: f.directory, domain: f.specDomain } : null) },

  // ── mutating decision tools (write into the cached repo's gitignored .openlore) ──
  record_decision: {
    kind: 'mutating',
    buildArgs: (f) => ({
      directory: f.directory,
      title: 'spec-09 live-data harness probe',
      rationale: 'Exercise record_decision against a real repo (behavior-neutral harness).',
      scope: 'local',
    }),
  },
  approve_decision: {
    kind: 'mutating',
    buildArgs: (f) => (f.decisionId ? { directory: f.directory, id: f.decisionId } : null),
  },
  reject_decision: {
    kind: 'mutating',
    buildArgs: (f) => (f.decisionId ? { directory: f.directory, id: f.decisionId } : null),
  },
  sync_decisions: { kind: 'mutating', buildArgs: (f) => ({ directory: f.directory, dryRun: true }) },

  // ── code-anchored memory ───────────────────────────────────────────────────
  remember: {
    kind: 'mutating',
    buildArgs: (f) => ({
      directory: f.directory,
      content: 'spec-09 live-data harness probe (behavior-neutral).',
      anchors: f.filePath ? [{ file: f.filePath }] : undefined,
    }),
  },
  recall: { kind: 'read', buildArgs: (f) => ({ directory: f.directory, limit: 5 }) },
  // safe-to-change needs only a subject — a single-symbol probe over the fixture.
  verify_claim: { kind: 'read', buildArgs: needFn((f, fn) => ({ directory: f.directory, kind: 'safe-to-change', subject: fn })) },

  // ── LLM-backed tools (openWorldHint) ─────────────────────────────────────
  // generate_tests has a deterministic no-LLM path (useLlm:false + dryRun:true), so
  // it is genuinely exercised offline — classified 'read', not 'llm'.
  generate_tests: {
    kind: 'read',
    buildArgs: (f) => ({ directory: f.directory, useLlm: false, dryRun: true }),
  },
  generate_change_proposal: {
    kind: 'llm',
    buildArgs: (f) => ({ directory: f.directory, description: 'spec-09 probe', slug: 'spec-09-probe' }),
  },
  annotate_story: {
    kind: 'llm',
    buildArgs: (f) =>
      f.filePath ? { directory: f.directory, storyFilePath: f.filePath, description: 'spec-09 probe' } : null,
  },
};

/** Tool names in TOOL_DEFINITIONS that have no driver entry — MUST be empty. */
export function uncoveredTools(): string[] {
  const covered = new Set(Object.keys(TOOL_REGISTRY));
  return TOOL_DEFINITIONS.map((t) => t.name).filter((n) => !covered.has(n)).sort();
}

/** Registry entries that do not correspond to a real tool (stale) — MUST be empty. */
export function staleRegistryEntries(): string[] {
  const real = new Set(TOOL_DEFINITIONS.map((t) => t.name));
  return Object.keys(TOOL_REGISTRY).filter((n) => !real.has(n)).sort();
}
