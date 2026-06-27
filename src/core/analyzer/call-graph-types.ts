/**
 * Call-graph type & edge model — extracted from `call-graph.ts` behind its stable
 * barrel (change: modularize-call-graph-builder; analyzer: StableCallGraphBarrel).
 *
 * This module holds the pure type/edge/node/class model plus the deterministic
 * call-distance and layer helpers. It is dependency-light (only `FunctionCfg` and
 * `FileStyleRaw`, both type-only) and carries NO runtime build logic, so moving it
 * out of `call-graph.ts` cannot change graph output. `call-graph.ts` re-exports
 * every public name here, so no importer of `call-graph.ts` changes.
 */

import type { FunctionCfg } from './cfg.js';
import type { FileStyleRaw } from './style-fingerprint.js';

export type EdgeConfidence =
  | 'self_cls'       // intra-class call via self/cls
  | 'type_inference' // receiver type resolved via type inference
  | 'import'         // callee was imported from a known file
  | 're_export'      // callee resolved through a re-export/barrel chain to its true definition (change: add-call-resolution-recall)
  | 'http_endpoint'  // cross-language HTTP route match
  | 'same_file'      // multiple candidates; same-file wins
  | 'name_only'      // last-resort: pick first candidate by name
  | 'type_name'      // Swift/C++ capitalized receiver treated as type name
  | 'synthesized'    // dynamic-dispatch edge recovered by AST pattern synthesis (not direct name resolution)
  | 'external';      // unresolved external/stdlib call (synthetic leaf node)

/** Broad relationship kind */
export type EdgeKind =
  | 'calls'
  | 'overrides'      // base method → overriding method (CHA; spec: add-type-hierarchy-resolved-dispatch)
  | 'tested_by'
  | 'references'
  | 'depends_on'
  | 'affects'        // decision → governed file (spec-16)
  | 'authored_by'    // file → person, from local git history (spec-18)
  | 'changed_in_pr'; // file → pull request, from local git/gh (spec-18)

/** Semantic nature of the call at the call site */
export type CallType =
  | 'direct'       // foo()
  | 'method'       // obj.method()
  | 'awaited'      // await foo() or await obj.method()
  | 'constructor'; // new Foo()

/** Internal raw edge before resolution */
export interface RawEdge {
  callerId: string;
  calleeName: string;
  line: number;
  /** Receiver variable name in `obj.method()` calls */
  calleeObject?: string;
  /** Call type detected from AST shape at extraction time */
  callType?: CallType;
}

export interface FunctionNode {
  /** Unique ID: "filepath::ClassName.methodName" or "filepath::functionName" */
  id: string;
  name: string;
  filePath: string;
  className?: string;
  isAsync: boolean;
  language: string;
  /** Byte offset range in source (for call attribution) */
  startIndex: number;
  endIndex: number;
  fanIn: number;
  fanOut: number;
  /** First meaningful line of the doc comment / docstring, extracted from AST positions */
  docstring?: string;
  /** Declaration line(s) up to opening brace/colon, whitespace-normalized */
  signature?: string;
  /** True for synthetic nodes representing unresolved external/stdlib calls (e.g. fetch, https.request) */
  isExternal?: boolean;
  /** Classification of external node — used to filter stdlib noise from views */
  externalKind?: ExternalKind;
  /** True for nodes whose source file is a test file (*.test.ts, *_test.py, etc.) */
  isTest?: boolean;
  /** 1-based line number of the function start (computed from startIndex at build time) */
  startLine?: number;
  /** 1-based line number of the function end (computed from endIndex at build time) */
  endLine?: number;
  /** Label-propagation community ID (canonical node id of the community representative) */
  communityId?: string;
  /** Human-readable community label (name of the hub function in the community) */
  communityLabel?: string;
  /** McCabe cyclomatic complexity computed from AST body slice (1 = linear, ≥10 = complex) */
  cyclomaticComplexity?: number;
  /**
   * Content-addressed, location-independent stable identity (change:
   * add-content-addressed-stable-symbol-ids). Derived from the qualified name +
   * signature shape, excluding the file path — so it survives a rename/move.
   * Additive: the path-based `id` remains the canonical key. Absent for
   * anonymous/synthetic symbols with no derivable descriptor.
   */
  stableId?: string;
}

/** Broad category of an external (unresolved) call */
export type ExternalKind = 'http' | 'database' | 'filesystem' | 'stdlib' | 'unknown';

export interface CallEdge {
  callerId: string;
  /** Resolved callee ID */
  calleeId: string;
  /** Raw name as it appears in source */
  calleeName: string;
  line?: number;
  confidence: EdgeConfidence;
  /** Broad relationship kind — omitted on legacy/pre-existing edges, treated as 'calls' */
  kind?: EdgeKind;
  /** Semantic call type; only set when kind === 'calls' */
  callType?: CallType;
  /**
   * Name of the synthesis rule that produced this edge (e.g. 'event-channel',
   * 'route-handler'). Set only when `confidence === 'synthesized'`; absent on
   * directly-resolved edges. Lets every consumer and agent see which conclusions
   * lean on a heuristic and which rest on direct name resolution.
   */
  synthesizedBy?: string;
}

/**
 * Deterministic call-distance cost per edge resolution confidence. A lower cost
 * means a structurally *nearer* (more strongly resolved) edge. Used by
 * {@link callDistance} and the weighted traversal that scopes context by nearest
 * neighbour instead of by a fixed neighbour count.
 *
 * `external` is `Infinity`: external nodes are synthetic stdlib/HTTP leaves and
 * are never traversed *through* for internal scoping (see `weightedBfs`).
 */
export const CALL_DISTANCE_COSTS: Record<EdgeConfidence, number> = {
  // Strongly resolved — concrete symbol/route match.
  import: 1,
  // Re-export-resolved — a proven concrete definition reached through a barrel;
  // as strongly resolved as a direct import (the chain was followed statically).
  re_export: 1,
  same_file: 1,
  self_cls: 1,
  http_endpoint: 1,
  // Moderately resolved — receiver type inferred or treated as a type name.
  type_inference: 2,
  type_name: 2,
  // Heuristic — last-resort first-candidate-by-name match.
  name_only: 3,
  // Synthesized dynamic-dispatch edge — deliberately costlier than ANY directly-
  // resolved confidence so find_path / call-distance scoping prefer a directly-
  // resolved route when one exists, falling back to synthesized only when needed.
  synthesized: 4,
  // Unresolved external/stdlib leaf — excluded from internal traversal.
  external: Infinity,
};

/** Fallback cost for a malformed/legacy confidence value not in the enum. */
const CALL_DISTANCE_FALLBACK = 3;

/**
 * Deterministic distance cost for a single call edge, derived solely from its
 * resolution confidence — a pure function of static analysis, no learned or
 * stochastic component. The switch is exhaustive over {@link EdgeConfidence}
 * (the `never` assignment fails compilation if a member is added without a
 * cost); the runtime `default` defends against malformed/legacy edge data.
 */
export function callDistance(edge: CallEdge): number {
  switch (edge.confidence) {
    case 'import':
    case 're_export':
    case 'same_file':
    case 'self_cls':
    case 'http_endpoint':
      return 1;
    case 'type_inference':
    case 'type_name':
      return 2;
    case 'name_only':
      return 3;
    case 'synthesized':
      return 4;
    case 'external':
      return Infinity;
    default: {
      const _exhaustive: never = edge.confidence;
      void _exhaustive;
      return CALL_DISTANCE_FALLBACK;
    }
  }
}

export interface LayerViolation {
  callerId: string;
  calleeId: string;
  callerLayer: string;
  calleeLayer: string;
  reason: string;
}

/**
 * The layer a file belongs to, by the first matching prefix in declared order.
 * Shared by the call-graph layer detector and the architecture guardrail (spec-23)
 * so both agree on one layering convention.
 */
export function layerOf(filePath: string, layers: Record<string, string[]>): string | undefined {
  for (const [layerName, prefixes] of Object.entries(layers)) {
    // Path-prefix match, not substring: `src/cli` must not classify
    // `src/clinic/x.ts` or `src/api-deprecated/y.ts` into a neighbouring layer.
    if (prefixes.some(p => { const q = p.endsWith('/') ? p : p + '/'; return filePath === p || filePath.startsWith(q); }))
      return layerName;
  }
  return undefined;
}

/**
 * Classify a single directed edge (from → to) against a layer ordering. Declared
 * key order is top → bottom; a lower layer depending on an upper layer is a
 * violation. Returns the offending layer pair, or null when the edge is legal,
 * unclassified, or intra-layer. The canonical layer-direction primitive — reused
 * by `detectLayerViolations` (call edges) and the spec-23 architecture checker
 * (file dependency edges).
 */
export function classifyLayerEdge(
  fromFile: string,
  toFile: string,
  layers: Record<string, string[]>
): { fromLayer: string; toLayer: string } | null {
  const order = Object.keys(layers);
  const fromLayer = layerOf(fromFile, layers);
  const toLayer = layerOf(toFile, layers);
  if (!fromLayer || !toLayer || fromLayer === toLayer) return null;
  const fi = order.indexOf(fromLayer);
  const ti = order.indexOf(toLayer);
  if (fi === -1 || ti === -1) return null;
  return fi > ti ? { fromLayer, toLayer } : null;
}

/**
 * A class or interface as a structural unit, grouping its methods.
 * Derived from FunctionNode.className after the call graph is built.
 */
export interface ClassNode {
  /** Unique ID: first filePath where the class is seen + "::" + className */
  id: string;
  name: string;
  filePath: string;
  language: string;
  /** Direct parent class names (from `extends` / Python base / C++ base) */
  parentClasses: string[];
  /** Implemented interfaces (TypeScript `implements`, Java `implements`) */
  interfaces: string[];
  /** IDs of FunctionNode members that belong to this class */
  methodIds: string[];
  /** Sum of method fanIn values */
  fanIn: number;
  /** Sum of method fanOut values */
  fanOut: number;
  /** True for synthetic file-level module nodes (free functions grouped by file) */
  isModule?: boolean;
  /**
   * Content-addressed, location-independent stable identity (change:
   * add-content-addressed-stable-symbol-ids); the escaped class name, excluding
   * the file path. Absent for synthetic module groupings. Additive — `id`
   * remains canonical.
   */
  stableId?: string;
}

/**
 * An inheritance or implementation edge between two ClassNodes in the graph.
 */
export interface InheritanceEdge {
  id: string;
  /** ClassNode id of the parent / base / interface */
  parentId: string;
  /** ClassNode id of the child / derived / implementor */
  childId: string;
  kind: 'extends' | 'implements' | 'embeds' | 'overrides';
}

export interface CallGraphResult {
  nodes: Map<string, FunctionNode>;
  edges: CallEdge[];
  /**
   * Per-function intra-procedural control-flow + reaching-definitions overlay
   * (spec: add-intraprocedural-cfg-dataflow-overlay), keyed by function id.
   * Transient build-time data: persisted to the disposable SQLite store but
   * deliberately NOT carried into {@link SerializedCallGraph}/the resident graph,
   * so in-memory footprint is unchanged. Absent for unsupported languages.
   */
  cfgs?: Map<string, FunctionCfg>;
  /** Class-level structural nodes, derived from FunctionNode.className grouping */
  classes: ClassNode[];
  /** Inheritance / implementation edges between ClassNodes */
  inheritanceEdges: InheritanceEdge[];
  /** Functions with fanIn >= HUB_THRESHOLD */
  hubFunctions: FunctionNode[];
  /** Functions with no internal callers (fanIn === 0) */
  entryPoints: FunctionNode[];
  layerViolations: LayerViolation[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    avgFanIn: number;
    avgFanOut: number;
  };
  /**
   * Raw per-file style idiom counters (change: add-codebase-style-fingerprint), keyed by file
   * path. Tallied in the same per-file AST walk that extracts nodes/edges — no second parse.
   * Present only for languages with a declared counter set (fail-soft otherwise). Transient
   * build-time data: rolled up into the persisted `style-fingerprint.json` by the artifact
   * generator, not carried into {@link SerializedCallGraph}.
   */
  styleByFile?: Map<string, FileStyleRaw>;
}

/** Serializable version (Maps replaced by arrays) for JSON storage */
export interface SerializedCallGraph {
  nodes: FunctionNode[];
  edges: CallEdge[];
  classes: ClassNode[];
  inheritanceEdges: InheritanceEdge[];
  hubFunctions: FunctionNode[];
  entryPoints: FunctionNode[];
  layerViolations: LayerViolation[];
  stats: CallGraphResult['stats'];
}
