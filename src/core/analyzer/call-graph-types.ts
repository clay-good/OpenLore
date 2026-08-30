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
import type { FileParseHealth, GrammarUnavailableBoundary } from './parse-health.js';
import type { ExtractionLaneDisclosure } from './extraction-pool.js';
import type { Pass1CacheDisclosure } from './pass1-fact-cache.js';

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
  /** Source offset of the call expression, when retained by the extractor. */
  offset?: number;
  /** Receiver variable name in `obj.method()` calls */
  calleeObject?: string;
  /** Call type detected from AST shape at extraction time */
  callType?: CallType;
  /** Number of arguments known to be present at the call site. */
  argCount?: number;
  /** True when a spread/splat makes argCount a lower bound rather than an exact count. */
  argCountLowerBound?: true;
}

/** Plain-data class relationship extracted while the Pass-1 syntax tree is alive. */
export interface ClassRelationshipFact {
  className: string;
  parentClasses: string[];
  interfaces: string[];
}

export interface DynamicEventFacts {
  group: string;
  rule: 'event-channel' | 'type-event' | 'actor-message';
  registrations: Array<{ key: string; handlerIds: string[] }>;
  dispatches: Array<{ key: string; callerId: string; line: number }>;
}

export interface DynamicCallbackFact {
  group: 'TypeScript' | 'Go' | 'C++';
  callerId: string;
  handlerId: string;
  line: number;
}

export interface DynamicDispatchFacts {
  events: DynamicEventFacts[];
  callbacks: DynamicCallbackFact[];
}

/** Invocation-arity facts recovered from a live declaration AST. */
export interface FunctionCallArity {
  /** Required arguments at an ordinary call site (implicit receivers excluded). */
  required: number;
  /** Maximum fixed arguments before any variadic parameter (implicit receivers excluded). */
  total: number;
  variadic: boolean;
  /** Exact number of source variadic declarations (`...rest`, `*args`, `**kwargs`). */
  variadicParameterCount?: number;
  /** Optional/defaulted parameters exist; conservative verdict consumers must stay silent. */
  hasOptionalOrDefault: boolean;
  /** Source parameters such as Python self/cls or a TypeScript pseudo-this, excluded above. */
  implicitReceiverCount: number;
  /** Multiple same-scope declarations collapsed to this graph node. */
  overloaded?: true;
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
  /** AST-derived invocation bounds. Present only for supported, unambiguous declaration shapes. */
  callArity?: FunctionCallArity;
}

/** Broad category of an external (unresolved) call */
export type ExternalKind = 'http' | 'database' | 'filesystem' | 'stdlib' | 'unknown';

/**
 * Maximum number of candidate ids retained on an {@link AmbiguousCallSite}. An
 * ambiguous name can in pathological cases match many definitions; the list is
 * bounded so the persisted graph and tool payloads stay small. When the true
 * candidate count exceeds the cap, `candidateCount` records the full total while
 * `candidateIds` holds the first {@link AMBIGUOUS_CANDIDATE_CAP} (id-sorted, so the
 * truncation is deterministic).
 */
export const AMBIGUOUS_CANDIDATE_CAP = 8;

/** Which resolution strategy refused to bind because the candidate set was ambiguous. */
export type AmbiguousStrategy = 'name_only' | 'self_cls' | 'type_name' | 'type_inference' | 'overload';

/**
 * A call site the resolution ladder refused to bind because more than one candidate
 * definition was viable and no affinity/arity signal singled one out (change:
 * harden-call-resolution-ambiguity; analyzer: NoFirstMatchBindingOnAmbiguity).
 *
 * Recorded INSTEAD of emitting an arbitrary first-match edge, so precision-sensitive
 * consumers (find_dead_code, analyze_error_propagation, analyze_impact, select_tests)
 * can disclose the ambiguity as a boundary rather than trusting a guess or assuming
 * absence. A UNIQUE candidate still binds at the strategy's declared confidence — an
 * ambiguous site is only recorded when the ladder would otherwise have guessed.
 */
export interface AmbiguousCallSite {
  /** Node id of the calling function. */
  callerId: string;
  /** Callee name as written at the call site. */
  calleeName: string;
  /** Receiver in `obj.method()` calls, if any. */
  calleeObject?: string;
  /** 1-based call-site line, when known. */
  line?: number;
  /** Which strategy hit the ambiguity. */
  strategy: AmbiguousStrategy;
  /** Candidate node ids (id-sorted, bounded to {@link AMBIGUOUS_CANDIDATE_CAP}). */
  candidateIds: string[];
  /** Total viable candidates before capping (equals candidateIds.length when not truncated). */
  candidateCount: number;
}

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
  /** Number of arguments known to be present at the call site. */
  argCount?: number;
  /** True when a spread/splat makes argCount a lower bound rather than an exact count. */
  argCountLowerBound?: true;
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

/**
 * The per-file result of Pass-1 extraction (before cross-file resolution). Lives here, in the
 * dependency-light type barrel, because it crosses two module boundaries besides the builder:
 * the extraction workers (as a structured clone) and the Pass-1 fact cache (as JSON). Every
 * field is plain data for exactly that reason.
 */
export type FileExtractResult = {
  nodes: FunctionNode[];
  rawEdges: RawEdge[];
  cfg?: Map<string, FunctionCfg>;
  style?: FileStyleRaw;
  parseHealth?: FileParseHealth;
  /** Survives worker structured-clone and persistent fact-cache JSON boundaries. */
  classRelationships?: ClassRelationshipFact[];
  /** Unresolved handler references are resolved only after all repository nodes exist. */
  dynamicDispatch?: DynamicDispatchFacts;
  /** Plain outbound HTTP call-site facts, reused by Pass 2 without reparsing the file. */
  httpCalls?: Array<{
    file: string;
    method: string;
    url: string;
    normalizedUrl: string;
    line: number;
    offset?: number;
    client: string;
  }>;
  httpDegradations?: Array<{
    file: string;
    reason: 'budget-exceeded' | 'parse-failure' | 'traversal-budget';
    budgetMs?: number;
  }>;
  /** Plain-data receipt that survives the worker-thread structured-clone boundary. */
  grammarUnavailable?: Omit<GrammarUnavailableBoundary, 'fileCount'>;
  /** Multiple unavailable parser lanes, used by mixed-language script containers. */
  grammarUnavailableAll?: Array<Omit<GrammarUnavailableBoundary, 'fileCount'>>;
};

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
  /**
   * Per-file parse health (change: add-parse-health-boundary-disclosure), keyed by file path.
   * Tallied in the same per-file AST walk that extracts nodes/edges — no second parse. Present
   * ONLY for a file that carried a parse error or full parse failure (a clean file has no entry,
   * so a healthy repo leaves this undefined). Transient build-time data: rolled up into the
   * persisted `parse-health.json` by the artifact generator, not carried into
   * {@link SerializedCallGraph}.
   */
  parseHealthByFile?: Map<string, FileParseHealth>;
  /** Optional HTTP client projection failures. The primary graph parse may still
   * be healthy, so these are disclosed separately from whole-file parse health. */
  httpClientDegradations?: Array<{
    file: string;
    reason: 'budget-exceeded' | 'parse-failure' | 'traversal-budget';
    budgetMs?: number;
  }>;
  /** Language-level grammar failures aggregated across Pass-1 files. */
  grammarUnavailable?: GrammarUnavailableBoundary[];
  /**
   * Call sites the resolution ladder refused to bind because the candidate set was
   * ambiguous (change: harden-call-resolution-ambiguity). NOT edges — these are the
   * disclosed alternative to an arbitrary first-match guess. Carried through
   * serialization so serve-time consumers can surface them as boundaries. Absent
   * (undefined) when the graph has no ambiguous sites.
   */
  ambiguousSites?: AmbiguousCallSite[];
  /**
   * Which lane Pass-1 extraction actually ran on — the worker pool or the serial
   * reference path — and whether anything degraded (change:
   * optimize-parallel-extraction-pool). Transient build-time data: it describes HOW the
   * facts were computed, never WHAT they are, so it is deliberately not carried into
   * {@link SerializedCallGraph} or any artifact. Read by the analyze summary to disclose a
   * degraded lane.
   *
   * "Byte-identical" is the contract for every fact the extractors produce, and it is
   * verified end to end. One residual asymmetry is inherent rather than a gap: a worker
   * thread gets a larger default stack than the main thread, so a pathological
   * deep-recursion parse can succeed on one lane and fail on the other. That is a
   * different FILE failing to parse, disclosed through parse health either way — not a
   * different interpretation of a file that parsed.
   */
  extractionLane?: ExtractionLaneDisclosure;
  /**
   * How many files reused memoized Pass-1 facts vs. were re-extracted (change:
   * optimize-hash-keyed-analyze). Present only when the caller supplied a fact cache. Like
   * {@link extractionLane} this describes HOW the facts were computed, never what they are —
   * the two lanes are byte-identical by construction — and is transient build-time data the
   * analyze summary renders so the lane is never silent.
   */
  pass1Cache?: Pass1CacheDisclosure;
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
  /** Unresolved-ambiguous call sites (change: harden-call-resolution-ambiguity). Omitted when empty. */
  ambiguousSites?: AmbiguousCallSite[];
}
