/**
 * Call Graph Analyzer
 *
 * Performs static analysis of function calls across source files using tree-sitter.
 * Supports TypeScript/JavaScript, Python, Go, Rust, Ruby, Java, Swift — no LLM, pure AST.
 *
 * Produces:
 *  - FunctionNode[]  — all identified functions/methods
 *  - CallEdge[]      — resolved function→function call relationships
 *  - Hub functions   — high-fanIn nodes (called by many others)
 *  - Entry points    — functions with no internal callers
 *  - Layer violations — cross-layer calls in the wrong direction
 */

import { dirname, join as joinPath } from 'node:path';
import type Parser from 'tree-sitter';
import { FunctionRegistryTrie } from './function-registry-trie.js';
import type { ImportMap } from './import-resolver-bridge.js';
import { buildResolvedImportMap } from './import-resolver-bridge.js';
import { inferTypesFromSource, resolveViaTypeInference } from './type-inference-engine.js';
import {
  extractAllHttpEdges,
  extractTsRouteDefinitions,
  extractRouteDefinitions,
  extractJavaRouteDefinitions,
  type RouteDefinition,
} from './http-route-parser.js';
import { buildProjectedIac } from './iac/index.js';
import { isIacLanguage } from './iac/types.js';
import { isTestFile } from './test-file.js';
import { buildFunctionCfg, type FunctionCfg, type CfgNode } from './cfg.js';
import { stableSymbolId, stableClassId } from '../scip/moniker.js';
import { synthesizeTypeHierarchyEdges, type RawMethodCall } from './cha.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// TYPES
// ============================================================================

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
interface RawEdge {
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

// ============================================================================
// CONSTANTS
// ============================================================================

const HUB_THRESHOLD = 5;

// Builtins / stdlib names to ignore as call targets, partitioned BY LANGUAGE.
// This used to be one global set applied to every language, which dropped
// legitimate calls: a Java `repo.find(id)`, `list.contains(x)`, or
// `cache.remove(k)` vanished because `find`/`contains`/`remove` are C++ STL /
// Swift names. Each language now only ignores its own builtins; unknown
// languages fall back to the union (legacy behavior) — see isIgnoredCallee.

const PYTHON_IGNORED = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'bool', 'type', 'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
  'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'sum', 'min', 'max',
  'open', 'input', 'format', 'repr', 'id', 'hash', 'abs', 'round', 'pow',
  'super', 'object', 'property', 'staticmethod', 'classmethod',
  'assert', 'raise', 'return', 'yield', 'await', 'pass', 'del',
]);

const JS_IGNORED = new Set([
  'console', 'log', 'error', 'warn', 'JSON', 'parse', 'stringify',
  'Promise', 'resolve', 'reject', 'then', 'catch', 'finally',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'require', 'import', 'exports',
  'map', 'filter', 'reduce', 'forEach',
  // Node.js
  'readFile', 'writeFile', 'mkdir', 'join', 'resolve', 'basename', 'dirname',
  'existsSync', 'readFileSync', 'writeFileSync',
]);

const GO_IGNORED = new Set([
  'make', 'new', 'append', 'copy', 'delete', 'close', 'panic', 'recover',
  'println', 'printf', 'sprintf', 'errorf', 'fprintf', 'print',
]);

const RUST_IGNORED = new Set([
  'println', 'eprintln', 'format', 'vec', 'assert', 'unwrap', 'expect',
  'ok', 'err', 'some', 'none',
]);

const RUBY_IGNORED = new Set([
  'puts', 'print', 'p', 'raise', 'require', 'require_relative', 'include',
  'extend', 'attr_accessor', 'attr_reader', 'attr_writer',
]);

// JVM family (Java/Kotlin/Scala) + C# share these Object/print builtins. Note:
// generic collection methods (find/insert/remove/contains/size/...) are NOT
// ignored here — they are legitimate, frequently user-defined method names.
const JVM_IGNORED = new Set([
  'toString', 'equals', 'hashCode', 'getClass', 'println', 'printf', 'print',
]);

const SWIFT_IGNORED = new Set([
  'print', 'debugPrint', 'dump', 'fatalError', 'precondition', 'preconditionFailure',
  'assert', 'assertionFailure', 'withUnsafePointer', 'withUnsafeMutablePointer',
  'DispatchQueue', 'main', 'async', 'sync', 'append', 'remove', 'insert', 'contains',
  'map', 'filter', 'reduce', 'forEach', 'compactMap', 'flatMap', 'sorted', 'first', 'last',
]);

const CFAMILY_IGNORED = new Set([
  'cout', 'cin', 'cerr', 'endl', 'malloc', 'free', 'memcpy', 'memset', 'memcmp',
  'strlen', 'strcpy', 'strcat', 'strcmp', 'sprintf', 'snprintf', 'fprintf', 'printf',
  'push_back', 'pop_back', 'emplace_back', 'begin', 'end', 'size', 'empty',
  'find', 'insert', 'erase', 'at', 'front', 'back', 'clear', 'reserve', 'resize',
  'make_shared', 'make_unique', 'move', 'forward', 'swap',
  'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
]);

const IGNORED_BY_LANGUAGE: Record<string, Set<string>> = {
  Python: PYTHON_IGNORED,
  TypeScript: JS_IGNORED,
  JavaScript: JS_IGNORED,
  Go: GO_IGNORED,
  Rust: RUST_IGNORED,
  Ruby: RUBY_IGNORED,
  Java: JVM_IGNORED,
  Kotlin: JVM_IGNORED,
  Scala: JVM_IGNORED,
  'C#': JVM_IGNORED,
  Swift: SWIFT_IGNORED,
  'C++': CFAMILY_IGNORED,
  C: CFAMILY_IGNORED,
};

// Union of every language's set — the fallback for callers that pass no
// language (and languages without a dedicated set), preserving legacy behavior.
const ALL_IGNORED_CALLEES = new Set<string>(
  Object.values(IGNORED_BY_LANGUAGE).flatMap(s => Array.from(s))
);

/**
 * Returns true if the name should be skipped as a call target.
 * Pass the source `language` so only that language's builtins are ignored;
 * omit it (or pass an unmapped language) to fall back to the cross-language
 * union (legacy behavior).
 */
function isIgnoredCallee(name: string, language?: string): boolean {
  // ALL_CAPS names (3+ chars) are almost certainly C/C++ macros (or constants),
  // not function calls — skip regardless of language.
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(name)) return true;
  const set = language ? IGNORED_BY_LANGUAGE[language] : undefined;
  if (set) return set.has(name);
  if (ALL_IGNORED_CALLEES.has(name)) return true;
  return false;
}

// ============================================================================
// PARSER SINGLETONS (lazy init)
// ============================================================================

let _tsParser: Parser | undefined;
let _pyParser: Parser | undefined;
let _goParser: Parser | undefined;
let _rustParser: Parser | undefined;
let _rubyParser: Parser | undefined;
let _javaParser: Parser | undefined;
let _cppParser: Parser | undefined;
let _swiftParser: Parser | undefined;
let _phpParser: Parser | undefined;
let _csParser: Parser | undefined;
let _ktParser: Parser | undefined;
let _scalaParser: Parser | undefined;
let _exParser: Parser | undefined;

// null = tried and unavailable; undefined = not yet tried
let _NativeParser: (typeof Parser) | null | undefined;
let _NativeQuery: (typeof Parser.Query) | null | undefined;

async function loadNativeParser(): Promise<typeof Parser | null> {
  if (_NativeParser === undefined) {
    try {
      const m = ((await import('tree-sitter')).default) as typeof Parser;
      _NativeParser = m;
      _NativeQuery = m.Query;
    } catch {
      _NativeParser = null;
      _NativeQuery = null;
    }
  }
  return _NativeParser;
}
let _TsLanguage: object | undefined;
let _PyLanguage: object | undefined;
let _GoLanguage: object | undefined;
let _RustLanguage: object | undefined;
let _RubyLanguage: object | undefined;
let _JavaLanguage: object | undefined;
let _CppLanguage: object | undefined;
let _SwiftLanguage: object | undefined;
let _PhpLanguage: object | undefined;
let _CsLanguage: object | undefined;
let _KtLanguage: object | undefined;
let _ScalaLanguage: object | undefined;
let _ExLanguage: object | undefined;

async function getTSParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_tsParser) {
    const tsModule = await import('tree-sitter-typescript');
    _TsLanguage = (tsModule.default as { typescript: object }).typescript;
    _tsParser = new NP();
    _tsParser.setLanguage(_TsLanguage as unknown as Parser.Language);
  }
  return { parser: _tsParser!, lang: _TsLanguage! };
}

async function getPyParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_pyParser) {
    const pyModule = await import('tree-sitter-python');
    _PyLanguage = pyModule.default;
    _pyParser = new NP();
    _pyParser.setLanguage(_PyLanguage as unknown as Parser.Language);
  }
  return { parser: _pyParser!, lang: _PyLanguage! };
}

async function getGoParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_goParser) {
    const goModule = await import('tree-sitter-go');
    _GoLanguage = goModule.default;
    _goParser = new NP();
    _goParser.setLanguage(_GoLanguage as unknown as Parser.Language);
  }
  return { parser: _goParser!, lang: _GoLanguage! };
}

async function getRustParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_rustParser) {
    const rustModule = await import('tree-sitter-rust');
    _RustLanguage = rustModule.default;
    _rustParser = new NP();
    _rustParser.setLanguage(_RustLanguage as unknown as Parser.Language);
  }
  return { parser: _rustParser!, lang: _RustLanguage! };
}

async function getRubyParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_rubyParser) {
    const rubyModule = await import('tree-sitter-ruby');
    _RubyLanguage = rubyModule.default;
    _rubyParser = new NP();
    _rubyParser.setLanguage(_RubyLanguage as unknown as Parser.Language);
  }
  return { parser: _rubyParser!, lang: _RubyLanguage! };
}

async function getJavaParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_javaParser) {
    const javaModule = await import('tree-sitter-java');
    _JavaLanguage = javaModule.default;
    _javaParser = new NP();
    _javaParser.setLanguage(_JavaLanguage as unknown as Parser.Language);
  }
  return { parser: _javaParser!, lang: _JavaLanguage! };
}

async function getPhpParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_phpParser) {
    const phpModule = await import('tree-sitter-php');
    _PhpLanguage = (phpModule.default as { php: object }).php;
    _phpParser = new NP();
    _phpParser.setLanguage(_PhpLanguage as unknown as Parser.Language);
  }
  return { parser: _phpParser!, lang: _PhpLanguage! };
}

async function getCSharpParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_csParser) {
    const csModule = await import('tree-sitter-c-sharp');
    _CsLanguage = csModule.default;
    _csParser = new NP();
    _csParser.setLanguage(_CsLanguage as unknown as Parser.Language);
  }
  return { parser: _csParser!, lang: _CsLanguage! };
}

async function getKotlinParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_ktParser) {
    const ktModule = await import('tree-sitter-kotlin');
    _KtLanguage = ktModule.default;
    _ktParser = new NP();
    _ktParser.setLanguage(_KtLanguage as unknown as Parser.Language);
  }
  return { parser: _ktParser!, lang: _KtLanguage! };
}

async function getScalaParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_scalaParser) {
    const scalaModule = await import('tree-sitter-scala');
    _ScalaLanguage = (scalaModule as { default: object }).default;
    _scalaParser = new NP();
    _scalaParser.setLanguage(_ScalaLanguage as unknown as Parser.Language);
  }
  return { parser: _scalaParser!, lang: _ScalaLanguage! };
}

async function getElixirParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_exParser) {
    const exModule = await import('tree-sitter-elixir');
    _ExLanguage = exModule.default;
    _exParser = new NP();
    _exParser.setLanguage(_ExLanguage as unknown as Parser.Language);
  }
  return { parser: _exParser!, lang: _ExLanguage! };
}

async function getCppParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_cppParser) {
    const cppModule = await import('tree-sitter-cpp');
    _CppLanguage = cppModule.default;
    _cppParser = new NP();
    _cppParser.setLanguage(_CppLanguage as unknown as Parser.Language);
  }
  return { parser: _cppParser!, lang: _CppLanguage! };
}

async function getSwiftParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParser();
  if (!NP) return null;
  if (!_swiftParser) {
    const swiftModule = await import('tree-sitter-swift');
    _SwiftLanguage = swiftModule.default;
    _swiftParser = new NP();
    _swiftParser.setLanguage(_SwiftLanguage as unknown as Parser.Language);
  }
  return { parser: _swiftParser!, lang: _SwiftLanguage! };
}

// ============================================================================
// ATTRIBUTION HELPER
// ============================================================================

/**
 * Given a list of function nodes (with startIndex/endIndex) and a call position,
 * find the narrowest enclosing function node.
 */
function findEnclosingFunction(
  nodes: FunctionNode[],
  callPos: number
): FunctionNode | undefined {
  let best: FunctionNode | undefined;
  let bestSize = Infinity;
  for (const n of nodes) {
    if (n.startIndex <= callPos && callPos < n.endIndex) {
      const size = n.endIndex - n.startIndex;
      if (size < bestSize) {
        bestSize = size;
        best = n;
      }
    }
  }
  return best;
}

/**
 * Cross-domain code↔infra edges (spec-17).
 *
 * For each embedded IaC resource (Pulumi/CDK/CDKTF, declared inside a code file),
 * find the narrowest enclosing code function in the same file by line containment
 * and emit a `references` edge: enclosing function → resource. This is the single
 * deterministic link that crosses the code↔infra boundary, so the existing graph
 * traversal (which already walks `references` edges) answers "what infrastructure
 * does this code provision?" and the reverse, end-to-end.
 *
 * Resources with no enclosing function (e.g. Pulumi declared at module top level)
 * are left unlinked — there is no code unit to attribute them to. Standalone IaC
 * (.tf/.yaml) has no co-located code functions, so nothing matches.
 */
function linkCodeToInfra(
  iacNodes: FunctionNode[],
  allNodes: Map<string, FunctionNode>,
): CallEdge[] {
  // Index code (non-IaC, non-external) function nodes with known line ranges by file.
  const codeByFile = new Map<string, FunctionNode[]>();
  for (const n of allNodes.values()) {
    if (n.isExternal) continue;
    if (isIacLanguage(n.language)) continue;
    if (n.startLine === undefined || n.endLine === undefined) continue;
    const arr = codeByFile.get(n.filePath);
    if (arr) arr.push(n);
    else codeByFile.set(n.filePath, [n]);
  }
  if (codeByFile.size === 0) return [];

  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  // Deterministic: iterate resources in id order.
  const sorted = [...iacNodes].sort((a, b) => a.id.localeCompare(b.id));
  for (const res of sorted) {
    if (!isIacLanguage(res.language)) continue;
    if (res.startLine === undefined) continue;
    const candidates = codeByFile.get(res.filePath);
    if (!candidates) continue;

    // Narrowest code function whose line range encloses the resource declaration.
    let best: FunctionNode | undefined;
    let bestSpan = Infinity;
    for (const fn of candidates) {
      if (fn.startLine! <= res.startLine && res.startLine <= fn.endLine!) {
        const span = fn.endLine! - fn.startLine!;
        if (span < bestSpan) { bestSpan = span; best = fn; }
      }
    }
    if (!best || best.id === res.id) continue;

    const key = `${best.id}\0${res.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      callerId: best.id,
      calleeId: res.id,
      calleeName: res.name,
      line: res.startLine,
      confidence: 'import',
      kind: 'references',
    });
  }
  return edges;
}

// ============================================================================
// DOCSTRING / SIGNATURE EXTRACTION HELPERS
// ============================================================================

/**
 * Scan backward from `startIndex` in `source` to find the doc comment
 * immediately preceding the function declaration. Skip blank lines.
 *
 * For Python, docstrings are INSIDE the function body — scan forward from
 * `startIndex` past the `def name(...):` colon to find the triple-quoted string.
 *
 * Returns the first meaningful (non-empty, non-decorator) line of the comment.
 */
function extractDocstringBefore(
  source: string,
  startIndex: number,
  language: string
): string | undefined {
  // ── Python: scan forward past the colon into the function body ──────────
  if (language === 'Python') {
    // Find the colon that ends the `def` line. Track bracket depth so a colon
    // inside a parameter annotation (`def f(x: int) -> T:`) doesn't end the scan
    // prematurely — mirrors the depth handling in extractDeclaration below.
    let i = startIndex;
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ':' && depth === 0) break;
      i++;
    }
    // Skip past the colon
    i++;
    // Skip whitespace / newline
    while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\n' || source[i] === '\r')) i++;
    // Check for triple-quoted docstring
    const tripleDouble = source.startsWith('"""', i);
    const tripleSingle = source.startsWith("'''", i);
    if (tripleDouble || tripleSingle) {
      const quote = tripleDouble ? '"""' : "'''";
      const bodyStart = i + 3;
      const closeIdx = source.indexOf(quote, bodyStart);
      if (closeIdx === -1) return undefined;
      const inner = source.slice(bodyStart, closeIdx);
      const firstLine = inner.split('\n').map(l => l.trim()).find(l => l.length > 0);
      return firstLine ?? undefined;
    }
    return undefined;
  }

  // ── All other languages: scan backward from startIndex ─────────────────
  // Move to the character just before startIndex
  let pos = startIndex - 1;

  // Skip trailing whitespace / newlines before the declaration
  while (pos >= 0 && (source[pos] === ' ' || source[pos] === '\t' || source[pos] === '\n' || source[pos] === '\r')) {
    pos--;
  }

  if (pos < 0) return undefined;

  // ── TypeScript / JavaScript / Java / C++: JSDoc block /** ... */ ────────
  if (
    language === 'TypeScript' || language === 'JavaScript' ||
    language === 'Java' || language === 'C++'
  ) {
    // Expect closing */ of a JSDoc block
    if (source[pos] === '/' && pos > 0 && source[pos - 1] === '*') {
      const closePos = pos - 1; // points at '*' of closing '*/'
      // Find opening /**
      const openIdx = source.lastIndexOf('/**', closePos);
      if (openIdx === -1) return undefined;
      const inner = source.slice(openIdx + 3, closePos - 0);
      // Remove leading * on each line, find first non-empty, non-@ line
      const firstLine = inner
        .split('\n')
        .map(l => l.replace(/^\s*\*\s?/, '').trim())
        .find(l => l.length > 0 && !l.startsWith('@'));
      return firstLine ?? undefined;
    }
    return undefined;
  }

  // ── Go: // comment lines immediately before ──────────────────────────────
  if (language === 'Go') {
    const lines: string[] = [];
    // Walk backward line by line
    let lineEnd = pos;
    while (lineEnd >= 0) {
      // Find start of this line
      let lineStart = lineEnd;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      const line = source.slice(lineStart, lineEnd + 1).trimEnd();
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) {
        lines.unshift(trimmed.slice(2).trim());
        lineEnd = lineStart - 1;
        // Skip over the newline
        while (lineEnd >= 0 && (source[lineEnd] === '\n' || source[lineEnd] === '\r')) lineEnd--;
      } else {
        break;
      }
    }
    return lines.find(l => l.length > 0) ?? undefined;
  }

  // ── Rust / Swift: /// doc comment lines immediately before ─────────────
  if (language === 'Rust' || language === 'Swift') {
    const lines: string[] = [];
    let lineEnd = pos;
    while (lineEnd >= 0) {
      let lineStart = lineEnd;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      const line = source.slice(lineStart, lineEnd + 1).trimEnd();
      const trimmed = line.trim();
      if (trimmed.startsWith('///')) {
        lines.unshift(trimmed.slice(3).trim());
        lineEnd = lineStart - 1;
        while (lineEnd >= 0 && (source[lineEnd] === '\n' || source[lineEnd] === '\r')) lineEnd--;
      } else {
        break;
      }
    }
    return lines.find(l => l.length > 0) ?? undefined;
  }

  // ── Ruby: # comment lines immediately before ─────────────────────────────
  if (language === 'Ruby') {
    const lines: string[] = [];
    let lineEnd = pos;
    while (lineEnd >= 0) {
      let lineStart = lineEnd;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      const line = source.slice(lineStart, lineEnd + 1).trimEnd();
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        lines.unshift(trimmed.slice(1).trim());
        lineEnd = lineStart - 1;
        while (lineEnd >= 0 && (source[lineEnd] === '\n' || source[lineEnd] === '\r')) lineEnd--;
      } else {
        break;
      }
    }
    return lines.find(l => l.length > 0) ?? undefined;
  }

  return undefined;
}

/**
 * Extract the function declaration (signature without body) from
 * `source.slice(startIndex, endIndex)`.
 *
 * Strategy:
 * - TS/JS/Java/C++/Go/Rust/Ruby: take everything up to the first `{` at depth 0
 * - Python: take everything up to the first `:` that ends the `def` line
 *
 * Whitespace is normalized (multiple spaces/newlines → single space).
 * Limited to 300 characters max.
 */
function extractDeclaration(
  source: string,
  startIndex: number,
  endIndex: number,
  language: string
): string {
  const slice = source.slice(startIndex, Math.min(endIndex, startIndex + 1500));

  let decl: string;

  if (language === 'Python') {
    // Take up to (not including) the first `:` that ends the def line
    // We scan for `:` while tracking parenthesis depth to avoid matching
    // colons inside type annotations (e.g., def f(x: int) -> dict[str, int]:)
    let depth = 0;
    let end = -1;
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ':' && depth === 0) {
        end = i;
        break;
      }
    }
    decl = end !== -1 ? slice.slice(0, end) : slice.slice(0, 300);
  } else {
    // Find first `{` at brace depth 0
    let depth = 0;
    let end = -1;
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i];
      if (ch === '{') {
        if (depth === 0) { end = i; break; }
        depth++;
      } else if (ch === '}') {
        depth--;
      }
    }
    decl = end !== -1 ? slice.slice(0, end) : slice.slice(0, 300);
  }

  // Normalize whitespace
  return decl.replace(/\s+/g, ' ').trim().slice(0, 300);
}

// ============================================================================
// CFG / DATA-FLOW OVERLAY HELPER (spec: add-intraprocedural-cfg-dataflow-overlay)
// ============================================================================

/**
 * Build the per-function CFG + reaching-definitions overlay for one function
 * while its parse tree is still live. `fnNode` is the node captured as the
 * function (may be a declaration wrapper, e.g. a `const f = () => {}`
 * lexical_declaration); this resolves to the node that actually owns the body
 * so arrow/function-expression bodies and params are analyzed too. Fail-soft:
 * returns undefined for unsupported languages or any analysis surprise.
 */
function buildCfgFor(fnNode: CfgNode, language: string): FunctionCfg | undefined {
  // The overlay is strictly additive: a CFG-builder surprise (an unexpected
  // grammar shape, a partially-loaded optional grammar after the tree-sitter
  // deps became optional) must never propagate and drop the function's node/edge
  // data from the call graph — or, in watch mode, roll back the per-file swap.
  // Fail soft to no overlay; the base call graph is unaffected.
  try {
    let target = fnNode;
    if (!fnNode.childForFieldName('body')) {
      // Dig (breadth-first) for the node that actually owns the body: a TS arrow/
      // function-expression assigned to a variable, or — crucially — the inner
      // `function_definition` of a Python `@decorator`'d function, whose captured
      // node is the `decorated_definition` wrapper (no `body` field of its own).
      const stack = [...fnNode.namedChildren];
      while (stack.length) {
        const n = stack.shift()!;
        if (
          (n.type === 'arrow_function' || n.type === 'function_expression' ||
           n.type === 'function' || n.type === 'function_definition') &&
          n.childForFieldName('body')
        ) { target = n; break; }
        stack.push(...n.namedChildren);
      }
    }
    return buildFunctionCfg(target as unknown as CfgNode, language);
  } catch (error) {
    if (process.env.DEBUG) {
      console.debug(`[cfg] overlay skipped for a ${language} function: ${(error as Error).message}`);
    }
    return undefined;
  }
}

// ============================================================================
// TYPESCRIPT EXTRACTOR
// ============================================================================

const TS_FN_QUERY = `
  (function_declaration
    name: (identifier) @fn.name) @fn.node

  (export_statement
    declaration: (function_declaration
      name: (identifier) @fn.name)) @fn.node

  (method_definition
    name: (property_identifier) @fn.name) @fn.node

  (lexical_declaration
    (variable_declarator
      name: (identifier) @fn.name
      value: [(arrow_function) (function_expression)] @fn.value)) @fn.node

  (variable_declaration
    (variable_declarator
      name: (identifier) @fn.name
      value: [(arrow_function) (function_expression)] @fn.value)) @fn.node

  (assignment_expression
    left: [(identifier) (member_expression)] @fn.name
    right: [(arrow_function) (function_expression)] @fn.value) @fn.node

  (public_field_definition
    name: (property_identifier) @fn.name
    value: [(arrow_function) (function_expression)] @fn.value) @fn.node
`;

const TS_CALL_QUERY = `
  (call_expression
    function: [(identifier) @call.name
               (member_expression
                 object: (identifier) @call.object
                 property: (property_identifier) @call.name)]) @call.node
`;

async function extractTSGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[]; cfg: Map<string, FunctionCfg> }> {
  const r = await getTSParser();
  if (!r) return { nodes: [], rawEdges: [], cfg: new Map() };
  const { parser, lang } = r;
  const tree = (parser as Parser).parse(content);

  const fnQuery = new _NativeQuery!(lang as unknown as Parser.Language, TS_FN_QUERY);
  const callQuery = new _NativeQuery!(lang as unknown as Parser.Language, TS_CALL_QUERY);

  // --- Extract function nodes ---
  const nodes: FunctionNode[] = [];
  const cfg = new Map<string, FunctionCfg>();
  const fnMatches = fnQuery.matches(tree.rootNode);

  for (const match of fnMatches) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    // For member-assigned functions (`app.use = …`, `Foo.prototype.bar = …`) the
    // name capture is the whole `member_expression`; its text is the dotted path.
    // Collapse any incidental whitespace (a LHS split across lines) so the derived
    // name — and therefore the node id and stableId — stay stable and readable.
    const name = nameCapture.node.type === 'member_expression'
      ? nameCapture.node.text.replace(/\s+/g, '')
      : nameCapture.node.text;
    const fnNode = nodeCapture.node;
    // The arrow/function-expression RHS for binding/assignment/field shapes
    // (`const f = async …`, `exports.h = async function …`, `x = async () => …`).
    // For function_declaration / method_definition arms there is no value capture
    // and async lives on fnNode itself.
    const valueNode = match.captures.find(c => c.name === 'fn.value')?.node;

    // Find enclosing class (walk up — skip class_body, its children are methods not the name)
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class_declaration') {
        const classNameNode = cursor.children.find(c => c.type === 'type_identifier' || c.type === 'identifier');
        if (classNameNode) className = classNameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    // Detect async. For binding/assignment/field shapes the keyword is on the
    // captured RHS (`async () => {}`, `async function () {}`), NOT on the
    // enclosing declaration/assignment whose text starts with `const`/`var`/
    // `exports.…`. Prefer the value node when present; otherwise fall back to
    // fnNode (function_declaration / method_definition, which carry `async` directly).
    const asyncNode = valueNode ?? fnNode;
    const isAsync = asyncNode.children.some(c => c.type === 'async') ||
      asyncNode.text.startsWith('async ') ||
      asyncNode.text.startsWith('async(');

    const id = className
      ? `${filePath}::${className}.${name}`
      : `${filePath}::${name}`;

    nodes.push({
      id,
      name,
      filePath,
      className,
      isAsync,
      language: 'TypeScript',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0,
      fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'TypeScript'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'TypeScript'),
    });

    const fnCfg = buildCfgFor(fnNode, 'TypeScript');
    if (fnCfg) cfg.set(id, fnCfg);
  }

  // --- Extract calls ---
  const rawEdges: RawEdge[] = [];
  const callMatches = callQuery.matches(tree.rootNode);

  for (const match of callMatches) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName, 'TypeScript')) continue;

    const callPos = nodeCapture.node.startIndex;
    const caller = findEnclosingFunction(nodes, callPos);
    if (!caller) continue;

    // Detect call type from AST parent context
    let callType: CallType = objectCapture ? 'method' : 'direct';
    const parentType = nodeCapture.node.parent?.type;
    if (parentType === 'await_expression') callType = 'awaited';
    else if (parentType === 'new_expression') callType = 'constructor';

    rawEdges.push({
      callerId: caller.id,
      calleeName,
      line: nodeCapture.node.startPosition.row + 1,
      calleeObject: objectCapture?.node.text,
      callType,
    });
  }

  return { nodes, rawEdges, cfg };
}

// ============================================================================
// PYTHON EXTRACTOR
// ============================================================================

const PY_FN_QUERY = `
  (function_definition
    name: (identifier) @fn.name) @fn.node

  (decorated_definition
    (function_definition
      name: (identifier) @fn.name)) @fn.node
`;

/**
 * Direct function calls: foo(), bar(x)
 * We keep this separate from attribute calls so we can filter attribute calls
 * by object name (only self/cls are resolved to internal functions).
 */
const PY_DIRECT_CALL_QUERY = `
  (call
    function: (identifier) @call.name) @call.node
`;

/**
 * Method calls on an object: obj.method()
 * We capture the object name so we can restrict resolution to self/cls.
 * Calls like redis.get(), dict.get(), os.environ.get() are NOT resolved —
 * only self.method() and cls.method() are tracked as internal edges.
 */
const PY_METHOD_CALL_QUERY = `
  (call
    function: (attribute
      object: (identifier) @call.object
      attribute: (identifier) @call.name)) @call.node
`;

async function extractPyGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[]; cfg: Map<string, FunctionCfg> }> {
  const r = await getPyParser();
  if (!r) return { nodes: [], rawEdges: [], cfg: new Map() };
  const { parser, lang } = r;
  const tree = (parser as Parser).parse(content);

  const fnQuery = new _NativeQuery!(lang as unknown as Parser.Language, PY_FN_QUERY);

  // --- Extract function nodes ---
  const nodes: FunctionNode[] = [];
  const cfg = new Map<string, FunctionCfg>();
  const seen = new Set<number>(); // avoid duplicates from decorated_definition + function_definition
  const fnMatches = fnQuery.matches(tree.rootNode);

  for (const match of fnMatches) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Deduplicate by name node position (decorated_definition wraps the function_definition)
    if (seen.has(nameCapture.node.startIndex)) continue;
    seen.add(nameCapture.node.startIndex);

    // Find enclosing class
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class_definition') {
        const classNameNode = cursor.children.find(c => c.type === 'identifier');
        if (classNameNode) className = classNameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    // Skip private methods (underscore prefix) unless they're __init__ or there are very few nodes
    if (name.startsWith('_') && name !== '__init__') continue;

    const isAsync = fnNode.text.startsWith('async ') ||
      (fnNode.type === 'function_definition' && fnNode.children[0]?.text === 'async');

    const id = className
      ? `${filePath}::${className}.${name}`
      : `${filePath}::${name}`;

    nodes.push({
      id,
      name,
      filePath,
      className,
      isAsync,
      language: 'Python',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0,
      fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Python'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Python'),
    });

    const fnCfg = buildCfgFor(fnNode, 'Python');
    if (fnCfg) cfg.set(id, fnCfg);
  }

  // --- Extract calls ---
  const rawEdges: RawEdge[] = [];

  const directCallQuery = new _NativeQuery!(lang as unknown as Parser.Language, PY_DIRECT_CALL_QUERY);
  const methodCallQuery = new _NativeQuery!(lang as unknown as Parser.Language, PY_METHOD_CALL_QUERY);

  // Direct calls: foo(), bar(x) — resolve across all files
  for (const match of directCallQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName, 'Python')) continue;

    const callPos = nodeCapture.node.startIndex;
    const caller = findEnclosingFunction(nodes, callPos);
    if (!caller) continue;

    // In Python tree-sitter, `await expr` wraps the call: parent type is 'await'
    const callType: CallType = nodeCapture.node.parent?.type === 'await' ? 'awaited' : 'direct';
    rawEdges.push({
      callerId: caller.id,
      calleeName,
      line: nodeCapture.node.startPosition.row + 1,
      callType,
    });
  }

  // Method calls: obj.method() — capture receiver for type-inference-based resolution
  for (const match of methodCallQuery.matches(tree.rootNode)) {
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!objectCapture || !nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName, 'Python')) continue;

    const callPos = nodeCapture.node.startIndex;
    const caller = findEnclosingFunction(nodes, callPos);
    if (!caller) continue;

    const methodCallType: CallType = nodeCapture.node.parent?.type === 'await' ? 'awaited' : 'method';
    rawEdges.push({
      callerId: caller.id,
      calleeName,
      line: nodeCapture.node.startPosition.row + 1,
      calleeObject: objectCapture.node.text,
      callType: methodCallType,
    });
  }

  return { nodes, rawEdges, cfg };
}

// ============================================================================
// GO EXTRACTOR
// ============================================================================

const GO_FN_QUERY = `
  (function_declaration
    name: (identifier) @fn.name) @fn.node

  (method_declaration
    name: (field_identifier) @fn.name) @fn.node
`;

const GO_CALL_QUERY = `
  (call_expression
    function: (identifier) @call.name) @call.node

  (call_expression
    function: (selector_expression
      operand: (identifier) @call.object
      field: (field_identifier) @call.name)) @call.node
`;

async function extractGoGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[]; cfg: Map<string, FunctionCfg> }> {
  const r = await getGoParser();
  if (!r) return { nodes: [], rawEdges: [], cfg: new Map() };
  const { parser, lang } = r;
  const tree = (parser as Parser).parse(content);

  const fnQuery = new _NativeQuery!(lang as unknown as Parser.Language, GO_FN_QUERY);
  const callQuery = new _NativeQuery!(lang as unknown as Parser.Language, GO_CALL_QUERY);

  const nodes: FunctionNode[] = [];
  const cfg = new Map<string, FunctionCfg>();
  for (const match of fnQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Receiver type for method_declaration → use as className
    let className: string | undefined;
    if (fnNode.type === 'method_declaration') {
      const receiver = fnNode.children.find(c => c.type === 'parameter_list');
      if (receiver) {
        // Extract type name from receiver: (r *MyStruct) → MyStruct
        const typeNode = receiver.descendantsOfType('type_identifier')[0]
          ?? receiver.descendantsOfType('pointer_type')[0];
        if (typeNode) className = typeNode.text.replace(/^\*/, '');
      }
    }

    const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
    nodes.push({
      id, name, filePath, className,
      isAsync: false, // Go has goroutines, not async/await
      language: 'Go',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0, fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Go'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Go'),
    });

    const fnCfg = buildCfgFor(fnNode, 'Go');
    if (fnCfg) cfg.set(id, fnCfg);
  }

  const rawEdges: RawEdge[] = [];
  for (const match of callQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName, 'Go')) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject: objectCapture?.node.text });
  }

  return { nodes, rawEdges, cfg };
}

// ============================================================================
// RUST EXTRACTOR
// ============================================================================

const RUST_FN_QUERY = `
  (function_item
    name: (identifier) @fn.name) @fn.node
`;

const RUST_CALL_QUERY = `
  (call_expression
    function: (identifier) @call.name) @call.node

  (call_expression
    function: (field_expression
      value: (identifier) @call.object
      field: (field_identifier) @call.name)) @call.node
`;

async function extractRustGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[]; cfg: Map<string, FunctionCfg> }> {
  const r = await getRustParser();
  if (!r) return { nodes: [], rawEdges: [], cfg: new Map() };
  const { parser, lang } = r;
  const tree = (parser as Parser).parse(content);

  const fnQuery = new _NativeQuery!(lang as unknown as Parser.Language, RUST_FN_QUERY);
  const callQuery = new _NativeQuery!(lang as unknown as Parser.Language, RUST_CALL_QUERY);

  const nodes: FunctionNode[] = [];
  const cfg = new Map<string, FunctionCfg>();
  for (const match of fnQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Find enclosing impl block → use the IMPLEMENTING TYPE as className.
    // Use the `type` field, not the first `type_identifier`: for
    // `impl Trait for Struct` the first type_identifier is the TRAIT, which would
    // wrongly attribute the method to the trait (and collide across all impls of
    // that trait). `impl<T> Box<T>` exposes a `generic_type` node, so strip the
    // generic args to key methods on `Box`, not the whole generic application.
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'impl_item') {
        const typeNode = cursor.childForFieldName('type');
        if (typeNode) className = typeNode.text.replace(/<[\s\S]*>$/, '').trim();
        break;
      }
      cursor = cursor.parent;
    }

    // Rust: async keyword lives inside a function_modifiers child
    const isAsync = fnNode.children.some(
      c => c.type === 'function_modifiers' && c.text.includes('async')
    );
    const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
    nodes.push({
      id, name, filePath, className,
      isAsync,
      language: 'Rust',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0, fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Rust'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Rust'),
    });

    const fnCfg = buildCfgFor(fnNode, 'Rust');
    if (fnCfg) cfg.set(id, fnCfg);
  }

  const rawEdges: RawEdge[] = [];
  for (const match of callQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName, 'Rust')) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject: objectCapture?.node.text });
  }

  return { nodes, rawEdges, cfg };
}

// ============================================================================
// RUBY EXTRACTOR
// ============================================================================

const RUBY_FN_QUERY = `
  (method
    name: (identifier) @fn.name) @fn.node

  (singleton_method
    name: (identifier) @fn.name) @fn.node
`;

// Explicit calls: fn(), obj.method()
const RUBY_CALL_QUERY = `
  (call
    receiver: (identifier) @call.object
    method: (identifier) @call.name) @call.node

  (call
    method: (identifier) @call.name) @call.node
`;

// Bareword calls: Ruby allows calling methods without parentheses.
// An identifier at statement level inside a body_statement is almost always
// a method call (variable usage appears in assignments/expressions, not alone).
const RUBY_BAREWORD_QUERY = `
  (body_statement
    (identifier) @call.name)
`;

async function extractRubyGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[]; cfg: Map<string, FunctionCfg> }> {
  const r = await getRubyParser();
  if (!r) return { nodes: [], rawEdges: [], cfg: new Map() };
  const { parser, lang } = r;
  const tree = (parser as Parser).parse(content);

  const fnQuery = new _NativeQuery!(lang as unknown as Parser.Language, RUBY_FN_QUERY);
  const callQuery = new _NativeQuery!(lang as unknown as Parser.Language, RUBY_CALL_QUERY);
  const barewordQuery = new _NativeQuery!(lang as unknown as Parser.Language, RUBY_BAREWORD_QUERY);

  const nodes: FunctionNode[] = [];
  const cfg = new Map<string, FunctionCfg>();
  for (const match of fnQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Find enclosing class/module
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class' || cursor.type === 'module') {
        const nameNode = cursor.children.find(c => c.type === 'constant' || c.type === 'scope_resolution');
        if (nameNode) className = nameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
    nodes.push({
      id, name, filePath, className,
      isAsync: false,
      language: 'Ruby',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0, fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Ruby'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Ruby'),
    });

    const fnCfg = buildCfgFor(fnNode, 'Ruby');
    if (fnCfg) cfg.set(id, fnCfg);
  }

  // Explicit calls: fn(), obj.method(). RUBY_CALL_QUERY has the same two-pattern
  // overlap as Java (a bare `method:` pattern that also matches `receiver.method`),
  // so dedupe per call site to avoid emitting both `obj.method` and a bare `method`.
  const rawEdges = dedupeOverlappingCalls(callQuery, tree.rootNode, nodes, 'Ruby');

  // Bareword calls: identifier at statement level, no parens
  for (const match of barewordQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    if (!nameCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName, 'Ruby')) continue;

    const caller = findEnclosingFunction(nodes, nameCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nameCapture.node.startPosition.row + 1 });
  }

  return { nodes, rawEdges, cfg };
}

// ============================================================================
// JAVA EXTRACTOR
// ============================================================================

const JAVA_FN_QUERY = `
  (method_declaration
    name: (identifier) @fn.name) @fn.node

  (constructor_declaration
    name: (identifier) @fn.name) @fn.node
`;

const JAVA_CALL_QUERY = `
  (method_invocation
    object: (identifier) @call.object
    name: (identifier) @call.name) @call.node

  (method_invocation
    name: (identifier) @call.name) @call.node

  (object_creation_expression
    type: (type_identifier) @call.name) @call.node

  (object_creation_expression
    type: (generic_type (type_identifier) @call.name)) @call.node

  (method_reference (identifier) @call.name .) @call.node
`;

/**
 * Build raw call edges from a call query whose patterns overlap on the same
 * invocation node — e.g. a qualified `object.name(...)` pattern plus a bare
 * `name(...)` pattern where the bare one also matches qualified calls (Java,
 * Ruby). Without deduplication each qualified call emits two edges (a qualified
 * `Obj.name` and a bare `name`), doubling fan-out and inflating the external
 * node set. We keep one edge per invocation node, preferring the match that
 * carries the receiver (`@call.object`).
 */
function dedupeOverlappingCalls(
  callQuery: Parser.Query,
  root: Parser.SyntaxNode,
  nodes: FunctionNode[],
  language: string
): RawEdge[] {
  const callByNode = new Map<number, { calleeName: string; calleeObject?: string; node: Parser.SyntaxNode }>();
  for (const match of callQuery.matches(root)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    // Key by the callee NAME position, not the invocation node: in a chained
    // call like `a.b().c()` the inner and outer method_invocation nodes share a
    // startIndex (both begin at `a`), so keying by the node would collapse them
    // and drop the outer `.c()` call. The name identifiers (`b`, `c`) are at
    // distinct positions, while the two overlapping patterns for ONE call (the
    // bug we are deduping) capture the SAME name node — exactly the right key.
    const key = nameCapture.node.startIndex;
    const existing = callByNode.get(key);
    // First match for this call site, or upgrade a bare match to the qualified one.
    if (!existing || (objectCapture && !existing.calleeObject)) {
      callByNode.set(key, {
        calleeName: nameCapture.node.text,
        calleeObject: objectCapture?.node.text,
        node: nodeCapture.node,
      });
    }
  }

  const rawEdges: RawEdge[] = [];
  for (const call of callByNode.values()) {
    if (isIgnoredCallee(call.calleeName, language)) continue;
    const caller = findEnclosingFunction(nodes, call.node.startIndex);
    if (!caller) continue;
    rawEdges.push({ callerId: caller.id, calleeName: call.calleeName, line: call.node.startPosition.row + 1, calleeObject: call.calleeObject });
  }
  return rawEdges;
}

/**
 * Synthesize call edges for Java `super(...)` explicit constructor invocations.
 *
 * A `super(...)` call targets the PARENT class's constructor, which is keyed in
 * the graph by the parent's simple name (constructors are named after their
 * class). We read each class's parent from its `extends` clause and emit a
 * constructor-typed edge from the enclosing constructor to the parent name.
 *
 * `this(...)` is intentionally skipped: overloaded constructors collapse to a
 * single node, so a `this(...)` edge would only ever be a self-loop.
 *
 * Edges whose parent does not resolve to an internal node (e.g. `extends
 * RuntimeException`) are dropped during resolution — the `callType: 'constructor'`
 * marker tells Strategy 4 not to manufacture an external leaf node for them, so
 * the external-node set stays clean.
 */
function synthesizeJavaSuperCalls(
  root: Parser.SyntaxNode,
  nodes: FunctionNode[],
  lang: unknown
): RawEdge[] {
  // class simple-name → parent simple-name, from `extends` clauses.
  const parentOf = new Map<string, string>();
  const clsQuery = new _NativeQuery!(
    lang as Parser.Language,
    `(class_declaration name: (identifier) @cls (superclass (type_identifier) @parent))`
  );
  for (const m of clsQuery.matches(root)) {
    const cls = m.captures.find(c => c.name === 'cls')?.node.text;
    const parent = m.captures.find(c => c.name === 'parent')?.node.text;
    if (cls && parent) parentOf.set(cls, parent);
  }
  if (parentOf.size === 0) return [];

  const out: RawEdge[] = [];
  const ctorQuery = new _NativeQuery!(
    lang as Parser.Language,
    `(explicit_constructor_invocation (super)) @node`
  );
  for (const m of ctorQuery.matches(root)) {
    const node = m.captures.find(c => c.name === 'node')?.node;
    if (!node) continue;
    const caller = findEnclosingFunction(nodes, node.startIndex);
    if (!caller?.className) continue;
    const parent = parentOf.get(caller.className);
    if (!parent) continue;
    out.push({ callerId: caller.id, calleeName: parent, line: node.startPosition.row + 1, callType: 'constructor' });
  }
  return out;
}

async function extractJavaGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[]; cfg: Map<string, FunctionCfg> }> {
  const r = await getJavaParser();
  if (!r) return { nodes: [], rawEdges: [], cfg: new Map() };
  const { parser, lang } = r;
  const tree = (parser as Parser).parse(content);

  const fnQuery = new _NativeQuery!(lang as unknown as Parser.Language, JAVA_FN_QUERY);
  const callQuery = new _NativeQuery!(lang as unknown as Parser.Language, JAVA_CALL_QUERY);

  const nodes: FunctionNode[] = [];
  const cfg = new Map<string, FunctionCfg>();
  for (const match of fnQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Find enclosing class/interface/enum/record. Walk to the NEAREST type so a
    // method inside `record LineItem { … }` nested in an outer class is attributed
    // to LineItem, not the outer class.
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (
        cursor.type === 'class_declaration' ||
        cursor.type === 'interface_declaration' ||
        cursor.type === 'enum_declaration' ||
        cursor.type === 'record_declaration'
      ) {
        const nameNode = cursor.children.find(c => c.type === 'identifier');
        if (nameNode) className = nameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    const isAsync = false; // Java uses Future/CompletableFuture, not async keyword
    const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
    if (nodes.some(n => n.id === id)) continue; // collapse overloads (same name) to one node
    nodes.push({
      id, name, filePath, className,
      isAsync,
      language: 'Java',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0, fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Java'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Java'),
    });

    const fnCfg = buildCfgFor(fnNode, 'Java');
    if (fnCfg) cfg.set(id, fnCfg);
  }

  // JAVA_CALL_QUERY has two patterns: a qualified `object.name(...)` pattern and a
  // bare `name(...)` pattern. A qualified invocation like `Money.of(...)` matches
  // BOTH (the second pattern ignores the object field), which would emit two edges
  // for one call site — a qualified `Money.of` AND a bare `of` — doubling fan-out
  // and polluting the external-node set. Collapse to one edge per invocation node,
  // preferring the qualified match (it carries the receiver).
  const rawEdges = dedupeOverlappingCalls(callQuery, tree.rootNode, nodes, 'Java');

  // super(...) constructor-chain edges (this(...) intentionally omitted).
  rawEdges.push(...synthesizeJavaSuperCalls(tree.rootNode, nodes, lang));

  return { nodes, rawEdges, cfg };
}

// ============================================================================
// C++ EXTRACTOR
// ============================================================================

/**
 * Safely run a tree-sitter query, returning [] if the S-expression is invalid
 * for the grammar. C++ grammar has many edge cases (templates, operators,
 * pointer declarators) that can make certain queries fail.
 */
function safeQuery(
  lang: object,
  queryStr: string,
  root: Parser.SyntaxNode
): Parser.QueryMatch[] {
  if (!_NativeQuery) return [];
  try {
    const q = new _NativeQuery(lang as unknown as Parser.Language, queryStr);
    return q.matches(root);
  } catch {
    return [];
  }
}

/** Free functions and inline class methods with a simple identifier name */
const CPP_FN_BASIC_QUERY = `
  (function_definition
    declarator: (function_declarator
      declarator: (identifier) @fn.name)) @fn.node

  (function_definition
    declarator: (function_declarator
      declarator: (field_identifier) @fn.name)) @fn.node
`;

/** Out-of-class definitions: void Foo::bar() {} */
const CPP_FN_QUALIFIED_QUERY = `
  (function_definition
    declarator: (function_declarator
      declarator: (qualified_identifier
        name: (identifier) @fn.name))) @fn.node
`;

/** Plain function calls: foo() */
const CPP_CALL_DIRECT_QUERY = `
  (call_expression
    function: (identifier) @call.name) @call.node
`;

/** Member calls: obj.method() and ptr->method() — captures receiver */
const CPP_CALL_MEMBER_QUERY = `
  (call_expression
    function: (field_expression
      argument: (identifier) @call.object
      field: (field_identifier) @call.name)) @call.node
`;

async function extractCppGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[]; cfg: Map<string, FunctionCfg> }> {
  const r = await getCppParser();
  if (!r) return { nodes: [], rawEdges: [], cfg: new Map() };
  const { parser, lang } = r;
  const tree = (parser as Parser).parse(content);

  const nodes: FunctionNode[] = [];
  const cfg = new Map<string, FunctionCfg>();
  const seen = new Set<number>(); // deduplicate by name-node start position

  for (const queryStr of [CPP_FN_BASIC_QUERY, CPP_FN_QUALIFIED_QUERY]) {
    for (const match of safeQuery(lang, queryStr, tree.rootNode)) {
      const nameCapture = match.captures.find(c => c.name === 'fn.name');
      const nodeCapture = match.captures.find(c => c.name === 'fn.node');
      if (!nameCapture || !nodeCapture) continue;

      if (seen.has(nameCapture.node.startIndex)) continue;
      seen.add(nameCapture.node.startIndex);

      const name = nameCapture.node.text;
      // Skip ALL_CAPS names — these are almost certainly macros, not functions
      if (/^[A-Z][A-Z0-9_]{2,}$/.test(name)) continue;
      const fnNode = nodeCapture.node;

      // Find enclosing class (inline method defined inside class body)
      let className: string | undefined;
      let cursor = fnNode.parent;
      while (cursor) {
        if (cursor.type === 'class_specifier' || cursor.type === 'struct_specifier') {
          const nameNode = cursor.children.find(c => c.type === 'type_identifier');
          if (nameNode) className = nameNode.text;
          break;
        }
        cursor = cursor.parent;
      }

      // For out-of-class: void Foo::bar() — extract class from qualified_identifier scope
      if (!className) {
        const fnDeclarator = fnNode.children.find(c => c.type === 'function_declarator');
        if (fnDeclarator) {
          const qualNode = fnDeclarator.children.find(c => c.type === 'qualified_identifier');
          if (qualNode) {
            const scopeNode = qualNode.children.find(
              c => c.type === 'namespace_identifier' || c.type === 'type_identifier'
            );
            if (scopeNode) className = scopeNode.text;
          }
        }
      }

      const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
      nodes.push({
        id, name, filePath, className,
        isAsync: false, // C++ has no async keyword at language level
        language: 'C++',
        startIndex: fnNode.startIndex,
        endIndex: fnNode.endIndex,
        fanIn: 0, fanOut: 0,
        docstring: extractDocstringBefore(content, fnNode.startIndex, 'C++'),
        signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'C++'),
      });

      const fnCfg = buildCfgFor(fnNode, 'C++');
      if (fnCfg) cfg.set(id, fnCfg);
    }
  }

  const rawEdges: RawEdge[] = [];

  // Plain calls: foo()
  for (const match of safeQuery(lang, CPP_CALL_DIRECT_QUERY, tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName, 'C++')) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1 });
  }

  // Member calls: obj.method() / ptr->method()
  for (const match of safeQuery(lang, CPP_CALL_MEMBER_QUERY, tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName, 'C++')) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject: objectCapture?.node.text });
  }

  return { nodes, rawEdges, cfg };
}

// ============================================================================
// SWIFT EXTRACTOR
// ============================================================================

// function_declaration covers free functions and methods inside class_body
const SWIFT_FN_QUERY = `
  (function_declaration
    name: (simple_identifier) @fn.name) @fn.node

  (init_declaration) @fn.node
`;

// Direct calls: foo()
const SWIFT_CALL_DIRECT_QUERY = `
  (call_expression
    (simple_identifier) @call.name) @call.node
`;

// Method calls: obj.method() / self.method()
const SWIFT_CALL_NAV_QUERY = `
  (call_expression
    (navigation_expression
      (navigation_suffix
        (simple_identifier) @call.name))) @call.node
`;

async function extractSwiftGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const r = await getSwiftParser();
  if (!r) return { nodes: [], rawEdges: [] };
  const { parser, lang } = r;
  const tree = (parser as Parser).parse(content);

  const fnQuery = new _NativeQuery!(lang as unknown as Parser.Language, SWIFT_FN_QUERY);
  const directCallQuery = new _NativeQuery!(lang as unknown as Parser.Language, SWIFT_CALL_DIRECT_QUERY);
  const navCallQuery = new _NativeQuery!(lang as unknown as Parser.Language, SWIFT_CALL_NAV_QUERY);

  const nodes: FunctionNode[] = [];
  for (const match of fnQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nodeCapture) continue;

    const fnNode = nodeCapture.node;
    const name = nameCapture?.node.text ?? 'init';

    // Find enclosing class/struct/actor/enum/extension (all are class_declaration in this grammar)
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class_declaration') {
        const nameNode = cursor.children.find(c => c.type === 'type_identifier');
        if (nameNode) className = nameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    const isAsync = content.slice(fnNode.startIndex, fnNode.endIndex).includes(' async ');
    const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;

    nodes.push({
      id, name, filePath, className,
      isAsync,
      language: 'Swift',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0, fanOut: 0,
      docstring: extractDocstringBefore(content, fnNode.startIndex, 'Swift'),
      signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, 'Swift'),
    });
  }

  const rawEdges: RawEdge[] = [];

  // Direct calls: foo()
  for (const match of directCallQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName, 'Swift')) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1 });
  }

  // Method calls: obj.method() / self.method()
  for (const match of navCallQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (isIgnoredCallee(calleeName, 'Swift')) continue;

    const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
    if (!caller) continue;

    // Extract the receiver object (first child of navigation_expression)
    const navExpr = nodeCapture.node.firstChild;
    const objText = navExpr?.firstChild?.type === 'self_expression'
      ? 'self'
      : navExpr?.firstChild?.text;

    rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject: objText });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// ADDITIONAL GENERAL-PURPOSE LANGUAGES (spec-08)
// ============================================================================
//
// C#, Kotlin, PHP, C, Scala, Dart, Lua, Elixir, Bash. Each follows the existing
// extractor pattern (lazy soft-loaded grammar + FN/CALL queries + dispatch).
// Grammars are native modules; loaders fail SOFT (graceful degradation): a
// missing/ABI-incompatible grammar logs one warning and skips graphing for that
// language without aborting analyze or any other language.

const _warnedUnavailable = new Set<string>();

/**
 * Minimal structural node/match interface shared by native tree-sitter and the
 * web-tree-sitter (WASM) backend, so one extractor works against either.
 */
interface TsNodeLike {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  parent: TsNodeLike | null;
  namedChildren: TsNodeLike[];
  previousNamedSibling: TsNodeLike | null;
  nextNamedSibling: TsNodeLike | null;
  childForFieldName(name: string): TsNodeLike | null;
}
interface TsMatch { captures: Array<{ name: string; node: TsNodeLike }> }
/**
 * Uniform grammar handle. `withTree` parses, exposes the root + a query runner,
 * and guarantees cleanup afterward — essential for the WASM backend, where
 * trees/queries hold WASM heap memory that corrupts the next parse if not freed.
 */
interface GrammarHandle {
  withTree<T>(content: string, fn: (root: TsNodeLike, runQuery: (src: string) => TsMatch[]) => T): T;
}

const _grammarHandleCache = new Map<string, GrammarHandle | null>();

function warnUnavailable(language: string, err: unknown): null {
  if (!_warnedUnavailable.has(language)) {
    _warnedUnavailable.add(language);
    logger.warning(
      `language ${language} grammar unavailable — files will be indexed for search but not graphed (${(err as Error).message})`,
    );
  }
  return null;
}

/** Native tree-sitter loader. Returns a uniform handle, or null when unavailable. */
async function loadGrammarSoft(
  language: string,
  importer: () => Promise<unknown>,
  pick: (m: Record<string, unknown>) => unknown,
): Promise<GrammarHandle | null> {
  if (_grammarHandleCache.has(language)) return _grammarHandleCache.get(language)!;
  try {
    const NP = await loadNativeParser();
    if (!NP) throw new Error('tree-sitter native bindings not available');
    const mod = (await importer()) as Record<string, unknown>;
    const lang = pick(mod) as object;
    if (!lang) throw new Error('grammar export resolved to undefined');
    const parser = new NP();
    parser.setLanguage(lang as unknown as Parser.Language);
    const handle: GrammarHandle = {
      withTree: (content, fn) => {
        const tree = (parser as Parser).parse(content);
        const root = tree.rootNode as unknown as TsNodeLike;
        const runQuery = (src: string): TsMatch[] => {
          if (!_NativeQuery) return [];
          try {
            const q = new _NativeQuery(lang as unknown as Parser.Language, src);
            return q.matches(tree.rootNode) as unknown as TsMatch[];
          } catch { return []; }
        };
        return fn(root, runQuery);
      },
    };
    _grammarHandleCache.set(language, handle);
    return handle;
  } catch (err) {
    _grammarHandleCache.set(language, warnUnavailable(language, err));
    return null;
  }
}

/**
 * WASM grammar loader via web-tree-sitter (ABI-agnostic, portable). Used for
 * grammars with no host-ABI-compatible native build (Dart, Lua). Soft-fails.
 */
async function loadWasmGrammarSoft(
  language: string,
  wasmSpecifier: string,
): Promise<GrammarHandle | null> {
  const cacheKey = `wasm:${language}`;
  if (_grammarHandleCache.has(cacheKey)) return _grammarHandleCache.get(cacheKey)!;
  try {
    const { createRequire } = await import('node:module');
    const { readFile } = await import('node:fs/promises');
    const req = createRequire(import.meta.url);
    const wasmPath = req.resolve(wasmSpecifier);
    // Load the wasm bytes ourselves and hand web-tree-sitter a Uint8Array, so it
    // never does its own `require("fs/promises")` (which breaks under ESM/vitest).
    const wasmBytes = new Uint8Array(await readFile(wasmPath));
    // CRITICAL: each WASM grammar gets its OWN web-tree-sitter module instance.
    // web-tree-sitter is a singleton emscripten module with a shared heap; loading
    // two different grammars into one instance corrupts parsing (a Dart parse
    // silently breaks subsequent Lua parses). Busting the require cache before each
    // grammar yields an isolated runtime + heap per grammar, so they never interfere.
    for (const k of Object.keys(req.cache)) {
      if (k.includes('web-tree-sitter')) delete req.cache[k];
    }
    const TS = req('web-tree-sitter') as Record<string, unknown>;
    const WasmQuery = TS.Query as new (lang: unknown, src: string) => { matches(root: TsNodeLike): TsMatch[]; delete?(): void };
    const ParserCtor = (TS.default ?? TS.Parser ?? TS) as {
      new (): { setLanguage(l: unknown): void; parse(s: string): { rootNode: TsNodeLike } };
      init?: () => Promise<void>;
      Language?: { load(p: Uint8Array): Promise<{ query(src: string): { matches(root: TsNodeLike): TsMatch[] } }> };
    };
    if (typeof ParserCtor.init === 'function') await ParserCtor.init();
    const LanguageNs = (TS.Language ?? ParserCtor.Language) as { load(p: Uint8Array): Promise<{ query(src: string): { matches(root: TsNodeLike): TsMatch[] } }> };
    const lang = await LanguageNs.load(wasmBytes) as {
      query(src: string): { matches(root: TsNodeLike): TsMatch[]; delete?: () => void };
    };
    const handle: GrammarHandle = {
      withTree: (content, fn) => {
        // Fresh parser + explicit tree/query disposal: web-tree-sitter holds the
        // parse tree in WASM heap, which corrupts the next parse if not freed.
        const p = new ParserCtor() as { setLanguage(l: unknown): void; parse(s: string): { rootNode: TsNodeLike; delete?: () => void }; delete?: () => void };
        p.setLanguage(lang);
        const tree = p.parse(content);
        const queries: Array<{ delete?: () => void }> = [];
        const runQuery = (src: string): TsMatch[] => {
          try {
            const q = WasmQuery ? new WasmQuery(lang, src) : lang.query(src);
            queries.push(q);
            return q.matches(tree.rootNode);
          } catch { return []; }
        };
        try {
          return fn(tree.rootNode, runQuery);
        } finally {
          for (const q of queries) q.delete?.();
          tree.delete?.();
          p.delete?.();
        }
      },
    };
    _grammarHandleCache.set(cacheKey, handle);
    return handle;
  } catch (err) {
    _grammarHandleCache.set(cacheKey, warnUnavailable(language, err));
    return null;
  }
}

/** Reset loader caches — test-only hook for the graceful-degradation test. */
export function __resetGrammarCacheForTests(): void {
  _grammarHandleCache.clear();
  _warnedUnavailable.clear();
}

const NAME_CHILD_TYPES = new Set(['identifier', 'name', 'type_identifier', 'simple_identifier', 'word']);

/** Walk up from a node to the nearest grouping construct; return its declared name. */
function enclosingGroupName(node: TsNodeLike, classTypes: Set<string>): string | undefined {
  let cursor = node.parent;
  while (cursor) {
    if (classTypes.has(cursor.type)) {
      const nameNode = cursor.namedChildren.find(c => NAME_CHILD_TYPES.has(c.type))
        ?? cursor.childForFieldName('name') ?? undefined;
      if (nameNode) return nameNode.text;
    }
    cursor = cursor.parent;
  }
  return undefined;
}

interface QueryLangSpec {
  language: string;
  loader: () => Promise<GrammarHandle | null>;
  fnQuery: string;
  callQuery: string;
  /** Node types that form a grouping (class/object/module). Empty = no classes. */
  classTypes: Set<string>;
  /** Optional per-language hook to compute an extra className (e.g. Kotlin receiver). */
  extraClassName?: (fnNode: TsNodeLike) => string | undefined;
  /** Optional filter: only emit a call edge when this returns true. */
  callFilter?: (calleeName: string, definedNames: Set<string>) => boolean;
}


/**
 * Generic query-driven extractor shared by the structurally-similar languages.
 * Mirrors the Java extractor's shape; per-language differences are expressed
 * via the QueryLangSpec rather than copy-pasted bodies.
 */
async function extractByQueries(
  spec: QueryLangSpec,
  filePath: string,
  content: string,
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[]; cfg: Map<string, FunctionCfg> }> {
  const handle = await spec.loader();
  if (!handle) return { nodes: [], rawEdges: [], cfg: new Map() };

  return handle.withTree(content, (_root, runQuery) => {
    const nodes: FunctionNode[] = [];
    const cfg = new Map<string, FunctionCfg>();
    for (const match of runQuery(spec.fnQuery)) {
      const nameCapture = match.captures.find(c => c.name === 'fn.name');
      const nodeCapture = match.captures.find(c => c.name === 'fn.node');
      if (!nameCapture || !nodeCapture) continue;
      const name = nameCapture.node.text;
      const fnNode = nodeCapture.node;
      const className = (spec.classTypes.size ? enclosingGroupName(fnNode, spec.classTypes) : undefined)
        ?? spec.extraClassName?.(fnNode);
      const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
      if (nodes.some(n => n.id === id)) continue; // collapse multi-clause/overloads to one node
      // CFG/def-use overlay (spec: add-intraprocedural-cfg-dataflow-overlay) for
      // spec-08 languages that have a CfgLangSpec; others fail soft to no overlay.
      // Built inside withTree while the (possibly WASM) tree is live.
      const fnCfg = buildCfgFor(fnNode as unknown as CfgNode, spec.language);
      if (fnCfg) cfg.set(id, fnCfg);
      nodes.push({
        id, name, filePath, className,
        isAsync: false,
        language: spec.language,
        startIndex: fnNode.startIndex,
        endIndex: fnNode.endIndex,
        fanIn: 0, fanOut: 0,
        signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, spec.language),
      });
    }

    const definedNames = new Set(nodes.map(n => n.name));
    const rawEdges: RawEdge[] = [];
    const seen = new Set<string>();
    for (const match of runQuery(spec.callQuery)) {
      const nameCapture = match.captures.find(c => c.name === 'call.name');
      const nodeCapture = match.captures.find(c => c.name === 'call.node');
      const objectCapture = match.captures.find(c => c.name === 'call.object');
      if (!nameCapture || !nodeCapture) continue;
      const calleeName = nameCapture.node.text;
      if (isIgnoredCallee(calleeName, spec.language)) continue;
      if (spec.callFilter && !spec.callFilter(calleeName, definedNames)) continue;
      const caller = findEnclosingFunction(nodes, nodeCapture.node.startIndex);
      if (!caller) continue;
      const calleeObject = objectCapture?.node.text;
      const key = `${caller.id}\0${calleeName}\0${calleeObject ?? ''}\0${nodeCapture.node.startIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject });
    }
    return { nodes, rawEdges, cfg };
  });
}

// ── C# ──────────────────────────────────────────────────────────────────────
const CSHARP_SPEC: QueryLangSpec = {
  language: 'C#',
  loader: () => loadGrammarSoft('C#', () => import('tree-sitter-c-sharp'), m => m.default),
  classTypes: new Set(['class_declaration', 'struct_declaration', 'record_declaration', 'interface_declaration', 'enum_declaration']),
  fnQuery: `
    (method_declaration name: (identifier) @fn.name) @fn.node
    (constructor_declaration name: (identifier) @fn.name) @fn.node
    (local_function_statement name: (identifier) @fn.name) @fn.node
  `,
  // Name-based resolution (matches the codebase's best-effort approach): capture
  // the callee name only — the object isn't used for resolution in these langs.
  callQuery: `
    (invocation_expression function: (member_access_expression name: (identifier) @call.name)) @call.node
    (invocation_expression function: (identifier) @call.name) @call.node
  `,
};

// ── Kotlin ──────────────────────────────────────────────────────────────────
const KOTLIN_SPEC: QueryLangSpec = {
  language: 'Kotlin',
  loader: () => loadGrammarSoft('Kotlin', () => import('tree-sitter-kotlin'), m => m.default),
  classTypes: new Set(['class_declaration', 'object_declaration', 'interface_declaration', 'companion_object']),
  // Extension functions: `fun Foo.bar()` — the receiver user_type becomes the className.
  // The receiver is the user_type that appears BEFORE the function name. A user_type
  // AFTER the name is the return type, and parameter types are nested inside
  // function_value_parameters — neither is a receiver. Picking the first user_type
  // unconditionally mis-filed a plain `fun f(x: Int): Int` under a phantom class `Int`
  // (and surfaced `Int`/`String`/`T` as classes). Only a true receiver counts.
  extraClassName: (fnNode) => {
    const nameNode = fnNode.namedChildren.find(c => c.type === 'simple_identifier');
    if (!nameNode) return undefined;
    const receiver = fnNode.namedChildren.find(
      c => c.type === 'user_type' && c.endIndex <= nameNode.startIndex,
    );
    return receiver?.text;
  },
  fnQuery: `
    (function_declaration (simple_identifier) @fn.name) @fn.node
  `,
  callQuery: `
    (call_expression (simple_identifier) @call.name) @call.node
    (call_expression (navigation_expression (navigation_suffix (simple_identifier) @call.name))) @call.node
  `,
};

// ── PHP ─────────────────────────────────────────────────────────────────────
const PHP_SPEC: QueryLangSpec = {
  language: 'PHP',
  loader: () => loadGrammarSoft('PHP', () => import('tree-sitter-php'), m => (m.default as { php: object }).php),
  classTypes: new Set(['class_declaration', 'trait_declaration', 'interface_declaration', 'enum_declaration']),
  fnQuery: `
    (function_definition name: (name) @fn.name) @fn.node
    (method_declaration name: (name) @fn.name) @fn.node
  `,
  callQuery: `
    (function_call_expression function: (name) @call.name) @call.node
    (member_call_expression name: (name) @call.name) @call.node
    (scoped_call_expression name: (name) @call.name) @call.node
  `,
};

// ── C ───────────────────────────────────────────────────────────────────────
const C_SPEC: QueryLangSpec = {
  language: 'C',
  loader: () => loadGrammarSoft('C', () => import('tree-sitter-c'), m => m.default),
  classTypes: new Set(), // C has no classes — file scope is the implicit grouping
  fnQuery: `
    (function_definition declarator: (function_declarator declarator: (identifier) @fn.name)) @fn.node
  `,
  callQuery: `
    (call_expression function: (identifier) @call.name) @call.node
  `,
};

// ── Scala ───────────────────────────────────────────────────────────────────
const SCALA_SPEC: QueryLangSpec = {
  language: 'Scala',
  loader: () => loadGrammarSoft('Scala', () => import('tree-sitter-scala'), m => m.default),
  classTypes: new Set(['object_definition', 'class_definition', 'trait_definition']),
  fnQuery: `
    (function_definition name: (identifier) @fn.name) @fn.node
  `,
  callQuery: `
    (call_expression function: (identifier) @call.name) @call.node
    (call_expression function: (field_expression field: (identifier) @call.name)) @call.node
  `,
};

// ── Lua (via bundled WASM — no ABI-compatible native build for the host) ─────
const LUA_SPEC: QueryLangSpec = {
  language: 'Lua',
  loader: () => loadWasmGrammarSoft('Lua', 'tree-sitter-wasms/out/tree-sitter-lua.wasm'),
  classTypes: new Set(),
  // `function t.f()` / `function t:m()` record the table name in className.
  extraClassName: (fnNode) => {
    const nameVar = fnNode.childForFieldName('name');
    if (nameVar?.type === 'variable') return nameVar.childForFieldName('table')?.text;
    return undefined;
  },
  fnQuery: `
    (local_function_definition_statement name: (identifier) @fn.name) @fn.node
    (function_definition_statement name: (identifier) @fn.name) @fn.node
    (function_definition_statement name: (variable field: (identifier) @fn.name)) @fn.node
    (function_definition_statement name: (variable method: (identifier) @fn.name)) @fn.node
  `,
  callQuery: `
    (call function: (variable name: (identifier) @call.name)) @call.node
    (call function: (variable field: (identifier) @call.name)) @call.node
    (call function: (variable method: (identifier) @call.name)) @call.node
  `,
};

// ── Bash ────────────────────────────────────────────────────────────────────
const BASH_SPEC: QueryLangSpec = {
  language: 'Bash',
  loader: () => loadGrammarSoft('Bash', () => import('tree-sitter-bash'), m => m.default),
  classTypes: new Set(),
  // Only edge to project-defined functions, never external binaries (grep/ls/…).
  callFilter: (calleeName, definedNames) => definedNames.has(calleeName),
  fnQuery: `
    (function_definition name: (word) @fn.name) @fn.node
  `,
  callQuery: `
    (command name: (command_name (word) @call.name)) @call.node
  `,
};

const QUERY_LANG_SPECS: Record<string, QueryLangSpec> = {
  'C#': CSHARP_SPEC, 'Kotlin': KOTLIN_SPEC, 'PHP': PHP_SPEC, 'C': C_SPEC,
  'Scala': SCALA_SPEC, 'Lua': LUA_SPEC, 'Bash': BASH_SPEC,
};

/**
 * Languages for which `CallGraphBuilder.build()` extracts function/method nodes and
 * call edges. The authoritative source for the `callGraph` capability flag in the
 * declarative language-support registry (change: add-declarative-language-support-registry).
 *
 * MUST stay in sync with the per-language dispatch in `build()`: the native extractors
 * (Python/TS/JS/Go/Rust/Ruby/Java/C++/Swift/Elixir/Dart) plus the data-driven
 * `QUERY_LANG_SPECS` languages. A behavioral test asserts a fixture in each member
 * yields ≥1 node, so this set cannot silently over-claim.
 */
export const CALLGRAPH_LANGUAGES: ReadonlySet<string> = new Set<string>([
  'Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Ruby', 'Java', 'C++', 'Swift', 'Elixir', 'Dart',
  ...Object.keys(QUERY_LANG_SPECS),
]);

// ── Dart (via portable WASM + web-tree-sitter) ───────────────────────────────
//
// No ABI-compatible native Dart grammar exists for the pinned host binding, so
// Dart loads the portable `tree-sitter-wasms` WASM through web-tree-sitter
// (ABI-agnostic, pure JS/WASM, builds on every platform) — each WASM grammar in
// its own module instance (see loadWasmGrammarSoft). Dart's grammar places the
// `function_body` as a SIBLING of `function_signature` (not a child), so a
// generic query extractor would attribute no calls — hence a custom walk that
// spans signature+body.

const DART_CLASS_TYPES = new Set(['class_definition', 'mixin_declaration', 'extension_declaration', 'enum_declaration']);

async function extractDartGraph(
  filePath: string,
  content: string,
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const handle = await loadWasmGrammarSoft('Dart', 'tree-sitter-wasms/out/tree-sitter-dart.wasm');
  if (!handle) return { nodes: [], rawEdges: [] };

  return handle.withTree(content, (root) => {
  const enclosingClass = (node: TsNodeLike): string | undefined => {
    let c = node.parent;
    while (c) {
      if (DART_CLASS_TYPES.has(c.type)) return c.childForFieldName('name')?.text;
      c = c.parent;
    }
    return undefined;
  };

  const nodes: FunctionNode[] = [];
  const collectFns = (n: TsNodeLike): void => {
    if (n.type === 'function_signature') {
      const nameNode = n.childForFieldName('name');
      if (nameNode) {
        // Body is a sibling of the signature (or of its method_signature parent).
        const unit = n.parent && n.parent.type === 'method_signature' ? n.parent : n;
        const sib = unit.nextNamedSibling;
        const endIndex = sib && sib.type === 'function_body' ? sib.endIndex : n.endIndex;
        const className = enclosingClass(n);
        const id = className ? `${filePath}::${className}.${nameNode.text}` : `${filePath}::${nameNode.text}`;
        if (!nodes.some(x => x.id === id)) {
          nodes.push({
            id, name: nameNode.text, filePath, className, isAsync: false, language: 'Dart',
            startIndex: n.startIndex, endIndex, fanIn: 0, fanOut: 0,
            signature: extractDeclaration(content, n.startIndex, n.endIndex, 'Dart'),
          });
        }
      }
    }
    for (const c of n.namedChildren) collectFns(c);
  };
  collectFns(root);

  const rawEdges: RawEdge[] = [];
  const seen = new Set<string>();
  const collectCalls = (n: TsNodeLike): void => {
    if (n.type === 'selector' && n.namedChildren.some(c => c.type === 'argument_part')) {
      const prev = n.previousNamedSibling;
      let name: string | undefined;
      if (prev?.type === 'identifier') name = prev.text;
      else if (prev?.type === 'selector') {
        const uas = prev.namedChildren.find(c => c.type === 'unconditional_assignable_selector');
        name = uas?.namedChildren.find(c => c.type === 'identifier')?.text;
      }
      if (name && !isIgnoredCallee(name)) {
        const caller = findEnclosingFunction(nodes, n.startIndex);
        if (caller) {
          const key = `${caller.id}\0${name}\0${n.startIndex}`;
          if (!seen.has(key)) {
            seen.add(key);
            rawEdges.push({ callerId: caller.id, calleeName: name, line: n.startPosition.row + 1 });
          }
        }
      }
    }
    for (const c of n.namedChildren) collectCalls(c);
  };
  collectCalls(root);
  return { nodes, rawEdges };
  });
}

// ── Elixir (custom walk — everything is a `call` node) ───────────────────────
const ELIXIR_DEF_KEYWORDS = new Set(['def', 'defp', 'defmacro', 'defmacrop']);

async function extractElixirGraph(
  filePath: string,
  content: string,
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[] }> {
  const loaded = await loadGrammarSoft('Elixir', () => import('tree-sitter-elixir'), m => m.default);
  if (!loaded) return { nodes: [], rawEdges: [] };

  return loaded.withTree(content, (root) => {
  const nodes: FunctionNode[] = [];
  const calls: Array<{ name: string; object?: string; pos: number; row: number }> = [];

  const targetIdent = (call: TsNodeLike): TsNodeLike | undefined => {
    const t = call.childForFieldName('target');
    return t ?? call.namedChildren[0];
  };

  const walk = (node: TsNodeLike, moduleName: string | undefined) => {
    if (node.type === 'call') {
      const target = targetIdent(node);
      const kw = target?.type === 'identifier' ? target.text : undefined;
      const args = node.childForFieldName('arguments') ?? node.namedChildren.find(c => c.type === 'arguments');

      if (kw === 'defmodule') {
        const aliasNode = args?.namedChildren.find(c => c.type === 'alias');
        const newModule = aliasNode?.text ?? moduleName;
        for (const child of node.namedChildren) walk(child, newModule);
        return;
      }
      if (kw && ELIXIR_DEF_KEYWORDS.has(kw)) {
        // First argument is the function head: an identifier (no args) or a call (with args).
        const head = args?.namedChildren[0];
        let fnName: string | undefined;
        let arity = 0;
        if (head?.type === 'identifier') { fnName = head.text; }
        else if (head?.type === 'call') {
          const ht = head.childForFieldName('target') ?? head.namedChildren[0];
          fnName = ht?.text;
          const hargs = head.childForFieldName('arguments') ?? head.namedChildren.find(c => c.type === 'arguments');
          arity = hargs?.namedChildren.length ?? 0;
        }
        if (fnName) {
          const id = moduleName ? `${filePath}::${moduleName}.${fnName}` : `${filePath}::${fnName}`;
          const existing = nodes.find(n => n.id === id);
          if (existing) {
            existing.signature = `${existing.signature} (+clause)`;
          } else {
            nodes.push({
              id, name: fnName, filePath, className: moduleName, isAsync: false,
              language: 'Elixir', startIndex: node.startIndex, endIndex: node.endIndex,
              fanIn: 0, fanOut: 0, signature: `${kw} ${fnName}/${arity}`,
            });
          }
        }
        // Recurse into the body for nested calls.
        for (const child of node.namedChildren) walk(child, moduleName);
        return;
      }

      // Otherwise it's a call site: local `fun(...)` or remote `Mod.fun(...)`.
      if (target?.type === 'identifier' && !ELIXIR_DEF_KEYWORDS.has(target.text)) {
        calls.push({ name: target.text, pos: node.startIndex, row: node.startPosition.row });
      } else if (target?.type === 'dot') {
        // Remote `Mod.fun(...)`: emit the function name only (no receiver), so
        // name-based resolution can match an in-project function (matching how
        // the other spec-08 languages resolve member/static calls).
        const right = target.childForFieldName('right') ?? target.namedChildren[target.namedChildren.length - 1];
        if (right) calls.push({ name: right.text, pos: node.startIndex, row: node.startPosition.row });
      }
    }
    for (const child of node.namedChildren) walk(child, moduleName);
  };
  walk(root, undefined);

  const rawEdges: RawEdge[] = [];
  const seen = new Set<string>();
  for (const c of calls) {
    if (isIgnoredCallee(c.name)) continue;
    const caller = findEnclosingFunction(nodes, c.pos);
    if (!caller) continue;
    const key = `${caller.id}\0${c.name}\0${c.object ?? ''}\0${c.pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rawEdges.push({ callerId: caller.id, calleeName: c.name, line: c.row + 1, calleeObject: c.object });
  }
  return { nodes, rawEdges };
  });
}

// ============================================================================
// CLASS HIERARCHY EXTRACTION
// ============================================================================

/**
 * Extract parent class / interface relationships from source files using
 * tree-sitter.  Returns a map from `filePath::ClassName` → relationship info.
 * Uses safeQuery so any query that doesn't match a grammar version is silently
 * skipped rather than crashing.
 */
async function extractClassRelationships(
  files: Array<{ path: string; content: string; language: string }>,
): Promise<Map<string, { parentClasses: string[]; interfaces: string[] }>> {
  const out = new Map<string, { parentClasses: string[]; interfaces: string[] }>();

  // Helper to merge into map keyed by `filePath::ClassName`
  function merge(
    filePath: string,
    className: string,
    parents: string[],
    ifaces: string[],
  ) {
    const key = `${filePath}::${className}`;
    const existing = out.get(key) ?? { parentClasses: [], interfaces: [] };
    for (const p of parents) if (!existing.parentClasses.includes(p)) existing.parentClasses.push(p);
    for (const i of ifaces)  if (!existing.interfaces.includes(i))   existing.interfaces.push(i);
    out.set(key, existing);
  }

  for (const file of files) {
    try {
      if (file.language === 'TypeScript' || file.language === 'JavaScript') {
        const r = await getTSParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        // class Foo extends Bar implements Baz, Qux
        const EXTENDS_Q = `
          (class_declaration
            name: (type_identifier) @cls
            (class_heritage (extends_clause value: (identifier) @parent)))`;
        const IMPLEMENTS_Q = `
          (class_declaration
            name: (type_identifier) @cls
            (class_heritage (implements_clause (type_identifier) @iface)))`;

        for (const m of safeQuery(lang, EXTENDS_Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent) merge(file.path, cls, [parent], []);
        }
        for (const m of safeQuery(lang, IMPLEMENTS_Q, tree.rootNode)) {
          const cls  = m.captures.find(c => c.name === 'cls')?.node.text;
          const iface = m.captures.find(c => c.name === 'iface')?.node.text;
          if (cls && iface) merge(file.path, cls, [], [iface]);
        }

      } else if (file.language === 'Python') {
        const r = await getPyParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        // class Foo(Bar, Baz):
        const Q = `
          (class_definition
            name: (identifier) @cls
            superclasses: (argument_list (identifier) @parent))`;
        for (const m of safeQuery(lang, Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent && parent !== 'object') merge(file.path, cls, [parent], []);
        }

      } else if (file.language === 'Java') {
        const r = await getJavaParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        const EXTENDS_Q = `
          (class_declaration
            name: (identifier) @cls
            (superclass (type_identifier) @parent))`;
        const IMPLEMENTS_Q = `
          (class_declaration
            name: (identifier) @cls
            (super_interfaces (type_list (type_identifier) @iface)))`;

        for (const m of safeQuery(lang, EXTENDS_Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent) merge(file.path, cls, [parent], []);
        }
        for (const m of safeQuery(lang, IMPLEMENTS_Q, tree.rootNode)) {
          const cls  = m.captures.find(c => c.name === 'cls')?.node.text;
          const iface = m.captures.find(c => c.name === 'iface')?.node.text;
          if (cls && iface) merge(file.path, cls, [], [iface]);
        }

      } else if (file.language === 'C++') {
        const r = await getCppParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        // class Foo : public Bar
        const Q = `
          (class_specifier
            name: (type_identifier) @cls
            (base_class_clause (type_identifier) @parent))`;
        for (const m of safeQuery(lang, Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent) merge(file.path, cls, [parent], []);
        }

      } else if (file.language === 'C#') {
        const r = await getCSharpParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        // C# `class D : B, IFoo, IBar<T>` / `interface I : IBase` — the base_list holds
        // the base class AND interfaces with no syntactic distinction. Capture every
        // base (plain or generic) and split by the C# `I<Upper>` interface naming
        // convention; either way CHA treats both as subtype edges. Without this branch
        // C# classes had empty parent/interface sets and CHA was inert for C#.
        for (const declType of ['class_declaration', 'interface_declaration', 'record_declaration', 'struct_declaration']) {
          const Q = `
            (${declType}
              name: (identifier) @cls
              (base_list [(identifier) @base (generic_name (identifier) @base)]))`;
          for (const m of safeQuery(lang, Q, tree.rootNode)) {
            const cls  = m.captures.find(c => c.name === 'cls')?.node.text;
            const base = m.captures.find(c => c.name === 'base')?.node.text;
            if (!cls || !base) continue;
            if (/^I[A-Z]/.test(base)) merge(file.path, cls, [], [base]);
            else merge(file.path, cls, [base], []);
          }
        }

      } else if (file.language === 'Kotlin') {
        const r = await getKotlinParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        // Kotlin `class C : Base(), IFace` — every supertype is a `delegation_specifier`
        // with no syntactic class/interface distinction (a superclass may carry a
        // constructor_invocation). Capture the whole user_type and take its leaf name,
        // SKIPPING qualified types (`Outer.Inner`, e.g. `Job : CoroutineContext.Element`):
        // those resolve to a nested/stdlib type, and matching the outer segment wires the
        // class to a phantom (an extension-function receiver such as `CoroutineContext`).
        for (const declType of ['class_declaration', 'object_declaration', 'interface_declaration']) {
          for (const wrap of ['(user_type) @put', '(constructor_invocation (user_type) @put)']) {
            const Q = `(${declType} (type_identifier) @cls (delegation_specifier ${wrap}))`;
            for (const m of safeQuery(lang, Q, tree.rootNode)) {
              const cls = m.captures.find(c => c.name === 'cls')?.node.text;
              const put = m.captures.find(c => c.name === 'put')?.node.text;
              if (!cls || !put) continue;
              const parent = put.replace(/<[\s\S]*$/, '').trim(); // strip generic args
              if (parent.includes('.')) continue;                 // skip qualified/nested types
              merge(file.path, cls, [parent], []);
            }
          }
        }

      } else if (file.language === 'PHP') {
        const r = await getPhpParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        // PHP distinguishes `extends` (base_clause, one parent) from `implements`
        // (class_interface_clause, many interfaces).
        const EXTENDS_Q = `(class_declaration name: (name) @cls (base_clause (name) @parent))`;
        const IMPLEMENTS_Q = `(class_declaration name: (name) @cls (class_interface_clause (name) @iface))`;
        for (const m of safeQuery(lang, EXTENDS_Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent) merge(file.path, cls, [parent], []);
        }
        for (const m of safeQuery(lang, IMPLEMENTS_Q, tree.rootNode)) {
          const cls   = m.captures.find(c => c.name === 'cls')?.node.text;
          const iface = m.captures.find(c => c.name === 'iface')?.node.text;
          if (cls && iface) merge(file.path, cls, [], [iface]);
        }

      } else if (file.language === 'Swift') {
        const r = await getSwiftParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        // Swift `class C: Base, Proto` — every supertype/protocol is an
        // `inheritance_specifier` with no syntactic distinction. (class_declaration in
        // this grammar also covers struct/enum/extension.) Take the user_type leaf name
        // and skip qualified types (`Module.Type`) for the same reason as Kotlin.
        for (const declType of ['class_declaration', 'protocol_declaration']) {
          const Q = `(${declType} (type_identifier) @cls (inheritance_specifier (user_type) @put))`;
          for (const m of safeQuery(lang, Q, tree.rootNode)) {
            const cls = m.captures.find(c => c.name === 'cls')?.node.text;
            const put = m.captures.find(c => c.name === 'put')?.node.text;
            if (!cls || !put) continue;
            const parent = put.replace(/<[\s\S]*$/, '').trim();
            if (parent.includes('.')) continue;
            merge(file.path, cls, [parent], []);
          }
        }

      } else if (file.language === 'Scala') {
        const r = await getScalaParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        // Scala `class C extends Base with Trait` — the superclass and every mixed-in
        // trait sit in one `extends_clause`. Treat each as a subtype edge.
        for (const declType of ['class_definition', 'trait_definition', 'object_definition']) {
          const Q = `(${declType} (identifier) @cls (extends_clause (type_identifier) @parent))`;
          for (const m of safeQuery(lang, Q, tree.rootNode)) {
            const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
            const parent = m.captures.find(c => c.name === 'parent')?.node.text;
            if (cls && parent) merge(file.path, cls, [parent], []);
          }
        }

      } else if (file.language === 'Ruby') {
        const r = await getRubyParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        // class Foo < Bar
        const Q = `
          (class
            name: (constant) @cls
            superclass: (superclass (constant) @parent))`;
        for (const m of safeQuery(lang, Q, tree.rootNode)) {
          const cls    = m.captures.find(c => c.name === 'cls')?.node.text;
          const parent = m.captures.find(c => c.name === 'parent')?.node.text;
          if (cls && parent) merge(file.path, cls, [parent], []);
        }

      } else if (file.language === 'Go') {
        // Go has no inheritance but has struct embedding; treat as 'embeds' edges.
        const r = await getGoParser();
        if (!r) continue;
        const { parser, lang } = r;
        const tree = (parser as Parser).parse(file.content);

        // An EMBEDDED field is an ANONYMOUS field (a type with no field name):
        // `type Foo struct { Bar }` or `{ *Bar }`. A NAMED field `Name Bar` is NOT an
        // embed — capturing its type as a parent wires phantom edges (e.g. cobra's
        // `CompletionOptions CompletionOptions` field looked like an embed) and pollutes
        // parent_classes with field types. So capture the field_declaration and only
        // treat it as an embed when it has no `name:` field; unwrap a leading `*`.
        const Q = `
          (type_declaration
            (type_spec
              name: (type_identifier) @cls
              type: (struct_type
                (field_declaration_list
                  (field_declaration) @field))))`;
        for (const m of safeQuery(lang, Q, tree.rootNode)) {
          const cls   = m.captures.find(c => c.name === 'cls')?.node.text;
          const field = m.captures.find(c => c.name === 'field')?.node;
          if (!cls || !field) continue;
          if (field.childForFieldName('name')) continue; // named field — not an embed
          const typeNode = field.childForFieldName('type');
          // Embedded type: `Bar` (type_identifier) or `*Bar` (pointer_type → type_identifier).
          // Skip qualified embeds (`pkg.Bar`) — they resolve to an external package type.
          const embedded = typeNode?.type === 'type_identifier'
            ? typeNode.text
            : (typeNode?.type === 'pointer_type'
                ? typeNode.namedChildren.find((c: { type: string }) => c.type === 'type_identifier')?.text
                : undefined);
          if (!embedded) continue;
          const key = `${file.path}::${cls}`;
          const existing = out.get(key) ?? { parentClasses: [], interfaces: [] };
          // Store Go embeds as parentClasses (tagged 'embeds' when building edges).
          if (!existing.parentClasses.includes(embedded)) existing.parentClasses.push(embedded);
          out.set(key, existing);
        }
      }
      // Rust: trait impls are structural but less like OOP inheritance; skip for now
    } catch {
      // Best-effort; skip unparseable files
    }
  }

  return out;
}

/**
 * Build ClassNode[] from the set of extracted FunctionNodes (which carry
 * `className`), enriched with inheritance data from `extractClassRelationships`.
 *
 * Functions without a className are grouped by file into synthetic module nodes
 * (e.g. `[call-graph]`) so every function appears in the class graph, not just
 * class methods. This is essential for codebases that use mostly module-level
 * exports rather than OOP classes.
 */
function buildClassNodes(
  allNodes: Map<string, FunctionNode>,
  relationships: Map<string, { parentClasses: string[]; interfaces: string[] }>,
  importMap?: ImportMap,
): { classes: ClassNode[]; inheritanceEdges: InheritanceEdge[] } {
  // Group FunctionNodes by (filePath, className).
  // Free functions use a synthetic "[basename]" module name keyed by filePath alone.
  const groups = new Map<string, {
    name: string; filePath: string; language: string; isModule: boolean; methods: FunctionNode[]
  }>();

  for (const fn of allNodes.values()) {
    let key: string;
    let name: string;
    let isModule: boolean;
    if (fn.className) {
      key = `${fn.filePath}::${fn.className}`;
      name = fn.className;
      isModule = false;
    } else {
      // Synthetic module node — one per file
      key = fn.filePath;
      const base = fn.filePath.split('/').pop() ?? fn.filePath;
      name = '[' + base.replace(/\.[^.]+$/, '') + ']';
      isModule = true;
    }
    if (!groups.has(key)) {
      groups.set(key, { name, filePath: fn.filePath, language: fn.language, isModule, methods: [] });
    }
    groups.get(key)!.methods.push(fn);
  }

  // Build ClassNode[]
  const classMap = new Map<string, ClassNode>();
  for (const [id, g] of groups) {
    const rel = relationships.get(id) ?? { parentClasses: [], interfaces: [] };
    const cls: ClassNode = {
      id,
      name: g.name,
      filePath: g.filePath,
      language: g.language,
      parentClasses: rel.parentClasses,
      interfaces: rel.interfaces,
      methodIds: g.methods.map(m => m.id),
      fanIn:  g.methods.reduce((s, m) => s + m.fanIn, 0),
      fanOut: g.methods.reduce((s, m) => s + m.fanOut, 0),
      isModule: g.isModule,
    };
    classMap.set(id, cls);
  }

  // Build InheritanceEdge[] — only when both parent and child are in our graph.
  // Parent lookup resolves a base/interface NAME to a ClassNode, preferring a class
  // of that name in the SAME FILE as the child before any global match. Without the
  // same-file preference, two unrelated classes sharing a name in different files
  // (e.g. an `observer.py::Subject` and a `proxy.py::Subject`) collapse to one under
  // a global first-match-wins lookup, so a child resolves its base to the wrong
  // declaration and CHA then synthesizes a false override edge between semantically
  // unrelated classes. Same-file-first eliminates that collision for the common case
  // (a class extending a base declared in its own file / a same-named local shadow);
  // genuine cross-file inheritance falls back to the global first match.
  const byName = new Map<string, ClassNode>();
  const nameCount = new Map<string, number>();
  const byNameAndDir = new Map<string, ClassNode[]>(); // `${dir}\0${name}` → classes
  const dirOf = (p: string): string => { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; };
  const byNameList = new Map<string, ClassNode[]>(); // name → all classes of that name (for import resolution)
  for (const cls of classMap.values()) {
    nameCount.set(cls.name, (nameCount.get(cls.name) ?? 0) + 1);
    if (!byName.has(cls.name)) byName.set(cls.name, cls);
    const dk = `${dirOf(cls.filePath)}\0${cls.name}`;
    const arr = byNameAndDir.get(dk);
    if (arr) arr.push(cls); else byNameAndDir.set(dk, [cls]);
    const nl = byNameList.get(cls.name);
    if (nl) nl.push(cls); else byNameList.set(cls.name, [cls]);
  }
  // Resolve a base/interface NAME to a ClassNode, most-specific evidence first:
  //   1. same file  2. the file the child imports the name from  3. unique within the
  //   child's directory (same package)  4. globally unique  5. otherwise SKIP.
  // Earlier layers carry real evidence (declaration site, import, package); the global-
  // unique fallback is safe (only one candidate). When the bare name is ambiguous across
  // directories and no import disambiguates it (e.g. several namespaced `Builder` classes),
  // skip rather than guess a first-match — false-negatives over false-positives.
  const resolveParent = (parentName: string, childFile: string): ClassNode | undefined => {
    const sameFile = classMap.get(`${childFile}::${parentName}`);
    if (sameFile) return sameFile;
    const importedFrom = importMap?.get(childFile)?.get(parentName);
    if (importedFrom) {
      // `importedFrom` is an extensionless, repo-relative module path (e.g. `shapes/base`)
      // while class filePaths carry an extension (`shapes/base.ts`) or index a directory
      // (`shapes/base/index.ts`). Prefix-match rather than exact-key, anchored on `.` / `/`
      // so `shapes/base` never collides with `shapes/base2.ts`.
      const viaImport = byNameList.get(parentName)?.find(c =>
        c.filePath === importedFrom
        || c.filePath.startsWith(`${importedFrom}.`)
        || c.filePath.startsWith(`${importedFrom}/`),
      );
      if (viaImport) return viaImport;
    }
    const sameDir = byNameAndDir.get(`${dirOf(childFile)}\0${parentName}`);
    if (sameDir && sameDir.length === 1) return sameDir[0];
    if ((nameCount.get(parentName) ?? 0) > 1) return undefined; // ambiguous across dirs → skip
    return byName.get(parentName);
  };

  const inheritanceEdges: InheritanceEdge[] = [];
  const seenEdges = new Set<string>();

  for (const cls of classMap.values()) {
    for (const parentName of cls.parentClasses) {
      const parent = resolveParent(parentName, cls.filePath);
      if (!parent || parent.id === cls.id) continue;
      const edgeId = `${parent.id}->${cls.id}`;
      if (seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      // Go embedding vs OOP inheritance
      const kind = cls.language === 'Go' ? 'embeds' : 'extends';
      inheritanceEdges.push({ id: edgeId, parentId: parent.id, childId: cls.id, kind });
    }
    for (const ifaceName of cls.interfaces) {
      const parent = resolveParent(ifaceName, cls.filePath);
      if (!parent || parent.id === cls.id) continue;
      const edgeId = `${parent.id}->${cls.id}`;
      if (seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      inheritanceEdges.push({ id: edgeId, parentId: parent.id, childId: cls.id, kind: 'implements' });
    }
  }

  // OVERRIDES edges: child defines method with same name as parent — language-agnostic
  const methodNameSet = new Map<string, Set<string>>();
  for (const [id, cls] of classMap) {
    const names = new Set<string>();
    for (const memberId of cls.methodIds) {
      const fn = allNodes.get(memberId);
      if (fn && !fn.isExternal) names.add(fn.name);
    }
    methodNameSet.set(id, names);
  }
  const extendsEdges = inheritanceEdges.filter(e => e.kind === 'extends');
  for (const edge of extendsEdges) {
    const childNames = methodNameSet.get(edge.childId);
    const parentNames = methodNameSet.get(edge.parentId);
    if (!childNames || !parentNames) continue;
    if (![...childNames].some(n => parentNames.has(n))) continue;
    const overrideId = `${edge.parentId}=>${edge.childId}:overrides`;
    if (seenEdges.has(overrideId)) continue;
    seenEdges.add(overrideId);
    inheritanceEdges.push({ id: overrideId, parentId: edge.parentId, childId: edge.childId, kind: 'overrides' });
  }

  return { classes: Array.from(classMap.values()), inheritanceEdges };
}

// ============================================================================
// EXTERNAL NODE HELPER
// ============================================================================

// isTestFile is imported at the top of the file from ./test-file.js — the shared
// cross-language predicate, so call-graph classification can't drift from the
// artifact generator's. (A narrower local copy previously let test code in
// tests/, __tests__/, *Spec.kt, etc. leak into the production graph and dropped
// `tested_by` edges for those layouts.)

const EXTERNAL_HTTP_RE = /^(fetch|axios|got|superagent|node-fetch|ky|request|https?|xmlhttprequest|grpc|undici|requests|aiohttp|httpx|urllib|urllib2|urllib3|curl|curleasy|pycurl|http|httpclient|httpurlconnection|reqwest|hyper|ureq|isahc|surf|net|faraday|httparty|rest|typhoeus|excon|okhttp|retrofit|feign|resttemplate|webclient|urlsession|alamofire|moya)$/;
const EXTERNAL_DB_RE = /^(pg|mysql|mysql2|sqlite|sqlite3|redis|ioredis|mongoose|mongo|mongodb|prisma|knex|sequelize|typeorm|drizzle|cassandra|dynamodb|firestore|supabase|neo4j|influxdb|clickhouse|kysely|psycopg2|psycopg|sqlalchemy|pymysql|asyncpg|motor|aiomysql|tortoise|sql|gorm|sqlx|pgx|bun|diesel|seaorm|rusqlite|activerecord|sequel|jdbc|hibernate|jpa|entitymanager|datasource|jdbctemplate|r2dbc|coredata|grdb|realm)$/;
const EXTERNAL_FS_RE = /^(fs|fsp|readfile|writefile|readdir|stat|mkdir|unlink|rename|copyfile|createreadstream|createwritestream|open|fopen|fread|fwrite|fclose|remove|ifstream|ofstream|fstream|os|path|file)$/;
const EXTERNAL_STDLIB_BASES = new Set([
  // JavaScript / Node.js
  'array', 'object', 'string', 'number', 'math', 'json', 'date', 'regexp',
  'promise', 'map', 'set', 'weakmap', 'weakset', 'symbol', 'reflect', 'proxy',
  'console', 'error', 'buffer', 'process', 'int8array', 'uint8array',
  // Python
  'os', 'sys', 're', 'io', 'abc', 'ast', 'csv', 'copy', 'enum', 'glob',
  'gzip', 'hmac', 'html', 'http', 'logging', 'operator', 'pathlib', 'pickle',
  'pprint', 'queue', 'random', 'shutil', 'signal', 'socket', 'ssl', 'struct',
  'subprocess', 'tempfile', 'threading', 'time', 'traceback', 'typing', 'uuid',
  'warnings', 'collections', 'functools', 'itertools', 'contextlib',
  'dataclasses', 'unittest', 'hashlib', 'base64', 'binascii', 'codecs',
  'inspect', 'importlib', 'weakref', 'gc', 'platform', 'shlex', 'textwrap',
  // C / C++
  'std', 'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'malloc',
  'calloc', 'realloc', 'free', 'memcpy', 'memmove', 'memset', 'memcmp',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strcmp', 'strncmp', 'strstr',
  'assert', 'abort', 'exit', 'atexit',
  // Go
  'fmt', 'log', 'sort', 'sync', 'atomic', 'bytes', 'errors', 'context',
  'reflect', 'runtime', 'bufio', 'unicode', 'strings', 'strconv', 'math',
  'rand', 'time', 'flag', 'testing',
  // Rust
  'vec', 'option', 'result', 'iter', 'collections', 'thread', 'env',
  'cell', 'rc', 'arc', 'mutex', 'rwlock', 'channel', 'mpsc',
  // Ruby
  'integer', 'float', 'numeric', 'enumerable', 'comparable', 'kernel',
  'module', 'class', 'basicobject', 'nilclass', 'trueclass', 'falseclass',
  'symbol', 'regexp', 'range', 'proc', 'method', 'encoding',
  // Java
  'system', 'integer', 'long', 'double', 'boolean', 'character',
  'list', 'arraylist', 'linkedlist', 'hashmap', 'treemap', 'hashset', 'treeset',
  'optional', 'stream', 'arrays', 'collections', 'objects', 'math',
  'thread', 'runnable', 'exception', 'runtimeexception', 'illegalargumentexception',
  'stringbuilder', 'stringbuffer', 'scanner',
  // Swift
  'int', 'double', 'bool', 'dictionary', 'swift', 'foundation',
  'dispatchqueue', 'notificationcenter', 'nsstring', 'nsarray', 'nsdictionary',
]);
const EXTERNAL_NOISE_RECEIVERS = new Set([
  'response', 'body', 't', 'err', 'error', 'buf', 'str', 'res', 'req', 'data', 'result',
]);

function classifyExternal(name: string): ExternalKind {
  const base = name.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (EXTERNAL_HTTP_RE.test(base)) return 'http';
  if (EXTERNAL_DB_RE.test(base)) return 'database';
  if (EXTERNAL_FS_RE.test(base)) return 'filesystem';
  if (EXTERNAL_STDLIB_BASES.has(base)) return 'stdlib';
  if (name.includes('.') && EXTERNAL_NOISE_RECEIVERS.has(name.split('.')[0].toLowerCase())) return 'stdlib';
  return 'unknown';
}

function getOrCreateExternalNode(name: string, nodes: Map<string, FunctionNode>): FunctionNode {
  const id = `external::${name}`;
  if (!nodes.has(id)) {
    nodes.set(id, {
      id, name, filePath: 'external', isExternal: true,
      externalKind: classifyExternal(name),
      isAsync: false, language: 'external',
      startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0,
    });
  }
  return nodes.get(id)!;
}

// ============================================================================
// CYCLOMATIC COMPLEXITY
// ============================================================================

const CC_PATTERN_PYTHON = /\bif\s|\belif\s|\bwhile\s|\bfor\s|\bexcept\b|\band\s|\bor\s/g;
const CC_PATTERN_DEFAULT = /\bif\s*\(|\bwhile\s*\(|\bfor\s*[(]|\bdo\s*[{]|\bcase\s+|\bcatch\s*\(|&&|\|\|/g;

/**
 * McCabe cyclomatic complexity via regex over function body.
 * CC = 1 + decision points (if, while, for, case, catch, &&, ||).
 * Approximate (regex, not AST), suitable for triage/ranking.
 */
export function computeCyclomaticComplexity(body: string, language: string): number {
  const source = language === 'Python' ? CC_PATTERN_PYTHON.source : CC_PATTERN_DEFAULT.source;
  return 1 + (body.match(new RegExp(source, 'g'))?.length ?? 0);
}

// ============================================================================
// CALL GRAPH BUILDER
// ============================================================================

// ============================================================================
// DYNAMIC-DISPATCH EDGE SYNTHESIS (spec: add-synthesized-dynamic-dispatch-edges)
//
// A deterministic, additive post-resolution pass that recovers call edges direct
// name resolution cannot: event channels and route→handler bindings. Every edge
// it emits carries `confidence: 'synthesized'` + a `synthesizedBy` rule name, so
// it is never silently mixed with directly-resolved edges. No LLM — pattern
// matching over the same tree-sitter trees the graph is built from. Rules are
// independent: each reads the inputs and returns edges; adding one cannot change
// another's output.
// ============================================================================

/** Per-channel handler fan-out cap. Over-cap channels are DROPPED, never guessed. */
export const EVENT_CHANNEL_FANOUT_CAP = 8;

/**
 * Identifiers that are runtime/promise/middleware callback LOCALS, not registered named
 * handlers — e.g. the `resolve`/`reject` parameters of a Promise executor, Express/Koa
 * `next`, node-callback `err`/`callback`/`cb`/`done`. Resolving these by name to a
 * coincidentally same-named function elsewhere produces false synthesized edges
 * (observed: `setTimeout(resolve, ms)` inside `new Promise((resolve) => …)`). They are
 * never legitimate handler references, so all reference-based handler resolution skips them.
 */
const RUNTIME_CALLBACK_LOCALS = new Set(['resolve', 'reject', 'next', 'done', 'callback', 'cb', 'err', 'error', 'fulfill']);

/**
 * JS/TS methods that register a handler on a channel key: `x.on('k', fn)`. Covers
 * Node EventEmitter (`on`/`once`/`addListener`/`prepend*`), the DOM
 * (`addEventListener`), and pub/sub (`subscribe`). A bare `subscribe(fn)` (RxJS,
 * no key) is naturally ignored — registration requires a string-literal first arg.
 */
const EVENT_REGISTER_METHODS = new Set([
  'on', 'once', 'addListener', 'prependListener', 'prependOnceListener', 'addEventListener', 'subscribe',
]);
/** JS/TS methods that dispatch on a channel key: `x.emit('k')` / `x.dispatchEvent(new Event('k'))`. */
const EVENT_DISPATCH_METHODS = new Set(['emit', 'dispatch', 'publish', 'dispatchEvent']);

/** Ruby adds instrumentation/broadcast dispatch verbs (ActiveSupport::Notifications, pub/sub). */
const RUBY_DISPATCH_METHODS = new Set([...EVENT_DISPATCH_METHODS, 'instrument', 'broadcast']);

/** PHP register/dispatch verbs (Laravel `Event::listen`/`event()`, Symfony `addListener`/`dispatch`). */
const PHP_REGISTER_METHODS = new Set(['listen', 'addListener', 'subscribe', 'on']);
const PHP_DISPATCH_METHODS = new Set(['dispatch', 'emit', 'fire', 'publish', 'broadcast', 'event']);

/** Single regex pre-filter so we only parse files that could contain a pattern. */
const EVENT_PREFILTER = /\b(on|once|addListener|prependListener|prependOnceListener|addEventListener|subscribe|emit|dispatch|publish|dispatchEvent|instrument|broadcast|listen|fire|event)\s*\(/;

/** Pre-filters for the type-based (Java/C#) rule: an annotation/interface or a dispatch verb. */
const JAVA_TYPE_EVENT_PREFILTER = /@(?:Subscribe|EventListener|TransactionalEventListener|EventHandler)\b|\b(?:post|publishEvent|publish|fire|fireEvent|raise|send)\s*\(/;
const CSHARP_TYPE_EVENT_PREFILTER = /\b(?:INotificationHandler|IRequestHandler|IConsumer|IEventHandler|IHandleMessages|IHandle)\b|\b(?:Publish|Send|Raise|RaiseEvent|Fire|Notify)\s*\(/;
/** Swift NotificationCenter pre-filter: an observer registration or a post. */
const SWIFT_EVENT_PREFILTER = /\b(?:addObserver|post)\s*\(/;

/** Resolve a referenced simple name to a single internal function node, or undefined
 *  when unknown or ambiguous (never guesses). Prefers a match in `preferFile`. */
type HandlerResolver = (name: string, preferFile: string) => FunctionNode | undefined;

/** Method name of a call's callee: property for `a.b()`, identifier for `b()`. */
function calleeMethodName(callee: Parser.SyntaxNode | null): string | undefined {
  if (!callee) return undefined;
  if (callee.type === 'identifier') return callee.text;
  if (callee.type === 'member_expression') return callee.childForFieldName('property')?.text;
  return undefined;
}

/**
 * Static channel key of an argument node, or undefined when not statically pairable.
 * Accepts the forms that appear on BOTH a registration and a dispatch site so the two
 * pair deterministically:
 *   - a string literal `'mount'`                          → `str:mount`
 *   - a substitution-free template literal `` `mount` ``  → `str:mount`
 *   - a constant member reference `EVENTS.MOUNT`          → `const:EVENTS.MOUNT`
 * The `str:`/`const:` namespace prefix keeps a string `'MOUNT'` from pairing with a
 * constant `EVENTS.MOUNT`. A computed/dynamic key returns undefined (no guess).
 */
function staticChannelKey(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'string') {
    // tree-sitter `string` text includes the surrounding quotes.
    return `str:${node.text.length >= 2 ? node.text.slice(1, -1) : ''}`;
  }
  if (node.type === 'template_string') {
    // Only a literal template with no ${…} substitution is a static key.
    if (node.descendantsOfType('template_substitution').length === 0) {
      return `str:${node.text.length >= 2 ? node.text.slice(1, -1) : ''}`;
    }
    return undefined;
  }
  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object');
    const prop = node.childForFieldName('property');
    if (obj?.type === 'identifier' && prop?.type === 'property_identifier') {
      return `const:${obj.text}.${prop.text}`;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Channel key for a dispatch call. For `dispatchEvent(new Event('k'))` /
 * `dispatchEvent(new CustomEvent('k'))` the key is the Event constructor's first
 * static argument; otherwise it is the call's first static argument.
 */
function dispatchChannelKey(method: string, args: Parser.SyntaxNode[]): string | undefined {
  if (method === 'dispatchEvent') {
    const arg0 = args[0];
    if (arg0?.type === 'new_expression') {
      const ctorArgs = arg0.childForFieldName('arguments')?.namedChildren ?? [];
      return staticChannelKey(ctorArgs[0]);
    }
    return undefined;
  }
  return staticChannelKey(args[0]);
}

/**
 * Resolve the handler argument of a registration to the internal function node-ids
 * it dispatches to. Handles, deterministically and without guessing:
 *   - a bare identifier `fn`
 *   - a member reference `this.fn` / `obj.fn`
 *   - a bound reference `fn.bind(this)`
 *   - an inline arrow / function expression — wired to the internal functions its
 *     body actually calls (so `() => realHandler()` still connects the dispatcher
 *     to `realHandler`).
 * Every leaf resolves through {@link HandlerResolver} (exact, single-match only).
 */
function resolveHandlerTargets(
  arg: Parser.SyntaxNode | undefined,
  file: string,
  resolveHandler: HandlerResolver,
): string[] {
  if (!arg) return [];
  const add = (name: string | undefined, out: string[]): void => {
    if (!name) return;
    const node = resolveHandler(name, file);
    if (node) out.push(node.id);
  };

  if (arg.type === 'identifier') {
    const out: string[] = []; add(arg.text, out); return out;
  }
  if (arg.type === 'member_expression') {
    const out: string[] = []; add(arg.childForFieldName('property')?.text, out); return out;
  }
  if (arg.type === 'call_expression') {
    // `fn.bind(this)` — unwrap to the bound function reference.
    const callee = arg.childForFieldName('function');
    if (callee?.type === 'member_expression' && callee.childForFieldName('property')?.text === 'bind') {
      return resolveHandlerTargets(callee.childForFieldName('object') ?? undefined, file, resolveHandler);
    }
    return [];
  }
  if (arg.type === 'arrow_function' || arg.type === 'function_expression' || arg.type === 'function' || arg.type === 'function_declaration') {
    // Inline handler — wire to the internal functions its body calls.
    const out: string[] = [];
    const seen = new Set<string>();
    for (const inner of arg.descendantsOfType('call_expression')) {
      const id = resolveHandler(calleeMethodName(inner.childForFieldName('function')) ?? '', file)?.id;
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  }
  return [];
}

// Shared registration/dispatch site shapes produced by each language's collector.
interface EventRegistration { key: string; handlerIds: string[] }
interface EventDispatch { key: string; callerId: string; line: number }
interface EventSites { registrations: EventRegistration[]; dispatches: EventDispatch[] }

/**
 * Pair an EventSites set (from ONE language) into synthesized edges: group handlers
 * by channel key, drop over-cap channels, and emit a dispatcher→handler edge per
 * pair. Language-agnostic — only the collection of sites is language-specific, so
 * pairing/fan-out/provenance stay identical across languages and adding a language
 * cannot change another's edges.
 */
function pairAndEmitEventEdges(sites: EventSites, allNodes: Map<string, FunctionNode>, ruleName: string): CallEdge[] {
  if (sites.dispatches.length === 0) return [];

  const handlersByKey = new Map<string, Set<string>>();
  for (const reg of sites.registrations) {
    let set = handlersByKey.get(reg.key);
    if (!set) handlersByKey.set(reg.key, (set = new Set()));
    for (const id of reg.handlerIds) set.add(id);
  }

  // Fan-out cap: DROP over-cap channels (typically generic keys) rather than guess.
  for (const [key, set] of handlersByKey) {
    if (set.size > EVENT_CHANNEL_FANOUT_CAP) {
      logger.debug(
        `[edge-synthesis] event-channel '${key}' dropped: ${set.size} handlers exceed cap ${EVENT_CHANNEL_FANOUT_CAP}`,
      );
      handlersByKey.delete(key);
    }
  }

  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const disp of sites.dispatches) {
    const handlers = handlersByKey.get(disp.key);
    if (!handlers) continue;
    for (const handlerId of handlers) {
      if (handlerId === disp.callerId) continue; // no trivial self-edge
      const pair = `${disp.callerId}\0${handlerId}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      edges.push({
        callerId: disp.callerId,
        calleeId: handlerId,
        calleeName: allNodes.get(handlerId)?.name ?? '',
        line: disp.line,
        confidence: 'synthesized',
        kind: 'calls',
        callType: 'direct',
        synthesizedBy: ruleName,
      });
    }
  }
  return edges;
}

/** Collect JS/TS event-channel sites from one parsed file into `sites`. */
function collectTsEventSites(
  tree: Parser.Tree, fileNodes: FunctionNode[], filePath: string,
  resolveHandler: HandlerResolver, sites: EventSites,
): void {
  for (const call of tree.rootNode.descendantsOfType('call_expression')) {
    const method = calleeMethodName(call.childForFieldName('function'));
    if (!method) continue;
    const argsNode = call.childForFieldName('arguments');
    if (!argsNode) continue;
    const args = argsNode.namedChildren;
    if (EVENT_REGISTER_METHODS.has(method)) {
      const key = staticChannelKey(args[0]);
      if (key !== undefined) {
        const handlerIds = resolveHandlerTargets(args[1], filePath, resolveHandler);
        if (handlerIds.length) sites.registrations.push({ key, handlerIds });
      }
    } else if (EVENT_DISPATCH_METHODS.has(method)) {
      const key = dispatchChannelKey(method, args);
      if (key !== undefined) {
        const caller = findEnclosingFunction(fileNodes, call.startIndex);
        if (caller) sites.dispatches.push({ key, callerId: caller.id, line: call.startPosition.row + 1 });
      }
    }
  }
}

/** Method name of a Python call's callee: `x.method()` (attribute) or `method()` (identifier). */
function pyCalleeMethodName(func: Parser.SyntaxNode | null): string | undefined {
  if (!func) return undefined;
  if (func.type === 'identifier') return func.text;
  if (func.type === 'attribute') return func.childForFieldName('attribute')?.text;
  return undefined;
}

/** Static channel key for a Python argument (string literal or `Const.MEMBER`), namespaced. */
function pyChannelKey(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'string') {
    if (node.descendantsOfType('interpolation').length > 0) return undefined; // f-string with {expr}
    const m = node.text.match(/^[A-Za-z]*('''|"""|'|")([\s\S]*)\1$/);
    return m ? `str:${m[2]}` : undefined;
  }
  if (node.type === 'attribute') {
    const obj = node.childForFieldName('object');
    const attr = node.childForFieldName('attribute');
    if (obj?.type === 'identifier' && attr?.type === 'identifier') return `const:${obj.text}.${attr.text}`;
    return undefined;
  }
  return undefined;
}

/** Resolve a Python handler argument to internal node-ids: `fn`, `self.fn`, or an inline `lambda`. */
function pyHandlerTargets(arg: Parser.SyntaxNode | undefined, file: string, resolveHandler: HandlerResolver): string[] {
  if (!arg) return [];
  const out: string[] = [];
  const add = (name: string | undefined): void => { if (name) { const n = resolveHandler(name, file); if (n) out.push(n.id); } };
  if (arg.type === 'identifier') { add(arg.text); return out; }
  if (arg.type === 'attribute') { add(arg.childForFieldName('attribute')?.text); return out; }
  if (arg.type === 'lambda') {
    const seen = new Set<string>();
    for (const inner of arg.descendantsOfType('call')) {
      const id = resolveHandler(pyCalleeMethodName(inner.childForFieldName('function')) ?? '', file)?.id;
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  }
  return [];
}

/** Collect Python event-channel sites (pyee-style `on`/`emit`, pub/sub `subscribe`/`publish`). */
function collectPyEventSites(
  tree: Parser.Tree, fileNodes: FunctionNode[], filePath: string,
  resolveHandler: HandlerResolver, sites: EventSites,
): void {
  for (const call of tree.rootNode.descendantsOfType('call')) {
    const method = pyCalleeMethodName(call.childForFieldName('function'));
    if (!method) continue;
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    if (EVENT_REGISTER_METHODS.has(method)) {
      const key = pyChannelKey(args[0]);
      if (key !== undefined) {
        const handlerIds = pyHandlerTargets(args[1], filePath, resolveHandler);
        if (handlerIds.length) sites.registrations.push({ key, handlerIds });
      }
    } else if (EVENT_DISPATCH_METHODS.has(method)) {
      const key = pyChannelKey(args[0]); // Python has no dispatchEvent(new Event())
      if (key !== undefined) {
        const caller = findEnclosingFunction(fileNodes, call.startIndex);
        if (caller) sites.dispatches.push({ key, callerId: caller.id, line: call.startPosition.row + 1 });
      }
    }
  }
}

/** Static channel key for a Ruby argument: a symbol (`:mount`) or a string literal. */
function rubyChannelKey(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'simple_symbol') return `sym:${node.text.replace(/^:/, '')}`;
  if (node.type === 'string') {
    if (node.descendantsOfType('interpolation').length > 0) return undefined;
    const m = node.text.match(/^('|")([\s\S]*)\1$/);
    return m ? `str:${m[2]}` : undefined;
  }
  return undefined;
}

/**
 * Resolve a Ruby handler to internal node-ids. Ruby handlers are usually a block
 * (`on(:x) { … }` / `subscribe('x') { … }`) — wired to the internal functions the
 * block calls, including paren-less bareword calls; the conservative resolver drops
 * block params and locals. Also handles a block-pass `&handler` / trailing proc arg.
 */
function rubyHandlerTargets(call: Parser.SyntaxNode, file: string, resolveHandler: HandlerResolver): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | undefined): void => {
    if (!name) return;
    const n = resolveHandler(name, file);
    if (n && !seen.has(n.id)) { seen.add(n.id); out.push(n.id); }
  };
  const block = call.childForFieldName('block');
  if (block) {
    for (const inner of block.descendantsOfType('call')) add(inner.childForFieldName('method')?.text);
    // Paren-less bareword calls appear as bare identifiers; resolver gates to real fns.
    for (const id of block.descendantsOfType('identifier')) add(id.text);
  }
  const args = call.childForFieldName('arguments')?.namedChildren ?? [];
  for (const a of args.slice(1)) {
    if (a.type === 'block_argument' || a.type === 'block_pass') {
      const ref = a.namedChildren.find(c => c.type === 'identifier' || c.type === 'simple_symbol');
      if (ref) add(ref.type === 'simple_symbol' ? ref.text.replace(/^:/, '') : ref.text);
    } else if (a.type === 'identifier') {
      add(a.text);
    }
  }
  return out;
}

/** Collect Ruby event-channel sites (symbol/string-keyed on/emit, ActiveSupport::Notifications). */
function collectRubyEventSites(
  tree: Parser.Tree, fileNodes: FunctionNode[], filePath: string,
  resolveHandler: HandlerResolver, sites: EventSites,
): void {
  for (const call of tree.rootNode.descendantsOfType('call')) {
    const method = call.childForFieldName('method')?.text;
    if (!method) continue;
    const args = call.childForFieldName('arguments')?.namedChildren ?? [];
    if (EVENT_REGISTER_METHODS.has(method)) {
      const key = rubyChannelKey(args[0]);
      if (key !== undefined) {
        const handlerIds = rubyHandlerTargets(call, filePath, resolveHandler);
        if (handlerIds.length) sites.registrations.push({ key, handlerIds });
      }
    } else if (RUBY_DISPATCH_METHODS.has(method)) {
      const key = rubyChannelKey(args[0]);
      if (key !== undefined) {
        const caller = findEnclosingFunction(fileNodes, call.startIndex);
        if (caller) sites.dispatches.push({ key, callerId: caller.id, line: call.startPosition.row + 1 });
      }
    }
  }
}

/** Method name of a PHP call (`Cls::m()`, `$o->m()`, or `m()`). */
function phpMethodName(call: Parser.SyntaxNode): string | undefined {
  if (call.type === 'function_call_expression') return call.childForFieldName('function')?.text;
  return call.childForFieldName('name')?.text; // scoped_/member_call_expression
}

/** Unwrap a PHP `arguments` node to its ordered argument VALUE nodes. */
function phpArgValues(call: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const argsNode = call.childForFieldName('arguments');
  return (argsNode?.namedChildren ?? []).map(a => (a.type === 'argument' ? a.namedChildren[0] ?? a : a));
}

/** Static string-literal channel key for a PHP value, or undefined. */
function phpChannelKey(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node || node.type !== 'string') return undefined; // encapsed_string (interpolated) excluded
  const m = node.text.match(/^('|")([\s\S]*)\1$/);
  return m ? `str:${m[2]}` : undefined;
}

/** Resolve a PHP handler value to node-ids: a `'fn'` string, `[Cls, 'method']`, or a closure. */
function phpHandlerTargets(node: Parser.SyntaxNode | undefined, file: string, resolveHandler: HandlerResolver): string[] {
  if (!node) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const m = raw.match(/^('|")([\s\S]*)\1$/);
    const name = (m ? m[2] : raw).split('\\').pop()?.split('::').pop();
    if (!name) return;
    const n = resolveHandler(name, file);
    if (n && !seen.has(n.id)) { seen.add(n.id); out.push(n.id); }
  };
  if (node.type === 'string') { add(node.text); return out; }
  if (node.type === 'array_creation_expression') {
    // [$this, 'method'] / [Cls::class, 'method'] — the method name is a string element.
    for (const el of node.descendantsOfType('string')) add(el.text);
    return out;
  }
  if (node.type === 'anonymous_function' || node.type === 'anonymous_function_creation_expression' || node.type === 'arrow_function') {
    for (const inner of node.descendantsOfType(['function_call_expression', 'scoped_call_expression', 'member_call_expression'])) {
      add(phpMethodName(inner));
    }
    return out;
  }
  return [];
}

/** Collect PHP event-channel sites (Laravel `Event::listen`/`event()`, Symfony dispatcher). */
function collectPhpEventSites(
  tree: Parser.Tree, fileNodes: FunctionNode[], filePath: string,
  resolveHandler: HandlerResolver, sites: EventSites,
): void {
  const calls = tree.rootNode.descendantsOfType(['scoped_call_expression', 'member_call_expression', 'function_call_expression']);
  for (const call of calls) {
    const method = phpMethodName(call);
    if (!method) continue;
    const args = phpArgValues(call);
    if (PHP_REGISTER_METHODS.has(method)) {
      const key = phpChannelKey(args[0]);
      if (key !== undefined) {
        const handlerIds = phpHandlerTargets(args[1], filePath, resolveHandler);
        if (handlerIds.length) sites.registrations.push({ key, handlerIds });
      }
    } else if (PHP_DISPATCH_METHODS.has(method)) {
      const key = phpChannelKey(args[0]);
      if (key !== undefined) {
        const caller = findEnclosingFunction(fileNodes, call.startIndex);
        if (caller) sites.dispatches.push({ key, callerId: caller.id, line: call.startPosition.row + 1 });
      }
    }
  }
}

// ── Type-based events (Java/C#): keyed on the event TYPE, not a string channel ──

/** Java annotations that mark an event-handler method. */
const JAVA_HANDLER_ANNOTATIONS = new Set(['Subscribe', 'EventListener', 'TransactionalEventListener', 'EventHandler']);
/** Java dispatch verbs carrying a constructed event (Guava `post`, Spring `publishEvent`). */
const JAVA_TYPE_DISPATCH_METHODS = new Set(['post', 'publishEvent', 'publish', 'fire', 'fireEvent', 'raise', 'send']);
/** C# handler interfaces whose first type argument is the handled event type. */
const CSHARP_HANDLER_INTERFACES = new Set(['INotificationHandler', 'IRequestHandler', 'IConsumer', 'IEventHandler', 'IHandleMessages', 'IHandle']);
/** C# dispatch verbs carrying a constructed event (MediatR `Publish`/`Send`, aggregators `Publish`). */
const CSHARP_TYPE_DISPATCH_METHODS = new Set(['Publish', 'Send', 'Raise', 'RaiseEvent', 'Fire', 'Notify']);

/** Handler node-id for a declaration node (the call-graph node enclosing its name). */
function handlerNodeIdAt(declNode: Parser.SyntaxNode, fileNodes: FunctionNode[]): string | undefined {
  const pos = (declNode.childForFieldName('name') ?? declNode).startIndex;
  return findEnclosingFunction(fileNodes, pos)?.id;
}

/** Collect Java type-based event sites (`@Subscribe`/`@EventListener` ↔ `post(new T())`). */
function collectJavaTypeEventSites(
  tree: Parser.Tree, fileNodes: FunctionNode[], _filePath: string, _resolveHandler: HandlerResolver, sites: EventSites,
): void {
  for (const method of tree.rootNode.descendantsOfType('method_declaration')) {
    // `modifiers` is a child (not a named field) in tree-sitter-java; annotations live inside it.
    const mods = method.namedChildren.find(c => c.type === 'modifiers');
    if (!mods) continue;
    const annotated = mods.namedChildren.some(
      a => (a.type === 'marker_annotation' || a.type === 'annotation') &&
        JAVA_HANDLER_ANNOTATIONS.has(a.childForFieldName('name')?.text ?? ''),
    );
    if (!annotated) continue;
    const params = method.childForFieldName('parameters') ?? method.namedChildren.find(c => c.type === 'formal_parameters');
    const firstParam = params?.namedChildren.find(c => c.type === 'formal_parameter');
    const typeNode = firstParam?.childForFieldName('type');
    if (typeNode?.type !== 'type_identifier') continue; // require a concrete type
    const handlerId = handlerNodeIdAt(method, fileNodes);
    if (handlerId) sites.registrations.push({ key: `type:${typeNode.text}`, handlerIds: [handlerId] });
  }
  for (const inv of tree.rootNode.descendantsOfType('method_invocation')) {
    const name = inv.childForFieldName('name')?.text;
    if (!name || !JAVA_TYPE_DISPATCH_METHODS.has(name)) continue;
    const arg0 = inv.childForFieldName('arguments')?.namedChildren[0];
    if (arg0?.type !== 'object_creation_expression') continue;
    const t = arg0.childForFieldName('type')?.text;
    if (!t) continue;
    const caller = findEnclosingFunction(fileNodes, inv.startIndex);
    if (caller) sites.dispatches.push({ key: `type:${t}`, callerId: caller.id, line: inv.startPosition.row + 1 });
  }
}

/** C# invocation method name: `x.M()` (member access) or `M()` (identifier). */
function csInvocationName(inv: Parser.SyntaxNode): string | undefined {
  const fn = inv.childForFieldName('function');
  if (!fn) return undefined;
  if (fn.type === 'member_access_expression') return fn.childForFieldName('name')?.text;
  if (fn.type === 'identifier') return fn.text;
  return undefined;
}

/** First type argument of a handler interface in a C# class's base list, or undefined. */
function csHandlerEventType(cls: Parser.SyntaxNode): string | undefined {
  const bases = cls.childForFieldName('bases') ?? cls.namedChildren.find(c => c.type === 'base_list');
  if (!bases) return undefined;
  for (const g of bases.descendantsOfType('generic_name')) {
    const base = g.namedChildren.find(c => c.type === 'identifier')?.text;
    if (base && CSHARP_HANDLER_INTERFACES.has(base)) {
      const arg = g.childForFieldName('type_arguments')?.namedChildren.find(c => c.type === 'identifier')
        ?? g.namedChildren.find(c => c.type === 'type_argument_list')?.namedChildren.find(c => c.type === 'identifier');
      if (arg) return arg.text;
    }
  }
  return undefined;
}

/** First parameter type name of a C# method, or undefined. */
function csFirstParamType(method: Parser.SyntaxNode): string | undefined {
  const params = method.childForFieldName('parameters') ?? method.namedChildren.find(c => c.type === 'parameter_list');
  const first = params?.namedChildren.find(c => c.type === 'parameter');
  const t = first?.childForFieldName('type');
  return t?.type === 'identifier' ? t.text : undefined;
}

/** Collect C# type-based event sites (`INotificationHandler<T>` ↔ `Publish(new T())`). */
function collectCSharpTypeEventSites(
  tree: Parser.Tree, fileNodes: FunctionNode[], _filePath: string, _resolveHandler: HandlerResolver, sites: EventSites,
): void {
  for (const cls of tree.rootNode.descendantsOfType('class_declaration')) {
    const eventType = csHandlerEventType(cls);
    if (!eventType) continue;
    for (const method of cls.descendantsOfType('method_declaration')) {
      if (csFirstParamType(method) !== eventType) continue;
      const handlerId = handlerNodeIdAt(method, fileNodes);
      if (handlerId) sites.registrations.push({ key: `type:${eventType}`, handlerIds: [handlerId] });
    }
  }
  for (const inv of tree.rootNode.descendantsOfType('invocation_expression')) {
    const name = csInvocationName(inv);
    if (!name || !CSHARP_TYPE_DISPATCH_METHODS.has(name)) continue;
    const arg0 = inv.childForFieldName('arguments')?.namedChildren[0]?.namedChildren?.[0]
      ?? inv.childForFieldName('arguments')?.namedChildren[0];
    const ctor = arg0?.type === 'object_creation_expression' ? arg0
      : arg0?.descendantsOfType('object_creation_expression')[0];
    const t = ctor?.childForFieldName('type')?.text;
    if (!t) continue;
    const caller = findEnclosingFunction(fileNodes, inv.startIndex);
    if (caller) sites.dispatches.push({ key: `type:${t}`, callerId: caller.id, line: inv.startPosition.row + 1 });
  }
}

/** Method name of a Kotlin call_expression: `recv.m(...)` (navigation) or `m(...)` (identifier). */
function ktCallName(call: Parser.SyntaxNode): string | undefined {
  const callee = call.namedChildren[0];
  if (!callee) return undefined;
  if (callee.type === 'simple_identifier') return callee.text;
  if (callee.type === 'navigation_expression') {
    const suffixes = callee.namedChildren.filter(c => c.type === 'navigation_suffix');
    return suffixes[suffixes.length - 1]?.namedChildren.find(c => c.type === 'simple_identifier')?.text;
  }
  return undefined;
}

/** Ordered argument VALUE nodes of a Kotlin call (`call_suffix > value_arguments > value_argument`). */
function ktArgValues(call: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const suffix = call.namedChildren.find(c => c.type === 'call_suffix');
  const va = suffix?.namedChildren.find(c => c.type === 'value_arguments');
  return (va?.namedChildren.filter(c => c.type === 'value_argument') ?? [])
    .map(a => a.namedChildren[a.namedChildren.length - 1]);
}

/** Constructed type for a Kotlin value: `Foo(...)` is a call_expression with a Capitalized callee. */
function ktConstructedType(value: Parser.SyntaxNode | undefined): string | undefined {
  if (value?.type !== 'call_expression') return undefined;
  const callee = value.namedChildren[0];
  if (callee?.type === 'simple_identifier' && /^[A-Z]/.test(callee.text)) return callee.text;
  return undefined;
}

/** Collect Kotlin type-based event sites (JVM annotation model, like Java; construction is `T(...)`). */
function collectKotlinTypeEventSites(
  tree: Parser.Tree, fileNodes: FunctionNode[], _filePath: string, _resolveHandler: HandlerResolver, sites: EventSites,
): void {
  for (const fn of tree.rootNode.descendantsOfType('function_declaration')) {
    const mods = fn.namedChildren.find(c => c.type === 'modifiers');
    const annotated = mods?.descendantsOfType('annotation').some(
      a => JAVA_HANDLER_ANNOTATIONS.has(a.descendantsOfType('type_identifier')[0]?.text ?? ''),
    );
    if (!annotated) continue;
    const params = fn.namedChildren.find(c => c.type === 'function_value_parameters');
    const firstParam = params?.namedChildren.find(c => c.type === 'parameter');
    const t = firstParam?.descendantsOfType('type_identifier')[0]?.text;
    if (!t) continue;
    const nameNode = fn.namedChildren.find(c => c.type === 'simple_identifier');
    const handlerId = nameNode && findEnclosingFunction(fileNodes, nameNode.startIndex)?.id;
    if (handlerId) sites.registrations.push({ key: `type:${t}`, handlerIds: [handlerId] });
  }
  for (const call of tree.rootNode.descendantsOfType('call_expression')) {
    const name = ktCallName(call);
    if (!name || !JAVA_TYPE_DISPATCH_METHODS.has(name)) continue;
    const t = ktConstructedType(ktArgValues(call)[0]);
    if (!t) continue;
    const caller = findEnclosingFunction(fileNodes, call.startIndex);
    if (caller) sites.dispatches.push({ key: `type:${t}`, callerId: caller.id, line: call.startPosition.row + 1 });
  }
}

/** Swift NotificationCenter name → namespaced key: `Notification.Name("x")` / `NSNotification.Name("x")`. */
function swiftNotificationKey(value: Parser.SyntaxNode | undefined): string | undefined {
  if (value?.type !== 'call_expression') return undefined;
  const callee = value.namedChildren[0];
  const endsInName = callee?.type === 'navigation_expression' &&
    callee.descendantsOfType('navigation_suffix').slice(-1)[0]?.text === '.Name';
  if (!endsInName) return undefined;
  const str = value.descendantsOfType('line_string_literal')[0];
  if (!str) return undefined;
  return `str:${str.text.replace(/^"|"$/g, '')}`;
}

/** The labeled argument value for `label:` in a Swift call's value_arguments, or undefined. */
function swiftLabeledArg(call: Parser.SyntaxNode, label: string): Parser.SyntaxNode | undefined {
  const suffix = call.namedChildren.find(c => c.type === 'call_suffix');
  const va = suffix?.namedChildren.find(c => c.type === 'value_arguments');
  for (const arg of va?.namedChildren.filter(c => c.type === 'value_argument') ?? []) {
    if (arg.childForFieldName('name')?.text === label) return arg.namedChildren[arg.namedChildren.length - 1];
  }
  return undefined;
}

/** Collect Swift NotificationCenter sites (`addObserver(forName:…){closure}` ↔ `post(name:…)`). */
function collectSwiftEventSites(
  tree: Parser.Tree, fileNodes: FunctionNode[], filePath: string, resolveHandler: HandlerResolver, sites: EventSites,
): void {
  const callName = (call: Parser.SyntaxNode): string | undefined => {
    const callee = call.namedChildren[0];
    if (callee?.type === 'navigation_expression') {
      return callee.descendantsOfType('navigation_suffix').slice(-1)[0]?.namedChildren.find(c => c.type === 'simple_identifier')?.text;
    }
    if (callee?.type === 'simple_identifier') return callee.text;
    return undefined;
  };
  for (const call of tree.rootNode.descendantsOfType('call_expression')) {
    const name = callName(call);
    if (name === 'addObserver') {
      const key = swiftNotificationKey(swiftLabeledArg(call, 'forName') ?? swiftLabeledArg(call, 'name'));
      if (key === undefined) continue;
      // Handler: the trailing closure's inner calls.
      const lambda = call.namedChildren.find(c => c.type === 'call_suffix')?.namedChildren.find(c => c.type === 'lambda_literal');
      const handlerIds: string[] = [];
      const seen = new Set<string>();
      for (const inner of lambda?.descendantsOfType('call_expression') ?? []) {
        const id = resolveHandler(callName(inner) ?? '', filePath)?.id;
        if (id && !seen.has(id)) { seen.add(id); handlerIds.push(id); }
      }
      if (handlerIds.length) sites.registrations.push({ key, handlerIds });
    } else if (name === 'post') {
      const key = swiftNotificationKey(swiftLabeledArg(call, 'name'));
      if (key === undefined) continue;
      const caller = findEnclosingFunction(fileNodes, call.startIndex);
      if (caller) sites.dispatches.push({ key, callerId: caller.id, line: call.startPosition.row + 1 });
    }
  }
}

/**
 * Event-channel rule: pair handler registrations (`on`/`once`/`addEventListener`/
 * `subscribe`/… with a static key) against dispatch sites (`emit`/`dispatch`/
 * `publish`/`dispatchEvent` on the same key), emitting an edge from each dispatch
 * site's enclosing function to each registered handler. Handler shapes: bare /
 * member (`this.`/`self.`/`obj.`) references, `.bind()`, and inline function/lambda
 * bodies (wired to the internal functions they call). Cross-file by key; per-channel
 * fan-out capped (over-cap dropped).
 *
 * Recovery is PER-LANGUAGE and added one language at a time: each language has its
 * own collector (its AST node types), but pairing/fan-out/provenance are shared, and
 * sites are paired only within their own language (no cross-language pairing). In
 * effect: JavaScript/TypeScript, Python, Ruby, and PHP for the string-key rule.
 *
 * Java and C# use a TYPE-based rule (`synthesizedBy: 'type-event'`) instead: the key
 * is the event type — an annotated/typed handler (`@Subscribe`/`@EventListener`,
 * `INotificationHandler<T>`) paired with a constructed dispatch (`post(new T())`,
 * `Publish(new T())`). Channel-based languages with no statically-pairable idiom (Go,
 * Rust, …) have no collector — the pass emits nothing rather than guess.
 */
async function synthesizeEventChannelEdges(
  files: Array<{ path: string; content: string; language: string }>,
  allNodes: Map<string, FunctionNode>,
  resolveHandler: HandlerResolver,
): Promise<CallEdge[]> {
  const nodesByFile = new Map<string, FunctionNode[]>();
  for (const n of allNodes.values()) {
    if (n.isExternal) continue;
    (nodesByFile.get(n.filePath) ?? nodesByFile.set(n.filePath, []).get(n.filePath)!).push(n);
  }
  const edges: CallEdge[] = [];

  const tsFiles = files.filter(f =>
    (f.language === 'TypeScript' || f.language === 'JavaScript') && EVENT_PREFILTER.test(f.content),
  );
  if (tsFiles.length > 0) {
    const r = await getTSParser();
    if (r) {
      const { parser } = r;
      const sites: EventSites = { registrations: [], dispatches: [] };
      for (const file of tsFiles) {
        try { collectTsEventSites((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
        catch { /* skip unparseable file */ }
      }
      edges.push(...pairAndEmitEventEdges(sites, allNodes, 'event-channel'));
    }
  }

  const pyFiles = files.filter(f => f.language === 'Python' && EVENT_PREFILTER.test(f.content));
  if (pyFiles.length > 0) {
    const r = await getPyParser();
    if (r) {
      const { parser } = r;
      const sites: EventSites = { registrations: [], dispatches: [] };
      for (const file of pyFiles) {
        try { collectPyEventSites((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
        catch { /* skip unparseable file */ }
      }
      edges.push(...pairAndEmitEventEdges(sites, allNodes, 'event-channel'));
    }
  }

  const rubyFiles = files.filter(f => f.language === 'Ruby' && EVENT_PREFILTER.test(f.content));
  if (rubyFiles.length > 0) {
    const r = await getRubyParser();
    if (r) {
      const { parser } = r;
      const sites: EventSites = { registrations: [], dispatches: [] };
      for (const file of rubyFiles) {
        try { collectRubyEventSites((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
        catch { /* skip unparseable file */ }
      }
      edges.push(...pairAndEmitEventEdges(sites, allNodes, 'event-channel'));
    }
  }

  const phpFiles = files.filter(f => f.language === 'PHP' && EVENT_PREFILTER.test(f.content));
  if (phpFiles.length > 0) {
    const r = await getPhpParser();
    if (r) {
      const { parser } = r;
      const sites: EventSites = { registrations: [], dispatches: [] };
      for (const file of phpFiles) {
        try { collectPhpEventSites((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
        catch { /* skip unparseable file */ }
      }
      edges.push(...pairAndEmitEventEdges(sites, allNodes, 'event-channel'));
    }
  }

  // ── Type-based events (keyed on the event TYPE, not a string channel) ──
  const javaFiles = files.filter(f => f.language === 'Java' && JAVA_TYPE_EVENT_PREFILTER.test(f.content));
  if (javaFiles.length > 0) {
    const r = await getJavaParser();
    if (r) {
      const { parser } = r;
      const sites: EventSites = { registrations: [], dispatches: [] };
      for (const file of javaFiles) {
        try { collectJavaTypeEventSites((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
        catch { /* skip unparseable file */ }
      }
      edges.push(...pairAndEmitEventEdges(sites, allNodes, 'type-event'));
    }
  }

  const csFiles = files.filter(f => f.language === 'C#' && CSHARP_TYPE_EVENT_PREFILTER.test(f.content));
  if (csFiles.length > 0) {
    const r = await getCSharpParser();
    if (r) {
      const { parser } = r;
      const sites: EventSites = { registrations: [], dispatches: [] };
      for (const file of csFiles) {
        try { collectCSharpTypeEventSites((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
        catch { /* skip unparseable file */ }
      }
      edges.push(...pairAndEmitEventEdges(sites, allNodes, 'type-event'));
    }
  }

  const ktFiles = files.filter(f => f.language === 'Kotlin' && JAVA_TYPE_EVENT_PREFILTER.test(f.content));
  if (ktFiles.length > 0) {
    const r = await getKotlinParser();
    if (r) {
      const { parser } = r;
      const sites: EventSites = { registrations: [], dispatches: [] };
      for (const file of ktFiles) {
        try { collectKotlinTypeEventSites((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
        catch { /* skip unparseable file */ }
      }
      edges.push(...pairAndEmitEventEdges(sites, allNodes, 'type-event'));
    }
  }

  const swiftFiles = files.filter(f => f.language === 'Swift' && SWIFT_EVENT_PREFILTER.test(f.content));
  if (swiftFiles.length > 0) {
    const r = await getSwiftParser();
    if (r) {
      const { parser } = r;
      const sites: EventSites = { registrations: [], dispatches: [] };
      for (const file of swiftFiles) {
        try { collectSwiftEventSites((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
        catch { /* skip unparseable file */ }
      }
      edges.push(...pairAndEmitEventEdges(sites, allNodes, 'event-channel'));
    }
  }

  return edges;
}

/** Byte offset of the start of a 1-based line in `content`. */
function offsetOfLine(content: string, line: number): number {
  let offset = 0;
  const lines = content.split('\n');
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  return offset;
}

/**
 * Route→handler rule: wire each route detected by the existing route inventory to
 * the handler function it binds, as a synthesized `calls`-kind edge from the route
 * declaration's enclosing function to the handler. Reuses route detection; does not
 * extend it.
 *
 * The edge is attributed to the route registration's enclosing function (e.g. a
 * `setupRoutes(app)` / app-init function — the common Express/Fastify pattern), so a
 * route registered at module top level with no enclosing function is skipped here.
 * Dead-code analysis additionally seeds the *targets* of these edges as liveness
 * roots (they are framework-invoked entry points), so an enclosed route whose setup
 * function is itself unreached still keeps its handler live — see
 * `externallyInvokedHandlerIds` in `reachability.ts`.
 */
async function synthesizeRouteHandlerEdges(
  files: Array<{ path: string; content: string; language: string }>,
  allNodes: Map<string, FunctionNode>,
  resolveHandler: HandlerResolver,
): Promise<CallEdge[]> {
  const contentByPath = new Map(files.map(f => [f.path, f.content]));
  const routes: RouteDefinition[] = [];
  await Promise.all(files.map(async (f) => {
    try {
      if (/\.(py|pyw)$/.test(f.path)) routes.push(...await extractRouteDefinitions(f.path));
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(f.path)) routes.push(...await extractTsRouteDefinitions(f.path));
      else if (/\.java$/.test(f.path)) routes.push(...await extractJavaRouteDefinitions(f.path));
    } catch { /* best-effort per file */ }
  }));
  if (routes.length === 0) return [];

  const nodesByFile = new Map<string, FunctionNode[]>();
  for (const n of allNodes.values()) {
    if (n.isExternal) continue;
    (nodesByFile.get(n.filePath) ?? nodesByFile.set(n.filePath, []).get(n.filePath)!).push(n);
  }

  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (!route.handlerName) continue;
    // Handler may be a qualified `Controller.method` (decorator/class routers) —
    // resolve on the method's simple name (the call-graph node name).
    const simpleHandler = route.handlerName.split('.').pop() ?? route.handlerName;
    const handler = resolveHandler(simpleHandler, route.file);
    if (!handler) continue;
    const content = contentByPath.get(route.file);
    if (content === undefined) continue;
    const caller = findEnclosingFunction(nodesByFile.get(route.file) ?? [], offsetOfLine(content, route.line));
    if (!caller || caller.id === handler.id) continue;
    const pair = `${caller.id}\0${handler.id}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    edges.push({
      callerId: caller.id,
      calleeId: handler.id,
      calleeName: route.handlerName,
      line: route.line,
      confidence: 'synthesized',
      kind: 'calls',
      callType: 'direct',
      synthesizedBy: 'route-handler',
    });
  }
  return edges;
}

/**
 * Run all dynamic-dispatch synthesis rules and return the combined synthesized
 * edges. Rules are independent and order-insensitive; failures are isolated so one
 * rule cannot abort the others (or the build).
 */
// ── Callback-registration rule ────────────────────────────────────────────────
// A NAMED internal function passed to a curated registrar that the framework/runtime
// will later invoke (Go HTTP handlers, JS/TS schedulers). The edge runs from the
// registration's enclosing function to the handler — the same shape as route-handler,
// generalized. Inline closures are deliberately NOT matched here: direct resolution
// already attributes a closure body's calls to its enclosing function, so a synthesized
// edge would be redundant. Only well-known registrars are matched, so a function passed
// to an unrelated call is never mistaken for a callback (false-negatives over false-positives).

/** Go registrars whose function argument is an invoked handler (net/http + gin/echo/chi). */
const GO_CALLBACK_REGISTRARS = new Set(['HandleFunc', 'Handle', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'Any', 'Use']);
/** JS/TS scheduler/deferred registrars that reliably invoke their callback argument. */
const TS_CALLBACK_REGISTRARS = new Set(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback', 'nextTick']);
const GO_CALLBACK_PREFILTER = /\b(?:HandleFunc|Handle|GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Use)\s*\(/;
const TS_CALLBACK_PREFILTER = /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|requestIdleCallback|nextTick)\s*\(/;
/** C++ Qt signal/slot registrar. */
const CPP_CALLBACK_REGISTRARS = new Set(['connect']);
const CPP_CALLBACK_PREFILTER = /\bconnect\s*\(/;

/** Append a callback-registration edge (deduped on caller→callee). */
function pushCallbackEdge(out: CallEdge[], seen: Set<string>, callerId: string, handler: FunctionNode, line: number): void {
  if (callerId === handler.id) return;
  const pair = `${callerId}\0${handler.id}`;
  if (seen.has(pair)) return;
  seen.add(pair);
  out.push({ callerId, calleeId: handler.id, calleeName: handler.name, line, confidence: 'synthesized', kind: 'calls', callType: 'direct', synthesizedBy: 'callback-registration' });
}

/** Collect Go HTTP-handler callback registrations. */
function collectGoCallbackEdges(tree: Parser.Tree, fileNodes: FunctionNode[], file: string, resolveHandler: HandlerResolver, out: CallEdge[], seen: Set<string>): void {
  for (const call of tree.rootNode.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    const name = fn?.type === 'selector_expression' ? fn.childForFieldName('field')?.text : (fn?.type === 'identifier' ? fn.text : undefined);
    if (!name || !GO_CALLBACK_REGISTRARS.has(name)) continue;
    const caller = findEnclosingFunction(fileNodes, call.startIndex);
    if (!caller) continue;
    for (const arg of call.childForFieldName('arguments')?.namedChildren ?? []) {
      const hname = arg.type === 'identifier' ? arg.text : (arg.type === 'selector_expression' ? arg.childForFieldName('field')?.text : undefined);
      if (!hname) continue;
      const h = resolveHandler(hname, file);
      if (h) pushCallbackEdge(out, seen, caller.id, h, call.startPosition.row + 1);
    }
  }
}

/** Collect JS/TS scheduler callback registrations (named-function arguments only). */
function collectTsCallbackEdges(tree: Parser.Tree, fileNodes: FunctionNode[], file: string, resolveHandler: HandlerResolver, out: CallEdge[], seen: Set<string>): void {
  for (const call of tree.rootNode.descendantsOfType('call_expression')) {
    const name = calleeMethodName(call.childForFieldName('function'));
    if (!name || !TS_CALLBACK_REGISTRARS.has(name)) continue;
    const caller = findEnclosingFunction(fileNodes, call.startIndex);
    if (!caller) continue;
    for (const arg of call.childForFieldName('arguments')?.namedChildren ?? []) {
      const hname = arg.type === 'identifier' ? arg.text : (arg.type === 'member_expression' ? arg.childForFieldName('property')?.text : undefined);
      if (!hname) continue; // skip inline arrow/function args — covered by direct resolution
      const h = resolveHandler(hname, file);
      if (h) pushCallbackEdge(out, seen, caller.id, h, call.startPosition.row + 1);
    }
  }
}

/** Collect C++ Qt signal/slot registrations: `connect(sender, &S::sig, recv, &R::slot)`. The slot's
 *  member function resolves to an internal node; the signal (a Qt declaration) does not, so only the
 *  slot is wired. Both the `connect(...)` and `QObject::connect(...)` forms are matched. */
function collectCppCallbackEdges(tree: Parser.Tree, fileNodes: FunctionNode[], file: string, resolveHandler: HandlerResolver, out: CallEdge[], seen: Set<string>): void {
  for (const call of tree.rootNode.descendantsOfType('call_expression')) {
    const fn = call.childForFieldName('function');
    const name = fn?.type === 'identifier' ? fn.text : (fn?.type === 'qualified_identifier' ? fn.text.split('::').pop() : undefined);
    if (!name || !CPP_CALLBACK_REGISTRARS.has(name)) continue;
    const caller = findEnclosingFunction(fileNodes, call.startIndex);
    if (!caller) continue;
    for (const arg of call.childForFieldName('arguments')?.namedChildren ?? []) {
      // A pointer-to-member `&Class::method` (slot/signal); take the member name.
      const qual = arg.type === 'pointer_expression' ? arg.namedChildren.find(c => c.type === 'qualified_identifier') : undefined;
      if (!qual) continue;
      const ids = qual.descendantsOfType('identifier');
      const mname = ids[ids.length - 1]?.text;
      if (!mname) continue;
      const h = resolveHandler(mname, file);
      if (h) pushCallbackEdge(out, seen, caller.id, h, call.startPosition.row + 1);
    }
  }
}

/** Callback-registration rule across languages (Go HTTP handlers, JS/TS schedulers, C++ Qt slots). */
async function synthesizeCallbackRegistrationEdges(
  files: Array<{ path: string; content: string; language: string }>,
  allNodes: Map<string, FunctionNode>,
  resolveHandler: HandlerResolver,
): Promise<CallEdge[]> {
  const nodesByFile = new Map<string, FunctionNode[]>();
  for (const n of allNodes.values()) {
    if (n.isExternal) continue;
    (nodesByFile.get(n.filePath) ?? nodesByFile.set(n.filePath, []).get(n.filePath)!).push(n);
  }
  const out: CallEdge[] = [];
  const seen = new Set<string>();

  const tsFiles = files.filter(f => (f.language === 'TypeScript' || f.language === 'JavaScript') && TS_CALLBACK_PREFILTER.test(f.content));
  if (tsFiles.length > 0) {
    const r = await getTSParser();
    if (r) {
      const { parser } = r;
      for (const file of tsFiles) {
        try { collectTsCallbackEdges((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, out, seen); }
        catch { /* skip */ }
      }
    }
  }

  const goFiles = files.filter(f => f.language === 'Go' && GO_CALLBACK_PREFILTER.test(f.content));
  if (goFiles.length > 0) {
    const r = await getGoParser();
    if (r) {
      const { parser } = r;
      for (const file of goFiles) {
        try { collectGoCallbackEdges((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, out, seen); }
        catch { /* skip */ }
      }
    }
  }

  const cppFiles = files.filter(f => f.language === 'C++' && CPP_CALLBACK_PREFILTER.test(f.content));
  if (cppFiles.length > 0) {
    const r = await getCppParser();
    if (r) {
      const { parser } = r;
      for (const file of cppFiles) {
        try { collectCppCallbackEdges((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, out, seen); }
        catch { /* skip */ }
      }
    }
  }
  return out;
}

// ── Actor-message rule (Elixir GenServer) ─────────────────────────────────────
// The one actor/channel model that is statically pairable to a named handler: a
// GenServer dispatch (`GenServer.cast`/`call`, or `send` → `handle_info`) carries a
// message whose tag (a leading atom, incl. the tag of a `{:tag, …}` tuple) matches a
// `handle_cast`/`handle_call`/`handle_info` clause. Keyed by `{kind}:{tag}` so a cast
// never pairs with a `handle_call` of the same tag. Go channels and Akka `receive`
// blocks are NOT covered — they expose no named handler to pair, so the pass emits
// nothing for them rather than guess.
const ELIXIR_HANDLER_PREFIX: Record<string, string> = { handle_cast: 'excast', handle_call: 'excall', handle_info: 'exinfo' };
const ELIXIR_DISPATCH_PREFIX: Record<string, string> = { cast: 'excast', call: 'excall', send: 'exinfo' };
const ELIXIR_ACTOR_PREFILTER = /\b(?:handle_cast|handle_call|handle_info|GenServer)\b/;

/** Message tag: a leading atom (`:tag`) or the first atom of a `{:tag, …}` tuple. */
function elixirMsgTag(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'atom') return node.text.replace(/^:/, '');
  if (node.type === 'tuple') {
    const first = node.namedChildren[0];
    if (first?.type === 'atom') return first.text.replace(/^:/, '');
  }
  return undefined;
}

/** Collect Elixir GenServer cast/call/send ↔ handle_cast/handle_call/handle_info sites. */
function collectElixirActorSites(tree: Parser.Tree, fileNodes: FunctionNode[], _file: string, _resolveHandler: HandlerResolver, sites: EventSites): void {
  const argsOf = (n: Parser.SyntaxNode) => n.namedChildren.find(c => c.type === 'arguments')?.namedChildren ?? [];
  for (const call of tree.rootNode.descendantsOfType('call')) {
    const callee = call.namedChildren[0];
    if (!callee) continue;
    // Registration: `def handle_cast(<msg>, …)` (or defp).
    if (callee.type === 'identifier' && (callee.text === 'def' || callee.text === 'defp')) {
      const target = argsOf(call)[0];
      if (target?.type !== 'call') continue;
      const hname = target.namedChildren[0]?.type === 'identifier' ? target.namedChildren[0].text : undefined;
      const prefix = hname ? ELIXIR_HANDLER_PREFIX[hname] : undefined;
      if (!prefix) continue;
      const tag = elixirMsgTag(argsOf(target)[0]);
      if (!tag) continue;
      const handler = findEnclosingFunction(fileNodes, target.startIndex);
      if (handler) sites.registrations.push({ key: `${prefix}:${tag}`, handlerIds: [handler.id] });
      continue;
    }
    // Dispatch: `GenServer.cast(pid, <msg>)` / `call` / `send(pid, <msg>)`.
    const method = callee.type === 'dot' ? callee.text.split('.').pop() : (callee.type === 'identifier' ? callee.text : undefined);
    const prefix = method ? ELIXIR_DISPATCH_PREFIX[method] : undefined;
    if (!prefix) continue;
    const tag = elixirMsgTag(argsOf(call)[1]);
    if (!tag) continue;
    const caller = findEnclosingFunction(fileNodes, call.startIndex);
    if (caller) sites.dispatches.push({ key: `${prefix}:${tag}`, callerId: caller.id, line: call.startPosition.row + 1 });
  }
}

/** Actor-message rule across languages (Elixir GenServer). */
async function synthesizeActorMessageEdges(
  files: Array<{ path: string; content: string; language: string }>,
  allNodes: Map<string, FunctionNode>,
  resolveHandler: HandlerResolver,
): Promise<CallEdge[]> {
  const exFiles = files.filter(f => f.language === 'Elixir' && ELIXIR_ACTOR_PREFILTER.test(f.content));
  if (exFiles.length === 0) return [];
  const nodesByFile = new Map<string, FunctionNode[]>();
  for (const n of allNodes.values()) {
    if (n.isExternal) continue;
    (nodesByFile.get(n.filePath) ?? nodesByFile.set(n.filePath, []).get(n.filePath)!).push(n);
  }
  const r = await getElixirParser();
  if (!r) return [];
  const { parser } = r;
  const sites: EventSites = { registrations: [], dispatches: [] };
  for (const file of exFiles) {
    try { collectElixirActorSites((parser as Parser).parse(file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
    catch { /* skip */ }
  }
  return pairAndEmitEventEdges(sites, allNodes, 'actor-message');
}

export async function synthesizeDynamicDispatchEdges(
  files: Array<{ path: string; content: string; language: string }>,
  allNodes: Map<string, FunctionNode>,
  resolveHandler: HandlerResolver,
): Promise<CallEdge[]> {
  const rules: Array<Promise<CallEdge[]>> = [
    synthesizeEventChannelEdges(files, allNodes, resolveHandler).catch(() => []),
    synthesizeRouteHandlerEdges(files, allNodes, resolveHandler).catch(() => []),
    synthesizeCallbackRegistrationEdges(files, allNodes, resolveHandler).catch(() => []),
    synthesizeActorMessageEdges(files, allNodes, resolveHandler).catch(() => []),
  ];
  const results = await Promise.all(rules);
  return results.flat();
}

export class CallGraphBuilder {
  /**
   * Build a call graph from a list of source files.
   *
   * @param files       Source files with path, content, and language
   * @param layers      Optional layer map { layerName: [path prefix, ...] }
   * @param importMap   Optional per-file import map (from ImportResolverBridge)
   * @param resolutionNodes  Optional pre-existing nodes used only to seed the
   *   call-resolution trie (not added to the returned nodes/edges). An
   *   incremental subset rebuild passes the full set of known nodes so calls
   *   into files outside the re-parsed subset resolve to their real node
   *   instead of degrading to a synthetic `external::` leaf.
   */
  async build(
    files: Array<{ path: string; content: string; language: string }>,
    layers?: Record<string, string[]>,
    importMap?: ImportMap,
    resolutionNodes?: FunctionNode[],
  ): Promise<CallGraphResult> {
    const allNodes = new Map<string, FunctionNode>();
    const allRawEdges: RawEdge[] = [];
    const allCfgs = new Map<string, FunctionCfg>();

    // Pass 1: Extract nodes and raw edges from each file
    for (const file of files) {
      try {
        let result: { nodes: FunctionNode[]; rawEdges: RawEdge[]; cfg?: Map<string, FunctionCfg> };

        if (file.language === 'Python') {
          result = await extractPyGraph(file.path, file.content);
        } else if (file.language === 'TypeScript' || file.language === 'JavaScript') {
          result = await extractTSGraph(file.path, file.content);
        } else if (file.language === 'Go') {
          result = await extractGoGraph(file.path, file.content);
        } else if (file.language === 'Rust') {
          result = await extractRustGraph(file.path, file.content);
        } else if (file.language === 'Ruby') {
          result = await extractRubyGraph(file.path, file.content);
        } else if (file.language === 'Java') {
          result = await extractJavaGraph(file.path, file.content);
        } else if (file.language === 'C++') {
          result = await extractCppGraph(file.path, file.content);
        } else if (file.language === 'Swift') {
          result = await extractSwiftGraph(file.path, file.content);
        } else if (file.language === 'Elixir') {
          result = await extractElixirGraph(file.path, file.content);
        } else if (file.language === 'Dart') {
          result = await extractDartGraph(file.path, file.content);
        } else if (QUERY_LANG_SPECS[file.language]) {
          // spec-08 additional languages (C#, Kotlin, PHP, C, Scala, Dart, Lua, Bash).
          result = await extractByQueries(QUERY_LANG_SPECS[file.language], file.path, file.content);
        } else {
          continue;
        }

        // Compute startLine (1-based) from byte offset — cheap, done once at build time
        const lineOffsets = [0];
        for (let i = 0; i < file.content.length; i++) {
          if (file.content[i] === '\n') lineOffsets.push(i + 1);
        }
        const byteToLine = (offset: number): number => {
          let lo = 0, hi = lineOffsets.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineOffsets[mid] <= offset) lo = mid; else hi = mid - 1;
          }
          return lo + 1;
        };
        for (const node of result.nodes) {
          node.startLine = byteToLine(node.startIndex);
          node.endLine = byteToLine(node.endIndex);
          allNodes.set(node.id, node);
        }
        allRawEdges.push(...result.rawEdges);
        if (result.cfg) for (const [id, fnCfg] of result.cfg) allCfgs.set(id, fnCfg);
      } catch (error) {
        // Skip files that fail to parse (syntax errors, encoding issues, etc.)
        if (process.env.DEBUG) {
          console.debug(`[call-graph] Failed to parse ${file.path}: ${(error as Error).message}`);
        }
      }
    }

    // Pass 2: Resolve raw edges — multi-strategy resolution
    const trie = new FunctionRegistryTrie();
    for (const node of allNodes.values()) trie.insert(node);
    // Seed resolution with pre-existing nodes (incremental subset rebuilds) so
    // cross-file calls outside the re-parsed subset still resolve internally.
    // These are NOT added to allNodes, so they never appear in the output.
    // Skip any seed node whose FILE is itself in this build — the fresh parse is
    // authoritative for those files, so a stale node (e.g. a symbol this edit
    // renamed away) must not leak back in and re-bind a caller to the old id
    // (fix-transitive-incremental-staleness).
    if (resolutionNodes) {
      const subsetFiles = new Set(files.map((f) => f.path));
      for (const node of resolutionNodes) {
        if (subsetFiles.has(node.filePath)) continue;
        if (!allNodes.has(node.id) && !node.isExternal) trie.insert(node);
      }
    }

    // Build per-function-body content slices for type inference (keyed by functionId)
    const fileContents = new Map<string, string>();
    for (const file of files) fileContents.set(file.path, file.content);

    // Re-export-aware import resolution for Pass 2 call edges (change: add-call-resolution-recall).
    // Production callers never thread `importMap`, so derive a re-export-following map from the
    // sources: a cross-file call resolves to its TRUE definition (through any depth of barrel) at
    // `import`/`re_export` confidence instead of falling through to the ambiguous name-only
    // fallback. A caller-provided `importMap` is honoured verbatim (no re-export provenance set).
    // Reused for base-class resolution (Pass 7) below.
    const { map: callImportMap, reExported: reExportedNames } = importMap
      ? { map: importMap, reExported: new Set<string>() }
      : buildResolvedImportMap(files);

    const edges: CallEdge[] = [];
    for (const raw of allRawEdges) {
      const callerNode = allNodes.get(raw.callerId);
      if (!callerNode) continue;

      let calleeNode: FunctionNode | undefined;
      let confidence: EdgeConfidence = 'name_only';

      // Strategy 1 — self/cls intra-class (Python self.*, cls.* or same-class method)
      if (raw.calleeObject === 'self' || raw.calleeObject === 'cls') {
        if (callerNode.className) {
          const candidates = trie.findByQualifiedName(callerNode.className, raw.calleeName);
          if (candidates.length > 0) { calleeNode = candidates[0]; confidence = 'self_cls'; }
        }
      }

      // Strategy 1b — type-name resolution (capitalized receiver = type/class reference).
      // In Swift and C++ there are no intra-module imports, so cross-file calls appear
      // as TypeName.method() / TypeName::method(). Java has the same shape for static
      // calls and same-file nested types (Money.of(), Outer.Inner.make()) that imports
      // don't cover. A capitalized receiver is a reliable signal for a class reference
      // in these languages (variables are conventionally lower-case), so resolve it to
      // the matching internal type member before falling back to import/external.
      if (
        !calleeNode && raw.calleeObject &&
        (callerNode.language === 'Swift' || callerNode.language === 'C++' || callerNode.language === 'Java')
      ) {
        const ch = raw.calleeObject.charCodeAt(0);
        const isCapitalized = ch >= 65 && ch <= 90; // A-Z
        if (isCapitalized) {
          const candidates = trie.findByQualifiedName(raw.calleeObject, raw.calleeName);
          if (candidates.length > 0) { calleeNode = candidates[0]; confidence = 'type_name'; }
        }
      }

      // Strategy 1c — same-file member-assigned function (JS/TS dotted-name nodes).
      // The widen-js extraction indexes `app.render = function(){}` as the node
      // `${filePath}::app.render`. A call `app.render()` (receiver `app`, name
      // `render`) must resolve to that exact internal node — otherwise it falls
      // through to an `external::app.render` leaf and the real node sits at fanIn 0,
      // indexed but unreachable inbound. Direct id lookup is exact and same-file,
      // so there is no heuristic false-positive risk. (JS nodes are tagged
      // 'TypeScript' by the extractor; accept both spellings.)
      if (
        !calleeNode && raw.calleeObject &&
        (callerNode.language === 'TypeScript' || callerNode.language === 'JavaScript')
      ) {
        const dottedId = `${callerNode.filePath}::${raw.calleeObject}.${raw.calleeName}`;
        const internal = allNodes.get(dottedId);
        if (internal && !internal.isExternal) { calleeNode = internal; confidence = 'same_file'; }
      }

      // Strategy 2 — type inference on receiver variable
      if (!calleeNode && raw.calleeObject) {
        const fileContent = fileContents.get(callerNode.filePath);
        if (fileContent) {
          const bodySlice = fileContent.slice(callerNode.startIndex, callerNode.endIndex);
          const inferredTypes = inferTypesFromSource(bodySlice, callerNode.language);
          const resolved = resolveViaTypeInference(raw.calleeObject, raw.calleeName, inferredTypes, trie);
          if (resolved) { calleeNode = resolved; confidence = 'type_inference'; }
        }
      }

      // Strategy 3 — import resolution, re-export aware (TS/JS/Python).
      // The map resolves an imported name to its true-definition module even when it
      // arrives through a barrel; an anchored prefix match (`x.` / `x/`, never bare
      // `startsWith`) avoids binding `shapes/base` to `shapes/base2.ts`. An edge whose
      // name was followed through a re-export chain is labelled `re_export` (still a
      // proven concrete target, but the barrel hop is disclosed); a direct import is
      // labelled `import`.
      if (!calleeNode) {
        const viaName = callImportMap.get(callerNode.filePath)?.get(raw.calleeName);
        const importedFile = viaName
          ?? (raw.calleeObject ? callImportMap.get(callerNode.filePath)?.get(raw.calleeObject) : undefined);
        if (importedFile) {
          const candidates = trie.findBySimpleName(raw.calleeName).filter(n =>
            n.filePath === importedFile
            || n.filePath.startsWith(`${importedFile}.`)
            || n.filePath.startsWith(`${importedFile}/`),
          );
          if (candidates.length > 0) {
            calleeNode = candidates[0];
            confidence = (viaName && reExportedNames.has(`${callerNode.filePath}\0${raw.calleeName}`))
              ? 're_export'
              : 'import';
          }
        }
      }

      // Strategy 4 — same-file preference (only for calls without a typed receiver)
      // When a receiver is explicitly present but unresolvable (e.g. redis_client.get()),
      // skip name_only fallback to avoid false-positive edges.
      if (!calleeNode && !raw.calleeObject) {
        const candidates = trie.findBySimpleName(raw.calleeName);
        if (candidates.length === 0) {
          // A synthesized super(...) edge whose parent class is not in the
          // analyzed code (e.g. `extends RuntimeException`) is dropped rather
          // than turned into an external leaf — keeps the external-node set clean.
          if (raw.callType === 'constructor') continue;
          // Unresolved bare call — create a synthetic external leaf node
          calleeNode = getOrCreateExternalNode(raw.calleeName, allNodes);
          confidence = 'external';
        } else {
          const sameFile = candidates.find(c => c.filePath === callerNode.filePath);
          if (sameFile) { calleeNode = sameFile; confidence = 'same_file'; }
          else { calleeNode = candidates[0]; confidence = 'name_only'; }
        }
      }

      if (!calleeNode) {
        // Unresolved receiver-based call (e.g. redis_client.get()) — synthetic external node
        const label = raw.calleeObject
          ? `${raw.calleeObject}.${raw.calleeName}`
          : raw.calleeName;
        calleeNode = getOrCreateExternalNode(label, allNodes);
        confidence = 'external';
      }

      const callType: CallType = raw.callType
        ?? (raw.calleeObject ? 'method' : 'direct');

      edges.push({
        callerId: raw.callerId,
        calleeId: calleeNode.id,
        calleeName: raw.calleeName,
        line: raw.line,
        confidence,
        kind: 'calls',
        callType,
      });
    }

    // Pass 2b: HTTP cross-language edges (JS/TS caller → Python handler)
    try {
      const filePaths = files.map(f => f.path);
      const { edges: httpEdges } = await extractAllHttpEdges(filePaths);
      for (const he of httpEdges) {
        // Find callee: handler function by name in handlerFile
        const calleeNode = trie.findBySimpleName(he.route.handlerName)
          .find(n => n.filePath === he.handlerFile);
        if (!calleeNode) continue;

        // Find caller: any function in callerFile that encloses the HTTP call's line
        const callerContent = fileContents.get(he.callerFile);
        const callerNode = callerContent
          ? (() => {
              let offset = 0;
              const lines = callerContent.split('\n');
              for (let i = 0; i < he.call.line - 1 && i < lines.length; i++) {
                offset += lines[i].length + 1;
              }
              const candidates = Array.from(allNodes.values())
                .filter(n => n.filePath === he.callerFile);
              return findEnclosingFunction(candidates, offset);
            })()
          : undefined;
        if (!callerNode) continue;

        edges.push({
          callerId: callerNode.id,
          calleeId: calleeNode.id,
          calleeName: he.route.handlerName,
          line: he.call.line,
          confidence: 'http_endpoint',
          kind: 'calls',
          callType: 'direct',
        });
      }
    } catch {
      // HTTP edge extraction is best-effort; don't fail the whole build
    }

    // Pass 2c: Infrastructure-as-Code projection (spec-07).
    // IaC resources/references project onto the existing node/edge primitives.
    let iacClasses: ClassNode[] = [];
    try {
      const iac = buildProjectedIac(files);
      for (const n of iac.nodes) if (!allNodes.has(n.id)) allNodes.set(n.id, n);
      edges.push(...iac.edges);
      iacClasses = iac.classes;

      // Pass 2c.1: Cross-domain code↔infra edges (spec-17).
      // Embedded IaC (Pulumi/CDK/CDKTF) declares resources *inside* code files.
      // Link the enclosing code function → the resource it provisions with a
      // `references` edge, so analyze_impact/get_subgraph traverse the code↔infra
      // boundary end-to-end. Standalone IaC (.tf/.yaml) has no co-located code, so
      // no edge is created — those stay infra-only components, exactly as today.
      edges.push(...linkCodeToInfra(iac.nodes, allNodes));
    } catch {
      // IaC extraction is best-effort; never fail the whole build
    }

    // Pass 2d: synthesized dynamic-dispatch edges (spec: add-synthesized-dynamic-dispatch-edges).
    // Additive and provenance-labeled (confidence: 'synthesized'); runs after direct
    // resolution and only *adds* edges. Best-effort: synthesis never fails the build.
    try {
      const resolveHandler: HandlerResolver = (name, preferFile) => {
        // Never resolve a runtime/promise/middleware callback LOCAL (e.g. the `resolve`
        // parameter of `new Promise((resolve) => setTimeout(resolve, ms))`) to a
        // coincidentally same-named function elsewhere. These names are never real
        // registered handlers, and matching them produced false synthesized edges.
        if (RUNTIME_CALLBACK_LOCALS.has(name)) return undefined;
        const candidates = trie.findBySimpleName(name).filter(n => !n.isExternal);
        if (candidates.length === 0) return undefined;
        const inFile = candidates.find(n => n.filePath === preferFile);
        if (inFile) return inFile;
        return candidates.length === 1 ? candidates[0] : undefined;
      };
      edges.push(...await synthesizeDynamicDispatchEdges(files, allNodes, resolveHandler));
    } catch {
      // Synthesis is best-effort; a failure must never abort the build.
    }

    // Pass 3: Calculate fanIn / fanOut (count unique caller→callee pairs, not call sites).
    // Synthesized dynamic-dispatch edges are EXCLUDED: synthesis augments reachability
    // (it adds traversable edges) but must not perturb the directly-resolved graph's
    // structural metrics — fanIn/fanOut, hub/god/entry-point classification, and every
    // dashboard built on them stay measured on certain edges only. Reachability, impact,
    // and dead-code traverse the full edge list (incl. synthesized) separately.
    const seenPairs = new Set<string>();
    for (const edge of edges) {
      if (edge.confidence === 'synthesized') continue;
      const pairKey = `${edge.callerId}\0${edge.calleeId}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const caller = allNodes.get(edge.callerId);
      const callee = allNodes.get(edge.calleeId);
      if (caller) caller.fanOut++;
      if (callee) callee.fanIn++;
    }

    // Pass 4 (prep): Mark test-file nodes before tested_by derivation
    const nodes = Array.from(allNodes.values());
    for (const n of nodes) {
      if (!n.isExternal && isTestFile(n.filePath)) n.isTest = true;
    }

    // Pass 3b: Derive tested_by edges — reverse edges from production fn ← test fn
    // Source 1: call edges where the caller is a test function
    const callsEdges = edges.filter(e => !e.kind || e.kind === 'calls');
    const testedByPairs = new Set<string>(); // deduplicate across sources
    for (const edge of callsEdges) {
      const caller = allNodes.get(edge.callerId);
      if (!caller || !isTestFile(caller.filePath)) continue;
      const callee = allNodes.get(edge.calleeId);
      // Only emit tested_by when the production fn is internal (not external, not a test helper)
      if (!callee || callee.isExternal || callee.isTest) continue;
      const pairKey = `${edge.calleeId}\0${caller.filePath}`;
      if (testedByPairs.has(pairKey)) continue;
      testedByPairs.add(pairKey);
      edges.push({
        kind: 'tested_by',
        callerId: edge.calleeId,
        calleeId: edge.callerId,
        calleeName: caller.name,
        confidence: edge.confidence,
        callType: undefined,
      });
    }

    // Source 2: import-based — every name imported by a test file from a production file.
    // Catches mocked functions that are imported but never directly called in the test.
    // Build a lightweight import map from file content (only test files, TS/JS).
    const allFilePaths = files.map(f => f.path);
    const NAMED_IMPORT_RE = /^\s*import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/gm;
    const DEFAULT_IMPORT_RE = /^\s*import\s+(?:type\s+)?(\w+)\s+from\s+['"](\.[^'"]+)['"]/gm;
    for (const file of files) {
      if (!isTestFile(file.path)) continue;
      if (file.language !== 'TypeScript' && file.language !== 'JavaScript') continue;
      const dir = dirname(file.path);
      const resolveSource = (rel: string): string | undefined => {
        // Strip .js extension: TS ESM imports use './foo.js' to refer to './foo.ts'
        const stripped = rel.replace(/\.js$/, '');
        // Form-preserving join (NOT resolve): the analyze pipeline passes repo-relative
        // paths, so resolve() would force an absolute path that never matches the
        // relative allFilePaths — silently zeroing out import-based tested_by edges.
        const base = joinPath(dir, stripped);
        return allFilePaths.find(p =>
          p === base || p === `${base}.ts` || p === `${base}.tsx` ||
          p === `${base}.js` || p === `${base}.jsx` || p === `${base}/index.ts`,
        );
      };
      const testLabel = file.path.split('/').pop()!.replace(/\.[tj]sx?$/, '');
      const emitEdge = (name: string, sourceFile: string) => {
        const candidates = trie.findBySimpleName(name)
          .filter(n => n.filePath === sourceFile && !n.isTest && !n.isExternal);
        for (const callee of candidates) {
          const pairKey = `${callee.id}\0${file.path}`;
          if (testedByPairs.has(pairKey)) continue;
          testedByPairs.add(pairKey);
          edges.push({
            kind: 'tested_by',
            callerId: callee.id,
            calleeId: `${file.path}::*`,
            calleeName: testLabel,
            confidence: 'import',
            callType: undefined,
          });
        }
      };
      // Named imports: import { foo, bar as baz } from './module'
      for (const m of file.content.matchAll(NAMED_IMPORT_RE)) {
        const sourceFile = resolveSource(m[2]);
        if (!sourceFile) continue;
        for (const part of m[1].split(',')) {
          const name = (part.match(/\bas\s+(\w+)/) ?? part.match(/(\w+)/))?.[1]?.trim();
          if (name) emitEdge(name, sourceFile);
        }
      }
      // Default imports: import foo from './module'
      for (const m of file.content.matchAll(DEFAULT_IMPORT_RE)) {
        const sourceFile = resolveSource(m[2]);
        if (!sourceFile) continue;
        emitEdge(m[1], sourceFile);
      }
    }

    // Also apply caller-provided importMap if present (cross-language coverage)
    if (importMap) {
      for (const [testFilePath, imports] of importMap) {
        if (!isTestFile(testFilePath)) continue;
        for (const [importedName, sourceFile] of imports) {
          const candidates = trie.findBySimpleName(importedName)
            .filter(n => n.filePath === sourceFile && !n.isTest && !n.isExternal);
          for (const callee of candidates) {
            const pairKey = `${callee.id}\0${testFilePath}`;
            if (testedByPairs.has(pairKey)) continue;
            testedByPairs.add(pairKey);
            edges.push({
              kind: 'tested_by',
              callerId: callee.id,
              calleeId: `${testFilePath}::*`,
              calleeName: testFilePath.split('/').pop()!.replace(/\.[tj]sx?$/, ''),
              confidence: 'import',
              callType: undefined,
            });
          }
        }
      }
    }

    // Pass 4: Derive hub functions, entry points, layer violations
    // External and test nodes are excluded from structural stats
    const internalNodes = nodes.filter(n => !n.isExternal && !n.isTest);

    const hubFunctions = internalNodes
      .filter(n => n.fanIn >= HUB_THRESHOLD)
      .sort((a, b) => b.fanIn - a.fanIn);

    const calledIds = new Set(edges.map(e => e.calleeId));
    const entryPoints = internalNodes
      .filter(n => !calledIds.has(n.id))
      .sort((a, b) => b.fanOut - a.fanOut);

    const layerViolations = layers
      ? this.detectLayerViolations(edges, allNodes, layers)
      : [];

    const totalFanIn = internalNodes.reduce((s, n) => s + n.fanIn, 0);
    const totalFanOut = internalNodes.reduce((s, n) => s + n.fanOut, 0);

    // Pass 5: Label-propagation community detection (internal non-test nodes only)
    // Each node starts with its own label; iteratively adopts the most common neighbor label.
    // Converges in ~10 passes for typical codebases. External/test nodes get no community.
    {
      const callsEdgesOnly = edges.filter(e => !e.kind || e.kind === 'calls');
      const label = new Map<string, string>();
      for (const n of internalNodes) label.set(n.id, n.id);

      // Build adjacency for internal nodes (bidirectional — community ignores direction)
      const neighbors = new Map<string, string[]>();
      for (const n of internalNodes) neighbors.set(n.id, []);
      for (const e of callsEdgesOnly) {
        if (label.has(e.callerId) && label.has(e.calleeId)) {
          neighbors.get(e.callerId)!.push(e.calleeId);
          neighbors.get(e.calleeId)!.push(e.callerId);
        }
      }

      for (let iter = 0; iter < 15; iter++) {
        let changed = false;
        // Deterministic order each iteration (sorted) avoids oscillation
        const order = [...internalNodes].sort((a, b) => a.id < b.id ? -1 : 1);
        for (const n of order) {
          const nbrs = neighbors.get(n.id)!;
          if (nbrs.length === 0) continue;
          const counts = new Map<string, number>();
          for (const nbId of nbrs) {
            const l = label.get(nbId) ?? nbId;
            counts.set(l, (counts.get(l) ?? 0) + 1);
          }
          let best = label.get(n.id)!;
          let bestCnt = 0;
          for (const [l, c] of counts) {
            if (c > bestCnt || (c === bestCnt && l < best)) { best = l; bestCnt = c; }
          }
          if (best !== label.get(n.id)) { label.set(n.id, best); changed = true; }
        }
        if (!changed) break;
      }

      // Name each community by its highest-fanIn member
      const communityMembers = new Map<string, FunctionNode[]>();
      for (const n of internalNodes) {
        const l = label.get(n.id)!;
        if (!communityMembers.has(l)) communityMembers.set(l, []);
        communityMembers.get(l)!.push(n);
      }
      for (const members of communityMembers.values()) {
        const hub = members.slice().sort((a, b) => b.fanIn - a.fanIn)[0];
        const communityLabel = hub.name;
        for (const n of members) {
          n.communityId = label.get(n.id)!;
          n.communityLabel = communityLabel;
        }
      }
    }

    // Pass 6: Cyclomatic complexity — regex over body slice for each internal node
    for (const node of allNodes.values()) {
      if (node.isExternal || node.startIndex === undefined || node.endIndex === undefined) continue;
      const content = fileContents.get(node.filePath);
      if (!content) continue;
      node.cyclomaticComplexity = computeCyclomaticComplexity(
        content.slice(node.startIndex, node.endIndex),
        node.language,
      );
    }

    // Pass 7: Build class hierarchy (inheritance + grouping)
    const relationships = await extractClassRelationships(files);
    // Base-class resolution needs the per-file import map so a child's explicit import
    // outranks a same-named class in its own directory (precision: avoid wiring a false
    // base). Reuse the re-export-aware map derived for Pass 2 so a base class imported
    // through a barrel resolves to its true definition too (change: add-call-resolution-recall).
    const { classes, inheritanceEdges } = buildClassNodes(allNodes, relationships, callImportMap);
    // Merge IaC module groupings (deduped by id) into the class set.
    const classIds = new Set(classes.map(c => c.id));
    for (const c of iacClasses) if (!classIds.has(c.id)) classes.push(c);

    // Pass 7b: CHA — type-hierarchy-resolved polymorphic dispatch
    // (spec: add-type-hierarchy-resolved-dispatch). Runs after the hierarchy is
    // built so ClassNode/InheritanceEdge are available. Additive and provenance-
    // labeled (confidence 'synthesized'); best-effort — never fails the build.
    // Placed after fanIn/fanOut (Pass 3) and tested_by (Pass 3b) so the heuristic
    // edges never perturb the directly-resolved structural metrics or tested_by.
    try {
      // Direct (non-synthesized) callee ids per caller, so CHA never duplicates a
      // directly-resolved edge.
      const directCalleeIdsByCaller = new Map<string, Set<string>>();
      for (const e of edges) {
        if (e.confidence === 'synthesized') continue;
        if (e.kind && e.kind !== 'calls') continue;
        let s = directCalleeIdsByCaller.get(e.callerId);
        if (!s) { s = new Set(); directCalleeIdsByCaller.set(e.callerId, s); }
        s.add(e.calleeId);
      }
      // Receiver-based method calls `recv.m()` recovered from the raw edges.
      const rawMethodCalls: RawMethodCall[] = [];
      for (const raw of allRawEdges) {
        if (!raw.calleeObject) continue;
        rawMethodCalls.push({
          callerId: raw.callerId,
          recv: raw.calleeObject,
          method: raw.calleeName,
          line: raw.line,
        });
      }
      edges.push(...synthesizeTypeHierarchyEdges({
        nodes: allNodes,
        classes,
        inheritanceEdges,
        rawMethodCalls,
        fileContents,
        directCalleeIdsByCaller,
        importMap: callImportMap,
      }));
    } catch {
      // CHA is best-effort; a failure must never abort the build.
    }

    // Pass 8: Content-addressed stable ids (change: add-content-addressed-stable-symbol-ids).
    // Pure post-pass over the fully-built node set — keeps the per-language
    // extractors untouched and the derivation in one place.
    assignStableIds(allNodes.values());
    assignClassStableIds(classes);

    return {
      nodes: allNodes,
      edges,
      cfgs: allCfgs,
      classes,
      inheritanceEdges,
      hubFunctions,
      entryPoints,
      layerViolations,
      stats: {
        totalNodes: internalNodes.length,
        totalEdges: edges.filter(e => !e.kind || e.kind === 'calls').length,
        avgFanIn: internalNodes.length > 0 ? totalFanIn / internalNodes.length : 0,
        avgFanOut: internalNodes.length > 0 ? totalFanOut / internalNodes.length : 0,
      },
    };
  }

  private detectLayerViolations(
    edges: CallEdge[],
    nodes: Map<string, FunctionNode>,
    layers: Record<string, string[]>
  ): LayerViolation[] {
    const violations: LayerViolation[] = [];
    for (const edge of edges) {
      const caller = nodes.get(edge.callerId);
      const callee = nodes.get(edge.calleeId);
      if (!caller || !callee) continue;

      // Lower layer calling upper layer — violation (canonical primitive).
      const cls = classifyLayerEdge(caller.filePath, callee.filePath, layers);
      if (!cls) continue;
      violations.push({
        callerId: edge.callerId,
        calleeId: edge.calleeId,
        callerLayer: cls.fromLayer,
        calleeLayer: cls.toLayer,
        reason: `${cls.fromLayer} calls ${cls.toLayer} (${caller.name} → ${callee.name})`,
      });
    }

    return violations;
  }
}

// ============================================================================
// SERIALIZATION HELPER
// ============================================================================

/**
 * Assign a content-addressed `stableId` to every internal function node that has
 * a derivable descriptor (change: add-content-addressed-stable-symbol-ids).
 *
 * The id is a pure function of each node's own name + parameter shape — no file
 * path, no body, and crucially no position-dependent discriminator. Homonyms
 * (distinct symbols sharing a qualified name + parameter shape) therefore receive
 * the SAME `stableId`; consumers resolve only when an id is unique and otherwise
 * fall back (see `EdgeStore.getNodeByStableId`). Because nothing here depends on
 * the OTHER nodes in the build, a symbol's id is identical whether computed in a
 * full build or an incremental single-file rebuild. External and
 * anonymous/synthetic symbols receive none (they keep only the path-based `id`).
 */
function assignStableIds(nodes: Iterable<FunctionNode>): void {
  for (const n of nodes) {
    if (n.isExternal) continue;
    const sid = stableSymbolId(n);
    if (sid) n.stableId = sid;
  }
}

/** Stable ids for class nodes — same content-only, position-free scheme. */
function assignClassStableIds(classes: ClassNode[]): void {
  for (const c of classes) {
    const sid = stableClassId(c.name, c.isModule);
    if (sid) c.stableId = sid;
  }
}

export function serializeCallGraph(result: CallGraphResult): SerializedCallGraph {
  return {
    nodes: Array.from(result.nodes.values()),
    edges: result.edges,
    classes: result.classes,
    inheritanceEdges: result.inheritanceEdges,
    hubFunctions: result.hubFunctions,
    entryPoints: result.entryPoints,
    layerViolations: result.layerViolations,
    stats: result.stats,
  };
}
