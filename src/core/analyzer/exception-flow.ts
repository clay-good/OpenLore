/**
 * Per-function exception extractor (change: add-error-propagation-graph).
 *
 * Deterministic, LLM-free static extraction of a single function's exception
 * facts — the throw sites it contains, the `try` regions that guard parts of its
 * body, and the call sites within it (each tagged with the guards that enclose
 * it) — for the languages whose throw/catch semantics are cleanly statically
 * extractable: TypeScript, JavaScript, Python, Java, and C#. Go uses the
 * separate value-flow extractor in this module. Every other language fails soft
 * (an `unsupported` record with no facts), never a guess.
 *
 * This is the substrate under the `analyze_error_propagation` conclusion tool.
 * The CFG overlay (`cfg.ts`) already models try/catch/finally/throw as control
 * flow; this module adds the *exception semantics* the CFG omits — which type is
 * thrown, which a handler catches, and whether a throw escapes its function —
 * reusing the same per-language throw/try node-type knowledge rather than a new
 * grammar.
 *
 * Containment is resolved by BYTE RANGE, not line number: a throw/call "inside" a
 * `try` body means its node lies within the body's byte span, so a throw in a
 * catch body (or after a one-line nested try sharing the same physical line) is
 * never mis-attributed as guarded. Handling walks ALL enclosing guards outward
 * (an inner typed/finally guard that does not match does not shadow an outer
 * catch-all). It deliberately does NOT descend into nested closures/functions
 * (consistent with the CFG overlay): a throw inside a nested function is
 * attributed to that nested function. Computed live (no persisted artifact).
 */

import type Parser from 'tree-sitter';
import { usesTsxGrammar } from './language-detection.js';
import { parseWithBudget, type BudgetableParser } from './parse-budget.js';

/** The languages whose exception flow is statically extractable here. This is the
 *  single authoritative source the language-support registry derives the
 *  `errorPropagation` capability from, so the matrix cannot over-claim. */
export const ERROR_PROPAGATION_LANGUAGES: ReadonlySet<string> = new Set([
  'TypeScript',
  'JavaScript',
  'Python',
  'Go',
  'Java',
  'C#',
]);

/** A thrown value whose static type cannot be known (a bare re-raise, `throw e`,
 *  `throw someValue`, a thrown call result). Surfaced, never dropped. */
export const DYNAMIC_TYPE = '<dynamic>';

/** One `try` region's guard: the body it covers and what its handler catches. */
export interface TryGuard {
  /** 1-based line span of the guarded `try` body (NOT the catch/finally). */
  fromLine: number;
  toLine: number;
  /** Byte span of the guarded `try` body — the authoritative containment range. */
  fromIndex: number;
  toIndex: number;
  /** True when the handler catches everything (every TS/JS `catch`; Python bare
   *  `except` / `except Exception` / `except BaseException`). */
  catchAll: boolean;
  /** Exact exception type names a typed Python `except` matches (empty for a
   *  catch-all). Matching is by exact name only — no subclass hierarchy. */
  caughtTypes: string[];
  /** True when the handler re-throws/re-raises — it does not swallow. */
  rethrows: boolean;
  /** Per-clause semantics. Aggregate fields above remain for compatibility. */
  handlers?: CatchHandler[];
  /** A definitely abrupt finally block suppresses completion of the try body. */
  suppresses?: boolean;
}

export interface CatchHandler {
  catchAll: boolean;
  caughtTypes: string[];
  rethrows: boolean;
  /** C# `when` filters are runtime predicates and cannot prove handling. */
  filtered?: boolean;
}

/** One direct `throw`/`raise` site in a function body. */
export interface ThrowSite {
  /** The constructed exception type, or {@link DYNAMIC_TYPE}. */
  type: string;
  /** 1-based line of the throw/raise statement. */
  line: number;
  /** Byte offset of the throw/raise statement (for containment). */
  index: number;
  /** True when an enclosing `try` in the SAME function catches it (so it does not
   *  escape this function). */
  locallyHandled: boolean;
  /** Java checked-exception contract declarations are escape sources, not throws. */
  source?: 'throw' | 'throws_clause';
}

/** How a call's callee is addressed.
 *  - `self`  : an intra-object call — TS/JS `this.x()` / `super.x()`, Python
 *              `self.x()` / `cls.x()`. The callee is provably an in-project
 *              method, so a MISSING call-graph edge for it is a true unresolved
 *              in-project callee (not an external), to be disclosed — never
 *              silently assumed exception-free.
 *  - `other` : a member call on some other receiver (`obj.x()`) — resolves to an
 *              internal edge or an `external::obj.x` edge (already disclosable).
 *  - `none`  : a bare call (`x()`) — resolves to an internal or external edge. */
export type CallReceiver = 'self' | 'other' | 'none' | 'constructor';

/** One call site within a function body, tagged with the guards that enclose it. */
export interface CallSite {
  /** The callee name as it appears in source (for joining to a call-graph edge). */
  calleeName: string;
  /** 1-based line of the call. */
  line: number;
  /** How the callee is addressed — see {@link CallReceiver}. Used to disclose an
   *  intra-object (`this.`/`self.`) call site that the call graph failed to
   *  resolve, the one call shape that otherwise gets NEITHER a resolved nor an
   *  external edge and so would be silently assumed exception-free. */
  receiver: CallReceiver;
  /** The `try` guards that enclose this call, innermost first. An exception
   *  propagating from the callee is caught here iff one of these guards catches
   *  its type. */
  guards: TryGuard[];
}

/** A function's static exception facts. */
export interface FunctionExceptionFacts {
  language: string;
  /** False outside the exception-shaped subset (and for Go, whose facts come
   *  from {@link extractGoErrorFacts}): no facts, not a claim of error-freedom. */
  supported: boolean;
  throwSites: ThrowSite[];
  tryGuards: TryGuard[];
  callSites: CallSite[];
  /** Count of throw sites whose type is {@link DYNAMIC_TYPE} (re-raises / rethrows
   *  / thrown values) — a disclosed honesty signal, not an error. */
  dynamicThrowCount: number;
  /** Semantics intentionally left unmodeled rather than silently cleared. */
  boundaries: string[];
}

export interface GoErrorSite {
  value: string;
  kind: 'returned_error' | 'panic';
  line: number;
  index: number;
  calleeName?: string;
  callLine?: number;
  callResultIndex?: number;
  /** Internal lexical identity used to avoid conflating shadowed names. */
  bindingId?: number;
}

export interface GoHandledSite {
  value: string;
  kind: 'checked_error' | 'recovered_panic';
  line: number;
  fromCallee?: string;
  callLine?: number;
  callResultIndex?: number;
  index?: number;
  /** Internal lexical identity used to avoid conflating shadowed names. */
  bindingId?: number;
}

export interface GoCallSite {
  calleeName: string;
  line: number;
  index: number;
}

export interface GoDiscardedResult {
  calleeName: string;
  line: number;
  index: number;
  resultIndex: number;
}

/**
 * A Go block's own statements, descending through the `statement_list` wrapper that
 * tree-sitter-go 0.25 inserts between `block` and its statements.
 *
 * Only that grammar-only node is flattened, so "at the top level of the function body"
 * keeps its meaning: a `defer` nested inside an `if` still does not count as
 * unconditional, which is what the proven-recovery analysis below depends on.
 */
function goBlockStatements(block: Node | null | undefined): Node[] {
  if (!block) return [];
  return block.namedChildren.flatMap(c => (c.type === 'statement_list' ? c.namedChildren : [c]));
}

/** Go uses returned values and panic/recover, deliberately separate from exception facts. */
export interface GoErrorFacts {
  language: 'Go';
  supported: boolean;
  returnsError: boolean;
  escapes: GoErrorSite[];
  handledInternally: GoHandledSite[];
  checkedCandidates: GoHandledSite[];
  discardedResults: GoDiscardedResult[];
  callSites: GoCallSite[];
  recoversPanics: boolean;
  recoveryDeferIndex?: number;
  errorResultIndices: number[];
  boundaries: string[];
}

// ── Per-language node-type knowledge (mirrors cfg.ts's SPECS, scoped) ────────

interface LangSpec {
  throwTypes: Set<string>;
  tryTypes: Set<string>;
  nestedFnTypes: Set<string>;
  bodyField: string;
  catchClauseTypes: Set<string>;
  blockTypes: Set<string>;
  callTypes: Set<string>;
  /** Field on a call node holding the callee expression. */
  callNameField: string;
}

const JAVA_LANG: LangSpec = {
  throwTypes: new Set(['throw_statement']),
  tryTypes: new Set(['try_statement', 'try_with_resources_statement']),
  nestedFnTypes: new Set(['lambda_expression', 'method_declaration', 'constructor_declaration']),
  bodyField: 'body', catchClauseTypes: new Set(['catch_clause']), blockTypes: new Set(['block']),
  callTypes: new Set(['method_invocation', 'object_creation_expression']), callNameField: 'name',
};

const CSHARP_LANG: LangSpec = {
  throwTypes: new Set(['throw_statement']), tryTypes: new Set(['try_statement']),
  nestedFnTypes: new Set(['lambda_expression', 'anonymous_method_expression', 'local_function_statement', 'method_declaration', 'constructor_declaration']),
  bodyField: 'body', catchClauseTypes: new Set(['catch_clause']), blockTypes: new Set(['block']),
  callTypes: new Set(['invocation_expression', 'object_creation_expression']), callNameField: 'function',
};

const TS_LANG: LangSpec = {
  throwTypes: new Set(['throw_statement']),
  tryTypes: new Set(['try_statement']),
  nestedFnTypes: new Set([
    'arrow_function',
    'function_expression',
    'function_declaration',
    'generator_function',
    'generator_function_declaration',
    'method_definition',
  ]),
  bodyField: 'body',
  catchClauseTypes: new Set(['catch_clause']),
  blockTypes: new Set(['statement_block']),
  callTypes: new Set(['call_expression', 'new_expression']),
  callNameField: 'function',
};

const PY_LANG: LangSpec = {
  throwTypes: new Set(['raise_statement']),
  tryTypes: new Set(['try_statement']),
  nestedFnTypes: new Set(['lambda', 'function_definition']),
  bodyField: 'body',
  catchClauseTypes: new Set(['except_clause', 'except_group_clause']),
  blockTypes: new Set(['block']),
  callTypes: new Set(['call']),
  callNameField: 'function',
};

function specFor(language: string): LangSpec | null {
  switch (language) {
    case 'TypeScript':
    case 'JavaScript':
      return TS_LANG;
    case 'Python':
      return PY_LANG;
    case 'Java':
      return JAVA_LANG;
    case 'C#':
      return CSHARP_LANG;
    default:
      return null;
  }
}

// ── Lazy tree-sitter parsers (scoped to the supported languages) ─────────────

let _tsParser: Parser | undefined;
let _tsxParser: Parser | undefined;
let _pyParser: Parser | undefined;
let _goParser: Parser | undefined;
let _javaParser: Parser | undefined;
let _csharpParser: Parser | undefined;
let _NativeParser: typeof Parser | null | undefined;

async function loadNativeParser(): Promise<typeof Parser | null> {
  if (_NativeParser === undefined) {
    try {
      _NativeParser = (await import('tree-sitter')).default as typeof Parser;
    } catch {
      _NativeParser = null;
    }
  }
  return _NativeParser;
}

/** A tree-sitter parser for a supported language, or null if unavailable.
 *  `filePath` is optional and only used to select the JSX grammar. */
export async function getExceptionParser(
  language: string,
  filePath?: string
): Promise<Parser | null> {
  try {
    const NP = await loadNativeParser();
    if (!NP) return null;
    switch (language) {
      case 'TypeScript':
      case 'JavaScript': {
        if (usesTsxGrammar(filePath)) {
          if (!_tsxParser) {
            const m = await import('tree-sitter-typescript');
            _tsxParser = new NP();
            _tsxParser.setLanguage(
              ((m.default ?? m) as { tsx: object }).tsx as Parser.Language,
            );
          }
          return _tsxParser!;
        }
        if (!_tsParser) {
          const m = await import('tree-sitter-typescript');
          _tsParser = new NP();
          _tsParser.setLanguage(
            ((m.default ?? m) as { typescript: object }).typescript as Parser.Language,
          );
        }
        return _tsParser!;
      }
      case 'Python': {
        if (!_pyParser) {
          const m = await import('tree-sitter-python');
          _pyParser = new NP();
          _pyParser.setLanguage((m.default ?? m) as Parser.Language);
        }
        return _pyParser!;
      }
      case 'Go': {
        if (!_goParser) { const m = await import('tree-sitter-go'); _goParser = new NP(); _goParser.setLanguage((m.default ?? m) as Parser.Language); }
        return _goParser;
      }
      case 'Java': {
        if (!_javaParser) { const m = await import('tree-sitter-java'); _javaParser = new NP(); _javaParser.setLanguage((m.default ?? m) as Parser.Language); }
        return _javaParser;
      }
      case 'C#': {
        if (!_csharpParser) { const m = await import('tree-sitter-c-sharp'); _csharpParser = new NP(); _csharpParser.setLanguage((m.default ?? m) as Parser.Language); }
        return _csharpParser;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ── Type-name helpers ────────────────────────────────────────────────────────

type Node = Parser.SyntaxNode;

/** Resolve a cached function span against a freshly parsed tree. Edits can make
 * byte ranges stale; callers must use the current node range rather than letting
 * a stale range widen extraction to the file root or a sibling function. */
export function resolveCurrentFunctionSpan(
  root: Node,
  startIndex: number,
  endIndex: number,
  language: string,
  expectedName: string,
): { startIndex: number; endIndex: number } | null {
  const functionTypes = language === 'Go'
    ? new Set(['function_declaration', 'method_declaration'])
    : specFor(language)?.nestedFnTypes;
  if (!functionTypes) return null;
  const index = rootAstIndex(root);
  if (!index) return null;
  const allFunctions = [...functionTypes].flatMap(type => index.nodesByType.get(type) ?? []);
  const overlapping = allFunctions.filter(node => node.startIndex < endIndex && startIndex < node.endIndex);
  const candidates = overlapping.filter(node => currentFunctionName(node) === expectedName);
  if (candidates.length !== 1) return null;
  const selected = candidates[0];
  const crossesSibling = overlapping.some(node => node !== selected &&
    !(selected.startIndex <= node.startIndex && node.endIndex <= selected.endIndex) &&
    !(node.startIndex <= selected.startIndex && selected.endIndex <= node.endIndex));
  if (crossesSibling) return null;
  return { startIndex: selected.startIndex, endIndex: selected.endIndex };
}

const MAX_TRAVERSAL_DEPTH = 512;
const MAX_TRAVERSAL_NODES = 250_000;

interface RootAstIndex { nodesByType: Map<string, Node[]>; customGoErrorTypes: Set<string> }
const rootAstIndexes = new WeakMap<object, RootAstIndex | null>();

function rootAstIndex(root: Node): RootAstIndex | null {
  const cached = rootAstIndexes.get(root as object);
  if (cached !== undefined) return cached;
  const nodesByType = new Map<string, Node[]>();
  const customGoErrorTypes = new Set<string>();
  const stack: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_TRAVERSAL_DEPTH || ++visited > MAX_TRAVERSAL_NODES) {
      rootAstIndexes.set(root as object, null);
      return null;
    }
    const sameType = nodesByType.get(node.type);
    if (sameType) sameType.push(node); else nodesByType.set(node.type, [node]);
    if (node.type === 'type_spec') {
      const name = node.childForFieldName('name')?.text;
      const type = node.childForFieldName('type') ?? node.namedChildren.at(-1);
      if (name && (type?.text === 'error' || /\bError\s*\(\s*\)/.test(type?.text ?? ''))) customGoErrorTypes.add(name);
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push({ node: node.namedChildren[i], depth: depth + 1 });
  }
  const index = { nodesByType, customGoErrorTypes };
  rootAstIndexes.set(root as object, index);
  return index;
}

function currentFunctionName(node: Node): string | undefined {
  const ownName = node.childForFieldName('name')?.text;
  if (ownName) return ownName;
  const parent = node.parent;
  if (!parent) return undefined;
  const parentName = parent.childForFieldName('name')?.text;
  if (parentName) return parentName;
  if (parent.type === 'assignment_expression') {
    return parent.childForFieldName('left')?.text.replace(/\s+/g, '');
  }
  return undefined;
}

/** Whether the per-tree identity/custom-type index could be built within bounds. */
export function rootAstIndexWithinBudget(root: Node): boolean {
  return rootAstIndex(root) !== null;
}

function astTraversalWithinBudget(root: Node): boolean {
  const stack: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_TRAVERSAL_DEPTH || ++visited > MAX_TRAVERSAL_NODES) return false;
    for (let i = node.namedChildren.length - 1; i >= 0; i--) {
      stack.push({ node: node.namedChildren[i], depth: depth + 1 });
    }
  }
  return true;
}

const PY_CLASS_NAME_RE = /^[A-Z][A-Za-z0-9_]*$/;
const PY_CATCH_ALL = new Set(['Exception', 'BaseException']);

/** Last identifier of a (possibly qualified) name node: `errors.MyError` → `MyError`. */
function nameOf(node: Node | null): string {
  if (!node) return DYNAMIC_TYPE;
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'property_identifier':
      return node.text;
    case 'member_expression': {
      const prop = node.childForFieldName('property');
      return prop ? nameOf(prop) : DYNAMIC_TYPE;
    }
    case 'attribute': {
      const attr = node.childForFieldName('attribute');
      return attr ? nameOf(attr) : DYNAMIC_TYPE;
    }
    case 'scoped_type_identifier':
    case 'qualified_name':
    case 'member_access_expression':
    case 'selector_expression': {
      const part = node.childForFieldName('name') ?? node.childForFieldName('field') ?? node.namedChildren.at(-1);
      return part ? nameOf(part) : DYNAMIC_TYPE;
    }
    default:
      return DYNAMIC_TYPE;
  }
}

/** Peel TS expression wrappers that surround a constructed exception so
 *  `throw (new E())`, `throw new E() as Error`, `throw <Error>new E()`, and
 *  `throw new E()!` still resolve to `E` rather than `<dynamic>`. */
function unwrapTsExpr(node: Node | null): Node | null {
  let cur = node;
  // Bounded peel — these wrappers never nest deeply in practice.
  for (let i = 0; cur && i < 8; i++) {
    switch (cur.type) {
      case 'parenthesized_expression':
        cur = cur.namedChildren[0] ?? null;
        break;
      case 'as_expression':
      case 'satisfies_expression':
        // `expr as Type` — the value is the first child, the type the second.
        cur = cur.namedChildren[0] ?? null;
        break;
      case 'non_null_expression':
        cur = cur.namedChildren[0] ?? null;
        break;
      case 'type_assertion':
        // `<Type>expr` — the value is the last child.
        cur = cur.namedChildren[cur.namedChildren.length - 1] ?? null;
        break;
      default:
        return cur;
    }
  }
  return cur;
}

/** The thrown type of a TS/JS `throw_statement`. */
function tsThrowType(stmt: Node): string {
  const expr = unwrapTsExpr(stmt.namedChildren[0] ?? null);
  if (!expr) return DYNAMIC_TYPE;
  if (expr.type === 'new_expression') {
    const ctor = expr.childForFieldName('constructor') ?? expr.namedChildren[0];
    return nameOf(ctor ?? null);
  }
  // throw e / throw {…} / throw fn() / throw a ? new A() : new B() — not statically knowable.
  return DYNAMIC_TYPE;
}

/** The raised type of a Python `raise_statement`. */
function pyRaiseType(stmt: Node): string {
  const expr = stmt.namedChildren[0];
  if (!expr) return DYNAMIC_TYPE; // bare `raise` — re-raise
  if (expr.type === 'call') {
    const fn = expr.childForFieldName('function') ?? expr.namedChildren[0];
    return nameOf(fn ?? null);
  }
  if (expr.type === 'identifier') {
    // `raise ValueError` (class) vs `raise e` (instance). Static heuristic: an
    // exception CLASS is CapWords by convention; anything else is a value. This is
    // a documented heuristic — a CapWords *parameter* is a rare false positive.
    return PY_CLASS_NAME_RE.test(expr.text) ? expr.text : DYNAMIC_TYPE;
  }
  if (expr.type === 'attribute') return nameOf(expr);
  return DYNAMIC_TYPE;
}

function objectThrowType(stmt: Node): string {
  const expr = stmt.namedChildren[0];
  if (!expr || expr.type !== 'object_creation_expression') return DYNAMIC_TYPE;
  return nameOf(expr.childForFieldName('type') ?? expr.namedChildren[0] ?? null);
}

/** Collect the exact type names a Python `except` type-expression names. */
function pyCatchNames(typeExpr: Node | null): string[] {
  if (!typeExpr) return [];
  if (typeExpr.type === 'tuple' || typeExpr.type === 'parenthesized_expression') {
    return typeExpr.namedChildren.flatMap(c => pyCatchNames(c));
  }
  if (typeExpr.type === 'identifier' || typeExpr.type === 'attribute') {
    const n = nameOf(typeExpr);
    return n === DYNAMIC_TYPE ? [] : [n];
  }
  return [];
}

/** The type-expression node of a Python `except` clause (unwrapping `… as e`), or
 *  null for a bare `except:`. */
function pyExceptTypeExpr(clause: Node, spec: LangSpec): Node | null {
  for (const child of clause.namedChildren) {
    if (spec.blockTypes.has(child.type)) break; // reached the body
    if (child.type === 'as_pattern') return child.namedChildren[0] ?? null;
    if (child.type === 'comment') continue;
    return child;
  }
  return null;
}

/** The callee name of a call node, as it appears in source (for edge joining). */
function calleeNameOf(callNode: Node, spec: LangSpec): string {
  const fn =
    callNode.childForFieldName('constructor') ??
    callNode.childForFieldName(spec.callNameField) ??
    callNode.namedChildren[0] ??
    null;
  if (!fn) return '';
  if (fn.type === 'identifier' || fn.type === 'property_identifier' || fn.type === 'type_identifier') {
    return fn.text;
  }
  const n = nameOf(fn);
  return n === DYNAMIC_TYPE ? '' : n;
}

/** Python receiver identifiers that denote the enclosing object/class. */
const PY_SELF_RECEIVERS = new Set(['self', 'cls']);

/** How the callee of a call node is addressed (see {@link CallReceiver}). A
 *  `this.x()` / `super.x()` (TS/JS) or `self.x()` / `cls.x()` (Python) call is
 *  `self` — an intra-object call whose callee is provably in-project. */
function receiverKindOf(callNode: Node, spec: LangSpec, language: string): CallReceiver {
  if ((language === 'Java' || language === 'C#') && callNode.type === 'object_creation_expression') return 'constructor';
  if (language === 'Java' && callNode.type === 'method_invocation') {
    const obj = callNode.childForFieldName('object');
    if (!obj) return 'none';
    return obj.type === 'this' || obj.type === 'super' ? 'self' : 'other';
  }
  const fn =
    callNode.childForFieldName('constructor') ??
    callNode.childForFieldName(spec.callNameField) ??
    callNode.namedChildren[0] ??
    null;
  if (!fn) return 'none';
  // Member access: `<object>.<prop>`. TS member_expression / Python attribute.
  if (fn.type === 'member_expression' || fn.type === 'attribute' || fn.type === 'member_access_expression') {
    const obj = fn.childForFieldName('object') ?? fn.childForFieldName('expression') ?? fn.namedChildren[0] ?? null;
    if (!obj) return 'other';
    if (obj.type === 'this' || obj.type === 'super') return 'self';
    if ((language === 'C#' || language === 'Java') && (obj.type === 'this_expression' || obj.type === 'base_expression')) return 'self';
    if (obj.type === 'identifier' && PY_SELF_RECEIVERS.has(obj.text)) return 'self';
    return 'other';
  }
  return 'none';
}

// ── Body scan helpers ────────────────────────────────────────────────────────

function blockBody(node: Node, spec: LangSpec): Node | null {
  return (
    node.childForFieldName(spec.bodyField) ??
    node.namedChildren.find(c => spec.blockTypes.has(c.type)) ??
    null
  );
}

/** Does the handler body re-throw/re-raise directly (not inside a nested fn)? */
function bodyRethrows(body: Node | null, spec: LangSpec, language: string, caughtBinding?: string): boolean {
  if (!body) return false;
  let found = false;
  const visit = (node: Node): void => {
    if (found) return;
    if (spec.nestedFnTypes.has(node.type)) return; // a throw in a nested fn is not this handler's
    if (spec.throwTypes.has(node.type)) {
      const thrown = node.namedChildren[0];
      found = (language === 'Python' || language === 'C#') && !thrown
        ? true
        : !!caughtBinding && thrown?.type === 'identifier' && thrown.text === caughtBinding;
      return;
    }
    for (const c of node.namedChildren) visit(c);
  };
  for (const c of body.namedChildren) visit(c);
  return found;
}

function caughtBindingOf(clause: Node, language: string): string | undefined {
  if (language === 'Python') {
    const asPattern = clause.namedChildren.find(c => c.type === 'as_pattern');
    return asPattern?.childForFieldName('alias')?.text ?? asPattern?.namedChildren.at(-1)?.text;
  }
  const decl = clause.namedChildren.find(c => c.type === 'catch_formal_parameter' || c.type === 'catch_declaration');
  return decl?.childForFieldName('name')?.text
    ?? [...(decl?.namedChildren ?? [])].reverse().find((c: Node) => c.type === 'identifier')?.text
    ?? clause.childForFieldName('parameter')?.text;
}

function finallyDefinitelySuppresses(tryStmt: Node, spec: LangSpec): boolean {
  const clause = tryStmt.namedChildren.find(c => c.type === 'finally_clause');
  const body = clause ? blockBody(clause, spec) : null;
  if (!body) return false;
  return body.namedChildren.some(c => spec.throwTypes.has(c.type) || c.type === 'return_statement');
}

/** The guard a `try` region provides. */
function tryGuardOf(tryStmt: Node, language: string, spec: LangSpec): TryGuard {
  const body = blockBody(tryStmt, spec);
  const span = body ?? tryStmt;
  const fromLine = span.startPosition.row + 1;
  const toLine = span.endPosition.row + 1;

  let catchAll = false;
  const caughtTypes: string[] = [];
  let rethrows = false;
  const handlers: CatchHandler[] = [];

  for (const clause of tryStmt.namedChildren) {
    if (!spec.catchClauseTypes.has(clause.type)) continue;
    const handlerBody = blockBody(clause, spec);
    const clauseRethrows = bodyRethrows(handlerBody, spec, language, caughtBindingOf(clause, language));
    if (clauseRethrows) rethrows = true;

    if (language === 'Python') {
      const typeExpr = pyExceptTypeExpr(clause, spec);
      if (!typeExpr) {
        catchAll = true; // bare `except:`
      } else {
        const names = pyCatchNames(typeExpr);
        if (names.length === 0 || names.some(n => PY_CATCH_ALL.has(n))) catchAll = true;
        for (const n of names) if (!PY_CATCH_ALL.has(n)) caughtTypes.push(n);
      }
      handlers.push({ catchAll: !typeExpr || namesForHandler(typeExpr).some(n => PY_CATCH_ALL.has(n)), caughtTypes: namesForHandler(typeExpr).filter(n => !PY_CATCH_ALL.has(n)), rethrows: clauseRethrows });
    } else if (language === 'Java' || language === 'C#') {
      const decl = clause.namedChildren.find(c => c.type === 'catch_formal_parameter' || c.type === 'catch_declaration');
      const typeRoot = decl?.namedChildren.find(c => c.type === 'catch_type') ?? decl?.childForFieldName('type') ?? decl?.namedChildren[0] ?? null;
      const names = typeRoot ? collectTypeNames(typeRoot) : [];
      const all = names.length === 0 || (language === 'Java'
        ? names.includes('Throwable')
        : names.includes('Exception'));
      const filtered = language === 'C#' && clause.namedChildren.some(c => c.type === 'catch_filter_clause' || c.type === 'catch_filter');
      if (all) catchAll = true;
      for (const n of names) if (!all || (n !== 'Exception' && n !== 'Throwable')) caughtTypes.push(n);
      handlers.push({ catchAll: all, caughtTypes: all ? names.filter(n => n !== 'Exception' && n !== 'Throwable') : names, rethrows: clauseRethrows, filtered });
    } else {
      // TS/JS `catch` has no type filter — it catches everything.
      catchAll = true;
      handlers.push({ catchAll: true, caughtTypes: [], rethrows: clauseRethrows });
    }
  }

  return {
    fromLine,
    toLine,
    fromIndex: span.startIndex,
    toIndex: span.endIndex,
    catchAll,
    caughtTypes: [...new Set(caughtTypes)],
    rethrows,
    handlers,
    suppresses: finallyDefinitelySuppresses(tryStmt, spec) || undefined,
  };
}

function namesForHandler(typeExpr: Node | null): string[] { return typeExpr ? pyCatchNames(typeExpr) : []; }

function collectTypeNames(node: Node): string[] {
  if (['identifier', 'type_identifier'].includes(node.type)) return [node.text];
  const nested = node.namedChildren.flatMap(collectTypeNames);
  return [...new Set(nested)];
}

/**
 * Extract a single function's exception facts from a parsed tree, scoped to the
 * byte range `[startIndex, endIndex)`. The range identifies the function; throws,
 * tries, and calls inside nested closures within it are excluded (attributed to
 * those closures). Deterministic.
 */
export function extractExceptionFacts(
  root: Node,
  startIndex: number,
  endIndex: number,
  language: string,
): FunctionExceptionFacts {
  const spec = specFor(language);
  if (!spec) {
    return {
      language,
      supported: false,
      throwSites: [],
      tryGuards: [],
      callSites: [],
      dynamicThrowCount: 0,
      boundaries: [],
    };
  }

  // Smallest node covering the function's span — the function (or a tight wrapper
  // like a lexical_declaration / export_statement / decorated_definition).
  let fnNode: Node = root;
  for (;;) {
    const child = fnNode.namedChildren.find(
      c => c.startIndex <= startIndex && c.endIndex >= endIndex,
    );
    if (!child || child === fnNode) break;
    fnNode = child;
  }
  if (!astTraversalWithinBudget(fnNode)) {
    return {
      language,
      supported: true,
      throwSites: [],
      tryGuards: [],
      callSites: [],
      dynamicThrowCount: 0,
      boundaries: ['AST traversal budget exceeded; exception facts were not extracted'],
    };
  }

  const throwSites: ThrowSite[] = [];
  const tryGuards: TryGuard[] = [];
  const rawCallSites: Array<{ calleeName: string; line: number; index: number; receiver: CallReceiver }> = [];
  const boundaries = new Set<string>();

  // Walk the function subtree counting function-type nodes along each path: the
  // FIRST is the function we are analyzing; a deeper one is a nested closure and
  // is pruned. Record throws/tries/calls only inside the primary function body.
  const walk = (node: Node, fnDepth: number): void => {
    const depth = fnDepth + (spec.nestedFnTypes.has(node.type) ? 1 : 0);
    if (depth >= 2) return; // inside a nested function — prune
    if (depth === 1) {
      if (spec.throwTypes.has(node.type)) {
        const type = language === 'Python' ? pyRaiseType(node) : (language === 'Java' || language === 'C#') ? objectThrowType(node) : tsThrowType(node);
        throwSites.push({ type, line: node.startPosition.row + 1, index: node.startIndex, locallyHandled: false, source: 'throw' });
      } else if (language === 'Java' && node.type === 'throws') {
        for (const type of collectTypeNames(node)) {
          throwSites.push({ type, line: node.startPosition.row + 1, index: node.startIndex, locallyHandled: false, source: 'throws_clause' });
        }
      } else if (spec.tryTypes.has(node.type)) {
        const guard = tryGuardOf(node, language, spec);
        tryGuards.push(guard);
        if ((language === 'Java' || language === 'C#') && node.namedChildren.some(c => c.type === 'finally_clause')) {
          boundaries.add(guard.suppresses
            ? `${language} definitely abrupt finally suppresses try-body completion at line ${node.startPosition.row + 1}`
            : `${language} finally control transfer/effects are not modeled at line ${node.startPosition.row + 1}`);
        }
        if (language === 'Java' && node.type === 'try_with_resources_statement') {
          boundaries.add(`Java try-with-resources cleanup exceptions are not modeled at line ${node.startPosition.row + 1}`);
        }
      } else if (spec.callTypes.has(node.type)) {
        const name = calleeNameOf(node, spec);
        if (name)
          rawCallSites.push({
            calleeName: name,
            line: node.startPosition.row + 1,
            index: node.startIndex,
            receiver: receiverKindOf(node, spec, language),
          });
      } else if (
        language === 'C#' &&
        (node.type === 'using_statement' ||
          (node.type === 'local_declaration_statement' && /^\s*(?:await\s+)?using\b/.test(node.text)))
      ) {
        boundaries.add(`C# using/await-using cleanup exceptions are not modeled at line ${node.startPosition.row + 1}`);
      }
    }
    for (const c of node.namedChildren) walk(c, depth);
  };
  walk(fnNode, 0);

  // Resolve local handling by BYTE containment: a throw is locally handled iff
  // SOME enclosing `try` body (smallest-or-larger) catches its type. Walking all
  // enclosing guards (not just the innermost) means an inner typed/finally guard
  // that does not match does not shadow an outer catch-all.
  for (const ts of throwSites) {
    const enclosing = enclosingGuards(tryGuards, ts.index);
    ts.locallyHandled = enclosing.some(g => g.suppresses || guardCatches(g, ts.type));
  }

  const callSites: CallSite[] = rawCallSites.map(c => ({
    calleeName: c.calleeName,
    line: c.line,
    receiver: c.receiver,
    guards: enclosingGuards(tryGuards, c.index),
  }));

  const dynamicThrowCount = throwSites.filter(t => t.type === DYNAMIC_TYPE).length;
  return { language, supported: true, throwSites, tryGuards, callSites, dynamicThrowCount, boundaries: [...boundaries].sort() };
}

/** Convenience: parse `source` as a whole file and extract facts for all of it
 *  (the function under test). Returns an unsupported record if the language is
 *  not supported or the parser is unavailable. */
export async function extractExceptionFactsFromSource(
  source: string,
  language: string,
  filePath?: string,
): Promise<FunctionExceptionFacts> {
  if (!ERROR_PROPAGATION_LANGUAGES.has(language) || language === 'Go') {
    return { language, supported: false, throwSites: [], tryGuards: [], callSites: [], dynamicThrowCount: 0, boundaries: [] };
  }
  const parser = await getExceptionParser(language, filePath);
  if (!parser) {
    return { language, supported: false, throwSites: [], tryGuards: [], callSites: [], dynamicThrowCount: 0, boundaries: [] };
  }
  // Bounded like every other parse (change: fix-analyze-native-abort-and-file-cost-budget). This
  // runs at TOOL time inside the long-lived daemon, where an unbounded parse of one hostile file
  // would wedge the whole server, not just one build. On the budget it throws, and the caller
  // records the file as an analysis boundary rather than as "no exceptions here".
  const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, source);
  if (tree.rootNode.hasError) {
    return {
      language, supported: true, throwSites: [], tryGuards: [], callSites: [], dynamicThrowCount: 0,
      boundaries: ['source contains syntax errors; exception facts were not extracted'],
    };
  }
  return extractExceptionFacts(tree.rootNode, 0, source.length, language);
}

/** Extract a conservative, value-shaped lower bound for one Go function. */
export function extractGoErrorFacts(
  root: Node,
  startIndex: number,
  endIndex: number,
): GoErrorFacts {
  let fnNode: Node = root;
  for (;;) {
    const child = fnNode.namedChildren.find(c => c.startIndex <= startIndex && c.endIndex >= endIndex);
    if (!child || child === fnNode) break;
    fnNode = child;
  }
  if (!astTraversalWithinBudget(fnNode)) {
    return {
      language: 'Go', supported: true, returnsError: false, errorResultIndices: [],
      escapes: [], handledInternally: [], checkedCandidates: [], discardedResults: [],
      callSites: [], recoversPanics: false,
      boundaries: ['AST traversal budget exceeded; Go error facts were not extracted'],
    };
  }
  const boundaries = new Set<string>();
  const rootIndex = rootAstIndex(root);
  if (!rootIndex) boundaries.add('AST root index budget exceeded; custom Go error aliases were not resolved');
  const customErrorTypes = rootIndex?.customGoErrorTypes ?? new Set<string>();
  const result = fnNode.childForFieldName('result');
  const errorResultIndices = new Set<number>();
  const namedErrorResults = new Set<string>();
  const classifyResultType = (type: Node | undefined, position: number, count: number): void => {
    if (type?.text === 'error') {
      for (let i = 0; i < count; i++) errorResultIndices.add(position + i);
    } else if (type?.type === 'type_identifier' && (customErrorTypes.has(type.text) || /(?:Err|Error)$/.test(type.text))) {
      boundaries.add(`custom Go result type ${type.text} may implement error but is not resolved`);
    }
  };
  if (result?.type === 'type_identifier') classifyResultType(result, 0, 1);
  else if (result?.type === 'parameter_list') {
    let position = 0;
    for (const declaration of result.namedChildren.filter(c => c.type === 'parameter_declaration')) {
      const type = declaration.childForFieldName('type') ?? declaration.namedChildren.at(-1);
      const names = declaration.namedChildren.filter(c => c !== type && c.type === 'identifier');
      const count = Math.max(1, names.length);
      classifyResultType(type, position, count);
      if (type?.text === 'error') for (const name of names) namedErrorResults.add(name.text);
      position += count;
    }
  }
  const returnsError = errorResultIndices.size > 0;
  const escapes: GoErrorSite[] = [];
  const handledInternally: GoHandledSite[] = [];
  const checkedCandidates: GoHandledSite[] = [];
  const callSites: GoCallSite[] = [];
  const discardedResults: GoDiscardedResult[] = [];
  interface BindingEvent { index: number; calleeName?: string; callLine?: number; resultIndex?: number; nil?: boolean }
  interface Binding { id: number; name: string; scopeStart: number; scopeEnd: number; declaredAt: number; events: BindingEvent[] }
  const bindings = new Map<string, Binding[]>();
  let nextBindingId = 1;
  let recoversPanics = false;
  let recoveryDeferIndex: number | undefined;

  const callName = (call: Node): string => calleeNameOf(call, { ...TS_LANG, callNameField: 'function' });
  const containsEffectiveRecover = (node: Node): boolean => {
    if (node.type === 'call_expression' && callName(node) === 'recover') return true;
    if (node.type === 'if_statement') {
      const initializer = node.childForFieldName('initializer');
      const condition = node.childForFieldName('condition');
      return !!initializer && containsEffectiveRecover(initializer) || !!condition && containsEffectiveRecover(condition);
    }
    if (
      node.type === 'for_statement' || node.type === 'expression_switch_statement' ||
      node.type === 'type_switch_statement' || node.type === 'select_statement' ||
      node.type === 'func_literal' || node.type === 'go_statement' || node.type === 'defer_statement'
    ) return false;
    return node.namedChildren.some(containsEffectiveRecover);
  };
  const containsCallNamed = (node: Node, name: string): boolean =>
    (node.type === 'call_expression' && callName(node) === name) || node.namedChildren.some(c => containsCallNamed(c, name));
  const containsNonRecoverCall = (node: Node): boolean =>
    (node.type === 'call_expression' && callName(node) !== 'recover') || node.namedChildren.some(containsNonRecoverCall);
  const containsIdentifier = (node: Node, name: string): boolean =>
    (node.type === 'identifier' && node.text === name) || node.namedChildren.some(c => containsIdentifier(c, name));
  const subtreeEscapesValue = (node: Node, name: string): boolean => {
    if ((node.type === 'return_statement' || (node.type === 'call_expression' && callName(node) === 'panic')) && containsIdentifier(node, name)) return true;
    return node.namedChildren.some(c => subtreeEscapesValue(c, name));
  };

  const fnBody = fnNode.childForFieldName('body');
  const scopeOf = (node: Node): Node => {
    let current: Node | null = node.parent;
    while (current && current !== fnNode && current.type !== 'block') current = current.parent;
    return current?.type === 'block' ? current : (fnBody ?? fnNode);
  };
  const visibleBinding = (name: string, index: number): Binding | undefined =>
    (bindings.get(name) ?? [])
      .filter(b => b.declaredAt < index && b.scopeStart <= index && index < b.scopeEnd)
      .sort((a, b) => b.scopeStart - a.scopeStart || b.declaredAt - a.declaredAt)[0];
  const createBinding = (name: string, scope: Node, declaredAt: number): Binding => {
    const binding = { id: nextBindingId++, name, scopeStart: scope.startIndex, scopeEnd: scope.endIndex, declaredAt, events: [] };
    bindings.set(name, [...(bindings.get(name) ?? []), binding]);
    return binding;
  };
  for (const name of namedErrorResults) {
    const binding = createBinding(name, fnBody ?? fnNode, fnNode.startIndex - 1);
    binding.events.push({ index: fnNode.startIndex - 1, nil: true });
  }
  const topLevelDefers = goBlockStatements(fnBody).filter(c => c.type === 'defer_statement');
  const deferRecovers = (deferStmt: Node): boolean => {
    const call = deferStmt.namedChildren.find(c => c.type === 'call_expression');
    const fn = call?.childForFieldName('function');
    const body = fn?.type === 'func_literal' ? fn.childForFieldName('body') : null;
    return !!body && containsEffectiveRecover(body);
  };
  const recoveryDefers = topLevelDefers.filter(deferRecovers);
  const provenRecoveryDefer = (deferStmt: Node): boolean => {
    const body = deferStmt.namedChildren.find(c => c.type === 'call_expression')?.childForFieldName('function')?.childForFieldName('body');
    return !!body && deferRecovers(deferStmt) && !containsCallNamed(body, 'panic') && !containsNonRecoverCall(body);
  };
  const allRecoveryDefers: Node[] = [];
  const collectRecoveryDefers = (node: Node): void => {
    if (node.type === 'defer_statement' && deferRecovers(node)) allRecoveryDefers.push(node);
    for (const child of node.namedChildren) collectRecoveryDefers(child);
  };
  if (fnBody) collectRecoveryDefers(fnBody);
  if (recoveryDefers.length === 1 && topLevelDefers.length === 1) {
    const deferStmt = recoveryDefers[0];
    const body = deferStmt.namedChildren.find(c => c.type === 'call_expression')?.childForFieldName('function')?.childForFieldName('body');
    if (body && provenRecoveryDefer(deferStmt)) {
      recoveryDeferIndex = deferStmt.startIndex;
      recoversPanics = true;
    } else {
      boundaries.add(`deferred recovery at line ${deferStmt.startPosition.row + 1} may re-panic or replace the panic`);
    }
  } else if (recoveryDefers.length > 0) {
    boundaries.add('panic recovery is not proven because multiple deferred actions affect unwind ordering');
  }
  if (allRecoveryDefers.length > recoveryDefers.length) boundaries.add('panic recovery inside conditional or nested control flow is not proven unconditional');

  const walk = (node: Node, nested: boolean): void => {
    const isNested = node !== fnNode && (node.type === 'function_declaration' || node.type === 'method_declaration' || node.type === 'func_literal');
    if (nested || isNested) return;
    if (node.type === 'call_expression') {
      const name = callName(node);
      if (name === 'panic') escapes.push({ value: node.childForFieldName('arguments')?.text ?? 'panic', kind: 'panic', line: node.startPosition.row + 1, index: node.startIndex });
      else if (name && name !== 'recover') callSites.push({ calleeName: name, line: node.startPosition.row + 1, index: node.startIndex });
    }
    if (node.type === 'short_var_declaration' || node.type === 'assignment_statement') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (left) {
        const scope = scopeOf(node);
        const rightValues = right?.type === 'expression_list' ? right.namedChildren : right ? [right] : [];
        const multiResultCall = rightValues.length === 1 && rightValues[0].type === 'call_expression'
          ? rightValues[0]
          : undefined;
        for (const [resultIndex, id] of left.namedChildren.filter(c => c.type === 'identifier').entries()) {
          const assigned = multiResultCall ?? rightValues[resultIndex];
          const assignedCall = assigned?.type === 'call_expression' ? assigned : undefined;
          const callee = assignedCall ? callName(assignedCall) : undefined;
          const callResultIndex = multiResultCall ? resultIndex : 0;
          if (id.text === '_' && assignedCall) discardedResults.push({
            calleeName: callee ?? '',
            line: node.startPosition.row + 1,
            index: node.startIndex,
            resultIndex: callResultIndex,
          });
          else if (id.text !== '_') {
            let binding: Binding | undefined;
            if (node.type === 'short_var_declaration') {
              binding = (bindings.get(id.text) ?? []).find(b => b.scopeStart === scope.startIndex && b.scopeEnd === scope.endIndex);
              binding ??= createBinding(id.text, scope, node.startIndex);
            } else {
              binding = visibleBinding(id.text, node.startIndex) ?? createBinding(id.text, fnBody ?? fnNode, node.startIndex);
            }
            binding.events.push({
              index: node.startIndex,
              calleeName: callee,
              callLine: assignedCall ? assignedCall.startPosition.row + 1 : undefined,
              resultIndex: assignedCall ? callResultIndex : undefined,
              nil: assigned?.type === 'nil',
            });
          }
        }
      }
    }
    if (returnsError && node.type === 'return_statement') {
      const values = node.namedChildren.flatMap(c => c.type === 'expression_list' ? c.namedChildren : [c]);
      if (values.length === 0) {
        if (namedErrorResults.size === 0) boundaries.add(`bare return at line ${node.startPosition.row + 1} has an unnamed error result`);
        for (const name of namedErrorResults) {
          const binding = visibleBinding(name, node.startIndex);
          const event = binding?.events.filter(e => e.index < node.startIndex).at(-1);
          if (!event || event.nil) continue;
          escapes.push({
            value: name, kind: 'returned_error', line: node.startPosition.row + 1, index: node.startIndex,
            calleeName: event.calleeName, callLine: event.callLine, callResultIndex: event.resultIndex,
            bindingId: binding?.id,
          });
        }
      }
      for (const [position, value] of values.entries()) {
        if (!(errorResultIndices.has(position) || (values.length === 1 && value.type === 'call_expression'))) continue;
        if (value.type === 'nil') continue;
        if (value.type === 'identifier') {
          const binding = visibleBinding(value.text, node.startIndex);
          const event = binding?.events.filter(e => e.index < node.startIndex).at(-1);
          if (event?.nil) continue;
          escapes.push({ value: value.text, kind: 'returned_error', line: node.startPosition.row + 1, index: node.startIndex, calleeName: event?.calleeName, callLine: event?.callLine, callResultIndex: event?.resultIndex, bindingId: binding?.id });
        } else if (value.type === 'call_expression') {
          escapes.push({ value: 'error', kind: 'returned_error', line: node.startPosition.row + 1, index: node.startIndex, calleeName: callName(value), callLine: value.startPosition.row + 1 });
        }
      }
    }
    for (const child of node.namedChildren) walk(child, false);
    if (node.type === 'if_statement') {
      const condition = node.childForFieldName('condition');
      const consequence = node.childForFieldName('consequence');
      if (condition && consequence && /!=\s*nil|nil\s*!=/.test(condition.text)) {
        for (const name of bindings.keys()) {
          if (!new RegExp(`\\b${name}\\b`).test(condition.text)) continue;
          if (!subtreeEscapesValue(consequence, name)) {
            const binding = visibleBinding(name, condition.startIndex);
            const latest = binding?.events.filter(e => e.index < condition.startIndex).at(-1);
            if (latest?.calleeName) checkedCandidates.push({ value: name, kind: 'checked_error', line: node.startPosition.row + 1, index: node.startIndex, fromCallee: latest.calleeName, callLine: latest.callLine, callResultIndex: latest.resultIndex, bindingId: binding?.id });
            else boundaries.add(`nil-checked value ${name} at line ${node.startPosition.row + 1} could not be tied to one call result`);
          }
        }
      }
    }
  };
  walk(fnNode, false);
  // A check that merely logs/observes an error before returning or panicking it
  // later does not handle that error. Reject such candidates conservatively;
  // statement-order rebinding is intentionally left as a future precision gain.
  for (let i = checkedCandidates.length - 1; i >= 0; i--) {
    const candidate = checkedCandidates[i];
    if (escapes.some(e =>
      e.value === candidate.value && e.index > (candidate.index ?? -1) &&
      e.bindingId === candidate.bindingId &&
      e.calleeName === candidate.fromCallee && e.callLine === candidate.callLine &&
      e.callResultIndex === candidate.callResultIndex
    )) {
      checkedCandidates.splice(i, 1);
    }
  }
  const directPanicSites = escapes.filter(e => e.kind === 'panic').map(e => ({ ...e }));

  const literalPanics = (node: Node): Node[] => {
    const found: Node[] = [];
    const collect = (candidate: Node): void => {
      if (candidate.type === 'func_literal') return;
      if (candidate.type === 'call_expression' && callName(candidate) === 'panic') {
        found.push(candidate);
        return;
      }
      for (const child of candidate.namedChildren) collect(child);
    };
    collect(node);
    return found;
  };
  const literalBody = (deferStmt: Node): Node | null => {
    const literal = deferStmt.namedChildren.find(c => c.type === 'call_expression')?.childForFieldName('function');
    return literal?.type === 'func_literal' ? literal.childForFieldName('body') : null;
  };
  const directLiteralPanic = (deferStmt: Node): Node | null => {
    const body = literalBody(deferStmt);
    if (!body) return null;
    const panics = literalPanics(body);
    if (panics.length !== 1) return null;
    let parent = panics[0].parent;
    while (parent && parent.parent !== body) parent = parent.parent;
    return parent?.parent === body ? panics[0] : null;
  };
  const panicDefers = topLevelDefers.filter(d => literalBody(d) && literalPanics(literalBody(d)!).length > 0);
  if (panicDefers.length > 0) {
    const finalPanic = directLiteralPanic(panicDefers[0]);
    const hasEarlierPanic = escapes.some(e => e.kind === 'panic' && e.index < panicDefers[0].startIndex);
    if (finalPanic && !hasEarlierPanic) {
      for (let i = escapes.length - 1; i >= 0; i--) {
        if (escapes[i].kind === 'panic' && escapes[i].index > panicDefers[0].startIndex) escapes.splice(i, 1);
      }
      escapes.push({
        value: finalPanic.childForFieldName('arguments')?.text ?? 'panic', kind: 'panic',
        line: finalPanic.startPosition.row + 1, index: finalPanic.startIndex,
      });
    }
    if (panicDefers.length > 1 || !finalPanic) {
      boundaries.add('deferred panic escape is limited by conditional control flow or multiple-defer LIFO replacement');
    }
    if (hasEarlierPanic) boundaries.add('deferred panic occurs after a panic site and is not proven registered');
  }
  if (topLevelDefers.length > 1) {
    type KnownDefer = { kind: 'recover'; node: Node } | { kind: 'panic'; node: Node; panic: Node };
    const actions = topLevelDefers.map((node): KnownDefer | null => {
      if (provenRecoveryDefer(node)) return { kind: 'recover', node };
      const panic = directLiteralPanic(node);
      return panic ? { kind: 'panic', node, panic } : null;
    });
    const deferredPanicIndices = new Set(actions.flatMap(action => action?.kind === 'panic' ? [action.panic.startIndex] : []));
    const lastDeferIndex = Math.max(...topLevelDefers.map(node => node.startIndex));
    const bodyPanics = directPanicSites;
    const bodyPanicIsAfterRegistration = bodyPanics.length === 0 ||
      (bodyPanics.length === 1 && bodyPanics[0].index > lastDeferIndex);
    if (actions.every((action): action is KnownDefer => action !== null) && bodyPanicIsAfterRegistration) {
      boundaries.delete('panic recovery is not proven because multiple deferred actions affect unwind ordering');
      boundaries.delete('deferred panic escape is limited by conditional control flow or multiple-defer LIFO replacement');
      for (let i = escapes.length - 1; i >= 0; i--) {
        if (escapes[i].kind === 'panic' && (deferredPanicIndices.has(escapes[i].index) || escapes[i].index > lastDeferIndex)) escapes.splice(i, 1);
      }
      let state: GoErrorSite | undefined = bodyPanics[0];
      for (const action of [...actions].reverse()) {
        if (action.kind === 'panic') {
          state = { value: action.panic.childForFieldName('arguments')?.text ?? 'panic', kind: 'panic', line: action.panic.startPosition.row + 1, index: action.panic.startIndex };
        } else if (state) {
          handledInternally.push({ value: state.value, kind: 'recovered_panic', line: action.node.startPosition.row + 1 });
          state = undefined;
        }
      }
      if (state) escapes.push(state);

      let incomingPanic = true;
      for (const action of [...actions].reverse()) incomingPanic = action.kind === 'panic' ? true : false;
      if (!incomingPanic) {
        recoversPanics = true;
        recoveryDeferIndex = Math.min(...topLevelDefers.map(node => node.startIndex));
      }
    }
  }
  const inspectDeferredAndAsyncLiterals = (node: Node): void => {
    if (node.type === 'defer_statement') {
      if (!topLevelDefers.includes(node)) {
        const body = literalBody(node);
        if (body && literalPanics(body).length > 0) boundaries.add(`panic in conditional or nested defer at line ${node.startPosition.row + 1} is not proven registered`);
      }
      return;
    }
    if (node.type === 'go_statement') {
      const literal = node.namedChildren.find(c => c.type === 'call_expression')?.childForFieldName('function');
      const body = literal?.type === 'func_literal' ? literal.childForFieldName('body') : null;
      if (body && containsCallNamed(body, 'panic')) boundaries.add(`panic in goroutine literal at line ${node.startPosition.row + 1} is asynchronous and does not propagate on the caller stack`);
      return;
    }
    if (node !== fnNode && (node.type === 'function_declaration' || node.type === 'method_declaration' || node.type === 'func_literal')) return;
    for (const child of node.namedChildren) inspectDeferredAndAsyncLiterals(child);
  };
  inspectDeferredAndAsyncLiterals(fnNode);
  if (recoveryDeferIndex !== undefined) {
    if (escapes.some(e => e.kind === 'panic' && e.index < recoveryDeferIndex)) boundaries.add('deferred recovery occurs after a panic site and cannot shield it');
    for (const panic of escapes.filter(e => e.kind === 'panic' && recoveryDeferIndex! < e.index)) handledInternally.push({ value: panic.value, kind: 'recovered_panic', line: panic.line });
    for (let i = escapes.length - 1; i >= 0; i--) if (escapes[i].kind === 'panic' && recoveryDeferIndex < escapes[i].index) escapes.splice(i, 1);
  }
  return { language: 'Go', supported: true, returnsError, errorResultIndices: [...errorResultIndices], escapes, handledInternally, checkedCandidates, discardedResults, callSites, recoversPanics, recoveryDeferIndex, boundaries: [...boundaries].sort() };
}

export async function extractGoErrorFactsFromSource(source: string): Promise<GoErrorFacts> {
  const parser = await getExceptionParser('Go');
  if (!parser) return { language: 'Go', supported: false, returnsError: false, errorResultIndices: [], escapes: [], handledInternally: [], checkedCandidates: [], discardedResults: [], callSites: [], recoversPanics: false, boundaries: ['Go parser unavailable'] };
  const tree = parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, source);
  if (tree.rootNode.hasError) {
    return {
      language: 'Go', supported: true, returnsError: false, errorResultIndices: [], escapes: [],
      handledInternally: [], checkedCandidates: [], discardedResults: [], callSites: [],
      recoversPanics: false, boundaries: ['source contains syntax errors; Go error facts were not extracted'],
    };
  }
  const fn = tree.rootNode.namedChildren.find(c => c.type === 'function_declaration' || c.type === 'method_declaration');
  return extractGoErrorFacts(tree.rootNode, fn?.startIndex ?? 0, fn?.endIndex ?? source.length);
}

/** All `try` guards whose body byte-range encloses `index`, innermost (smallest
 *  span) first. Byte containment is exact — unlike line containment it never
 *  conflates a throw/call sharing a physical line with a try-body boundary. */
export function enclosingGuards(guards: TryGuard[], index: number): TryGuard[] {
  return guards
    .filter(g => g.fromIndex <= index && index < g.toIndex)
    .sort((a, b) => a.toIndex - a.fromIndex - (b.toIndex - b.fromIndex));
}

/** The innermost (smallest byte-span) `try` guard whose body encloses `index`, or
 *  null. Kept for callers that want a single guard; resolution prefers
 *  {@link enclosingGuards} so an outer catch-all is not shadowed. */
export function innermostGuard(guards: TryGuard[], index: number): TryGuard | null {
  return enclosingGuards(guards, index)[0] ?? null;
}

/** Does a guard catch an exception of `type`? A catch-all catches anything
 *  (including {@link DYNAMIC_TYPE}); a typed guard catches only its exact named
 *  types (never {@link DYNAMIC_TYPE}, which it cannot be proven to match). A
 *  re-throwing handler does not swallow. */
export function guardCatches(guard: TryGuard, type: string): boolean {
  if (guard.handlers) {
    return guard.handlers.some(h => !h.rethrows && !h.filtered && (h.catchAll || (type !== DYNAMIC_TYPE && h.caughtTypes.includes(type))));
  }
  if (guard.rethrows) return false;
  if (guard.catchAll) return true;
  if (type === DYNAMIC_TYPE) return false;
  return guard.caughtTypes.includes(type);
}

/** Is an exception of `type` caught by ANY of these enclosing guards? */
export function guardsCatch(guards: TryGuard[], type: string): boolean {
  return guards.some(g => guardCatches(g, type));
}
