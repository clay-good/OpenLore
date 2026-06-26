/**
 * Per-function exception extractor (change: add-error-propagation-graph).
 *
 * Deterministic, LLM-free static extraction of a single function's exception
 * facts — the throw sites it contains, the `try` regions that guard parts of its
 * body, and the call sites within it (each tagged with the guards that enclose
 * it) — for the languages whose throw/catch semantics are cleanly statically
 * extractable: TypeScript, JavaScript, Python. Every other language fails soft
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

/** The languages whose exception flow is statically extractable here. This is the
 *  single authoritative source the language-support registry derives the
 *  `errorPropagation` capability from, so the matrix cannot over-claim. */
export const ERROR_PROPAGATION_LANGUAGES: ReadonlySet<string> = new Set([
  'TypeScript',
  'JavaScript',
  'Python',
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
export type CallReceiver = 'self' | 'other' | 'none';

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
  /** False for a language outside {@link ERROR_PROPAGATION_LANGUAGES}: no facts,
   *  not a claim of exception-freedom. */
  supported: boolean;
  throwSites: ThrowSite[];
  tryGuards: TryGuard[];
  callSites: CallSite[];
  /** Count of throw sites whose type is {@link DYNAMIC_TYPE} (re-raises / rethrows
   *  / thrown values) — a disclosed honesty signal, not an error. */
  dynamicThrowCount: number;
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
    default:
      return null;
  }
}

// ── Lazy tree-sitter parsers (scoped to the supported languages) ─────────────

let _tsParser: Parser | undefined;
let _pyParser: Parser | undefined;
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

/** A tree-sitter parser for a supported language, or null if unavailable. */
export async function getExceptionParser(language: string): Promise<Parser | null> {
  try {
    const NP = await loadNativeParser();
    if (!NP) return null;
    switch (language) {
      case 'TypeScript':
      case 'JavaScript': {
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
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ── Type-name helpers ────────────────────────────────────────────────────────

type Node = Parser.SyntaxNode;

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
function receiverKindOf(callNode: Node, spec: LangSpec): CallReceiver {
  const fn =
    callNode.childForFieldName('constructor') ??
    callNode.childForFieldName(spec.callNameField) ??
    callNode.namedChildren[0] ??
    null;
  if (!fn) return 'none';
  // Member access: `<object>.<prop>`. TS member_expression / Python attribute.
  if (fn.type === 'member_expression' || fn.type === 'attribute') {
    const obj = fn.childForFieldName('object') ?? fn.namedChildren[0] ?? null;
    if (!obj) return 'other';
    if (obj.type === 'this' || obj.type === 'super') return 'self';
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
function bodyRethrows(body: Node | null, spec: LangSpec): boolean {
  if (!body) return false;
  let found = false;
  const visit = (node: Node): void => {
    if (found) return;
    if (spec.nestedFnTypes.has(node.type)) return; // a throw in a nested fn is not this handler's
    if (spec.throwTypes.has(node.type)) {
      found = true;
      return;
    }
    for (const c of node.namedChildren) visit(c);
  };
  for (const c of body.namedChildren) visit(c);
  return found;
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

  for (const clause of tryStmt.namedChildren) {
    if (!spec.catchClauseTypes.has(clause.type)) continue;
    const handlerBody = blockBody(clause, spec);
    if (bodyRethrows(handlerBody, spec)) rethrows = true;

    if (language === 'Python') {
      const typeExpr = pyExceptTypeExpr(clause, spec);
      if (!typeExpr) {
        catchAll = true; // bare `except:`
      } else {
        const names = pyCatchNames(typeExpr);
        if (names.length === 0 || names.some(n => PY_CATCH_ALL.has(n))) catchAll = true;
        for (const n of names) if (!PY_CATCH_ALL.has(n)) caughtTypes.push(n);
      }
    } else {
      // TS/JS `catch` has no type filter — it catches everything.
      catchAll = true;
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
  };
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

  const throwSites: ThrowSite[] = [];
  const tryGuards: TryGuard[] = [];
  const rawCallSites: Array<{ calleeName: string; line: number; index: number; receiver: CallReceiver }> = [];

  // Walk the function subtree counting function-type nodes along each path: the
  // FIRST is the function we are analyzing; a deeper one is a nested closure and
  // is pruned. Record throws/tries/calls only inside the primary function body.
  const walk = (node: Node, fnDepth: number): void => {
    const depth = fnDepth + (spec.nestedFnTypes.has(node.type) ? 1 : 0);
    if (depth >= 2) return; // inside a nested function — prune
    if (depth === 1) {
      if (spec.throwTypes.has(node.type)) {
        const type = language === 'Python' ? pyRaiseType(node) : tsThrowType(node);
        throwSites.push({ type, line: node.startPosition.row + 1, index: node.startIndex, locallyHandled: false });
      } else if (spec.tryTypes.has(node.type)) {
        tryGuards.push(tryGuardOf(node, language, spec));
      } else if (spec.callTypes.has(node.type)) {
        const name = calleeNameOf(node, spec);
        if (name)
          rawCallSites.push({
            calleeName: name,
            line: node.startPosition.row + 1,
            index: node.startIndex,
            receiver: receiverKindOf(node, spec),
          });
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
    ts.locallyHandled = enclosing.some(g => guardCatches(g, ts.type));
  }

  const callSites: CallSite[] = rawCallSites.map(c => ({
    calleeName: c.calleeName,
    line: c.line,
    receiver: c.receiver,
    guards: enclosingGuards(tryGuards, c.index),
  }));

  const dynamicThrowCount = throwSites.filter(t => t.type === DYNAMIC_TYPE).length;
  return { language, supported: true, throwSites, tryGuards, callSites, dynamicThrowCount };
}

/** Convenience: parse `source` as a whole file and extract facts for all of it
 *  (the function under test). Returns an unsupported record if the language is
 *  not supported or the parser is unavailable. */
export async function extractExceptionFactsFromSource(
  source: string,
  language: string,
): Promise<FunctionExceptionFacts> {
  if (!ERROR_PROPAGATION_LANGUAGES.has(language)) {
    return { language, supported: false, throwSites: [], tryGuards: [], callSites: [], dynamicThrowCount: 0 };
  }
  const parser = await getExceptionParser(language);
  if (!parser) {
    return { language, supported: false, throwSites: [], tryGuards: [], callSites: [], dynamicThrowCount: 0 };
  }
  const tree = parser.parse(source);
  return extractExceptionFacts(tree.rootNode, 0, source.length, language);
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
  if (guard.rethrows) return false;
  if (guard.catchAll) return true;
  if (type === DYNAMIC_TYPE) return false;
  return guard.caughtTypes.includes(type);
}

/** Is an exception of `type` caught by ANY of these enclosing guards? */
export function guardsCatch(guards: TryGuard[], type: string): boolean {
  return guards.some(g => guardCatches(g, type));
}
