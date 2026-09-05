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

import { dirname, join as joinPath, posix } from 'node:path';
import type Parser from 'tree-sitter';
import { FunctionRegistryTrie } from './function-registry-trie.js';
import type { ImportMap } from './import-resolver-bridge.js';
import {
  buildResolvedImportMap,
  GO_IMPORT_PACKAGE_PREFIX,
  IMPORT_QUALIFIER_PREFIX,
  IMPORT_TOP_LEVEL_QUALIFIER,
  PACKAGE_SCOPE_IMPORT,
  PACKAGE_SCOPE_NAME,
} from './import-resolver-bridge.js';
import { findAmbiguousTypeBindings, inferReceiverTypeAt, inferTypesFromSource } from './type-inference-engine.js';
import {
  extractAllHttpEdges,
  extractTsRouteDefinitions,
  extractRouteDefinitions,
  extractJavaRouteDefinitions,
  extractHttpCalls,
  extractPythonHttpCallsFromRoot,
  extractGoHttpCallsFromRoot,
  type HttpCall,
  type HttpExtractionDegradation,
  type RouteDefinition,
} from './http-route-parser.js';
import { mapFilesBounded } from './bounded-file-scan.js';
import type { CfgSpill } from './cfg-spill.js';
import { buildProjectedIac } from './iac/index.js';
import { isIacLanguage } from './iac/types.js';
import { isTestFile } from './test-file.js';
import { type FunctionCfg, type CfgNode } from './cfg.js';
import { stableSymbolId, stableClassId } from '../scip/moniker.js';
import { synthesizeTypeHierarchyEdges, type RawMethodCall } from './cha.js';
import { logger } from '../../utils/logger.js';
import { HUB_THRESHOLD } from '../../constants.js';
import { tallyFileStyle, type FileStyleRaw, type StyleAstNode } from './style-fingerprint.js';
import {
  tallyParseHealth,
  type FileParseHealth,
  type FileExclusionReason,
  type GrammarUnavailableBoundary,
  type GrammarUnavailableReason,
  type ParseHealthNode,
} from './parse-health.js';
// Per-file parse budget (change: fix-analyze-native-abort-and-file-cost-budget). Bounds the one
// synchronous native call nothing else can interrupt.
import { parseWithBudget as rawParseWithBudget, parseBudgetOverrunMs, type BudgetableParser } from './parse-budget.js';
import { usesTsxGrammar } from './language-detection.js';
import { extractScriptContainer, SCRIPT_CONTAINER_FORMATS } from './sfc-script-extractor.js';
// Pass-1 extraction lane (change: optimize-parallel-extraction-pool). The pool holds no
// extraction logic of its own — it dispatches `dispatchFileExtract` to worker threads and
// merges by input index, with the serial loop as both reference and fallback.
import { extractFilesForPass1, type ExtractionLaneOptions, type ExtractOutcome } from './extraction-pool.js';
import type { Pass1FactCache, Pass1CacheDisclosure } from './pass1-fact-cache.js';

// ============================================================================
// TYPES — extracted to ./call-graph-types.ts and re-exported here so this file
// remains the stable public barrel (change: modularize-call-graph-builder;
// analyzer: StableCallGraphBarrel). Every name importable from call-graph.ts
// before the split stays importable from call-graph.ts.
// ============================================================================

// Internal bindings used by the builder below. RawEdge (and CALL_DISTANCE_FALLBACK)
// are intentionally NOT re-exported — they were never on call-graph.ts's surface.
import type {
  RawEdge,
  FunctionNode,
  FunctionCallArity,
  CallEdge,
  EdgeConfidence,
  CallType,
  LayerViolation,
  ClassNode,
  InheritanceEdge,
  CallGraphResult,
  SerializedCallGraph,
  AmbiguousCallSite,
  AmbiguousStrategy,
  FileExtractResult,
  ClassRelationshipFact,
  DynamicDispatchFacts,
} from './call-graph-types.js';
import { classifyLayerEdge, AMBIGUOUS_CANDIDATE_CAP } from './call-graph-types.js';

// Docstring/declaration extraction helpers — extracted to ./call-graph-extract.ts
// (internal, not re-exported; see the banner at the original section site below).
import { extractDocstringBefore, extractDeclaration } from './call-graph-extract.js';

// External-node helper — extracted to ./call-graph-external.ts (internal, not
// re-exported; classifyExternal + the EXTERNAL_* tables stay private to that module).
import { getOrCreateExternalNode } from './call-graph-external.js';

// Cyclomatic-complexity estimator — extracted to ./call-graph-complexity.ts. Used
// internally AND re-exported below (it was on call-graph.ts's public surface).
import { computeCyclomaticComplexity } from './call-graph-complexity.js';

// CFG / data-flow overlay helper — extracted to ./call-graph-cfg.ts (internal, not
// re-exported); wraps buildFunctionCfg with body-resolution + fail-soft.
import { buildCfgFor } from './call-graph-cfg.js';

// Callee-ignore predicates — extracted to ./call-graph-builtins.ts (internal, not
// re-exported; the *_IGNORED tables stay private to that module).
import { isIgnoredCallee, isSelfReceiver } from './call-graph-builtins.js';

// Stable barrel: re-export the full public type/edge model + distance/layer helpers.
export type {
  EdgeConfidence,
  EdgeKind,
  CallType,
  FunctionNode,
  FunctionCallArity,
  ExternalKind,
  CallEdge,
  LayerViolation,
  ClassNode,
  InheritanceEdge,
  CallGraphResult,
  SerializedCallGraph,
  AmbiguousCallSite,
  AmbiguousStrategy,
  FileExtractResult,
} from './call-graph-types.js';
export { CALL_DISTANCE_COSTS, callDistance, layerOf, classifyLayerEdge, AMBIGUOUS_CANDIDATE_CAP } from './call-graph-types.js';
// Re-export the extracted complexity estimator so it stays importable from call-graph.ts.
export { computeCyclomaticComplexity } from './call-graph-complexity.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const analyzerWorkCounters = { enabled: false, parses: 0, nativeQueryCompiles: 0, typeInferences: 0 };
let nextTestGrammarId = 1;
let testGrammarIds = new WeakMap<object, number>();
const testNativeQueryCompilesByKey = new Map<string, number>();

function parseWithBudget<T>(parser: BudgetableParser<T>, content: string): T {
  if (analyzerWorkCounters.enabled) analyzerWorkCounters.parses++;
  return rawParseWithBudget(parser, content);
}

/** Test-only boundary counters: actual parser/query/inference calls, not orchestration intent. */
export function __getAnalyzerWorkCountersForTests(): Readonly<{
  parses: number;
  nativeQueryCompiles: number;
  nativeQueryCompileCounts: number[];
  typeInferences: number;
}> {
  const { parses, nativeQueryCompiles, typeInferences } = analyzerWorkCounters;
  return {
    parses,
    nativeQueryCompiles,
    nativeQueryCompileCounts: [...testNativeQueryCompilesByKey.values()],
    typeInferences,
  };
}

export function __resetAnalyzerWorkCountersForTests(clearQueries = false): void {
  analyzerWorkCounters.enabled = true;
  analyzerWorkCounters.parses = 0;
  analyzerWorkCounters.nativeQueryCompiles = 0;
  analyzerWorkCounters.typeInferences = 0;
  testNativeQueryCompilesByKey.clear();
  if (clearQueries) {
    _nativeQueries = new WeakMap();
    _nativeQueryErrors = new WeakMap();
    testGrammarIds = new WeakMap();
    nextTestGrammarId = 1;
  }
}

// Callee-ignore tables (PYTHON_IGNORED…CFAMILY_IGNORED, IGNORED_BY_LANGUAGE,
// ALL_IGNORED_CALLEES) and the isIgnoredCallee / isSelfReceiver predicates were
// extracted to ./call-graph-builtins.ts (change: modularize-call-graph-builder);
// imported at the top of this file and used by the language extractors.

/**
 * Tally the style fingerprint for one file over its already-parsed tree (no second parse). Reuses
 * the function names the extractor already collected for the naming-case counter. Fail-soft: any
 * error or unsupported language yields `undefined`, never a thrown build (change:
 * add-codebase-style-fingerprint).
 */
function tallyStyle(language: string, tree: Parser.Tree, nodes: FunctionNode[], filePath: string): FileStyleRaw | undefined {
  try {
    const raw = tallyFileStyle({
      language,
      rootNode: tree.rootNode as unknown as StyleAstNode,
      functionNames: nodes.map(n => n.name),
    });
    if (!raw) return undefined;
    raw.filePath = filePath;
    return raw;
  } catch {
    return undefined;
  }
}

// ============================================================================
// PARSER SINGLETONS (lazy init)
// ============================================================================

let _tsParser: Parser | undefined;
let _tsxParser: Parser | undefined;
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

// Native queries are immutable after compilation. Weak grammar keys prevent a test/runtime
// grammar reload from being retained. Required and optional callers share compiled handles;
// only their failure handling differs.
let _nativeQueries = new WeakMap<object, Map<string, Parser.Query | null>>();
let _nativeQueryErrors = new WeakMap<object, Map<string, unknown>>();

function cachedNativeQuery(
  lang: object,
  source: string,
): Parser.Query | null {
  let bySource = _nativeQueries.get(lang);
  if (!bySource) {
    bySource = new Map();
    _nativeQueries.set(lang, bySource);
  }
  if (bySource.has(source)) return bySource.get(source) ?? null;
  if (!_NativeQuery) return null;
  try {
    if (analyzerWorkCounters.enabled) {
      analyzerWorkCounters.nativeQueryCompiles++;
      let grammarId = testGrammarIds.get(lang);
      if (!grammarId) {
        grammarId = nextTestGrammarId++;
        testGrammarIds.set(lang, grammarId);
      }
      const key = `${grammarId}\0${source}`;
      testNativeQueryCompilesByKey.set(key, (testNativeQueryCompilesByKey.get(key) ?? 0) + 1);
    }
    const query = new _NativeQuery(lang as unknown as Parser.Language, source);
    bySource.set(source, query);
    return query;
  } catch (error) {
    bySource.set(source, null);
    let errors = _nativeQueryErrors.get(lang);
    if (!errors) {
      errors = new Map();
      _nativeQueryErrors.set(lang, errors);
    }
    errors.set(source, error);
    return null;
  }
}

// null = tried and unavailable; undefined = not yet tried
let _NativeParser: (typeof Parser) | null | undefined;
let _NativeQuery: (typeof Parser.Query) | null | undefined;
let _nativeParserError: unknown;

export type GrammarStatus = 'loaded' | 'unavailable' | 'untried';
type GrammarFailureReceipt = Omit<GrammarUnavailableBoundary, 'fileCount'>;

const _grammarRuntime = new Map<string, { status: Exclude<GrammarStatus, 'untried'>; failure?: GrammarFailureReceipt }>();
const _warnedUnavailable = new Set<string>();

/** Runtime status for the grammar backing one statically-supported language. */
export function grammarStatus(language: string): GrammarStatus {
  return _grammarRuntime.get(language)?.status ?? 'untried';
}

function grammarFailure(language: string): GrammarFailureReceipt | undefined {
  return _grammarRuntime.get(language)?.failure;
}

function markGrammarLoaded(language: string): void {
  // A query incompatibility is terminal for this process even though the module itself loaded.
  if (_grammarRuntime.get(language)?.status !== 'unavailable') {
    _grammarRuntime.set(language, { status: 'loaded' });
  }
}

function markGrammarUnavailable(
  language: string,
  reason: GrammarUnavailableReason,
  error: unknown,
): GrammarFailureReceipt {
  const message = error instanceof Error ? error.message : String(error);
  const detail = reason === 'query-incompatible'
    ? `tree-sitter query is incompatible with the installed ${language} grammar: ${message}`
    : `${message}; rebuild the matching tree-sitter grammar or check the local build toolchain`;
  const failure: GrammarFailureReceipt = { language, reason, detail };
  _grammarRuntime.set(language, { status: 'unavailable', failure });
  return failure;
}

function warnGrammarUnavailable(failure: GrammarFailureReceipt): void {
  const { language, detail } = failure;
  if (!_warnedUnavailable.has(language)) {
    _warnedUnavailable.add(language);
    logger.warning(
      `language ${language} grammar unavailable — files will be indexed for search but not graphed (${detail})`,
    );
  }
}

async function loadCoreGrammarSoft<T>(
  language: string,
  load: () => Promise<T>,
): Promise<T | null> {
  if (grammarStatus(language) === 'unavailable') return null;
  try {
    const result = await load();
    markGrammarLoaded(language);
    return result;
  } catch (error) {
    markGrammarUnavailable(language, 'load-failure', error);
    return null;
  }
}

function emptyForUnavailable(
  language: string,
  cfg = true,
): FileExtractResult {
  const failure = grammarFailure(language);
  return {
    nodes: [],
    rawEdges: [],
    ...(cfg ? { cfg: new Map<string, FunctionCfg>() } : {}),
    ...(failure ? { grammarUnavailable: failure } : {}),
  };
}

function nativeQuerySoft(
  language: string,
  lang: object,
  source: string,
): Parser.Query | null {
  if (!_NativeQuery || grammarStatus(language) === 'unavailable') return null;
  const query = cachedNativeQuery(lang, source);
  if (!query) {
    const error = _nativeQueryErrors.get(lang)?.get(source)
      ?? new Error('query is incompatible with the loaded grammar');
    markGrammarUnavailable(language, 'query-incompatible', error);
  }
  return query;
}

async function loadNativeParser(): Promise<typeof Parser | null> {
  if (_NativeParser === undefined) {
    try {
      const m = ((await import('tree-sitter')).default) as typeof Parser;
      _NativeParser = m;
      _NativeQuery = m.Query;
    } catch (error) {
      _NativeParser = null;
      _NativeQuery = null;
      _nativeParserError = error;
    }
  }
  return _NativeParser;
}

async function loadNativeParserFor(language: string): Promise<typeof Parser | null> {
  const parser = await loadNativeParser();
  if (!parser) {
    markGrammarUnavailable(
      language,
      'load-failure',
      _nativeParserError ?? new Error('tree-sitter native bindings not available'),
    );
  }
  return parser;
}
let _TsLanguage: object | undefined;
let _TsxLanguage: object | undefined;
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

async function getTSParser(
  filePath?: string,
  languageOverride?: 'JavaScript' | 'TypeScript',
): Promise<{ parser: Parser; lang: object } | null> {
  const language = languageOverride
    ?? (filePath && /\.(?:[cm]?js|jsx)$/i.test(filePath) ? 'JavaScript' : 'TypeScript');
  const NP = await loadNativeParserFor(language);
  if (!NP) return null;
  if (grammarStatus(language) === 'unavailable') return null;
  if (usesTsxGrammar(filePath)) {
    if (!_tsxParser) {
      const loaded = await loadCoreGrammarSoft(language, async () => {
        const tsModule = await import('tree-sitter-typescript');
        const lang = (tsModule.default as { tsx: object }).tsx;
        const parser = new NP();
        parser.setLanguage(lang as unknown as Parser.Language);
        return { parser, lang };
      });
      if (!loaded) return null;
      _TsxLanguage = loaded.lang;
      _tsxParser = loaded.parser;
    }
    markGrammarLoaded(language);
    return { parser: _tsxParser!, lang: _TsxLanguage! };
  }
  if (!_tsParser) {
    const loaded = await loadCoreGrammarSoft(language, async () => {
      const tsModule = await import('tree-sitter-typescript');
      const lang = (tsModule.default as { typescript: object }).typescript;
      const parser = new NP();
      parser.setLanguage(lang as unknown as Parser.Language);
      return { parser, lang };
    });
    if (!loaded) return null;
    _TsLanguage = loaded.lang;
    _tsParser = loaded.parser;
  }
  markGrammarLoaded(language);
  return { parser: _tsParser!, lang: _TsLanguage! };
}

async function getPyParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParserFor('Python');
  if (!NP) return null;
  if (grammarStatus('Python') === 'unavailable') return null;
  if (!_pyParser) {
    const loaded = await loadCoreGrammarSoft('Python', async () => {
      const pyModule = await import('tree-sitter-python');
      const lang = pyModule.default;
      const parser = new NP();
      parser.setLanguage(lang as unknown as Parser.Language);
      return { parser, lang };
    });
    if (!loaded) return null;
    _PyLanguage = loaded.lang;
    _pyParser = loaded.parser;
  }
  markGrammarLoaded('Python');
  return { parser: _pyParser!, lang: _PyLanguage! };
}

async function getGoParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParserFor('Go');
  if (!NP) return null;
  if (grammarStatus('Go') === 'unavailable') return null;
  if (!_goParser) {
    const loaded = await loadCoreGrammarSoft('Go', async () => {
      const goModule = await import('tree-sitter-go');
      const lang = goModule.default;
      const parser = new NP();
      parser.setLanguage(lang as unknown as Parser.Language);
      return { parser, lang };
    });
    if (!loaded) return null;
    _GoLanguage = loaded.lang;
    _goParser = loaded.parser;
  }
  markGrammarLoaded('Go');
  return { parser: _goParser!, lang: _GoLanguage! };
}

async function getRustParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParserFor('Rust');
  if (!NP) return null;
  if (grammarStatus('Rust') === 'unavailable') return null;
  if (!_rustParser) {
    const loaded = await loadCoreGrammarSoft('Rust', async () => {
      const rustModule = await import('tree-sitter-rust');
      const lang = rustModule.default;
      const parser = new NP();
      parser.setLanguage(lang as unknown as Parser.Language);
      return { parser, lang };
    });
    if (!loaded) return null;
    _RustLanguage = loaded.lang;
    _rustParser = loaded.parser;
  }
  markGrammarLoaded('Rust');
  return { parser: _rustParser!, lang: _RustLanguage! };
}

async function getRubyParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParserFor('Ruby');
  if (!NP) return null;
  if (grammarStatus('Ruby') === 'unavailable') return null;
  if (!_rubyParser) {
    const loaded = await loadCoreGrammarSoft('Ruby', async () => {
      const rubyModule = await import('tree-sitter-ruby');
      const lang = rubyModule.default;
      const parser = new NP();
      parser.setLanguage(lang as unknown as Parser.Language);
      return { parser, lang };
    });
    if (!loaded) return null;
    _RubyLanguage = loaded.lang;
    _rubyParser = loaded.parser;
  }
  markGrammarLoaded('Ruby');
  return { parser: _rubyParser!, lang: _RubyLanguage! };
}

async function getJavaParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParserFor('Java');
  if (!NP) return null;
  if (grammarStatus('Java') === 'unavailable') return null;
  if (!_javaParser) {
    const loaded = await loadCoreGrammarSoft('Java', async () => {
      const javaModule = await import('tree-sitter-java');
      const lang = javaModule.default;
      const parser = new NP();
      parser.setLanguage(lang as unknown as Parser.Language);
      return { parser, lang };
    });
    if (!loaded) return null;
    _JavaLanguage = loaded.lang;
    _javaParser = loaded.parser;
  }
  markGrammarLoaded('Java');
  return { parser: _javaParser!, lang: _JavaLanguage! };
}

async function getPhpParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParserFor('PHP');
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
  const NP = await loadNativeParserFor('C#');
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
  const NP = await loadNativeParserFor('Kotlin');
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
  const NP = await loadNativeParserFor('Scala');
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
  const NP = await loadNativeParserFor('Elixir');
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
  const NP = await loadNativeParserFor('C++');
  if (!NP) return null;
  if (grammarStatus('C++') === 'unavailable') return null;
  if (!_cppParser) {
    const loaded = await loadCoreGrammarSoft('C++', async () => {
      const cppModule = await import('tree-sitter-cpp');
      const lang = cppModule.default;
      const parser = new NP();
      parser.setLanguage(lang as unknown as Parser.Language);
      return { parser, lang };
    });
    if (!loaded) return null;
    _CppLanguage = loaded.lang;
    _cppParser = loaded.parser;
  }
  markGrammarLoaded('C++');
  return { parser: _cppParser!, lang: _CppLanguage! };
}

async function getSwiftParser(): Promise<{ parser: Parser; lang: object } | null> {
  const NP = await loadNativeParserFor('Swift');
  if (!NP) return null;
  if (grammarStatus('Swift') === 'unavailable') return null;
  if (!_swiftParser) {
    const loaded = await loadCoreGrammarSoft('Swift', async () => {
      const swiftModule = await import('tree-sitter-swift');
      const lang = swiftModule.default;
      const parser = new NP();
      parser.setLanguage(lang as unknown as Parser.Language);
      return { parser, lang };
    });
    if (!loaded) return null;
    _SwiftLanguage = loaded.lang;
    _swiftParser = loaded.parser;
  }
  markGrammarLoaded('Swift');
  return { parser: _swiftParser!, lang: _SwiftLanguage! };
}

// ============================================================================
// ATTRIBUTION HELPER
// ============================================================================

/**
 * Given a list of function nodes (with startIndex/endIndex) and a call position,
 * find the narrowest enclosing function node.
 */
/**
 * Give NESTED functions a unique, STABLE node id so same-named nested functions —
 * or a nested function colliding with a same-named top-level one — are not collapsed
 * into a single node at id aggregation (`allNodes.set(node.id, …)`, last-write-wins),
 * which silently drops a real function and merges its edges/metrics.
 *
 * A node is re-keyed ONLY when its bare id collides AND it is byte-CONTAINED within
 * another function node (a genuinely nested function). Its id becomes the immediate
 * enclosing function's id segment + `/name` (`file::A.m1/helper`) — a discriminator
 * derived from the enclosing scope, NOT a byte offset, so it is STABLE across edits to
 * surrounding code (a positional offset would shift and read as removed+added on every
 * diff). Same-scope twins get a deterministic document-order ordinal (`…/helper#2`).
 *
 * Sibling collisions (non-contained nodes sharing an id — a re-assigned member
 * `obj.fn = …; obj.fn = …`, a same-file container homonym across namespaces) are left
 * collapsed: that is an intentional, separately-tested behavior. Nodes are processed
 * outermost→innermost (by span) so an enclosing function's id is final before a child
 * is qualified against it, composing across multiple nesting levels.
 *
 * MUST run after node extraction and BEFORE call extraction, so findEnclosingFunction
 * returns the disambiguated node and the rawEdge it produces carries the unique
 * callerId. Deterministic; a no-op when no bare id collides (the common case).
 * (change: add-stable-nested-function-identity.)
 */
/**
 * For every node, its immediate enclosing function — the smallest OTHER node strictly containing
 * it (identical spans excluded: an `export function` wrapper and its inner declaration are the
 * same logical function matched twice).
 *
 * Computed as one sweep with an ancestor stack rather than a scan per node. The scan it replaces
 * was O(nodes) per colliding node, and the collision it fires on is completely ordinary — a
 * wrapper and its inner declaration share an id, so in a file of plain `export function`s EVERY
 * node collides and the scan runs for all of them. On a 2 MB single-file fixture (33,116
 * functions) it was 24% of the entire analyze run, second only to the line-counting in
 * `line-index.ts`.
 *
 * `sorted` must be ordered by (startIndex asc, endIndex desc) — outermost first — which is the
 * order `ensureUniqueNodeIds` already needs for its own reasons. Under that order every node
 * already on the stack starts at or before the current node, so containment reduces to comparing
 * end offsets, and the stack stays a properly nested ancestor chain. The nearest entry that is not
 * an identical span is therefore the smallest container.
 *
 * AST spans are properly nested — two distinct nodes cannot partially overlap — so "innermost
 * ancestor" and "smallest container" are the same node. `call-graph-enclosing.test.ts` checks that
 * against the brute-force definition directly, including on randomized nestings.
 */
function computeEnclosing(
  sorted: FunctionNode[],
  originalOrder: Map<FunctionNode, number>
): Map<FunctionNode, FunctionNode | undefined> {
  const result = new Map<FunctionNode, FunctionNode | undefined>();
  const stack: FunctionNode[] = [];

  for (const n of sorted) {
    // Anything ending before n does not contain it, and — spans being nested — cannot contain
    // anything after n either.
    while (stack.length > 0 && stack[stack.length - 1].endIndex < n.endIndex) stack.pop();

    let found: FunctionNode | undefined;
    for (let i = stack.length - 1; i >= 0; i--) {
      const m = stack[i];
      if (m === n) continue;
      if (m.startIndex === n.startIndex && m.endIndex === n.endIndex) continue; // same span, not a container
      found = m;
      // Twins over the SAME span are equally valid containers, and the definition breaks that tie
      // by original array position — so the choice must not depend on how the sort happened to
      // order them. Walk the rest of the identical run and take the earliest.
      for (let j = i - 1; j >= 0; j--) {
        const k = stack[j];
        if (k.startIndex !== found.startIndex || k.endIndex !== found.endIndex) break;
        if ((originalOrder.get(k) ?? 0) < (originalOrder.get(found) ?? 0)) found = k;
      }
      break;
    }
    result.set(n, found);
    stack.push(n);
  }

  return result;
}

/** The definition {@link computeEnclosing} implements. Exported for its differential test only. */
export function _enclosingByBruteForceForTesting(
  nodes: FunctionNode[],
  n: FunctionNode
): FunctionNode | undefined {
  let best: FunctionNode | undefined;
  let bestSize = Infinity;
  for (const m of nodes) {
    if (m === n) continue;
    const contains =
      m.startIndex <= n.startIndex &&
      n.endIndex <= m.endIndex &&
      (m.startIndex !== n.startIndex || m.endIndex !== n.endIndex);
    if (!contains) continue;
    const size = m.endIndex - m.startIndex;
    if (size < bestSize) { bestSize = size; best = m; }
  }
  return best;
}

/** Test-only access to the swept version, so the two can be diffed. */
export function _computeEnclosingForTesting(
  nodes: FunctionNode[]
): Map<FunctionNode, FunctionNode | undefined> {
  const sorted = [...nodes].sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  return computeEnclosing(sorted, new Map(nodes.map((n, i) => [n, i])));
}

function ensureUniqueNodeIds(nodes: FunctionNode[]): void {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.id, (counts.get(n.id) ?? 0) + 1);
  let anyCollision = false;
  for (const c of counts.values()) if (c > 1) { anyCollision = true; break; }
  if (!anyCollision) return;

  // Outermost→innermost AND document order for siblings: a container has a smaller (or
  // equal-start, larger) span, so it sorts first; same-scope twins keep source order.
  const order = [...nodes].sort(
    (a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex,
  );

  const enclosing = computeEnclosing(order, new Map(nodes.map((n, i) => [n, i])));
  const taken = new Set(nodes.map(n => n.id));
  for (const n of order) {
    if ((counts.get(n.id) ?? 0) < 2) continue; // bare id is unique — leave it
    const m = enclosing.get(n);
    // Skip a sibling collision (no container — an intentional collapse) AND a
    // same-id container, which is the SAME logical function matched twice: an
    // `export function` / decorated-definition wrapper byte-contains its inner
    // declaration, both carry the same id, and they are MEANT to collapse. Only a
    // container with a DIFFERENT id is a genuine enclosing function.
    if (!m || m.id === n.id) continue;
    const sep = m.id.indexOf('::');
    const filePrefix = sep >= 0 ? m.id.slice(0, sep + 2) : '';
    const scope = sep >= 0 ? m.id.slice(sep + 2) : m.id;
    let qualified = `${filePrefix}${scope}/${n.name}`;
    if (taken.has(qualified)) {
      let ord = 2;
      while (taken.has(`${qualified}#${ord}`)) ord++;
      qualified = `${qualified}#${ord}`;
    }
    n.id = qualified;
    taken.add(qualified);
  }
}

/**
 * Materialize the function-id → CFG overlay map AFTER `ensureUniqueNodeIds` may have
 * re-keyed nested function nodes. CFGs MUST be collected during extraction keyed by the
 * node's start byte (`fnNode.startIndex` — unique per AST function node, and unchanged by
 * re-keying) rather than by the function id, because the bare id is non-unique for a
 * nested collision: a same-id `cfg.set(id, …)` would last-write-wins one CFG away before
 * disambiguation, and the surviving CFG would then orphan under the pre-disambiguation id
 * (no node carries it). Re-attaching by start byte to the FINAL node id keeps every
 * re-keyed nested function's CFG overlay addressable by its node id — the form every
 * downstream consumer (def-use dataflow, analyze_error_propagation) looks it up by.
 * (change: add-stable-nested-function-identity.)
 */
function materializeCfgByNodeId(
  nodes: FunctionNode[],
  cfgByStart: Map<number, FunctionCfg>,
): Map<string, FunctionCfg> {
  const cfg = new Map<string, FunctionCfg>();
  if (cfgByStart.size === 0) return cfg;
  for (const n of nodes) {
    const c = cfgByStart.get(n.startIndex);
    if (c) cfg.set(n.id, c);
  }
  return cfg;
}

/** Count arguments while the call AST is live. Spread/splat operands contribute no
 * fixed argument because they may expand to zero values; the retained count is the
 * provable lower bound. */
function callArgumentFacts(callNode: Parser.SyntaxNode, language: 'TypeScript' | 'JavaScript' | 'Python'):
  Pick<RawEdge, 'argCount' | 'argCountLowerBound'> | undefined {
  const group = callNode.childForFieldName('arguments')
    ?? callNode.namedChildren.find((c) => c.type === 'arguments' || c.type === 'argument_list');
  if (!group) return undefined;
  const spreadTypes = language === 'Python'
    ? new Set(['list_splat', 'dictionary_splat'])
    : new Set(['spread_element']);
  let fixed = 0;
  let lowerBound = false;
  for (const arg of group.namedChildren) {
    if (arg.type === 'comment') continue;
    if (spreadTypes.has(arg.type)) lowerBound = true;
    else fixed++;
  }
  return { argCount: fixed, ...(lowerBound ? { argCountLowerBound: true as const } : {}) };
}

function containsNodeType(node: Parser.SyntaxNode, types: ReadonlySet<string>): boolean {
  if (types.has(node.type)) return true;
  for (const type of types) if (node.descendantsOfType(type).length > 0) return true;
  return false;
}

/** Recover invocation bounds from declaration AST, excluding parameters that are
 * syntactically present but never supplied by an ordinary call (`self`/`cls`, TS `this`). */
function declarationCallArity(
  callable: Parser.SyntaxNode,
  language: 'TypeScript' | 'Python',
  pythonMethod = false,
): FunctionCallArity | undefined {
  const group = callable.childForFieldName('parameters')
    ?? callable.namedChildren.find((c) => c.type === 'formal_parameters' || c.type === 'parameters');
  const single = callable.childForFieldName('parameter');
  const params = group ? group.namedChildren : single ? [single] : [];
  // A declaration with an explicit empty group is known to take zero arguments.
  if (!group && !single) return undefined;

  const variadicTypes = language === 'Python'
    ? new Set(['list_splat_pattern', 'dictionary_splat_pattern'])
    : new Set(['rest_pattern']);
  const optionalTypes = language === 'Python'
    ? new Set(['default_parameter', 'typed_default_parameter'])
    : new Set(['optional_parameter', 'assignment_pattern']);
  let required = 0;
  let total = 0;
  let variadic = false;
  let variadicParameterCount = 0;
  let hasOptionalOrDefault = false;
  let implicitReceiverCount = 0;
  const pythonStaticMethod = language === 'Python'
    && callable.parent?.type === 'decorated_definition'
    && callable.parent.namedChildren.some(c => c.type === 'decorator' && /\bstaticmethod\b/.test(c.text));

  for (const param of params) {
    if (param.type === 'comment' ||
        (language === 'Python' && (param.type === 'positional_separator' || param.type === 'keyword_separator' || param.type === '/' || param.type === '*'))) {
      continue;
    }
    const isVariadic = containsNodeType(param, variadicTypes);
    if (isVariadic) {
      variadic = true;
      variadicParameterCount++;
      continue;
    }
    const text = param.text.trim();
    const implicit = language === 'Python'
      ? pythonMethod && !pythonStaticMethod && implicitReceiverCount === 0
      : implicitReceiverCount === 0 && /^this(?:\s*[:,?]|$)/.test(text);
    if (implicit) {
      implicitReceiverCount++;
      continue;
    }
    total++;
    if (containsNodeType(param, optionalTypes) || param.childForFieldName('value') !== null) {
      hasOptionalOrDefault = true;
    }
    else required++;
  }
  return { required, total, variadic, variadicParameterCount, hasOptionalOrDefault, implicitReceiverCount };
}

/** Same-scope overload declarations intentionally collapse to one graph node. Mark
 * that loss of uniqueness so precision-sensitive consumers never trust one shape. */
function markCollapsedOverloads(nodes: FunctionNode[]): void {
  const byId = new Map<string, FunctionNode[]>();
  for (const n of nodes) {
    if (!n.callArity) continue;
    const group = byId.get(n.id) ?? [];
    group.push(n);
    byId.set(n.id, group);
  }
  for (const group of byId.values()) {
    // Export/decorator query arms produce a wrapper plus the contained declaration.
    // Count only innermost distinct declarations, not those duplicate wrappers.
    const declarations = group.filter((n) => !group.some((m) =>
      m !== n && n.startIndex <= m.startIndex && m.endIndex <= n.endIndex
      && (n.startIndex < m.startIndex || m.endIndex < n.endIndex),
    ));
    const overloaded = new Set(declarations.map(n => `${n.startIndex}:${n.endIndex}`)).size > 1;
    if (overloaded) for (const n of group) n.callArity!.overloaded = true;
  }
}

function findEnclosingFunction(
  nodes: FunctionNode[],
  callPos: number,
  probe?: { steps: number },
): FunctionNode | undefined {
  const index = enclosingIndexes.get(nodes) ?? buildEnclosingIndex(nodes);
  let lo = 0;
  let hiExclusive = index.entries.length;
  while (lo < hiExclusive) {
    if (probe) probe.steps++;
    const mid = (lo + hiExclusive) >> 1;
    if (index.entries[mid].node.startIndex <= callPos) lo = mid + 1;
    else hiExclusive = mid;
  }
  const hi = lo - 1;
  if (hi < 0) return undefined;
  const found = findRightmostContaining(index, 1, 0, index.size - 1, hi, callPos, probe);
  return found < 0 ? undefined : index.entries[found].node;
}

interface EnclosingIndex {
  entries: Array<{ node: FunctionNode; original: number }>;
  maxEnd: number[];
  size: number;
}

const enclosingIndexes = new WeakMap<FunctionNode[], EnclosingIndex>();

function buildEnclosingIndex(nodes: FunctionNode[]): EnclosingIndex {
  // Function intervals from one syntax tree are nested or disjoint. For equal starts, placing the
  // widest first makes the rightmost containing interval the narrowest; identical spans retain the
  // original first-match behavior by sorting the lower original index last.
  const entries = nodes.map((node, original) => ({ node, original })).sort((a, b) =>
    a.node.startIndex - b.node.startIndex ||
    b.node.endIndex - a.node.endIndex ||
    b.original - a.original,
  );
  let size = 1;
  while (size < entries.length) size <<= 1;
  const maxEnd = new Array(size * 2).fill(-Infinity) as number[];
  for (let i = 0; i < entries.length; i++) maxEnd[size + i] = entries[i].node.endIndex;
  for (let i = size - 1; i > 0; i--) maxEnd[i] = Math.max(maxEnd[i * 2], maxEnd[i * 2 + 1]);
  const index = { entries, maxEnd, size };
  enclosingIndexes.set(nodes, index);
  return index;
}

function findRightmostContaining(
  index: EnclosingIndex,
  treeNode: number,
  left: number,
  right: number,
  hi: number,
  callPos: number,
  probe?: { steps: number },
): number {
  if (probe) probe.steps++;
  if (left > hi || index.maxEnd[treeNode] <= callPos) return -1;
  if (left === right) return left < index.entries.length ? left : -1;
  const mid = (left + right) >> 1;
  const fromRight = findRightmostContaining(index, treeNode * 2 + 1, mid + 1, right, hi, callPos, probe);
  return fromRight >= 0
    ? fromRight
    : findRightmostContaining(index, treeNode * 2, left, mid, hi, callPos, probe);
}

/** Test-only differential hook for the call-attribution interval index. */
export function _findEnclosingFunctionForTesting(nodes: FunctionNode[], callPos: number): FunctionNode | undefined {
  return findEnclosingFunction(nodes, callPos);
}

/** Deterministic work receipt for the interval-index complexity regression test. */
export function _findEnclosingFunctionStepsForTesting(nodes: FunctionNode[], callPos: number): number {
  const probe = { steps: 0 };
  findEnclosingFunction(nodes, callPos, probe);
  return probe.steps;
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
// DOCSTRING / SIGNATURE EXTRACTION HELPERS — extracted to ./call-graph-extract.ts
// (change: modularize-call-graph-builder). Internal helpers (never on the public
// surface); imported at the top of this file and used by the language extractors.
// ============================================================================

// ============================================================================
// CFG / DATA-FLOW OVERLAY HELPER — buildCfgFor extracted to ./call-graph-cfg.ts
// (change: modularize-call-graph-builder; spec: add-intraprocedural-cfg-dataflow-overlay).
// Imported at the top of this file; file-internal, not re-exported.
// ============================================================================

// ============================================================================
// TYPESCRIPT EXTRACTOR
// ============================================================================

const TS_FN_QUERY = `
  (function_declaration
    name: (identifier) @fn.name) @fn.node

  (function_signature
    name: (identifier) @fn.name) @fn.node

  (export_statement
    declaration: (function_declaration
      name: (identifier) @fn.name)) @fn.node

  (method_definition
    name: (property_identifier) @fn.name) @fn.node

  (method_signature
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

/** Node types that, encountered while walking UP from a function toward its class,
 *  prove the function is nested inside another scope (an object literal, or another
 *  function/method) rather than being a direct class member — so it must NOT inherit
 *  the enclosing class name. A direct method/field has only `class_body` between it
 *  and `class_declaration`, so it never hits one of these. */
const CLASS_WALK_BOUNDARIES: ReadonlySet<string> = new Set([
  'object',
  'arrow_function',
  'function_expression',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
]);

const TS_CALL_QUERY = `
  (call_expression
    function: [(identifier) @call.name
               (member_expression
                 object: (identifier) @call.object
                 property: (property_identifier) @call.name)
               (member_expression
                 object: (this) @call.object
                 property: (property_identifier) @call.name)
               (member_expression
                 object: (super) @call.object
                 property: (property_identifier) @call.name)]) @call.node
`;

async function extractTSGraph(
  filePath: string,
  content: string,
  languageOverride?: 'JavaScript' | 'TypeScript',
): Promise<FileExtractResult> {
  const language = languageOverride
    ?? (/\.(?:[cm]?js|jsx)$/i.test(filePath) ? 'JavaScript' : 'TypeScript');
  const r = await getTSParser(filePath, language);
  if (!r) return emptyForUnavailable(language);
  const { parser, lang } = r;
  const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content);

  const fnQuery = nativeQuerySoft(language, lang, TS_FN_QUERY);
  const callQuery = nativeQuerySoft(language, lang, TS_CALL_QUERY);
  if (!fnQuery || !callQuery) return emptyForUnavailable(language);

  // --- Extract function nodes ---
  const nodes: FunctionNode[] = [];
  const cfgByStart = new Map<number, FunctionCfg>();
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

    // Find enclosing class (walk up — skip class_body, its children are methods not the name).
    // STOP at an object-literal or an enclosing function/method scope BEFORE reaching the
    // class: a function nested inside a class method (an object-literal method shorthand, a
    // nested `function`, a callback) is NOT a class method — its runtime `this` is not the
    // instance — so it must not inherit the class name. Without this guard it would, and its
    // `this.x()` calls would resolve to false `self_cls` edges (a direct class method, by
    // contrast, has only class_body between it and class_declaration, so it never trips a
    // boundary). (change: add-this-super-method-resolution — adversarial round.)
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class_declaration' || cursor.type === 'interface_declaration' ||
          (fnNode.type === 'method_signature' && cursor.type === 'type_alias_declaration')) {
        const classNameNode = cursor.children.find(c => c.type === 'type_identifier' || c.type === 'identifier');
        if (classNameNode) className = classNameNode.text;
        break;
      }
      // Class EXPRESSION (`const K = class {…}`, `X = class {…}`, `class Named {…}` as a
      // value): named expressions carry their own name; an anonymous one takes the binding
      // it is assigned to, so its methods' `this.m()` resolve like any class method.
      if (cursor.type === 'class') {
        const named = cursor.childForFieldName('name');
        if (named) {
          className = named.text;
        } else {
          const par = cursor.parent;
          if (par?.type === 'variable_declarator') {
            className = par.childForFieldName('name')?.text;
          } else if (par?.type === 'assignment_expression') {
            const lhs = par.childForFieldName('left') ?? par.namedChildren[0];
            if (lhs?.type === 'identifier') className = lhs.text;
          }
        }
        break;
      }
      if (CLASS_WALK_BOUNDARIES.has(cursor.type)) break; // nested scope — not a class method
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
      ...(language === 'TypeScript'
        ? { callArity: declarationCallArity(valueNode ?? nameCapture.node.parent ?? fnNode, 'TypeScript') }
        : {}),
    });

    const fnCfg = buildCfgFor(fnNode, 'TypeScript');
    if (fnCfg) cfgByStart.set(fnNode.startIndex, fnCfg);
  }

  // --- Extract calls ---
  ensureUniqueNodeIds(nodes);
  markCollapsedOverloads(nodes);
  const rawEdges: RawEdge[] = [];
  const callMatches = callQuery.matches(tree.rootNode);

  for (const match of callMatches) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    // A `this.parse()` / `super.map()` is a real intra-object method call — bypass the
    // name-only noise filter (which targets `arr.map()` / `JSON.parse()`), or common
    // method names would be dropped before resolution ever sees them.
    if (!isSelfReceiver(objectCapture?.node.text) && isIgnoredCallee(calleeName, 'TypeScript')) continue;

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
      ...callArgumentFacts(nodeCapture.node, language),
    });
  }

  const style = tallyStyle('TypeScript', tree, nodes, filePath);
  const parseHealth = tallyParseHealth('TypeScript', tree.rootNode as unknown as ParseHealthNode, filePath);
  const cfg = materializeCfgByNodeId(nodes, cfgByStart);
  const classRelationships = collectClassRelationshipFacts('TypeScript', source =>
    safeQuery(lang, source, tree.rootNode) as unknown as TsMatch[]);
  const dynamicDispatch = collectPass1DynamicDispatch('TypeScript', content, tree.rootNode as unknown as TsNodeLike, nodes, filePath);
  const httpCalls = await extractHttpCalls(filePath, content);
  return { nodes, rawEdges, cfg, style, parseHealth, classRelationships, dynamicDispatch, httpCalls };
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
): Promise<FileExtractResult> {
  const r = await getPyParser();
  if (!r) return emptyForUnavailable('Python');
  const { parser, lang } = r;
  const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content);

  const fnQuery = nativeQuerySoft('Python', lang, PY_FN_QUERY);
  if (!fnQuery) return emptyForUnavailable('Python');

  // --- Extract function nodes ---
  const nodes: FunctionNode[] = [];
  const cfgByStart = new Map<number, FunctionCfg>();
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
      // A function nested inside a method is not itself descriptor-bound by the
      // enclosing class, so its first parameter remains an ordinary call argument.
      if (cursor.type === 'function_definition') break;
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
      callArity: declarationCallArity(nameCapture.node.parent ?? fnNode, 'Python', className !== undefined),
    });

    const fnCfg = buildCfgFor(fnNode, 'Python');
    if (fnCfg) cfgByStart.set(fnNode.startIndex, fnCfg);
  }

  // --- Extract calls ---
  ensureUniqueNodeIds(nodes);
  markCollapsedOverloads(nodes);
  const rawEdges: RawEdge[] = [];

  const directCallQuery = nativeQuerySoft('Python', lang, PY_DIRECT_CALL_QUERY);
  const methodCallQuery = nativeQuerySoft('Python', lang, PY_METHOD_CALL_QUERY);
  if (!directCallQuery || !methodCallQuery) return emptyForUnavailable('Python');

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
      ...callArgumentFacts(nodeCapture.node, 'Python'),
    });
  }

  // Method calls: obj.method() — capture receiver for type-inference-based resolution
  for (const match of methodCallQuery.matches(tree.rootNode)) {
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!objectCapture || !nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    // `self.parse()` / `cls.map()` are real intra-object calls — bypass the name-only
    // noise filter so a class method named like a builtin still resolves.
    if (!isSelfReceiver(objectCapture.node.text) && isIgnoredCallee(calleeName, 'Python')) continue;

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
      ...callArgumentFacts(nodeCapture.node, 'Python'),
    });
  }

  const style = tallyStyle('Python', tree, nodes, filePath);
  const parseHealth = tallyParseHealth('Python', tree.rootNode as unknown as ParseHealthNode, filePath);
  const cfg = materializeCfgByNodeId(nodes, cfgByStart);
  const classRelationships = collectClassRelationshipFacts('Python', source =>
    safeQuery(lang, source, tree.rootNode) as unknown as TsMatch[]);
  const dynamicDispatch = collectPass1DynamicDispatch('Python', content, tree.rootNode as unknown as TsNodeLike, nodes, filePath);
  const httpDegradations: HttpExtractionDegradation[] = [];
  const httpCalls = extractPythonHttpCallsFromRoot(filePath, tree.rootNode, d => httpDegradations.push(d));
  return { nodes, rawEdges, cfg, style, parseHealth, classRelationships, dynamicDispatch, httpCalls, httpDegradations };
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
): Promise<FileExtractResult> {
  const r = await getGoParser();
  if (!r) return emptyForUnavailable('Go');
  const { parser, lang } = r;
  const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content);

  const fnQuery = nativeQuerySoft('Go', lang, GO_FN_QUERY);
  const callQuery = nativeQuerySoft('Go', lang, GO_CALL_QUERY);
  if (!fnQuery || !callQuery) return emptyForUnavailable('Go');

  const nodes: FunctionNode[] = [];
  const cfgByStart = new Map<number, FunctionCfg>();
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
    if (fnCfg) cfgByStart.set(fnNode.startIndex, fnCfg);
  }

  ensureUniqueNodeIds(nodes);
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

  const style = tallyStyle('Go', tree, nodes, filePath);
  const parseHealth = tallyParseHealth('Go', tree.rootNode as unknown as ParseHealthNode, filePath);
  const cfg = materializeCfgByNodeId(nodes, cfgByStart);
  const classRelationships = collectClassRelationshipFacts('Go', source =>
    safeQuery(lang, source, tree.rootNode) as unknown as TsMatch[]);
  const dynamicDispatch = collectPass1DynamicDispatch('Go', content, tree.rootNode as unknown as TsNodeLike, nodes, filePath);
  const httpDegradations: HttpExtractionDegradation[] = [];
  const httpCalls = extractGoHttpCallsFromRoot(filePath, tree.rootNode, d => httpDegradations.push(d));
  return { nodes, rawEdges, cfg, style, parseHealth, classRelationships, dynamicDispatch, httpCalls, httpDegradations };
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
): Promise<FileExtractResult> {
  const r = await getRustParser();
  if (!r) return emptyForUnavailable('Rust');
  const { parser, lang } = r;
  const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content);
  const parseHealth = tallyParseHealth('', tree.rootNode as unknown as ParseHealthNode, filePath);

  const fnQuery = nativeQuerySoft('Rust', lang, RUST_FN_QUERY);
  const callQuery = nativeQuerySoft('Rust', lang, RUST_CALL_QUERY);
  if (!fnQuery || !callQuery) return emptyForUnavailable('Rust');

  const nodes: FunctionNode[] = [];
  const cfgByStart = new Map<number, FunctionCfg>();
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
    if (fnCfg) cfgByStart.set(fnNode.startIndex, fnCfg);
  }

  ensureUniqueNodeIds(nodes);
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

  const cfg = materializeCfgByNodeId(nodes, cfgByStart);
  return { nodes, rawEdges, cfg, parseHealth };
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
): Promise<FileExtractResult> {
  const r = await getRubyParser();
  if (!r) return emptyForUnavailable('Ruby');
  const { parser, lang } = r;
  const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content);
  const parseHealth = tallyParseHealth('', tree.rootNode as unknown as ParseHealthNode, filePath);

  const fnQuery = nativeQuerySoft('Ruby', lang, RUBY_FN_QUERY);
  const callQuery = nativeQuerySoft('Ruby', lang, RUBY_CALL_QUERY);
  const barewordQuery = nativeQuerySoft('Ruby', lang, RUBY_BAREWORD_QUERY);
  if (!fnQuery || !callQuery || !barewordQuery) return emptyForUnavailable('Ruby');

  const nodes: FunctionNode[] = [];
  const cfgByStart = new Map<number, FunctionCfg>();
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
    if (fnCfg) cfgByStart.set(fnNode.startIndex, fnCfg);
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

  const cfg = materializeCfgByNodeId(nodes, cfgByStart);
  const classRelationships = collectClassRelationshipFacts('Ruby', source =>
    safeQuery(lang, source, tree.rootNode) as unknown as TsMatch[]);
  const dynamicDispatch = collectPass1DynamicDispatch('Ruby', content, tree.rootNode as unknown as TsNodeLike, nodes, filePath);
  return { nodes, rawEdges, cfg, parseHealth, classRelationships, dynamicDispatch };
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
    object: [(identifier) (field_access)] @call.object
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

  ensureUniqueNodeIds(nodes);
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
  const clsQuery = nativeQuerySoft(
    'Java',
    lang as object,
    `(class_declaration name: (identifier) @cls (superclass (type_identifier) @parent))`
  );
  if (!clsQuery) return [];
  for (const m of clsQuery.matches(root)) {
    const cls = m.captures.find(c => c.name === 'cls')?.node.text;
    const parent = m.captures.find(c => c.name === 'parent')?.node.text;
    if (cls && parent) parentOf.set(cls, parent);
  }
  if (parentOf.size === 0) return [];

  const out: RawEdge[] = [];
  const ctorQuery = nativeQuerySoft(
    'Java',
    lang as object,
    `(explicit_constructor_invocation (super)) @node`
  );
  if (!ctorQuery) return [];
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
): Promise<FileExtractResult> {
  const r = await getJavaParser();
  if (!r) return emptyForUnavailable('Java');
  const { parser, lang } = r;
  const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content);
  const parseHealth = tallyParseHealth('', tree.rootNode as unknown as ParseHealthNode, filePath);

  const fnQuery = nativeQuerySoft('Java', lang, JAVA_FN_QUERY);
  const callQuery = nativeQuerySoft('Java', lang, JAVA_CALL_QUERY);
  if (!fnQuery || !callQuery) return emptyForUnavailable('Java');

  const nodes: FunctionNode[] = [];
  const nodeIds = new Set<string>();
  const cfgByStart = new Map<number, FunctionCfg>();
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
    if (nodeIds.has(id)) continue; // collapse overloads (same name) to one node
    nodeIds.add(id);
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
    if (fnCfg) cfgByStart.set(fnNode.startIndex, fnCfg);
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
  if (grammarStatus('Java') === 'unavailable') return emptyForUnavailable('Java');

  const cfg = materializeCfgByNodeId(nodes, cfgByStart);
  const classRelationships = collectClassRelationshipFacts('Java', source =>
    safeQuery(lang, source, tree.rootNode) as unknown as TsMatch[]);
  const dynamicDispatch = collectPass1DynamicDispatch('Java', content, tree.rootNode as unknown as TsNodeLike, nodes, filePath);
  return { nodes, rawEdges, cfg, parseHealth, classRelationships, dynamicDispatch };
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
    const query = cachedNativeQuery(lang, queryStr);
    return query?.matches(root) ?? [];
  } catch {
    // These are optional shape probes: one grammar version may reject a specialized arm while
    // another required arm still extracts the file correctly. Only required extractor queries
    // cross the language-level incompatibility boundary.
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
): Promise<FileExtractResult> {
  const r = await getCppParser();
  if (!r) return emptyForUnavailable('C++');
  const { parser, lang } = r;
  const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content);
  const parseHealth = tallyParseHealth('', tree.rootNode as unknown as ParseHealthNode, filePath);

  const nodes: FunctionNode[] = [];
  const cfgByStart = new Map<number, FunctionCfg>();
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
      if (fnCfg) cfgByStart.set(fnNode.startIndex, fnCfg);
    }
  }

  ensureUniqueNodeIds(nodes);
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

  const cfg = materializeCfgByNodeId(nodes, cfgByStart);
  const classRelationships = collectClassRelationshipFacts('C++', source =>
    safeQuery(lang, source, tree.rootNode) as unknown as TsMatch[]);
  const dynamicDispatch = collectPass1DynamicDispatch('C++', content, tree.rootNode as unknown as TsNodeLike, nodes, filePath);
  return { nodes, rawEdges, cfg, parseHealth, classRelationships, dynamicDispatch };
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
): Promise<FileExtractResult> {
  const r = await getSwiftParser();
  if (!r) return emptyForUnavailable('Swift', false);
  const { parser, lang } = r;
  const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content);
  const parseHealth = tallyParseHealth('', tree.rootNode as unknown as ParseHealthNode, filePath);

  const fnQuery = nativeQuerySoft('Swift', lang, SWIFT_FN_QUERY);
  const directCallQuery = nativeQuerySoft('Swift', lang, SWIFT_CALL_DIRECT_QUERY);
  const navCallQuery = nativeQuerySoft('Swift', lang, SWIFT_CALL_NAV_QUERY);
  if (!fnQuery || !directCallQuery || !navCallQuery) return emptyForUnavailable('Swift', false);

  const nodes: FunctionNode[] = [];
  const cfgByStart = new Map<number, FunctionCfg>();
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
    const fnCfg = buildCfgFor(fnNode as unknown as CfgNode, 'Swift');
    if (fnCfg) cfgByStart.set(fnNode.startIndex, fnCfg);
  }

  ensureUniqueNodeIds(nodes);
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

  const classRelationships = collectClassRelationshipFacts('Swift', source =>
    safeQuery(lang, source, tree.rootNode) as unknown as TsMatch[]);
  const dynamicDispatch = collectPass1DynamicDispatch('Swift', content, tree.rootNode as unknown as TsNodeLike, nodes, filePath);
  const cfg = materializeCfgByNodeId(nodes, cfgByStart);
  return { nodes, rawEdges, cfg, parseHealth, classRelationships, dynamicDispatch };
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
 * Extract inheritance/embedding facts while Pass 1 still owns the syntax tree. The returned
 * values contain no parser objects, so they can cross worker structured-clone and fact-cache JSON
 * boundaries. Optional grammar-version probes remain fail-soft through the supplied query runner.
 */
function collectClassRelationshipFacts(
  language: string,
  runQuery: (source: string) => TsMatch[],
): ClassRelationshipFact[] {
  try {
  const byClass = new Map<string, ClassRelationshipFact>();
  const merge = (className: string, parents: string[] = [], interfaces: string[] = []): void => {
    const fact = byClass.get(className) ?? { className, parentClasses: [], interfaces: [] };
    for (const parent of parents) if (!fact.parentClasses.includes(parent)) fact.parentClasses.push(parent);
    for (const iface of interfaces) if (!fact.interfaces.includes(iface)) fact.interfaces.push(iface);
    byClass.set(className, fact);
  };
  const captures = (query: string, clsName = 'cls', valueName = 'parent'): Array<[string, string]> => {
    const pairs: Array<[string, string]> = [];
    for (const match of runQuery(query)) {
      const cls = match.captures.find(c => c.name === clsName)?.node.text;
      const value = match.captures.find(c => c.name === valueName)?.node.text;
      if (cls && value) pairs.push([cls, value]);
    }
    return pairs;
  };

  if (language === 'TypeScript' || language === 'JavaScript') {
    for (const [cls, parent] of captures(`(class_declaration name: (type_identifier) @cls (class_heritage (extends_clause value: (identifier) @parent)))`)) merge(cls, [parent]);
    for (const [cls, iface] of captures(`(class_declaration name: (type_identifier) @cls (class_heritage (implements_clause (type_identifier) @iface)))`, 'cls', 'iface')) merge(cls, [], [iface]);
  } else if (language === 'Python') {
    for (const [cls, parent] of captures(`(class_definition name: (identifier) @cls superclasses: (argument_list (identifier) @parent))`)) {
      if (parent !== 'object') merge(cls, [parent]);
    }
  } else if (language === 'Java') {
    for (const [cls, parent] of captures(`(class_declaration name: (identifier) @cls (superclass (type_identifier) @parent))`)) merge(cls, [parent]);
    for (const [cls, iface] of captures(`(class_declaration name: (identifier) @cls (super_interfaces (type_list (type_identifier) @iface)))`, 'cls', 'iface')) merge(cls, [], [iface]);
  } else if (language === 'C++') {
    for (const [cls, parent] of captures(`(class_specifier name: (type_identifier) @cls (base_class_clause (type_identifier) @parent))`)) merge(cls, [parent]);
  } else if (language === 'C#') {
    for (const decl of ['class_declaration', 'interface_declaration', 'record_declaration', 'struct_declaration']) {
      for (const [cls, base] of captures(`(${decl} name: (identifier) @cls (base_list [(identifier) @base (generic_name (identifier) @base)]))`, 'cls', 'base')) {
        if (/^I[A-Z]/.test(base)) merge(cls, [], [base]); else merge(cls, [base]);
      }
    }
  } else if (language === 'Kotlin') {
    for (const decl of ['class_declaration', 'object_declaration', 'interface_declaration']) {
      for (const wrap of ['(user_type) @put', '(constructor_invocation (user_type) @put)']) {
        for (const [cls, raw] of captures(`(${decl} (type_identifier) @cls (delegation_specifier ${wrap}))`, 'cls', 'put')) {
          const parent = raw.replace(/<[\s\S]*$/, '').trim();
          if (!parent.includes('.')) merge(cls, [parent]);
        }
      }
    }
  } else if (language === 'PHP') {
    for (const [cls, parent] of captures(`(class_declaration name: (name) @cls (base_clause (name) @parent))`)) merge(cls, [parent]);
    for (const [cls, iface] of captures(`(class_declaration name: (name) @cls (class_interface_clause (name) @iface))`, 'cls', 'iface')) merge(cls, [], [iface]);
  } else if (language === 'Swift') {
    for (const decl of ['class_declaration', 'protocol_declaration']) {
      for (const [cls, raw] of captures(`(${decl} (type_identifier) @cls (inheritance_specifier (user_type) @put))`, 'cls', 'put')) {
        const parent = raw.replace(/<[\s\S]*$/, '').trim();
        if (!parent.includes('.')) merge(cls, [parent]);
      }
    }
  } else if (language === 'Scala') {
    for (const decl of ['class_definition', 'trait_definition', 'object_definition']) {
      for (const [cls, parent] of captures(`(${decl} (identifier) @cls (extends_clause (type_identifier) @parent))`)) merge(cls, [parent]);
    }
  } else if (language === 'Ruby') {
    for (const [cls, parent] of captures(`(class name: (constant) @cls superclass: (superclass (constant) @parent))`)) merge(cls, [parent]);
  } else if (language === 'Go') {
    const query = `(type_declaration (type_spec name: (type_identifier) @cls type: (struct_type (field_declaration_list (field_declaration) @field))))`;
    for (const match of runQuery(query)) {
      const cls = match.captures.find(c => c.name === 'cls')?.node.text;
      const field = match.captures.find(c => c.name === 'field')?.node;
      if (!cls || !field || field.childForFieldName('name')) continue;
      const typeNode = field.childForFieldName('type');
      const embedded = typeNode?.type === 'type_identifier'
        ? typeNode.text
        : typeNode?.type === 'pointer_type'
          ? typeNode.namedChildren.find(c => c.type === 'type_identifier')?.text
          : undefined;
      if (embedded) merge(cls, [embedded]);
    }
  }
    return [...byClass.values()];
  } catch {
    return [];
  }
}
/**
 * Uniform grammar handle. `withTree` parses, exposes the root + a query runner,
 * and guarantees cleanup afterward — essential for the WASM backend, where
 * trees/queries hold WASM heap memory that corrupts the next parse if not freed.
 */
interface GrammarHandle {
  withTree<T>(content: string, fn: (
    root: TsNodeLike,
    runQuery: (src: string) => TsMatch[],
    runOptionalQuery: (src: string) => TsMatch[],
  ) => T): T;
  /**
   * Whether `rootNode.hasError` is trustworthy for parse-health (change:
   * add-parse-health-boundary-disclosure). The WASM loader shares one Language object across parses,
   * and its heap lifecycle produces spurious ERROR nodes on any parse after the first — so
   * parse-health is fail-soft (not tallied) for WASM grammars, never falsely reported. `undefined`
   * (native loader) means reliable. See the WASM-lifecycle note in `loadWasmGrammarSoft`.
   */
  parseHealthReliable?: boolean;
}

const _grammarHandleCache = new Map<string, GrammarHandle | null>();

function warnUnavailable(language: string, err: unknown): null {
  markGrammarUnavailable(language, 'load-failure', err);
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
    markGrammarLoaded(language);
    const handle: GrammarHandle = {
      withTree: (content, fn) => {
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, content);
        const root = tree.rootNode as unknown as TsNodeLike;
        const runQuery = (src: string): TsMatch[] => {
          if (!_NativeQuery) return [];
          try {
            const q = cachedNativeQuery(lang, src);
            if (!q) throw new Error('tree-sitter query is incompatible with the loaded grammar');
            return q.matches(tree.rootNode) as unknown as TsMatch[];
          } catch (error) {
            markGrammarUnavailable(language, 'query-incompatible', error);
            return [];
          }
        };
        const runOptionalQuery = (src: string): TsMatch[] => {
          try {
            return cachedNativeQuery(lang, src)?.matches(tree.rootNode) as unknown as TsMatch[] ?? [];
          } catch {
            return [];
          }
        };
        return fn(root, runQuery, runOptionalQuery);
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
    // Pick the entry that is actually the Parser CONSTRUCTOR, not merely the first
    // defined one. web-tree-sitter's export shape moved between majors: 0.25 has no
    // `default`, so `TS.default ?? TS.Parser` fell through to the real class; 0.26+ adds
    // a self-referential `default` (`TS.default === TS`), so the same expression selects
    // the namespace OBJECT. That object has no `init`, so the emscripten runtime was
    // never initialised and `Language.load` failed with "Cannot read properties of
    // undefined (reading 'loadWebAssemblyModule')" — silently dropping Dart and Lua
    // while the capability matrix still claimed them. Requiring a function makes the
    // selection shape-proof in both directions.
    const ParserCtor = [TS.Parser, TS.default, TS].find(c => typeof c === 'function') as {
      new (): { setLanguage(l: unknown): void; parse(s: string): { rootNode: TsNodeLike } };
      init?: () => Promise<void>;
      Language?: { load(p: Uint8Array): Promise<{ query(src: string): { matches(root: TsNodeLike): TsMatch[] } }> };
    } | undefined;
    if (!ParserCtor) throw new Error('web-tree-sitter exposes no Parser constructor');
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
        // The budget applies here only if this web-tree-sitter build exposes the deadline; it is
        // feature-detected, never assumed. A throw (budget or otherwise) must still free the WASM
        // parser — the tree/query disposal below cannot run if `tree` was never assigned.
        let tree: { rootNode: TsNodeLike; delete?: () => void };
        try {
          tree = parseWithBudget(p as unknown as BudgetableParser<{ rootNode: TsNodeLike; delete?: () => void }>, content);
        } catch (err) {
          p.delete?.();
          throw err;
        }
        const queries: Array<{ delete?: () => void }> = [];
        const runQuery = (src: string): TsMatch[] => {
          try {
            const q = WasmQuery ? new WasmQuery(lang, src) : lang.query(src);
            queries.push(q);
            return q.matches(tree.rootNode);
          } catch (error) {
            markGrammarUnavailable(language, 'query-incompatible', error);
            return [];
          }
        };
        const runOptionalQuery = (src: string): TsMatch[] => {
          try {
            const q = WasmQuery ? new WasmQuery(lang, src) : lang.query(src);
            queries.push(q);
            return q.matches(tree.rootNode);
          } catch {
            return [];
          }
        };
        try {
          return fn(tree.rootNode, runQuery, runOptionalQuery);
        } finally {
          for (const q of queries) q.delete?.();
          tree.delete?.();
          p.delete?.();
        }
      },
      // The shared WASM Language heap yields spurious ERROR nodes on parses after the first, so
      // hasError is not trustworthy here — parse-health is fail-soft for WASM grammars.
      parseHealthReliable: false,
    };
    markGrammarLoaded(language);
    _grammarHandleCache.set(cacheKey, handle);
    return handle;
  } catch (err) {
    _grammarHandleCache.set(cacheKey, warnUnavailable(language, err));
    return null;
  }
}

/**
 * Did a grammar load attempt for this language already FAIL in this process?
 *
 * Every soft loader records `null` in the handle cache when a grammar cannot be loaded — an
 * optional dependency that was not installed, a native binding that will not build, a WASM file
 * that is absent. This reports that, so a caller can tell "the grammar is not here" apart from
 * "the grammar is here and produced nothing", which are the same empty result but very different
 * facts. `false` also means "not attempted yet"; drive an extraction first.
 *
 * Exists because the two are indistinguishable at the assertion site: when `tree-sitter-kotlin`
 * failed to install in CI, nine tests failed with messages like `expected [] to include 'main'`,
 * which reads exactly like a broken extractor and cost real time to diagnose as an install
 * problem. The grammars are `optionalDependencies` BY DESIGN (`loadGrammarSoft`, restricted
 * environments) — so a suite that cannot distinguish absence from breakage will keep going red
 * for reasons that are not defects.
 */
export function grammarLoadFailed(language: string): boolean {
  return grammarStatus(language) === 'unavailable';
}

/** Reset loader caches — test-only hook for the graceful-degradation test. */
export function __resetGrammarCacheForTests(): void {
  _grammarHandleCache.clear();
  _grammarRuntime.clear();
  _warnedUnavailable.clear();
  _NativeParser = undefined;
  _NativeQuery = undefined;
  _nativeQueries = new WeakMap();
  _nativeQueryErrors = new WeakMap();
  _nativeParserError = undefined;
  _tsParser = undefined;
  _tsxParser = undefined;
  _pyParser = undefined;
  _goParser = undefined;
  _rustParser = undefined;
  _rubyParser = undefined;
  _javaParser = undefined;
  _cppParser = undefined;
  _swiftParser = undefined;
  _TsLanguage = undefined;
  _TsxLanguage = undefined;
  _PyLanguage = undefined;
  _GoLanguage = undefined;
  _RustLanguage = undefined;
  _RubyLanguage = undefined;
  _JavaLanguage = undefined;
  _CppLanguage = undefined;
  _SwiftLanguage = undefined;
}

/** Replace the native query constructor after parser warm-up — test-only grammar-drift hook. */
export function __setNativeQueryForTests(query: typeof Parser.Query): void {
  _NativeQuery = query;
  _nativeQueries = new WeakMap();
  _nativeQueryErrors = new WeakMap();
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
  /** Optional receiver recovery for grammars whose call query historically captured only a name. */
  callObject?: (callNode: TsNodeLike) => string | undefined;
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
): Promise<FileExtractResult> {
  const handle = await spec.loader();
  if (!handle) return emptyForUnavailable(spec.language);

  const result = handle.withTree(content, (_root, runQuery, runOptionalQuery) => {
    const nodes: FunctionNode[] = [];
    const nodeIds = new Set<string>();
    const cfgByStart = new Map<number, FunctionCfg>();
    for (const match of runQuery(spec.fnQuery)) {
      const nameCapture = match.captures.find(c => c.name === 'fn.name');
      const nodeCapture = match.captures.find(c => c.name === 'fn.node');
      if (!nameCapture || !nodeCapture) continue;
      const name = nameCapture.node.text;
      const fnNode = nodeCapture.node;
      const className = (spec.classTypes.size ? enclosingGroupName(fnNode, spec.classTypes) : undefined)
        ?? spec.extraClassName?.(fnNode);
      const id = className ? `${filePath}::${className}.${name}` : `${filePath}::${name}`;
      if (nodeIds.has(id)) {
        // A colliding id is normally a multi-clause definition / overload and collapses
        // to one node. But a genuinely NESTED function — byte-contained in an already-seen
        // function with a DIFFERENT id — must survive so ensureUniqueNodeIds can re-key it
        // to a distinct scope-qualified id (change: add-stable-nested-function-identity).
        // Without this, query-spec languages (C#/Kotlin/Scala/…) keep merging same-named
        // nested twins and misrouting their calls — the exact bug this change fixes for the
        // dedicated extractors. The enclosing function is matched before its nested child
        // (document order), so it is present here. A same-id container (the same function
        // matched twice) has no different-id container and still collapses.
        const container = nodes.find(n =>
          n.id !== id && n.startIndex <= fnNode.startIndex && fnNode.endIndex <= n.endIndex);
        if (!container) continue; // true sibling overload / multi-clause — collapse to one node
      }
      // CFG/def-use overlay (spec: add-intraprocedural-cfg-dataflow-overlay) for
      // spec-08 languages that have a CfgLangSpec; others fail soft to no overlay.
      // Built inside withTree while the (possibly WASM) tree is live.
      const fnCfg = buildCfgFor(fnNode as unknown as CfgNode, spec.language);
      if (fnCfg) cfgByStart.set(fnNode.startIndex, fnCfg);
      nodes.push({
        id, name, filePath, className,
        isAsync: false,
        language: spec.language,
        startIndex: fnNode.startIndex,
        endIndex: fnNode.endIndex,
        fanIn: 0, fanOut: 0,
        signature: extractDeclaration(content, fnNode.startIndex, fnNode.endIndex, spec.language),
      });
      nodeIds.add(id);
    }

    const definedNames = new Set(nodes.map(n => n.name));
    ensureUniqueNodeIds(nodes);
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
      const calleeObject = objectCapture?.node.text ?? spec.callObject?.(nodeCapture.node);
      const key = `${caller.id}\0${calleeName}\0${calleeObject ?? ''}\0${nodeCapture.node.startIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rawEdges.push({ callerId: caller.id, calleeName, line: nodeCapture.node.startPosition.row + 1, calleeObject, offset: nodeCapture.node.startIndex });
    }
    const cfg = materializeCfgByNodeId(nodes, cfgByStart);
    // WASM grammars (e.g. Lua) yield spurious errors after the first parse — skip parse-health there.
    const parseHealth = handle.parseHealthReliable === false
      ? undefined
      : tallyParseHealth('', _root as unknown as ParseHealthNode, filePath);
    const classRelationships = collectClassRelationshipFacts(spec.language, runOptionalQuery);
    const dynamicDispatch = collectPass1DynamicDispatch(spec.language, content, _root, nodes, filePath);
    return { nodes, rawEdges, cfg, parseHealth, classRelationships, dynamicDispatch };
  });
  return grammarStatus(spec.language) === 'unavailable'
    ? emptyForUnavailable(spec.language)
    : result;
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
  callQuery: `
    (invocation_expression function: (member_access_expression name: (identifier) @call.name)) @call.node
    (invocation_expression function: (identifier) @call.name) @call.node
  `,
  callObject: (call) => call.childForFieldName('function')?.childForFieldName('expression')?.text,
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
  callObject: (call) => {
    const navigation = call.namedChildren.find(c => c.type === 'navigation_expression');
    return navigation?.namedChildren.find(c => c.type !== 'navigation_suffix')?.text;
  },
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
  callObject: (call) =>
    call.childForFieldName('object')?.text ?? call.childForFieldName('scope')?.text,
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

const UNIQUE_IMPORT_BINDING_LANGUAGES: ReadonlySet<string> = new Set([
  'Go', 'Java', 'Kotlin', 'C#', 'PHP',
]);
const RECOVERED_RECEIVER_LANGUAGES: ReadonlySet<string> = new Set(['Kotlin', 'C#', 'PHP']);

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
): Promise<FileExtractResult> {
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
  const nodeIds = new Set<string>();
  const cfgByStart = new Map<number, FunctionCfg>();
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
        if (!nodeIds.has(id)) {
          nodeIds.add(id);
          nodes.push({
            id, name: nameNode.text, filePath, className, isAsync: false, language: 'Dart',
            startIndex: n.startIndex, endIndex, fanIn: 0, fanOut: 0,
            signature: extractDeclaration(content, n.startIndex, n.endIndex, 'Dart'),
          });
          if (sib?.type === 'function_body') {
            const fnCfg = buildCfgFor(
              n as unknown as CfgNode,
              'Dart',
              sib as unknown as CfgNode,
            );
            if (fnCfg) cfgByStart.set(n.startIndex, fnCfg);
          }
        }
      }
    }
    for (const c of n.namedChildren) collectFns(c);
  };
  collectFns(root);

  ensureUniqueNodeIds(nodes);
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
            // A bare call's previous sibling is its callee identifier. Only a
            // selector has a receiver before it; treating `final p = Parser()`
            // as receiver `p` fabricates an external `p.Parser` method edge.
            const receiver = prev?.type === 'identifier' ? undefined : prev?.previousNamedSibling;
            rawEdges.push({
              callerId: caller.id,
              calleeName: name,
              line: n.startPosition.row + 1,
              offset: n.startIndex,
              ...(receiver?.type === 'identifier' ? { calleeObject: receiver.text } : {}),
            });
          }
        }
      }
    }
    for (const c of n.namedChildren) collectCalls(c);
  };
  collectCalls(root);
  // Dart loads via the WASM path, whose shared Language heap yields spurious ERROR nodes after the
  // first parse — parse-health is fail-soft (not tallied) for it (change:
  // add-parse-health-boundary-disclosure).
  const cfg = materializeCfgByNodeId(nodes, cfgByStart);
  return { nodes, rawEdges, cfg };
  });
}

// ── Elixir (custom walk — everything is a `call` node) ───────────────────────
const ELIXIR_DEF_KEYWORDS = new Set(['def', 'defp', 'defmacro', 'defmacrop']);

async function extractElixirGraph(
  filePath: string,
  content: string,
): Promise<{ nodes: FunctionNode[]; rawEdges: RawEdge[]; parseHealth?: FileParseHealth }> {
  const loaded = await loadGrammarSoft('Elixir', () => import('tree-sitter-elixir'), m => m.default);
  if (!loaded) return { nodes: [], rawEdges: [] };

  return loaded.withTree(content, (root) => {
  const nodes: FunctionNode[] = [];
  const nodeById = new Map<string, FunctionNode>();
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
          const existing = nodeById.get(id);
          if (existing) {
            existing.signature = `${existing.signature} (+clause)`;
          } else {
            const created: FunctionNode = {
              id, name: fnName, filePath, className: moduleName, isAsync: false,
              language: 'Elixir', startIndex: node.startIndex, endIndex: node.endIndex,
              fanIn: 0, fanOut: 0, signature: `${kw} ${fnName}/${arity}`,
            };
            nodes.push(created);
            nodeById.set(id, created);
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

  ensureUniqueNodeIds(nodes);
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
  const parseHealth = tallyParseHealth('', root as unknown as ParseHealthNode, filePath);
  const dynamicDispatch = collectPass1DynamicDispatch('Elixir', content, root, nodes, filePath);
  return { nodes, rawEdges, parseHealth, dynamicDispatch };
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
/** @deprecated Test/reference implementation for proving Pass-1 fact equivalence. */
export async function _extractClassRelationshipsLegacyForTesting(
  files: Array<{ path: string; content: string; language: string }>,
  /**
   * Collects files this pass abandoned at the parse budget (change:
   * fix-analyze-native-abort-and-file-cost-budget). A file can squeak under the budget in Pass 1
   * and overrun HERE — the per-file `catch` below would then drop its inheritance data with no
   * record anywhere, which is the silent loss this change exists to prevent. Reported so the
   * builder can record it like any other exclusion.
   */
  budgetExceeded?: Set<string>,
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
        const r = await getTSParser(file.path);
        if (!r) continue;
        const { parser, lang } = r;
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
        const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content);

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
    } catch (err) {
      // Best-effort; skip unparseable files — but a file abandoned at the BUDGET is reported, not
      // swallowed. "We ran out of time on this file" and "the grammar rejected it" call for
      // different actions, and only one of them used to leave any trace.
      if (parseBudgetOverrunMs((err as Error | undefined)?.message) !== undefined) {
        budgetExceeded?.add(file.path);
      }
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
  resolutionClasses: readonly ClassNode[] = [],
  resolutionNodes: readonly FunctionNode[] = [],
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
  // Retained classes seed hierarchy resolution during a scoped rebuild, just as
  // retained functions seed call resolution. Newly extracted classes overwrite
  // same-id seeds below and are the only rows the scoped publisher replaces.
  const classMap = new Map<string, ClassNode>(
    resolutionClasses.map(cls => [cls.id, { ...cls }]),
  );
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
  const hierarchyNodes = new Map(resolutionNodes.map(node => [node.id, node]));
  for (const [id, node] of allNodes) hierarchyNodes.set(id, node);
  const methodNameSet = new Map<string, Set<string>>();
  for (const [id, cls] of classMap) {
    const names = new Set<string>();
    for (const memberId of cls.methodIds) {
      const fn = hierarchyNodes.get(memberId);
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
// EXTERNAL NODE HELPER — classifyExternal + getOrCreateExternalNode extracted to
// ./call-graph-external.ts (change: modularize-call-graph-builder); imported at the
// top of this file. (The isTestFile note below documents a top-level import and is
// unrelated to the external-node helpers — kept in place.)
// ============================================================================

// isTestFile is imported at the top of the file from ./test-file.js — the shared
// cross-language predicate, so call-graph classification can't drift from the
// artifact generator's. (A narrower local copy previously let test code in
// tests/, __tests__/, *Spec.kt, etc. leak into the production graph and dropped
// `tested_by` edges for those layouts.)

// ============================================================================
// CYCLOMATIC COMPLEXITY — extracted to ./call-graph-complexity.ts
// (change: modularize-call-graph-builder). computeCyclomaticComplexity is imported
// at the top of this file and re-exported there to keep the public surface stable.
// ============================================================================

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
    const sites: EventSites = { registrations: [], dispatches: [] };
    for (const file of tsFiles) {
      const r = await getTSParser(file.path);
      if (!r) continue;
      try { collectTsEventSites(parseWithBudget(r.parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
      catch { /* skip unparseable file */ }
    }
    edges.push(...pairAndEmitEventEdges(sites, allNodes, 'event-channel'));
  }

  const pyFiles = files.filter(f => f.language === 'Python' && EVENT_PREFILTER.test(f.content));
  if (pyFiles.length > 0) {
    const r = await getPyParser();
    if (r) {
      const { parser } = r;
      const sites: EventSites = { registrations: [], dispatches: [] };
      for (const file of pyFiles) {
        try { collectPyEventSites(parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
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
        try { collectRubyEventSites(parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
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
        try { collectPhpEventSites(parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
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
        try { collectJavaTypeEventSites(parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
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
        try { collectCSharpTypeEventSites(parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
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
        try { collectKotlinTypeEventSites(parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
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
        try { collectSwiftEventSites(parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
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
  // Per-file-then-flatten over a BOUNDED scan: `mapFilesBounded` resolves in INPUT (file-list)
  // order regardless of its concurrency, so the synthesized edge order is a pure function of the
  // input — pushing into a shared `routes` array inside the callbacks would order routes by I/O
  // completion, making the serialized graph bytes non-deterministic (decision c6d1ad07). The
  // bound matters here too: these extractors re-read each file from disk, so an unbounded
  // `Promise.all` made the whole repository resident at once (issue #302).
  // The content is ALREADY resident here — `contentByPath` was just built from it — so each
  // extractor is handed the text rather than re-reading it. That is not only cheaper (one fewer
  // full pass over the repository); it is what keeps the enrichment scans' per-file SIZE CAP from
  // reaching the graph. Re-reading through the capped reader silently dropped the route-handler
  // edges of every file above the cap, which turns a live handler into a `find_dead_code`
  // candidate — and it bought no memory back, because the content was resident either way.
  const perFileRoutes = await mapFilesBounded(
    files.map(f => f.path),
    async (path): Promise<RouteDefinition[]> => {
      const resident = contentByPath.get(path);
      try {
        if (/\.(py|pyw)$/.test(path)) return await extractRouteDefinitions(path, resident);
        if (/\.(ts|tsx|js|jsx|mjs)$/.test(path)) return await extractTsRouteDefinitions(path, resident);
        if (/\.java$/.test(path)) return await extractJavaRouteDefinitions(path, resident);
      } catch { /* best-effort per file */ }
      return [];
    },
  );
  const routes: RouteDefinition[] = perFileRoutes.flat();
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
    for (const file of tsFiles) {
      const r = await getTSParser(file.path);
      if (!r) continue;
      try { collectTsCallbackEdges(parseWithBudget(r.parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, out, seen); }
      catch { /* skip */ }
    }
  }

  const goFiles = files.filter(f => f.language === 'Go' && GO_CALLBACK_PREFILTER.test(f.content));
  if (goFiles.length > 0) {
    const r = await getGoParser();
    if (r) {
      const { parser } = r;
      for (const file of goFiles) {
        try { collectGoCallbackEdges(parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, out, seen); }
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
        try { collectCppCallbackEdges(parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, out, seen); }
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
    try { collectElixirActorSites(parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, file.content), nodesByFile.get(file.path) ?? [], file.path, resolveHandler, sites); }
    catch { /* skip */ }
  }
  return pairAndEmitEventEdges(sites, allNodes, 'actor-message');
}

const HANDLER_REF_PREFIX = '\0openlore-handler\0';

function encodeHandlerRef(name: string, preferFile: string): string {
  return `${HANDLER_REF_PREFIX}${JSON.stringify([preferFile, name])}`;
}

function decodeHandlerRef(value: string): { name: string; preferFile: string } | undefined {
  if (!value.startsWith(HANDLER_REF_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(value.slice(HANDLER_REF_PREFIX.length)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(v => typeof v !== 'string')) return undefined;
    return { preferFile: parsed[0] as string, name: parsed[1] as string };
  } catch {
    return undefined;
  }
}

/** Collect tree-dependent dynamic-dispatch facts during Pass 1 as structured-clone-safe data. */
function collectPass1DynamicDispatch(
  language: string,
  content: string,
  rootNode: TsNodeLike,
  nodes: FunctionNode[],
  filePath: string,
): DynamicDispatchFacts | undefined {
  const events: DynamicDispatchFacts['events'] = [];
  const callbacks: DynamicDispatchFacts['callbacks'] = [];
  const tree = { rootNode } as unknown as Parser.Tree;
  const unresolved: HandlerResolver = (name, preferFile) => {
    if (!name || RUNTIME_CALLBACK_LOCALS.has(name)) return undefined;
    return { id: encodeHandlerRef(name, preferFile), name } as FunctionNode;
  };
  const addEvents = (
    group: string,
    rule: 'event-channel' | 'type-event' | 'actor-message',
    collect: (sites: EventSites) => void,
  ): void => {
    const sites: EventSites = { registrations: [], dispatches: [] };
    collect(sites);
    if (sites.registrations.length || sites.dispatches.length) events.push({ group, rule, ...sites });
  };

  try {
    if ((language === 'TypeScript' || language === 'JavaScript') && EVENT_PREFILTER.test(content)) {
      addEvents('TypeScript', 'event-channel', sites => collectTsEventSites(tree, nodes, filePath, unresolved, sites));
    } else if (language === 'Python' && EVENT_PREFILTER.test(content)) {
      addEvents('Python', 'event-channel', sites => collectPyEventSites(tree, nodes, filePath, unresolved, sites));
    } else if (language === 'Ruby' && EVENT_PREFILTER.test(content)) {
      addEvents('Ruby', 'event-channel', sites => collectRubyEventSites(tree, nodes, filePath, unresolved, sites));
    } else if (language === 'PHP' && EVENT_PREFILTER.test(content)) {
      addEvents('PHP', 'event-channel', sites => collectPhpEventSites(tree, nodes, filePath, unresolved, sites));
    } else if (language === 'Java' && JAVA_TYPE_EVENT_PREFILTER.test(content)) {
      addEvents('Java', 'type-event', sites => collectJavaTypeEventSites(tree, nodes, filePath, unresolved, sites));
    } else if (language === 'C#' && CSHARP_TYPE_EVENT_PREFILTER.test(content)) {
      addEvents('C#', 'type-event', sites => collectCSharpTypeEventSites(tree, nodes, filePath, unresolved, sites));
    } else if (language === 'Kotlin' && JAVA_TYPE_EVENT_PREFILTER.test(content)) {
      addEvents('Kotlin', 'type-event', sites => collectKotlinTypeEventSites(tree, nodes, filePath, unresolved, sites));
    } else if (language === 'Swift' && SWIFT_EVENT_PREFILTER.test(content)) {
      addEvents('Swift', 'event-channel', sites => collectSwiftEventSites(tree, nodes, filePath, unresolved, sites));
    } else if (language === 'Elixir' && ELIXIR_ACTOR_PREFILTER.test(content)) {
      addEvents('Elixir', 'actor-message', sites => collectElixirActorSites(tree, nodes, filePath, unresolved, sites));
    }
  } catch {
    // Event synthesis is optional and independent from callback synthesis.
    events.length = 0;
  }

  try {
    const callbackEdges: CallEdge[] = [];
    const seen = new Set<string>();
    if ((language === 'TypeScript' || language === 'JavaScript') && TS_CALLBACK_PREFILTER.test(content)) {
      collectTsCallbackEdges(tree, nodes, filePath, unresolved, callbackEdges, seen);
    } else if (language === 'Go' && GO_CALLBACK_PREFILTER.test(content)) {
      collectGoCallbackEdges(tree, nodes, filePath, unresolved, callbackEdges, seen);
    } else if (language === 'C++' && CPP_CALLBACK_PREFILTER.test(content)) {
      collectCppCallbackEdges(tree, nodes, filePath, unresolved, callbackEdges, seen);
    }
    for (const edge of callbackEdges) {
      const group = language === 'Go' ? 'Go' : language === 'C++' ? 'C++' : 'TypeScript';
      callbacks.push({ group, callerId: edge.callerId, handlerId: edge.calleeId, line: edge.line ?? 0 });
    }
  } catch {
    // Callback synthesis is optional and independent from event synthesis.
    callbacks.length = 0;
  }

  return events.length || callbacks.length ? { events, callbacks } : undefined;
}

export async function synthesizeDynamicDispatchEdges(
  files: Array<{ path: string; content: string; language: string }>,
  allNodes: Map<string, FunctionNode>,
  resolveHandler: HandlerResolver,
  pass1Facts?: DynamicDispatchFacts[],
): Promise<CallEdge[]> {
  if (pass1Facts) {
    const groupOrder = ['TypeScript', 'Python', 'Ruby', 'PHP', 'Java', 'C#', 'Kotlin', 'Swift', 'Elixir'];
    const grouped = new Map<string, { rule: 'event-channel' | 'type-event' | 'actor-message'; sites: EventSites }>();
    for (const facts of pass1Facts) {
      for (const event of facts.events) {
        const bucket = grouped.get(event.group) ?? { rule: event.rule, sites: { registrations: [], dispatches: [] } };
        bucket.sites.registrations.push(...event.registrations);
        bucket.sites.dispatches.push(...event.dispatches);
        grouped.set(event.group, bucket);
      }
    }
    const eventEdges: CallEdge[] = [];
    const actorEdges: CallEdge[] = [];
    for (const group of groupOrder) {
      const bucket = grouped.get(group);
      if (!bucket) continue;
      const resolved: EventSites = {
        registrations: bucket.sites.registrations.map(reg => ({
          key: reg.key,
          handlerIds: reg.handlerIds.flatMap(id => {
            const ref = decodeHandlerRef(id);
            if (!ref) return [id];
            const node = resolveHandler(ref.name, ref.preferFile);
            return node ? [node.id] : [];
          }),
        })),
        dispatches: bucket.sites.dispatches,
      };
      const emitted = pairAndEmitEventEdges(resolved, allNodes, bucket.rule);
      (bucket.rule === 'actor-message' ? actorEdges : eventEdges).push(...emitted);
    }
    const callbackEdges: CallEdge[] = [];
    const callbackSeen = new Set<string>();
    for (const group of ['TypeScript', 'Go', 'C++'] as const) {
      for (const facts of pass1Facts) {
        for (const fact of facts.callbacks) {
          if (fact.group !== group) continue;
          const ref = decodeHandlerRef(fact.handlerId);
          const handler = ref ? resolveHandler(ref.name, ref.preferFile) : allNodes.get(fact.handlerId);
          if (handler) pushCallbackEdge(callbackEdges, callbackSeen, fact.callerId, handler, fact.line);
        }
      }
    }
    const routeEdges = await synthesizeRouteHandlerEdges(files, allNodes, resolveHandler).catch(() => []);
    return [...eventEdges, ...routeEdges, ...callbackEdges, ...actorEdges];
  }
  const rules: Array<Promise<CallEdge[]>> = [
    synthesizeEventChannelEdges(files, allNodes, resolveHandler).catch(() => []),
    synthesizeRouteHandlerEdges(files, allNodes, resolveHandler).catch(() => []),
    synthesizeCallbackRegistrationEdges(files, allNodes, resolveHandler).catch(() => []),
    synthesizeActorMessageEdges(files, allNodes, resolveHandler).catch(() => []),
  ];
  const results = await Promise.all(rules);
  return results.flat();
}

/**
 * Does a Pass-1 extraction result carry no facts at all? Used only to decide whether a
 * WORKER's silence has been proven trustworthy (see `extraction-pool.ts`) — never to alter
 * a result. `undefined` (a language with no extractor) is not emptiness: it is the same
 * deterministic answer on both lanes.
 */
function isEmptyExtractResult(result: FileExtractResult | undefined): boolean {
  if (!result) return false;
  // Runtime grammar failures are never trustworthy or cacheable, including a mixed
  // container whose other lane produced facts. A repaired process must re-extract it.
  if (result.grammarUnavailable || result.grammarUnavailableAll?.length) return true;
  return result.nodes.length === 0
    && result.rawEdges.length === 0
    && !result.parseHealth
    && !result.style
    && !result.classRelationships?.length
    && !result.dynamicDispatch
    && !result.httpCalls?.length
    && !result.httpDegradations?.length;
}

/** Construction-time options for {@link CallGraphBuilder}. */
export interface CallGraphBuilderOptions {
  /**
   * Controls for the Pass-1 extraction lane (change: optimize-parallel-extraction-pool).
   * Production passes nothing: the lane decides for itself from core count, file count, the
   * process-wide worker budget, and `OPENLORE_NO_WORKERS`. Tests use these to drive a stub
   * pool whose completion order and failure modes are deterministic.
   */
  extraction?: ExtractionLaneOptions;
  /**
   * Memo of per-file Pass-1 facts (change: optimize-hash-keyed-analyze). When supplied, a file
   * whose content and extractor stamp match a stored row skips extraction entirely and its
   * cached facts are merged in its input position — the merge, and therefore every downstream
   * pass, cannot tell the two apart. Absent (the watcher's per-file rebuilds, tests, any
   * embedded caller) means today's behavior: extract everything.
   */
  pass1Cache?: Pass1FactCache;
  /**
   * Off-heap destination for the CFG/def-use overlay (issue #304). When supplied, each file's
   * overlay is serialized into the spill as the file is merged and then DROPPED, so the overlay
   * never accumulates across the repository; `cfgs` comes back `undefined` and the caller drains
   * the spill into `cfg_overlay` instead. Absent (the watcher's per-file rebuilds, tests, any
   * embedded caller) means today's behavior: the overlay is returned in memory.
   */
  cfgSpill?: CfgSpill;
  /** Test-only oracle: run the pre-optimization late parsers for byte-equivalence checks. */
  legacyLatePassesForTesting?: boolean;
}

export class CallGraphBuilder {
  private readonly extractionOptions: CallGraphBuilderOptions['extraction'];
  private readonly pass1Cache: Pass1FactCache | undefined;
  private readonly cfgSpill: CfgSpill | undefined;
  private readonly legacyLatePassesForTesting: boolean;

  constructor(options: CallGraphBuilderOptions = {}) {
    this.extractionOptions = options.extraction;
    this.pass1Cache = options.pass1Cache;
    this.cfgSpill = options.cfgSpill;
    this.legacyLatePassesForTesting = options.legacyLatePassesForTesting === true;
  }

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
    resolutionClasses?: ClassNode[],
  ): Promise<CallGraphResult> {
    const structuralFiles = files.map(file => {
      const container = extractScriptContainer(file.path, file.content);
      return container
        ? {
            ...file,
            content: container.content ?? '',
            language: container.lanes.some(lane => lane.language === 'TypeScript')
              ? 'TypeScript'
              : 'JavaScript',
          }
        : file;
    });
    const allNodes = new Map<string, FunctionNode>();
    const allRawEdges: RawEdge[] = [];
    const allCfgs = new Map<string, FunctionCfg>();
    const cfgSpill = this.cfgSpill;
    const styleByFile = new Map<string, FileStyleRaw>();
    const parseHealthByFile = new Map<string, FileParseHealth>();
    const grammarUnavailableByLanguage = new Map<string, GrammarUnavailableBoundary>();
    let relationships = new Map<string, { parentClasses: string[]; interfaces: string[] }>();
    const dynamicDispatchFacts: DynamicDispatchFacts[] = [];
    const httpCallFacts = new Map<string, HttpCall[]>();
    const pass1HttpDegradations: HttpExtractionDegradation[] = [];

    // Pass 1: Extract nodes and raw edges from each file.
    //
    // Extraction runs on a worker-thread pool when one is available and the build is large
    // enough to pay for the spawn (change: optimize-parallel-extraction-pool); otherwise it
    // runs on the serial lane, which stays the reference implementation and the fallback
    // executor — `dispatchFileExtract` is the single extractor for both lanes.
    //
    // The EXTRACT step and the MERGE step below are separated on purpose. Extraction may
    // complete in any order; the merge walks `files` by index and applies each result in
    // input order, so worker scheduling can never reach the graph. Every determinism
    // property downstream (node overwrite order, raw-edge sequence) is a property of this
    // loop, not of the extraction lane.
    // A supplied memo removes files from the extraction input entirely (change:
    // optimize-hash-keyed-analyze). The reused facts are spliced back into their INPUT
    // positions below, so the merge loop — and every determinism property it owns — runs
    // over the same sequence it would have run over with no cache at all.
    const cache = this.pass1Cache;
    const reusedFacts: Array<{ facts: FileExtractResult | undefined } | undefined> = new Array(files.length);
    const toExtract: Array<{ path: string; content: string; language: string }> = [];
    const toExtractAt: number[] = [];
    if (cache) {
      for (let i = 0; i < files.length; i++) {
        const hit = cache.lookup(files[i]);
        if (hit) reusedFacts[i] = hit;
        else { toExtract.push(files[i]); toExtractAt.push(i); }
      }
    } else {
      for (let i = 0; i < files.length; i++) { toExtract.push(files[i]); toExtractAt.push(i); }
    }

    const { outcomes: laneOutcomes, disclosure: extractionLane } = await extractFilesForPass1(
      toExtract,
      dispatchFileExtract,
      isEmptyExtractResult,
      this.extractionOptions ?? {},
    );

    const extractOutcomes: Array<ExtractOutcome<FileExtractResult>> = new Array(files.length);
    for (let i = 0; i < files.length; i++) {
      const hit = reusedFacts[i];
      if (hit) extractOutcomes[i] = { status: 'ok', value: hit.facts };
    }
    for (let i = 0; i < toExtractAt.length; i++) extractOutcomes[toExtractAt[i]] = laneOutcomes[i];

    /** Extracted files the memo refused to store — counted so the epilogue can say so. */
    let uncacheable = 0;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const outcome = extractOutcomes[fileIndex];
      /** Did this file's facts reach the memo? Read by the catch, which runs AFTER the record. */
      let memoized = false;
      try {
        if (outcome.status === 'error') throw outcome.error;
        const result = outcome.value;
        const grammarFailures = result?.grammarUnavailableAll
          ?? (result?.grammarUnavailable ? [result.grammarUnavailable] : []);
        for (const failure of grammarFailures) {
          warnGrammarUnavailable(failure);
          const existing = grammarUnavailableByLanguage.get(failure.language);
          grammarUnavailableByLanguage.set(failure.language, {
            ...failure,
            fileCount: (existing?.fileCount ?? 0) + 1,
          });
        }
        // Record what a FRESH extraction produced, before the relabeling below mutates it,
        // so the stored facts are exactly the extractor's own answer.
        //
        // Two answers are deliberately NOT recorded, both for the same reason — the memo is
        // permanent, so it must never freeze an answer the process might not be able to
        // reproduce:
        //
        //  - A file that THREW. A deterministic parse failure costs the same on every run;
        //    a transient one must not become permanent.
        //  - A result carrying NO FACTS AT ALL. This is the pool's "never trust an unproven
        //    silence" rule (see extraction-pool.ts), and it matters more here than there.
        //    The extractors report an unloadable grammar by returning an EMPTY result rather
        //    than throwing, and grammar loadability is a property of the RUNNING PROCESS
        //    (Node ABI, prebuilt binaries, a transient dlopen failure) that no content hash
        //    or code digest can see. Persisting one empty result would serve an empty graph
        //    from cache forever, and a repaired environment would never undo it. An
        //    genuinely empty file costs one re-parse per run instead — exactly today's cost.
        //
        // `undefined` (a language with no extractor) is NOT emptiness: it is a decision made
        // by the dispatch code, which the stamp does cover, so it is recorded.
        if (cache && reusedFacts[fileIndex] === undefined) {
          if (isEmptyExtractResult(result)) uncacheable++;
          else { cache.record(file, result); memoized = true; }
        }
        if (!result) continue;

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
        if (result.cfg) {
          if (cfgSpill) {
            // Serialize this file's overlay now and drop it. The CFG objects become collectable
            // as soon as the extraction outcome is released, instead of being held for the whole
            // build across every later pass (issue #304). `file.path` is the authoritative owner
            // for the row — the same value `deleteCfgForFile` keys the watcher's invalidation on.
            cfgSpill.write(file.path, result.cfg);
            result.cfg = new Map();
          } else {
            for (const [id, fnCfg] of result.cfg) allCfgs.set(id, fnCfg);
          }
        }
        if (result.style) {
          // The TS extractor handles both TS and JS; relabel to the real file language so the
          // fingerprint slices JS and TS apart (their counter sets are identical).
          result.style.language = file.language;
          styleByFile.set(file.path, result.style);
        }
        if (result.parseHealth) {
          // Parse health is tallied in the extractor with a placeholder language; relabel to the
          // real file language for the rollup (change: add-parse-health-boundary-disclosure).
          result.parseHealth.language = file.language;
          parseHealthByFile.set(file.path, result.parseHealth);
        }
        for (const fact of result.classRelationships ?? []) {
          const key = `${file.path}::${fact.className}`;
          const existing = relationships.get(key) ?? { parentClasses: [], interfaces: [] };
          for (const parent of fact.parentClasses) {
            if (!existing.parentClasses.includes(parent)) existing.parentClasses.push(parent);
          }
          for (const iface of fact.interfaces) {
            if (!existing.interfaces.includes(iface)) existing.interfaces.push(iface);
          }
          relationships.set(key, existing);
        }
        if (result.dynamicDispatch) dynamicDispatchFacts.push(result.dynamicDispatch);
        if (result.httpCalls) httpCallFacts.set(file.path, result.httpCalls);
        if (result.httpDegradations) pass1HttpDegradations.push(...result.httpDegradations);
      } catch (error) {
        // A throw is never memoized either (see above), so it re-extracts on every run —
        // unless the record already happened and the throw came from the MERGE below it, in
        // which case a row exists and counting it would misreport a cached file as uncacheable.
        if (cache && reusedFacts[fileIndex] === undefined && !memoized) uncacheable++;
        // A file that threw here contributed ZERO nodes/edges — the "swallowed parse failure" leak.
        // Record it as a structured parse-health failure so downstream conclusions disclose it
        // instead of treating the missing symbols as genuinely absent (change:
        // add-parse-health-boundary-disclosure). Still fail-soft — the build proceeds.
        //
        // Only `error.message` may be relied on here. A throw that happened inside an
        // extraction worker crossed a structured-clone boundary, so its class, `code`, and
        // stack did not survive — an `instanceof`/`.code` check added below would behave
        // differently on the two lanes (change: optimize-parallel-extraction-pool).
        //
        // Which is exactly why the one cause that IS distinguishable from a message is read off it
        // (change: fix-analyze-native-abort-and-file-cost-budget): a file abandoned at the parse
        // budget carries its own reason and its elapsed time, rather than being flattened into a
        // generic parse failure. Anything else stays `parse-failure` — a cause we cannot prove is
        // never guessed at. A worker fault never reaches here: the pool routes that file to the
        // main thread instead, so this message is always the main thread's own verdict.
        const message = (error as Error | undefined)?.message;
        const overrunBudgetMs = parseBudgetOverrunMs(message);
        const exclusion: FileExclusionReason = overrunBudgetMs !== undefined
          ? 'budget-exceeded'
          : 'parse-failure';
        parseHealthByFile.set(file.path, {
          filePath: file.path,
          language: file.language,
          errorCount: 0,
          missingCount: 0,
          errorLines: [],
          parseFailed: true,
          exclusion,
          ...(overrunBudgetMs !== undefined ? { budgetMs: overrunBudgetMs } : {}),
        });
        if (process.env.DEBUG) {
          console.debug(`[call-graph] Failed to parse ${file.path}: ${(error as Error).message}`);
        }
      }
    }

    // A file abandoned at the parse budget contributed nothing to Pass 1, and several later passes
    // RE-PARSE the same content (class relationships, and the event/callback/route/actor
    // synthesizers). Left in, each would spend the whole budget on it again — the cost is per PASS,
    // not per file, which is how one 300 KB file turned a 20 s bound into a 92 s build. Dropping it
    // from those passes costs nothing in facts: its parse cannot complete there either, so it would
    // contribute exactly the same nothing, only slower.
    //
    // This filter is deliberately NOT applied to `buildResolvedImportMap`. That pass is a REGEX
    // scan (`parseJSExports`), not a parse — it reads a file tree-sitter gave up on perfectly well,
    // and the parse budget was never what bounded it. An earlier revision of this change did filter
    // it, and an adversarial review reproduced the consequence: a re-export barrel abandoned at the
    // budget silently dropped `re_export` edges belonging to OTHER, perfectly-parsed files, which
    // then resolved by name only or not at all. The loss landed on files carrying no parse-health
    // record, so nothing connected the missing edge to the abandoned file — the exact
    // absence-read-as-evidence-of-absence failure this change exists to prevent. Correctness over
    // the few seconds it saves.
    //
    // When nothing was abandoned this is the same array, so ordinary runs are byte-identical
    // (change: fix-analyze-native-abort-and-file-cost-budget).
    const abandonedPaths = new Set(
      [...parseHealthByFile.values()].filter(h => h.exclusion === 'budget-exceeded').map(h => h.filePath),
    );
    const reparsableFiles = abandonedPaths.size > 0
      ? structuralFiles.filter(f => !abandonedPaths.has(f.path))
      : structuralFiles;
    if (this.legacyLatePassesForTesting) {
      relationships = await _extractClassRelationshipsLegacyForTesting(reparsableFiles);
    }

    const pass1Cache: Pass1CacheDisclosure | undefined = cache
      ? {
          reused: files.length - toExtract.length,
          extracted: toExtract.length,
          uncacheable,
          ...(cache.noReuseReason ? { noReuseReason: cache.noReuseReason } : {}),
        }
      : undefined;

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
    for (const file of structuralFiles) fileContents.set(file.path, file.content);

    // Re-export-aware import resolution for Pass 2 call edges (change: add-call-resolution-recall).
    // Production callers never thread `importMap`, so derive a re-export-following map from the
    // sources: a cross-file call resolves to its TRUE definition (through any depth of barrel) at
    // `import`/`re_export` confidence instead of falling through to the ambiguous name-only
    // fallback. A caller-provided `importMap` is honoured verbatim (no re-export provenance set).
    // Reused for base-class resolution (Pass 7) below.
    const { map: callImportMap, reExported: reExportedNames } = importMap
      ? { map: importMap, reExported: new Set<string>() }
      // NOT `reparsableFiles` — see the note there. This is a regex scan, and an abandoned file's
      // exports are still readable and still load-bearing for OTHER files' resolution.
      : buildResolvedImportMap(structuralFiles);

    // Class inheritance facts were collected inside Pass 1 while each tree was already alive.
    // They are plain data, so fresh serial extraction, worker extraction, and fact-cache reuse all
    // feed this same map without retaining or re-parsing syntax trees.

    /** Resolve an intra-object method call (`this.m()` / `self.m()` / `super.m()`) to
     *  a concrete indexed method by walking the enclosing class chain. For `this`/
     *  `self`/`cls` the chain starts at the enclosing class; for `super` it starts at
     *  the parents (a super call never targets the caller's own class). Ancestors are
     *  followed transitively (cycle-guarded) so an inherited method still resolves.
     *
     *  `findByQualifiedName` keys on `Class.method` with NO file dimension, so when
     *  two files declare a same-named class it would otherwise bind to an arbitrary
     *  one. Disambiguate by FILE AFFINITY: prefer a candidate in the caller's own file
     *  (the same-class / same-file family — the dominant case), then the file the
     *  caller imports the class from (cross-file parent); a single candidate is
     *  unambiguous; an ambiguous match with no affinity is SKIPPED, never guessed. */
    /** Outcome of an affinity-based candidate pick: a unique target, a genuinely
     *  ambiguous candidate set (≥2, no affinity signal — never guessed), or none.
     *  (change: harden-call-resolution-ambiguity). */
    type AffinityPick =
      | { kind: 'unique'; node: FunctionNode }
      | { kind: 'ambiguous'; candidates: FunctionNode[] }
      | { kind: 'none' };

    /** The one affinity ladder shared by self/cls, this/super and type-name
     *  resolution: own-file containment → the file the caller imports the qualifier
     *  from → a single remaining candidate. A candidate set that survives all three
     *  with >1 member is ambiguous and is NEVER bound to an arbitrary first match. */
    const pickByAffinity = (
      cands: FunctionNode[],
      callerFile: string,
      qualifier: string,
    ): AffinityPick => {
      if (cands.length === 0) return { kind: 'none' };
      const own = cands.find(c => c.filePath === callerFile);
      if (own) return { kind: 'unique', node: own };
      const importedFrom = callImportMap.get(callerFile)?.get(qualifier);
      if (importedFrom) {
        const m = cands.find(
          c =>
            c.filePath === importedFrom ||
            c.filePath.startsWith(`${importedFrom}.`) ||
            c.filePath.startsWith(`${importedFrom}/`),
        );
        if (m) return { kind: 'unique', node: m };
      }
      // Unambiguous single target → safe; ambiguous with no affinity → do not guess.
      return cands.length === 1
        ? { kind: 'unique', node: cands[0] }
        : { kind: 'ambiguous', candidates: cands };
    };

    const matchesImportedTarget = (filePath: string, target: string): boolean =>
      filePath === target
      || filePath.startsWith(`${target}.`)
      || filePath.startsWith(`${target}/`)
      || posix.dirname(filePath) === target;

    /** Resolve an intra-object method call by walking the enclosing class chain,
     *  disambiguating each hop with {@link pickByAffinity}. Returns the resolved node,
     *  or — when the first class with candidates was ambiguous with no affinity and no
     *  ancestor resolved — the ambiguous candidate set so the caller can disclose it. */
    const resolveSelfMethod = (
      callerNode: FunctionNode,
      methodName: string,
      includeSelf: boolean,
    ): { node?: FunctionNode; ambiguous?: FunctionNode[] } => {
      if (!callerNode.className) return {};
      let firstAmbiguous: FunctionNode[] | undefined;
      const seen = new Set<string>();
      const queue: string[] = includeSelf
        ? [callerNode.className]
        : [...(relationships.get(`${callerNode.filePath}::${callerNode.className}`)?.parentClasses ?? [])];
      while (queue.length > 0) {
        const cls = queue.shift()!;
        if (seen.has(cls)) continue;
        seen.add(cls);
        const picked = pickByAffinity(trie.findByQualifiedName(cls, methodName), callerNode.filePath, cls);
        if (picked.kind === 'unique') return { node: picked.node };
        if (picked.kind === 'ambiguous' && !firstAmbiguous) firstAmbiguous = picked.candidates;
        // Walk to this class's parents. The relationship map is keyed by file::Class;
        // probe the caller's file key (same-file class families — the common case).
        const rel = relationships.get(`${callerNode.filePath}::${cls}`);
        for (const p of rel?.parentClasses ?? []) if (!seen.has(p)) queue.push(p);
      }
      return firstAmbiguous ? { ambiguous: firstAmbiguous } : {};
    };

    const edges: CallEdge[] = [];
    // Call sites the ladder refused to bind because the candidate set was ambiguous
    // (change: harden-call-resolution-ambiguity). Recorded instead of an arbitrary
    // first-match edge so precision-sensitive consumers can disclose the ambiguity.
    const ambiguousSites: AmbiguousCallSite[] = [];
    const recordAmbiguous = (
      r: RawEdge,
      strategy: AmbiguousStrategy,
      candidates: FunctionNode[],
    ): void => {
      const ids = candidates
        .map(c => c.id)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      ambiguousSites.push({
        callerId: r.callerId,
        calleeName: r.calleeName,
        calleeObject: r.calleeObject,
        line: r.line,
        strategy,
        candidateIds: ids.slice(0, AMBIGUOUS_CANDIDATE_CAP),
        candidateCount: ids.length,
      });
    };
    const inferredTypesByCaller = new Map<string, ReturnType<typeof inferTypesFromSource>>();
    const ambiguousInferredBindingsByCaller = new Map<string, ReadonlySet<string>>();
    for (const raw of allRawEdges) {
      const callerNode = allNodes.get(raw.callerId);
      if (!callerNode) continue;

      let calleeNode: FunctionNode | undefined;
      let confidence: EdgeConfidence = 'name_only';

      // Strategy 1 — self/cls intra-class (Python self.*, cls.* or same-class method).
      // Shares the this/super affinity ladder (own-file → imported-from → single
      // candidate), walking ancestors so an inherited method still resolves. Two
      // same-named classes in different files no longer bind by insertion order:
      // the caller's own class wins, and a genuinely ambiguous set is disclosed, never
      // guessed (change: harden-call-resolution-ambiguity).
      if (raw.calleeObject === 'self' || raw.calleeObject === 'cls') {
        if (callerNode.className) {
          const res = resolveSelfMethod(callerNode, raw.calleeName, true);
          if (res.node) { calleeNode = res.node; confidence = 'self_cls'; }
          else if (res.ambiguous) { recordAmbiguous(raw, 'self_cls', res.ambiguous); continue; }
        }
      }

      // Strategy 1a — `this.m()` / `super.m()` intra-class (TS/JS). `this` walks the
      // enclosing class then its ancestors; `super` walks ancestors only (a super
      // call targets the parent's method, never the caller's own class). Without this
      // a `this.method()` call is the one shape that gets NO edge at all — neither
      // resolved nor external — because the call query historically only captured an
      // `(identifier)` receiver. (change: add-this-super-method-resolution)
      if (!calleeNode && (raw.calleeObject === 'this' || raw.calleeObject === 'super')) {
        const res = resolveSelfMethod(callerNode, raw.calleeName, raw.calleeObject === 'this');
        if (res.node) { calleeNode = res.node; confidence = 'self_cls'; }
        else if (res.ambiguous) { recordAmbiguous(raw, 'self_cls', res.ambiguous); continue; }
      }

      // Strategy 1b — type-name resolution (capitalized receiver = type/class reference).
      // In Swift and C++ there are no intra-module imports, so cross-file calls appear
      // as TypeName.method() / TypeName::method(). Java has the same shape for static
      // calls and same-file nested types (Money.of(), Outer.Inner.make()) that imports
      // don't cover. A capitalized receiver is a reliable signal for a class reference
      // in these languages (variables are conventionally lower-case), so resolve it to
      // the matching internal type member before falling back to import/external.
      // A unique type match (or one singled out by file/import affinity) binds; two
      // same-named types with no affinity are disclosed as ambiguous, never guessed
      // (change: harden-call-resolution-ambiguity).
      if (
        !calleeNode && raw.calleeObject &&
        (callerNode.language === 'Swift' || callerNode.language === 'C++' || callerNode.language === 'Java')
      ) {
        const ch = raw.calleeObject.charCodeAt(0);
        const isCapitalized = ch >= 65 && ch <= 90; // A-Z
        const hasImportBinding = callImportMap.get(callerNode.filePath)?.has(raw.calleeObject);
        if (isCapitalized && !hasImportBinding) {
          const picked = pickByAffinity(
            trie.findByQualifiedName(raw.calleeObject, raw.calleeName),
            callerNode.filePath,
            raw.calleeObject,
          );
          if (picked.kind === 'unique') { calleeNode = picked.node; confidence = 'type_name'; }
          else if (picked.kind === 'ambiguous') { recordAmbiguous(raw, 'type_name', picked.candidates); continue; }
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
          let inferredTypes = inferredTypesByCaller.get(callerNode.id);
          if (!inferredTypes) {
            if (analyzerWorkCounters.enabled) analyzerWorkCounters.typeInferences++;
            inferredTypes = inferTypesFromSource(bodySlice, callerNode.language);
            inferredTypesByCaller.set(callerNode.id, inferredTypes);
            ambiguousInferredBindingsByCaller.set(
              callerNode.id,
              findAmbiguousTypeBindings(bodySlice, callerNode.language),
            );
          }
          const inferredClass = raw.offset !== undefined &&
            (callerNode.language === 'Kotlin' || callerNode.language === 'Dart')
            ? inferReceiverTypeAt(
              bodySlice,
              callerNode.language,
              raw.calleeObject,
              raw.offset - callerNode.startIndex,
            )
            : inferredTypes.get(raw.calleeObject);
          if (inferredClass) {
            const picked = pickByAffinity(
              trie.findByQualifiedName(inferredClass, raw.calleeName),
              callerNode.filePath,
              inferredClass,
            );
            if (picked.kind === 'unique') { calleeNode = picked.node; confidence = 'type_inference'; }
            else if (picked.kind === 'ambiguous') { recordAmbiguous(raw, 'type_inference', picked.candidates); continue; }
          }
        }
      }

      // Strategy 3 — import/package resolution, re-export aware for TS/JS.
      // The map resolves an imported name to its true-definition module even when it
      // arrives through a barrel; an anchored prefix match (`x.` / `x/`, never bare
      // `startsWith`) avoids binding `shapes/base` to `shapes/base2.ts`. An edge whose
      // name was followed through a re-export chain is labelled `re_export` (still a
      // proven concrete target, but the barrel hop is disclosed); a direct import is
      // labelled `import`.
      if (!calleeNode) {
        const qualifier = raw.calleeObject?.split(/[.\\:]/).filter(Boolean).pop();
        const viaName = callImportMap.get(callerNode.filePath)?.get(raw.calleeName);
        const packageScopeTarget = !raw.calleeObject
          ? callImportMap.get(callerNode.filePath)?.get(PACKAGE_SCOPE_IMPORT)
          : undefined;
        const packageScopeName = packageScopeTarget
          ? callImportMap.get(callerNode.filePath)?.get(PACKAGE_SCOPE_NAME)
          : undefined;
        const importedFile = viaName
          ?? (raw.calleeObject
            ? callImportMap.get(callerNode.filePath)?.get(raw.calleeObject)
              ?? (qualifier ? callImportMap.get(callerNode.filePath)?.get(qualifier) : undefined)
            : packageScopeTarget);
        if (importedFile) {
          // The imported file is the authoritative qualifier. A source-level alias (for example
          // `using P = Wanted.Parser`) need not match the declaration's real class name.
          const boundName = raw.calleeObject ?? (viaName ? raw.calleeName : undefined);
          const declaredQualifier = boundName
            ? callImportMap.get(callerNode.filePath)?.get(
              `${IMPORT_QUALIFIER_PREFIX}${boundName}`,
            ) ?? (qualifier
              ? callImportMap.get(callerNode.filePath)?.get(`${IMPORT_QUALIFIER_PREFIX}${qualifier}`)
              : undefined)
            : undefined;
          const importedCandidates = declaredQualifier === IMPORT_TOP_LEVEL_QUALIFIER
            ? trie.findBySimpleName(raw.calleeName).filter(n => !n.className)
            : declaredQualifier
              ? trie.findByQualifiedName(declaredQualifier, raw.calleeName)
              : trie.findBySimpleName(raw.calleeName);
          const goQualifier = raw.calleeObject ?? qualifier;
          const goPackage = callerNode.language === 'Go'
            ? packageScopeName ?? (goQualifier
              ? callImportMap.get(callerNode.filePath)?.get(
                `${GO_IMPORT_PACKAGE_PREFIX}${goQualifier}`,
              )
              : undefined)
            : undefined;
          const candidates = importedCandidates.filter(n =>
            matchesImportedTarget(n.filePath, importedFile) &&
            (!goPackage || callImportMap.get(n.filePath)?.get(PACKAGE_SCOPE_NAME) === goPackage) &&
            // Go's package-scope binding is only for siblings. Same-file calls must continue to
            // the established `same_file` tier below.
            (!packageScopeTarget || n.filePath !== callerNode.filePath),
          );
          const requiresUniqueTarget = UNIQUE_IMPORT_BINDING_LANGUAGES.has(callerNode.language);
          if (candidates.length > 0 && (!requiresUniqueTarget || candidates.length === 1)) {
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
      if (
        !calleeNode &&
        (!raw.calleeObject ||
          (RECOVERED_RECEIVER_LANGUAGES.has(callerNode.language) &&
            (callerNode.language !== 'Kotlin' ||
              !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.calleeObject) ||
              /^[A-Z]/.test(raw.calleeObject)) &&
            !ambiguousInferredBindingsByCaller.get(callerNode.id)?.has(raw.calleeObject)))
      ) {
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
          const sameFileCands = candidates.filter(c => c.filePath === callerNode.filePath);
          // Lexical preference: a call to a same-named function resolves to the twin
          // NESTED within the caller's own span (byte-contained), not merely the first
          // same-file homonym. Two same-named nested functions are now distinct nodes
          // (change: add-stable-nested-function-identity); without this a nested call
          // would bind to whichever twin sorts first and misroute into a sibling scope
          // (e.g. processB()'s validate() resolving to processA's). Among contained
          // candidates prefer the NARROWEST (most-local) enclosing definition; the
          // caller itself is excluded so genuine recursion still falls through.
          const nested = sameFileCands
            .filter(c => c !== callerNode && c.startIndex >= callerNode.startIndex && c.endIndex <= callerNode.endIndex)
            .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex));
          // A function nested in the caller shadows the caller's own name, so it wins;
          // otherwise a self-named candidate is a recursive call and binds to the caller
          // itself (a nested `visit(){ … visit() … }` recurses, it does not jump to a
          // sibling scope's `visit`); only then fall back to the first same-file homonym.
          const recursive = sameFileCands.find(c => c === callerNode);
          const sameFile = nested[0] ?? recursive ?? sameFileCands[0];
          if (sameFile) { calleeNode = sameFile; confidence = 'same_file'; }
          else if (candidates.length === 1) {
            // A UNIQUE cross-file candidate still binds at name_only, exactly as before.
            calleeNode = candidates[0]; confidence = 'name_only';
          } else {
            // >1 cross-file candidate and no same-file / import affinity (Strategy 3
            // already ran): binding candidates[0] here was the highest-impact guess —
            // an arbitrary sort-order match carrying the substrate's authority. Refuse
            // it; disclose the ambiguity instead (change: harden-call-resolution-ambiguity).
            recordAmbiguous(raw, 'name_only', candidates); continue;
          }
        }
      }

      // An unresolved `this.`/`super.` call is an intra-object call we could not pin
      // to an indexed method — NOT an external object. Minting `external::this.m`
      // would be meaningless noise and would also mask error-propagation's targeted
      // "unresolved intra-object call" disclosure (which keys off the ABSENCE of an
      // edge). Drop it instead; the call site is still observable from source.
      if (!calleeNode && (raw.calleeObject === 'this' || raw.calleeObject === 'super')) continue;

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
        ...(raw.argCount !== undefined ? { argCount: raw.argCount } : {}),
        ...(raw.argCountLowerBound ? { argCountLowerBound: true } : {}),
      });
    }

    // Pass 2b: HTTP cross-language edges (JS/TS caller → Python handler)
    const httpClientDegradations: HttpExtractionDegradation[] = [...pass1HttpDegradations];
    try {
      const { edges: httpEdges, degradations } = await extractAllHttpEdges(structuralFiles, httpCallFacts);
      httpClientDegradations.push(...degradations);
      // Group once, then look up per edge. Rebuilt per edge this was an O(edges × nodes) scan.
      const httpNodesByFile = new Map<string, FunctionNode[]>();
      if (httpEdges.length > 0) {
        for (const n of allNodes.values()) {
          const list = httpNodesByFile.get(n.filePath);
          if (list) list.push(n); else httpNodesByFile.set(n.filePath, [n]);
        }
      }
      for (const he of httpEdges) {
        // Find callee: the route handler function by name. Prefer the route's own
        // file (FastAPI/NestJS/Express register a route on the handler's file), but
        // fall back to a UNIQUE non-external match elsewhere — Django declares routes
        // in urls.py while the handler lives in views.py, and Express apps often keep
        // a routes file separate from handler modules. A unique name match is
        // unambiguous; a name colliding across files stays unresolved (never guessed).
        const simpleHandler = he.route.handlerName.split('.').pop() ?? he.route.handlerName;
        const handlerCandidates = trie.findBySimpleName(simpleHandler).filter(n => !n.isExternal);
        let calleeNode = handlerCandidates.find(n => n.filePath === he.handlerFile);
        if (!calleeNode && handlerCandidates.length === 1) calleeNode = handlerCandidates[0];
        if (!calleeNode) continue;

        // Find caller: any function in callerFile that encloses the HTTP call's line
        const callerContent = fileContents.get(he.callerFile);
        const callerNode = callerContent
          ? (() => {
              if (he.call.offset !== undefined) {
                return findEnclosingFunction(httpNodesByFile.get(he.callerFile) ?? [], he.call.offset);
              }
              let offset = 0;
              const lines = callerContent.split('\n');
              for (let i = 0; i < he.call.line - 1 && i < lines.length; i++) {
                offset += lines[i].length + 1;
              }
              // Grouped once outside the loop, like every sibling synthesis pass does. Building
              // and scanning the whole node array PER EDGE cost 1.3s on a 250,000-node repository.
              return findEnclosingFunction(httpNodesByFile.get(he.callerFile) ?? [], offset);
            })()
          : undefined;
        if (!callerNode) continue;
        // No self-loop: a handler that calls its OWN endpoint (e.g. SSR fetching
        // its own route) would otherwise resolve caller===callee and inflate that
        // node's fan-in/out (http_endpoint edges, unlike synthesized ones, ARE
        // counted in the structural metrics). Mirrors the route-handler synth guard.
        if (callerNode.id === calleeNode.id) continue;

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
      const iac = buildProjectedIac(structuralFiles);
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
      edges.push(...await synthesizeDynamicDispatchEdges(
        reparsableFiles,
        allNodes,
        resolveHandler,
        this.legacyLatePassesForTesting ? undefined : dynamicDispatchFacts,
      ));
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
    const allFilePaths = structuralFiles.map(f => f.path);
    const NAMED_IMPORT_RE = /^\s*import\s+(?:type\s+)?\{([^{}]+)\}\s+from\s+['"](\.[^'"]+)['"]/gm;
    const DEFAULT_IMPORT_RE = /^\s*import\s+(?:type\s+)?(\w+)\s+from\s+['"](\.[^'"]+)['"]/gm;
    for (const file of structuralFiles) {
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

      // Deterministic order avoids oscillation. Computed ONCE: the loop mutates `label`, never
      // `internalNodes`, so re-sorting per iteration produced an identical array 15 times over —
      // 2.1s of it on a 250,000-node repository.
      const order = [...internalNodes].sort((a, b) => a.id < b.id ? -1 : 1);
      for (let iter = 0; iter < 15; iter++) {
        let changed = false;
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
      const cyclomaticComplexity = computeCyclomaticComplexity(
        content.slice(node.startIndex, node.endIndex),
        node.language,
      );
      if (cyclomaticComplexity !== undefined) node.cyclomaticComplexity = cyclomaticComplexity;
    }

    // Pass 7: Build class hierarchy (inheritance + grouping). `relationships` was
    // computed once before the Pass 2 resolution loop (reused here).
    // Base-class resolution needs the per-file import map so a child's explicit import
    // outranks a same-named class in its own directory (precision: avoid wiring a false
    // base). Reuse the re-export-aware map derived for Pass 2 so a base class imported
    // through a barrel resolves to its true definition too (change: add-call-resolution-recall).
    const { classes, inheritanceEdges } = buildClassNodes(
      allNodes,
      relationships,
      callImportMap,
      resolutionClasses,
      resolutionNodes,
    );
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
          offset: raw.offset,
        });
      }
      const hierarchyNodes = new Map((resolutionNodes ?? []).map(node => [node.id, node]));
      for (const [id, node] of allNodes) hierarchyNodes.set(id, node);
      edges.push(...synthesizeTypeHierarchyEdges({
        nodes: hierarchyNodes,
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
      // Spilled overlays are on disk, not here — the caller drains them into `cfg_overlay`.
      cfgs: cfgSpill ? undefined : allCfgs,
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
      styleByFile: styleByFile.size > 0 ? styleByFile : undefined,
      parseHealthByFile: parseHealthByFile.size > 0 ? parseHealthByFile : undefined,
      httpClientDegradations: httpClientDegradations.length > 0 ? httpClientDegradations : undefined,
      grammarUnavailable: grammarUnavailableByLanguage.size > 0
        ? [...grammarUnavailableByLanguage.values()].sort((a, b) => a.language < b.language ? -1 : a.language > b.language ? 1 : 0)
        : undefined,
      ambiguousSites: ambiguousSites.length > 0 ? ambiguousSites : undefined,
      extractionLane,
      pass1Cache,
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

/**
 * Dispatch ONE file to its per-language extractor (Pass-1 only — nodes/edges/cfg/style/parseHealth,
 * no cross-file resolution). The single source of truth for the language→extractor mapping, shared
 * by the full build, the watcher's per-file refreshers, AND the extraction-pool worker
 * (change: optimize-parallel-extraction-pool) so the dispatch is never duplicated and the pooled
 * lane cannot drift from the serial one. Returns `undefined` for a language with no extractor.
 */
export async function dispatchFileExtract(
  file: { path: string; content: string; language: string },
): Promise<FileExtractResult | undefined> {
  const container = (SCRIPT_CONTAINER_FORMATS as readonly string[]).includes(file.language)
    ? extractScriptContainer(file.path, file.content)
    : null;
  if (container) {
    const results = await Promise.all(container.lanes.map(lane =>
      extractTSGraph(file.path, lane.content, lane.language),
    ));
    return mergeScriptContainerResults(file.path, results);
  }
  if (file.language === 'Python') return extractPyGraph(file.path, file.content);
  if (file.language === 'TypeScript' || file.language === 'JavaScript') return extractTSGraph(file.path, file.content);
  if (file.language === 'Go') return extractGoGraph(file.path, file.content);
  if (file.language === 'Rust') return extractRustGraph(file.path, file.content);
  if (file.language === 'Ruby') return extractRubyGraph(file.path, file.content);
  if (file.language === 'Java') return extractJavaGraph(file.path, file.content);
  if (file.language === 'C++') return extractCppGraph(file.path, file.content);
  if (file.language === 'Swift') return extractSwiftGraph(file.path, file.content);
  if (file.language === 'Elixir') return extractElixirGraph(file.path, file.content);
  if (file.language === 'Dart') return extractDartGraph(file.path, file.content);
  // spec-08 additional languages (C#, Kotlin, PHP, C, Scala, Lua, Bash).
  if (QUERY_LANG_SPECS[file.language]) return extractByQueries(QUERY_LANG_SPECS[file.language], file.path, file.content);
  return undefined;
}

/**
 * Tally ONE file's style fingerprint in isolation (change: add-codebase-style-fingerprint).
 * Reuses the same per-language extractor (and its single parse) the full build uses, returning
 * only the style counters. Used by the watcher to refresh a changed file's fingerprint without a
 * whole-graph rebuild. Fail-soft: an unsupported language or parse failure returns `undefined`.
 */
export async function extractFileStyle(
  file: { path: string; content: string; language: string },
): Promise<FileStyleRaw | undefined> {
  try {
    const container = extractScriptContainer(file.path, file.content);
    if (container) {
      const result = await dispatchFileExtract(file);
      if (result?.style) result.style.language = file.language;
      return result?.style;
    }
    let result: { style?: FileStyleRaw } | undefined;
    if (file.language === 'Python') result = await extractPyGraph(file.path, file.content);
    else if (file.language === 'TypeScript' || file.language === 'JavaScript') result = await extractTSGraph(file.path, file.content);
    else if (file.language === 'Go') result = await extractGoGraph(file.path, file.content);
    else return undefined;
    if (result?.style) result.style.language = file.language;
    return result?.style;
  } catch {
    return undefined;
  }
}

function mergeScriptContainerResults(
  filePath: string,
  results: FileExtractResult[],
): FileExtractResult {
  const merged: FileExtractResult = { nodes: [], rawEdges: [], cfg: new Map() };
  const styles = results.flatMap(result => result.style ? [result.style] : []);
  const health = results.flatMap(result => result.parseHealth ? [result.parseHealth] : []);

  for (const result of results) {
    merged.nodes.push(...result.nodes);
    merged.rawEdges.push(...result.rawEdges);
    for (const [id, cfg] of result.cfg ?? []) merged.cfg!.set(id, cfg);
    if (result.classRelationships?.length) {
      merged.classRelationships = [...(merged.classRelationships ?? []), ...result.classRelationships];
    }
    if (result.dynamicDispatch) {
      merged.dynamicDispatch ??= { events: [], callbacks: [] };
      merged.dynamicDispatch.events.push(...result.dynamicDispatch.events);
      merged.dynamicDispatch.callbacks.push(...result.dynamicDispatch.callbacks);
    }
    if (result.httpCalls?.length) merged.httpCalls = [...(merged.httpCalls ?? []), ...result.httpCalls];
    if (result.httpDegradations?.length) {
      merged.httpDegradations = [...(merged.httpDegradations ?? []), ...result.httpDegradations];
    }
    const grammarFailures = result.grammarUnavailableAll
      ?? (result.grammarUnavailable ? [result.grammarUnavailable] : []);
    if (grammarFailures.length > 0) {
      merged.grammarUnavailableAll = [...(merged.grammarUnavailableAll ?? []), ...grammarFailures];
    }
  }

  if (merged.grammarUnavailableAll?.length === 1) {
    merged.grammarUnavailable = merged.grammarUnavailableAll[0];
    delete merged.grammarUnavailableAll;
  }

  if (styles.length > 0) {
    const counters: FileStyleRaw['counters'] = {};
    for (const style of styles) {
      for (const [idiom, tally] of Object.entries(style.counters)) {
        const target = (counters as Record<string, Record<string, number>>)[idiom] ??= {};
        for (const [option, count] of Object.entries(tally ?? {})) {
          target[option] = (target[option] ?? 0) + count;
        }
      }
    }
    merged.style = {
      filePath,
      language: styles[0].language,
      counters,
      functionsSampled: styles.reduce((sum, style) => sum + style.functionsSampled, 0),
    };
  }

  if (health.length > 0) {
    const exclusions = health.flatMap(item => item.exclusion ? [item.exclusion] : []);
    const budgets = health.flatMap(item => item.budgetMs === undefined ? [] : [item.budgetMs]);
    merged.parseHealth = {
      filePath,
      language: health[0].language,
      errorCount: health.reduce((sum, item) => sum + item.errorCount, 0),
      missingCount: health.reduce((sum, item) => sum + item.missingCount, 0),
      errorLines: [...new Set(health.flatMap(item => item.errorLines))].sort((a, b) => a - b),
      ...(health.some(item => item.truncated) ? { truncated: true } : {}),
      ...(health.some(item => item.parseFailed) ? { parseFailed: true } : {}),
      ...(health.some(item => item.encodingFallback) ? { encodingFallback: true } : {}),
      ...(exclusions[0] ? { exclusion: exclusions[0] } : {}),
      ...(budgets.length > 0 ? { budgetMs: Math.max(...budgets) } : {}),
    };
  }

  return merged;
}

/**
 * Record ONE file's parse health in isolation (change: add-parse-health-boundary-disclosure). Runs
 * the same per-language dispatch the full build uses (so it covers every callGraph language, not
 * just the style ones) over a single file — Pass 2 resolution over one file is trivial — and returns
 * only its parse-health record, or `undefined` for a clean file. Used by the watcher to keep
 * `parse-health.json` live for a changed file without a whole-graph rebuild. Fail-soft: a parse
 * failure is itself a parse-health signal, surfaced as `parseFailed`.
 */
export async function extractFileParseHealth(
  file: { path: string; content: string; language: string },
): Promise<FileParseHealth | undefined> {
  const result = await dispatchFileExtract(file);
  const h = result?.parseHealth;
  if (h) h.language = file.language;
  return h;
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
    // Unresolved-ambiguous call sites survive into llm-context.json so serve-time
    // consumers (find_dead_code, analyze_error_propagation, analyze_impact) can
    // disclose them (change: harden-call-resolution-ambiguity). Omitted when empty.
    ...(result.ambiguousSites && result.ambiguousSites.length > 0
      ? { ambiguousSites: result.ambiguousSites }
      : {}),
  };
}
