/**
 * Per-function exception extractor (change: add-error-propagation-graph).
 *
 * Deterministic, LLM-free static extraction of a single function's exception
 * facts — the throw sites it contains and the `try` regions that guard parts of
 * its body — for the languages whose throw/catch semantics are cleanly
 * statically extractable: TypeScript, JavaScript, Python. Every other language
 * fails soft (an `unsupported` record with no facts), never a guess.
 *
 * This is the substrate under the `analyze_error_propagation` conclusion tool.
 * The CFG overlay (`cfg.ts`) already models try/catch/finally/throw as control
 * flow; this module adds the *exception semantics* the CFG omits — which type is
 * thrown, which a handler catches, and whether a throw escapes its function —
 * reusing the same per-language throw/try node-type knowledge rather than a new
 * grammar.
 *
 * It deliberately does NOT descend into nested closures/functions: a throw inside
 * a nested function is attributed to that nested function (which, if indexed, is
 * analyzed on its own), not the enclosing one — consistent with how the CFG
 * overlay treats nested scopes. Computed live (no persisted artifact).
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
  /** True when an enclosing `try` in the SAME function catches it (so it does not
   *  escape this function). */
  locallyHandled: boolean;
}

/** A function's static exception facts. */
export interface FunctionExceptionFacts {
  language: string;
  /** False for a language outside {@link ERROR_PROPAGATION_LANGUAGES}: no facts,
   *  not a claim of exception-freedom. */
  supported: boolean;
  throwSites: ThrowSite[];
  tryGuards: TryGuard[];
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
};

const PY_LANG: LangSpec = {
  throwTypes: new Set(['raise_statement']),
  tryTypes: new Set(['try_statement']),
  nestedFnTypes: new Set(['lambda', 'function_definition']),
  bodyField: 'body',
  catchClauseTypes: new Set(['except_clause', 'except_group_clause']),
  blockTypes: new Set(['block']),
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

/** The thrown type of a TS/JS `throw_statement`. */
function tsThrowType(stmt: Node): string {
  const expr = stmt.namedChildren[0];
  if (!expr) return DYNAMIC_TYPE;
  if (expr.type === 'new_expression') {
    const ctor = expr.childForFieldName('constructor') ?? expr.namedChildren[0];
    return nameOf(ctor ?? null);
  }
  // throw e / throw {…} / throw fn() — type not statically knowable.
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
    // exception CLASS is CapWords by convention; anything else is a value.
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

// ── Body scan (depth-scoped to the primary function) ─────────────────────────

/** Does the handler body re-throw/re-raise directly (not inside a nested fn)? */
function bodyRethrows(body: Node | null, spec: LangSpec): boolean {
  if (!body) return false;
  let found = false;
  const visit = (node: Node, fnDepth: number): void => {
    if (found) return;
    const depth = fnDepth + (spec.nestedFnTypes.has(node.type) ? 1 : 0);
    if (depth >= 1 && node !== body) {
      // `body` itself is the handler block (depth 0 container); a nested fn inside
      // is pruned.
      if (spec.nestedFnTypes.has(node.type)) return;
    }
    if (spec.throwTypes.has(node.type)) {
      found = true;
      return;
    }
    for (const c of node.namedChildren) visit(c, depth);
  };
  for (const c of body.namedChildren) visit(c, 0);
  return found;
}

function blockBody(node: Node, spec: LangSpec): Node | null {
  return (
    node.childForFieldName(spec.bodyField) ??
    node.namedChildren.find(c => spec.blockTypes.has(c.type)) ??
    null
  );
}

/** The guard a `try` region provides. */
function tryGuardOf(tryStmt: Node, language: string, spec: LangSpec): TryGuard {
  const body = blockBody(tryStmt, spec);
  const fromLine = (body ?? tryStmt).startPosition.row + 1;
  const toLine = (body ?? tryStmt).endPosition.row + 1;

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

  return { fromLine, toLine, catchAll, caughtTypes: [...new Set(caughtTypes)], rethrows };
}

/**
 * Extract a single function's exception facts from a parsed tree, scoped to the
 * byte range `[startIndex, endIndex)`. The range identifies the function; throws
 * and tries inside nested closures within it are excluded (attributed to those
 * closures). Deterministic.
 */
export function extractExceptionFacts(
  root: Node,
  startIndex: number,
  endIndex: number,
  language: string,
): FunctionExceptionFacts {
  const spec = specFor(language);
  if (!spec) {
    return { language, supported: false, throwSites: [], tryGuards: [], dynamicThrowCount: 0 };
  }

  // Smallest node covering the function's span — the function (or a tight wrapper
  // like a lexical_declaration / export_statement around an arrow).
  let fnNode: Node = root;
  // Descend to the deepest node still containing the whole range.
  for (;;) {
    const child = fnNode.namedChildren.find(
      c => c.startIndex <= startIndex && c.endIndex >= endIndex,
    );
    if (!child || child === fnNode) break;
    fnNode = child;
  }

  const throwSites: ThrowSite[] = [];
  const tryGuards: TryGuard[] = [];

  // Walk the function subtree counting function-type nodes along each path: the
  // FIRST is the function we are analyzing; a deeper one is a nested closure and
  // is pruned. Record throws/tries only inside the primary function body.
  const walk = (node: Node, fnDepth: number): void => {
    const depth = fnDepth + (spec.nestedFnTypes.has(node.type) ? 1 : 0);
    if (depth >= 2) return; // inside a nested function — prune
    if (depth === 1) {
      if (spec.throwTypes.has(node.type)) {
        const type = language === 'Python' ? pyRaiseType(node) : tsThrowType(node);
        throwSites.push({ type, line: node.startPosition.row + 1, locallyHandled: false });
      } else if (spec.tryTypes.has(node.type)) {
        tryGuards.push(tryGuardOf(node, language, spec));
      }
    }
    for (const c of node.namedChildren) walk(c, depth);
  };
  walk(fnNode, 0);

  // Resolve local handling: a throw is locally handled if the INNERMOST `try`
  // body enclosing it catches its type and does not re-throw.
  for (const ts of throwSites) {
    const guard = innermostGuard(tryGuards, ts.line);
    if (guard && !guard.rethrows && guardCatches(guard, ts.type)) ts.locallyHandled = true;
  }

  const dynamicThrowCount = throwSites.filter(t => t.type === DYNAMIC_TYPE).length;
  return { language, supported: true, throwSites, tryGuards, dynamicThrowCount };
}

/** Convenience: parse `source` as a whole file and extract facts for all of it
 *  (the function under test). Returns an unsupported record if the language is
 *  not supported or the parser is unavailable. */
export async function extractExceptionFactsFromSource(
  source: string,
  language: string,
): Promise<FunctionExceptionFacts> {
  if (!ERROR_PROPAGATION_LANGUAGES.has(language)) {
    return { language, supported: false, throwSites: [], tryGuards: [], dynamicThrowCount: 0 };
  }
  const parser = await getExceptionParser(language);
  if (!parser) {
    return { language, supported: false, throwSites: [], tryGuards: [], dynamicThrowCount: 0 };
  }
  const tree = parser.parse(source);
  return extractExceptionFacts(tree.rootNode, 0, source.length, language);
}

/** The innermost (smallest-span) `try` guard whose body encloses `line`, or null. */
export function innermostGuard(guards: TryGuard[], line: number): TryGuard | null {
  let best: TryGuard | null = null;
  for (const g of guards) {
    if (line < g.fromLine || line > g.toLine) continue;
    if (!best || g.toLine - g.fromLine < best.toLine - best.fromLine) best = g;
  }
  return best;
}

/** Does a guard catch an exception of `type`? A catch-all catches anything
 *  (including {@link DYNAMIC_TYPE}); a typed guard catches only its exact named
 *  types (never {@link DYNAMIC_TYPE}, which it cannot be proven to match). */
export function guardCatches(guard: TryGuard, type: string): boolean {
  if (guard.rethrows) return false;
  if (guard.catchAll) return true;
  if (type === DYNAMIC_TYPE) return false;
  return guard.caughtTypes.includes(type);
}
