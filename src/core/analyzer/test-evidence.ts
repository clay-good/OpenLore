/**
 * What kind of test evidence a symbol has (change: add-test-evidence-claims).
 *
 * "A test reaches this function" is what `select_tests` answers, and it is the right answer to
 * "what do I run". It is not the answer to "is this verified". This module classes each
 * test-to-symbol relationship by what the test does with the symbol, without running anything:
 *
 * - `asserts-on`: an argument of a recognized assertion is derived from a call to the symbol in
 *   that test — "an assertion consumed this symbol's output", never "the behavior is correct";
 * - `exercises`: the test calls the symbol, and no recognized assertion uses a value from the call;
 * - `reaches`: the symbol is only in the test's transitive call graph, or the test's assertions
 *   are in a form no recognizer here knows (said so in the reason; never "untested").
 *
 * The data flow is local to one test body (the def-use overlay of `cfg.ts`), and follows one
 * helper in the same file: an assertion helper the test hands the value to, or a value helper
 * that returns it. Past that the walk stops and says so.
 */

import type Parser from 'tree-sitter';
import { readFileConfined } from '../../utils/path-confinement.js';
import { detectLanguage } from './language-detection.js';
import { getExceptionParser } from './exception-flow.js';
import { parseWithBudget, type BudgetableParser } from './extraction-budget.js';
import { buildFunctionCfg, type CfgNode, type FunctionCfg } from './cfg.js';
import type { SerializedCallGraph } from './call-graph.js';

type Node = Parser.SyntaxNode;

export type EvidenceClass = 'asserts-on' | 'exercises' | 'reaches';

/** Strongest first. */
export const EVIDENCE_ORDER: readonly EvidenceClass[] = ['asserts-on', 'exercises', 'reaches'];

/** Languages whose test assertions a recognizer below identifies, with their asserted arguments. */
export const ASSERTION_RECOGNITION_LANGUAGES: ReadonlySet<string> = new Set(['TypeScript', 'JavaScript', 'Python', 'Go']);

/** The frameworks each recognizer covers, for the registry and the docs. */
export const ASSERTION_FRAMEWORKS: Readonly<Record<string, string>> = {
  TypeScript: 'Vitest/Jest `expect`, Node `assert`, Chai `expect`/`assert`',
  JavaScript: 'Vitest/Jest `expect`, Node `assert`, Chai `expect`/`assert`',
  Python: 'pytest `assert`, `pytest.raises`/`warns`, unittest `self.assert*`',
  Go: 'testify `assert`/`require`, `testing` `t.Error*`/`t.Fatal*` under an `if`',
};

export interface TestRelationship {
  testFile: string;
  /** The test case, or null when the relationship is to the whole file. */
  test: string | null;
  class: EvidenceClass;
  /** The assertion line (`asserts-on`) or the call line (`exercises`); null for `reaches`. */
  line: number | null;
  /** False when the test's assertions were not recognized: its `reaches` is a gap, not a fact. */
  recognized: boolean;
  reason: string;
}

export interface SymbolEvidence {
  symbol: string;
  file: string;
  /** Null when no test relates to the symbol at all. */
  strongest: EvidenceClass | null;
  /** Every relationship's assertions were recognized (false when any test's were not). */
  allRecognized: boolean;
  relationships: TestRelationship[];
  /** Linked test files past the cap, not classified. */
  omittedFiles: number;
  /** Relationships past the listing cap (still counted in `strongest`). */
  omittedRelationships: number;
  /** Test files that could not be read or parsed, so were not classified. */
  notAssessed: string[];
  /** The backward walk to reaching tests stopped at its depth or node cap. */
  reachTruncated: boolean;
  /**
   * Every test file that references the symbol directly was classified and every test's assertions
   * recognized. False when such a file was past a cap, could not be read or parsed, or used an
   * unrecognized framework: then the absence of an asserting test is not established. A file that
   * only reaches the symbol is classed from the call graph without being read, so it never makes the
   * evidence partial.
   */
  complete: boolean;
}

/** Bounds: the walk runs inside hooks, so it must stay small and predictable. */
const MAX_FILES_PER_SYMBOL = 25;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REACH_DEPTH = 12;
const MAX_REACH_NODES = 5000;
const MAX_RELATIONSHIPS = 50;

export function strongerClass(a: EvidenceClass | null, b: EvidenceClass | null): EvidenceClass | null {
  if (a === null) return b;
  if (b === null) return a;
  return EVIDENCE_ORDER.indexOf(a) <= EVIDENCE_ORDER.indexOf(b) ? a : b;
}

// ── Linking a symbol to test files (from the index) ─────────────────────────────

interface LinkIndex {
  callers: Map<string, string[]>;
  testedBy: Map<string, Set<string>>;
  nodes: Map<string, SerializedCallGraph['nodes'][number]>;
}

const linkIndexes = new WeakMap<SerializedCallGraph, LinkIndex>();

function linkIndex(cg: SerializedCallGraph): LinkIndex {
  const cached = linkIndexes.get(cg);
  if (cached) return cached;
  const nodes = new Map(cg.nodes.map(n => [n.id, n]));
  const callers = new Map<string, string[]>();
  const testedBy = new Map<string, Set<string>>();
  for (const e of cg.edges) {
    if (e.kind === 'tested_by') {
      const file = e.calleeId.endsWith('::*') ? e.calleeId.slice(0, -3) : nodes.get(e.calleeId)?.filePath;
      if (file) (testedBy.get(e.callerId) ?? testedBy.set(e.callerId, new Set()).get(e.callerId)!).add(file);
    } else if ((!e.kind || e.kind === 'calls') && e.calleeId) {
      (callers.get(e.calleeId) ?? callers.set(e.calleeId, []).get(e.calleeId)!).push(e.callerId);
    }
  }
  const index = { callers, testedBy, nodes };
  linkIndexes.set(cg, index);
  return index;
}

/**
 * Test files that reference the symbol directly (a `tested_by` edge from it, or a test function
 * that calls it), and those that only reach it through other functions.
 */
export function linkedTestFiles(cg: SerializedCallGraph, symbolId: string): { direct: string[]; reach: string[]; truncated: boolean } {
  const { callers, testedBy, nodes } = linkIndex(cg);
  const direct = new Set<string>(testedBy.get(symbolId) ?? []);
  for (const c of callers.get(symbolId) ?? []) {
    const n = nodes.get(c);
    if (n?.isTest) direct.add(n.filePath);
  }
  const reach = new Set<string>();
  const seen = new Set<string>([symbolId]);
  let frontier = [symbolId];
  for (let depth = 0; depth < MAX_REACH_DEPTH && frontier.length && seen.size < MAX_REACH_NODES; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const c of callers.get(id) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        const n = nodes.get(c);
        if (n?.isTest) { reach.add(n.filePath); continue; }
        for (const f of testedBy.get(c) ?? []) reach.add(f);
        next.push(c);
      }
    }
    frontier = next;
  }
  for (const f of direct) reach.delete(f);
  // Callers were left unvisited at a cap: a test beyond it may exist.
  const truncated = frontier.length > 0 && frontier.some(id => (callers.get(id) ?? []).some(c => !seen.has(c)));
  return { direct: [...direct].sort(), reach: [...reach].sort(), truncated };
}

// ── Parsing ─────────────────────────────────────────────────────────────────────

const parserCache = new Map<string, Parser | null>();

async function parse(language: string, path: string, text: string): Promise<Node | null> {
  const key = language === 'TypeScript' || language === 'JavaScript' ? (/\.[jt]sx$/i.test(path) ? 'tsx' : 'ts') : language;
  if (!parserCache.has(key)) parserCache.set(key, await getExceptionParser(language, path));
  const parser = parserCache.get(key);
  if (!parser) return null;
  try {
    return parseWithBudget(parser as unknown as BudgetableParser<Parser.Tree>, text).rootNode;
  } catch {
    return null;
  }
}

function* walk(root: Node): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    yield n;
    const kids = n.namedChildren;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

const line = (n: Node): number => n.startPosition.row + 1;

function contains(outer: Node, inner: Node): boolean {
  return inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex;
}

// ── Per-language shapes ─────────────────────────────────────────────────────────

interface FileContext {
  /** Identifiers whose method calls are assertions (`assert`, `require`, `a := assert.New(t)`). */
  assertReceivers: Set<string>;
  /** Go: parameters typed `*testing.T` / `*testing.B` / `*testing.F`. */
  testingParams: Set<string>;
  /** Names the test file declares itself (variables, functions, parameters): never the symbol. */
  localNames: Set<string>;
}

/**
 * One asserted value. `exact`: the assertion is about a call raising (`toThrow`, `pytest.raises`), so
 * only a source call that IS the asserted call counts — `parse(add(1))` raising says nothing of `add`.
 */
interface Assertion { value: Node; line: number; exact?: boolean }

/** Inside `body`, is `n` within a nested function (a callback that may never run in the test)? */
function inNestedFunction(n: Node, body: Node, fnTypes: ReadonlySet<string>, allowed?: (fn: Node) => boolean): boolean {
  for (let p = n.parent; p && p.id !== body.id; p = p.parent) {
    if (fnTypes.has(p.type) && !(allowed?.(p) ?? false)) return true;
  }
  return false;
}

/** `inner` reaches `outer` along value-carrying steps only (see `Lang.spineStep`). */
function onSpine(lang: Lang, inner: Node, outer: Node): boolean {
  if (inner.startIndex < outer.startIndex || inner.endIndex > outer.endIndex) return false;
  for (let p: Node = inner; p.startIndex !== outer.startIndex || p.endIndex !== outer.endIndex || p.type !== outer.type; ) {
    const parent = p.parent;
    if (!parent || !lang.spineStep(parent, p)) return false;
    p = parent;
  }
  return true;
}

/** Same node, compared by span and type (tree-sitter node objects are not stable identities). */
const sameNode = (a: Node, b: Node): boolean => a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;

/** Identifier texts under `n` (a declaration's name or pattern). */
function identifiersIn(n: Node | null | undefined, types: ReadonlySet<string>): string[] {
  if (!n) return [];
  return [...walk(n)].filter(d => types.has(d.type)).map(d => d.text);
}

/** Assertion forms that assert no value (a message, a logger, a mock's call record). */
const NO_VALUE_ASSERTS = new Set(['fail', 'Fail', 'Failf', 'FailNow', 'assertLogs', 'assertNoLogs']);

/** Assertion forms whose only asserted value is the first argument. */
const ONE_VALUE_ASSERTS = new Set([
  // Node assert / Chai assert
  'ok', 'isOk', 'isNotOk', 'isTrue', 'isFalse', 'isNull', 'isNotNull', 'isUndefined', 'isDefined',
  'exists', 'notExists', 'ifError', 'throws', 'doesNotThrow', 'rejects', 'doesNotReject', 'isEmpty', 'isNotEmpty',
  // unittest
  'assertTrue', 'assertFalse', 'assertIsNone', 'assertIsNotNone',
  // testify
  'True', 'False', 'Nil', 'NotNil', 'NoError', 'Error', 'Empty', 'NotEmpty', 'Zero', 'NotZero', 'Panics', 'NotPanics',
]);

/** The asserted value positions of an assertion called `name`: the first one, or the first two. */
function valuePositions(name: string): number[] {
  if (NO_VALUE_ASSERTS.has(name)) return [];
  return ONE_VALUE_ASSERTS.has(name) ? [0] : [0, 1];
}

/** Jest/Vitest matchers about a mock's calls: their arguments are reference values, not checks of the symbol. */
const JS_MOCK_MATCHERS = /^(?:toHaveBeenCalled\w*|toBeCalled\w*|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|lastCalledWith|nthCalledWith|toHaveReturned\w*|toReturn\w*)$/;
/** Chai property assertions: an assertion with no call. */
const JS_CHAI_PROPS = new Set(['true', 'false', 'null', 'undefined', 'ok', 'empty', 'exist', 'NaN', 'finite']);

/** Inside `body`, is `n` in a `try` whose handler neither rethrows nor fails: an assertion there never fails the test. */
function jsSwallowed(n: Node, body: Node): boolean {
  for (let p = n.parent; p && p.id !== body.id; p = p.parent) {
    if (p.type !== 'statement_block' || p.parent?.type !== 'try_statement') continue;
    const tryStmt = p.parent;
    if (!sameNode(tryStmt.childForFieldName('body') ?? p, p)) continue;
    const handler = tryStmt.childForFieldName('handler');
    if (handler && ![...walk(handler)].some(c => c.type === 'throw_statement')) return true;
  }
  return false;
}

/** Matchers that assert the expect'ed function raises. */
const JS_THROW_MATCHERS = /^(?:toThrow\w*|rejects|toReject\w*)$/;

/** One test case: its name, the function node holding its body, and the body. */
interface Case {
  name: string; fn: Node; body: Node;
  /** How the test is turned off (`it.skip`, `@pytest.mark.skip`, `t.Skip()`), or undefined when it runs. */
  skipped?: string;
}

/** A function in the file a test may call: a helper candidate. */
interface FileFn { name: string; fn: Node; body: Node }

interface Lang {
  cases(root: Node): Case[];
  functions(root: Node): FileFn[];
  /**
   * The name a call invokes and its receiver (`x` in `x.f(…)`; null for `f(…)` / `new F(…)`), or null
   * when this node is not a call.
   */
  callee(n: Node): { name: string; receiver: Node | null } | null;
  /** The call's argument nodes (a call node from `callee`). */
  callArgs(n: Node): Node[];
  /** File facts the recognizers need (assertion receivers, `*testing.T` parameters, local names). */
  context(root: Node): FileContext;
  /** The call is itself a recognized assertion (never a call to the symbol under test). */
  isAssertionCall(name: string, receiver: Node | null, ctx: FileContext): boolean;
  /**
   * Recognized assertions within `body`: each asserted VALUE node (never a message argument), with
   * the assertion's line.
   */
  assertions(body: Node, ctx: FileContext): Assertion[];
  /**
   * The variables a source call's value is bound to, with the statement's line span: only the
   * pattern element whose initializer holds the call (`const r = add(1), other = 7` binds `r`).
   */
  bindings(source: Node, body: Node): { names: string[]; from: number; to: number } | null;
  /**
   * Whether `parent` carries `child`'s value forward unchanged in kind: an `await`, parentheses, a
   * cast, a comparison or arithmetic, a member read or index, a method call ON it. Never an argument
   * to another call: in `expect(f(add()))` the assertion checks `f`, and `add`'s result is only an input.
   */
  spineStep(parent: Node, child: Node): boolean;
  /** A call that looks like an assertion this analysis does not recognize (`should(x)`, `s.Equal`). */
  looksLikeAssertion(name: string, receiver: Node | null, ctx: FileContext): boolean;
  /** Return statements' values in a function body. */
  returns(body: Node): Node[];
  identifierTypes: ReadonlySet<string>;
}

const JS_CASES = new Set(['it', 'test', 'specify', 'xit', 'xtest', 'fit', 'ftest']);
const JS_SUITES = new Set(['describe', 'context', 'suite', 'xdescribe', 'fdescribe']);
const JS_ASSERT_ROOTS = new Set(['expect', 'assert']);
const JS_FN_TYPES = new Set(['arrow_function', 'function_expression', 'function']);

function jsRoot(call: Node): string | null {
  let fn = call.childForFieldName('function');
  if (fn?.type === 'call_expression') fn = fn.childForFieldName('function'); // it.each(t)('x', fn)
  while (fn?.type === 'member_expression') {
    fn = fn.childForFieldName('object');
    if (fn?.type === 'call_expression') fn = fn.childForFieldName('function');
  }
  return fn?.type === 'identifier' ? fn.text : null;
}

/** `it.skip`, `xit`, `describe.skip`, `it.skipIf(c)`, `test.todo`: how a case or suite is turned off. */
function jsSkipMarker(call: Node): string | undefined {
  let fn = call.childForFieldName('function');
  if (fn?.type === 'call_expression') fn = fn.childForFieldName('function'); // it.skipIf(c)('x', fn)
  const text = fn?.text ?? '';
  const parts = text.split('.');
  if (/^x(?:it|test|describe|specify|context)$/.test(parts[0]) || parts.some(p => /^(?:skip|todo|skipIf|runIf)$/.test(p))) return text;
  return undefined;
}

function jsTitle(n: Node | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string') return n.text.slice(1, -1);
  if (n.type === 'template_string') return n.text.slice(1, -1);
  return null;
}

const JS_DECL_NAME_TYPES: ReadonlySet<string> = new Set(['identifier', 'shorthand_property_identifier_pattern']);

/**
 * The names a declarator binds to the value holding `source`. `const r = add()` binds `r`; a
 * destructuring is paired element by element (`const [r, other] = [add(1), 7]` binds `r`) and binds
 * nothing when it cannot be paired: an unpaired pattern would taint names the call never reached.
 */
function jsPatternNames(name: Node | null, value: Node | null, source: Node): string[] {
  if (!name || !value) return [];
  if (name.type === 'identifier') return [name.text];
  if (name.type === 'array_pattern' && value.type === 'array') {
    const i = value.namedChildren.findIndex(v => onSpine(JS, source, v));
    const el = i >= 0 ? name.namedChildren[i] : undefined;
    return el?.type === 'identifier' ? [el.text] : [];
  }
  if (name.type === 'object_pattern' && value.type === 'object') {
    const pair = value.namedChildren.find(v => v.type === 'pair' && v.childForFieldName('value') !== null && onSpine(JS, source, v.childForFieldName('value')!));
    const key = pair?.childForFieldName('key')?.text;
    for (const el of name.namedChildren) {
      if (el.type === 'shorthand_property_identifier_pattern' && el.text === key) return [el.text];
      if (el.type === 'pair_pattern' && el.childForFieldName('key')?.text === key) {
        const v = el.childForFieldName('value');
        return v?.type === 'identifier' ? [v.text] : [];
      }
    }
  }
  return [];
}

/** The call a function-valued assertion argument makes, when its body is exactly one call. */
function jsSoleCall(fn: Node): Node | null {
  let body = fn.childForFieldName('body');
  if (body?.type === 'statement_block') {
    const stmts = body.namedChildren.filter(c => c.type !== 'comment');
    body = stmts.length === 1 && stmts[0].type === 'expression_statement' ? stmts[0].namedChildren[0] ?? null
      : stmts.length === 1 && stmts[0].type === 'return_statement' ? stmts[0].namedChildren[0] ?? null : null;
  }
  if (body?.type === 'await_expression') body = body.namedChildren[0] ?? null;
  return body && (body.type === 'call_expression' || body.type === 'new_expression') ? body : null;
}

const JS_SPINE_WRAPPERS = new Set(['await_expression', 'parenthesized_expression', 'as_expression', 'non_null_expression',
  'satisfies_expression', 'type_assertion', 'unary_expression', 'binary_expression', 'template_substitution', 'template_string']);

const JS: Lang = {
  identifierTypes: new Set(['identifier', 'shorthand_property_identifier']),
  spineStep(parent, child) {
    if (JS_SPINE_WRAPPERS.has(parent.type)) return true;
    if (parent.type === 'ternary_expression') return !sameNode(parent.childForFieldName('condition') ?? parent, child);
    if (parent.type === 'member_expression' || parent.type === 'subscript_expression') {
      const obj = parent.childForFieldName('object');
      return obj !== null && sameNode(obj, child);
    }
    if (parent.type === 'call_expression') {
      const fn = parent.childForFieldName('function');
      return fn !== null && sameNode(fn, child);
    }
    return false;
  },
  context(root) {
    const localNames = new Set<string>();
    for (const n of walk(root)) {
      if (n.type === 'variable_declarator') {
        // `const { add } = await import('./m')` / `require('./m')` binds the symbol, not a local.
        const value = n.childForFieldName('value');
        if (value && /^(?:await\s+)?(?:import|require)\s*\(/.test(value.text)) continue;
        for (const id of identifiersIn(n.childForFieldName('name'), JS_DECL_NAME_TYPES)) localNames.add(id);
      } else if (n.type === 'function_declaration' || n.type === 'class_declaration' || n.type === 'method_definition') {
        const name = n.childForFieldName('name')?.text;
        if (name) localNames.add(name);
      } else if (n.type === 'formal_parameters') {
        for (const id of identifiersIn(n, JS_DECL_NAME_TYPES)) localNames.add(id);
      } else if (n.type === 'arrow_function') {
        const p = n.childForFieldName('parameter');
        if (p?.type === 'identifier') localNames.add(p.text);
      } else if (n.type === 'for_in_statement') {
        for (const id of identifiersIn(n.childForFieldName('left'), JS_DECL_NAME_TYPES)) localNames.add(id);
      } else if (n.type === 'catch_clause') {
        for (const id of identifiersIn(n.childForFieldName('parameter'), JS_DECL_NAME_TYPES)) localNames.add(id);
      }
    }
    return { assertReceivers: new Set(['assert', 'expect']), testingParams: new Set(), localNames };
  },
  isAssertionCall: (name, receiver) => (receiver === null && JS_ASSERT_ROOTS.has(name))
    || (receiver?.type === 'identifier' && (JS_ASSERT_ROOTS.has(receiver.text) || receiver.text === 'chai')),
  looksLikeAssertion: (name, receiver) => /^(?:should|check|verify|validate|ensure|must|expectThat|assertThat)/i.test(name)
    || (receiver?.type === 'identifier' && /^should$/i.test(receiver.text)),
  bindings(source, body) {
    for (let p: Node | null = source; p && p.id !== body.id; p = p.parent) {
      if (JS_FN_TYPES.has(p.type) && p.id !== source.id) return null;
      if (p.type === 'variable_declarator') {
        const value = p.childForFieldName('value');
        const name = p.childForFieldName('name');
        // `const r = f(add())` binds f's result, not add's: only a value on the call's spine is bound.
        const names = name?.type === 'identifier'
          ? (value && onSpine(JS, source, value) ? [name.text] : [])
          : jsPatternNames(name, value, source);
        return { names, from: line(p), to: p.endPosition.row + 1 };
      }
      if (p.type === 'assignment_expression' || p.type === 'augmented_assignment_expression') {
        const left = p.childForFieldName('left');
        const right = p.childForFieldName('right');
        const names = left?.type === 'identifier' && right && onSpine(JS, source, right) ? [left.text] : [];
        return { names, from: line(p), to: p.endPosition.row + 1 };
      }
    }
    return null;
  },
  cases(root) {
    const out: Case[] = [];
    for (const n of walk(root)) {
      if (n.type !== 'call_expression') continue;
      const r = jsRoot(n);
      if (!r || !JS_CASES.has(r)) continue;
      const args = n.childForFieldName('arguments')?.namedChildren ?? [];
      const title = jsTitle(args[0]);
      const fn = args.find(a => JS_FN_TYPES.has(a.type));
      const body = fn?.childForFieldName('body');
      if (title === null || !fn || !body) continue;
      const suites: string[] = [];
      let skipped = jsSkipMarker(n);
      for (let p = n.parent; p; p = p.parent) {
        if (p.type !== 'call_expression') continue;
        const pr = jsRoot(p);
        const pt = jsTitle(p.childForFieldName('arguments')?.namedChildren[0]);
        if (pr && JS_SUITES.has(pr) && pt !== null) { suites.unshift(pt); skipped ??= jsSkipMarker(p); }
      }
      out.push({ name: [...suites, title].join(' > '), fn, body, ...(skipped ? { skipped } : {}) });
    }
    return out;
  },
  functions(root) {
    // Module-level functions only: a function nested in one test is never resolved by name from another.
    const topLevel = (n: Node): boolean => {
      for (let p = n.parent; p; p = p.parent) {
        if (p.type === 'program') return true;
        if (!['export_statement', 'lexical_declaration', 'variable_declaration'].includes(p.type)) return false;
      }
      return false;
    };
    const out: FileFn[] = [];
    for (const n of walk(root)) {
      if (!topLevel(n)) continue;
      if (n.type === 'function_declaration') {
        const name = n.childForFieldName('name')?.text;
        const body = n.childForFieldName('body');
        if (name && body) out.push({ name, fn: n, body });
      } else if (n.type === 'variable_declarator') {
        const name = n.childForFieldName('name');
        const value = n.childForFieldName('value');
        const body = value && JS_FN_TYPES.has(value.type) ? value.childForFieldName('body') : null;
        if (name?.type === 'identifier' && value && body) out.push({ name: name.text, fn: value, body });
      }
    }
    return out;
  },
  callee(n) {
    if (n.type === 'new_expression') {
      const c = n.childForFieldName('constructor');
      if (c?.type === 'identifier') return { name: c.text, receiver: null };
      const prop = c?.type === 'member_expression' ? c.childForFieldName('property')?.text : undefined;
      return prop ? { name: prop, receiver: c!.childForFieldName('object') } : null;
    }
    if (n.type !== 'call_expression') return null;
    const fn = n.childForFieldName('function');
    if (fn?.type === 'identifier') return { name: fn.text, receiver: null };
    const prop = fn?.type === 'member_expression' ? fn.childForFieldName('property')?.text : undefined;
    return prop ? { name: prop, receiver: fn!.childForFieldName('object') } : null;
  },
  callArgs(n) {
    return n.childForFieldName('arguments')?.namedChildren ?? [];
  },
  assertions(body) {
    const out: Assertion[] = [];
    for (const n of walk(body)) {
      if (n.type !== 'call_expression') continue;
      const fn = n.childForFieldName('function');
      const obj = fn?.type === 'member_expression' ? fn.childForFieldName('object') : null;
      const isRoot = fn?.type === 'identifier' && JS_ASSERT_ROOTS.has(fn.text);
      const isMember = obj?.type === 'identifier' && (JS_ASSERT_ROOTS.has(obj.text)
        || (obj.text === 'chai' && JS_ASSERT_ROOTS.has(fn!.childForFieldName('property')?.text ?? '')));
      if (!isRoot && !isMember) continue;
      // An assertion inside a callback (`setTimeout`, `.then`) may never run before the test ends, and
      // one inside a `try` whose handler swallows the failure never fails the test.
      if (inNestedFunction(n, body, JS_FN_TYPES) || jsSwallowed(n, body)) continue;
      const args = this.callArgs(n);
      const method = isRoot ? fn!.text : fn!.childForFieldName('property')?.text ?? '';
      // `expect.objectContaining(…)`, `expect.any(…)`: asymmetric matchers are values inside another
      // assertion, not assertions. `expect.soft` / `expect.poll` are; `expect.assertions(n)` checks no value.
      if (isMember && obj!.text === 'expect' && !['soft', 'poll'].includes(method)) continue;
      // The matcher chain after `expect(actual)`.
      const chain: Node[] = [];
      let cur: Node = n;
      while (cur.parent && (cur.parent.type === 'member_expression'
        || (cur.parent.type === 'call_expression' && cur.parent.childForFieldName('function')?.id === cur.id)
        || cur.parent.type === 'await_expression')) {
        cur = cur.parent;
        if (cur.type === 'member_expression') chain.push(cur);
      }
      const matchers = chain.map(m => m.childForFieldName('property')?.text ?? '');
      const throws = matchers.some(m => JS_THROW_MATCHERS.test(m));
      const mockMatcher = matchers.some(m => JS_MOCK_MATCHERS.test(m));
      const expectForm = method === 'expect' || method === 'poll' || method === 'soft';
      // `expect(x)` alone, or `expect(x).toBeDefined` never called, checks nothing; a chai property
      // assertion (`.to.be.true`) is one only from a closed list.
      const called = chain.some(m => m.parent?.type === 'call_expression' && sameNode(m.parent.childForFieldName('function') ?? m, m));
      if (expectForm && !called && !JS_CHAI_PROPS.has(matchers.at(-1) ?? '')) continue;
      if (/^(?:throws|rejects|doesNotThrow|doesNotReject)$/.test(method) && !isRoot) {
        // `assert.throws(() => add())`: only the function's one call, and only that call raising.
        const actual = args[0];
        const sole = actual && JS_FN_TYPES.has(actual.type) ? jsSoleCall(actual)
          : actual && (actual.type === 'call_expression' || actual.type === 'await_expression') ? actual : null;
        if (sole) out.push({ value: sole, line: line(n), exact: true });
        continue;
      }
      if (expectForm) {
        const actual = args[0];
        if (actual && JS_FN_TYPES.has(actual.type)) {
          // `expect(() => add()).toThrow()` / `expect.poll(() => add())`: the function's one call.
          const sole = jsSoleCall(actual);
          if (sole) out.push({ value: sole, line: line(n), exact: throws });
        } else if (actual && !mockMatcher) {
          out.push({ value: actual, line: line(n), ...(throws ? { exact: true } : {}) });
        }
      } else {
        // `assert(value, message)` / `assert.equal(a, b, msg)`: the compared values, never the message.
        for (const i of method === 'assert' ? [0] : valuePositions(method)) if (args[i]) out.push({ value: args[i], line: line(n) });
      }
      // Every matcher argument is an expected value, except a mock matcher's (a call record).
      if (!mockMatcher) {
        for (const m of chain) {
          const call = m.parent?.type === 'call_expression' && m.parent.childForFieldName('function')?.id === m.id ? m.parent : null;
          if (call) for (const a of this.callArgs(call)) out.push({ value: a, line: line(n) });
        }
      }
    }
    return out;
  },
  returns(body) {
    if (body.type !== 'statement_block') return [body]; // an arrow function's expression body
    const out: Node[] = [];
    for (const n of walk(body)) if (n.type === 'return_statement' && n.namedChildren[0]) out.push(n.namedChildren[0]);
    return out;
  },
};

const PY_IDS: ReadonlySet<string> = new Set(['identifier']);
/** unittest's assertion methods (a closed list: a user helper named `assert_x` is not one). */
const PY_UNITTEST_ASSERT = /^assert(?:Equal|NotEqual|True|False|Is|IsNot|IsNone|IsNotNone|In|NotIn|IsInstance|NotIsInstance|AlmostEqual|NotAlmostEqual|Greater|GreaterEqual|Less|LessEqual|Regex|NotRegex|CountEqual|DictEqual|ListEqual|TupleEqual|SetEqual|SequenceEqual|MultiLineEqual|Raises|RaisesRegex|Warns|WarnsRegex|Logs|NoLogs)$/;
/** A mock's call-record assertions: they assert no value of the symbol. */
const PY_MOCK_ASSERT = /^assert_(?:called\w*|any_call|has_calls|not_called|awaited\w*|has_awaits|any_await|not_awaited)$/;
/** Inside `body`, is `n` in a `try` whose broad handler (`except:`, `except Exception`, `except AssertionError`) does not re-raise? */
function pySwallowed(n: Node, body: Node): boolean {
  for (let p = n.parent; p && p.id !== body.id; p = p.parent) {
    if (p.type !== 'block' || p.parent?.type !== 'try_statement' || !sameNode(p.parent.childForFieldName('body') ?? p, p)) continue;
    for (const h of p.parent.namedChildren.filter(c => c.type === 'except_clause')) {
      const head = h.text.split('\n')[0];
      const broad = /^except\s*(?::|\(?\s*(?:BaseException|Exception|AssertionError)\b)/.test(head);
      if (broad && ![...walk(h)].some(c => c.type === 'raise_statement')) return true;
    }
  }
  return false;
}

/** The call a statement makes when the statement is exactly that call (or `x = call`). */
function pySoleCall(stmt: Node | undefined): Node | null {
  let e = stmt?.type === 'expression_statement' ? stmt.namedChildren[0] : stmt;
  if (e?.type === 'assignment') e = e.childForFieldName('right') ?? undefined;
  if (e?.type === 'await') e = e.namedChildren[0];
  return e?.type === 'call' ? e : null;
}

const PY_SPINE_WRAPPERS = new Set(['await', 'parenthesized_expression', 'not_operator', 'boolean_operator',
  'comparison_operator', 'binary_operator', 'unary_operator']);

const PY: Lang = {
  identifierTypes: new Set(['identifier']),
  spineStep(parent, child) {
    if (PY_SPINE_WRAPPERS.has(parent.type)) return true;
    if (parent.type === 'conditional_expression') return !sameNode(parent.namedChildren[1] ?? parent, child);
    if (parent.type === 'attribute') { const o = parent.childForFieldName('object'); return o !== null && sameNode(o, child); }
    if (parent.type === 'subscript') { const v = parent.childForFieldName('value'); return v !== null && sameNode(v, child); }
    if (parent.type === 'call') { const f = parent.childForFieldName('function'); return f !== null && sameNode(f, child); }
    return false;
  },
  context(root) {
    const localNames = new Set<string>();
    for (const n of walk(root)) {
      if (n.type === 'assignment' || n.type === 'augmented_assignment') {
        for (const id of identifiersIn(n.childForFieldName('left'), PY_IDS)) localNames.add(id);
      } else if (n.type === 'function_definition' || n.type === 'class_definition') {
        const name = n.childForFieldName('name')?.text;
        if (name) localNames.add(name);
      } else if (n.type === 'parameters' || n.type === 'lambda_parameters') {
        for (const id of identifiersIn(n, PY_IDS)) localNames.add(id);
      } else if (n.type === 'for_statement' || n.type === 'for_in_clause') {
        for (const id of identifiersIn(n.childForFieldName('left'), PY_IDS)) localNames.add(id);
      } else if (n.type === 'as_pattern') {
        for (const id of identifiersIn(n.childForFieldName('alias'), PY_IDS)) localNames.add(id);
      } else if (n.type === 'except_clause') {
        // `except E as add`: the name after `as`.
        const m = /\bas\s+(\w+)\s*:?\s*$/.exec(n.text.split('\n')[0]);
        if (m) localNames.add(m[1]);
      }
    }
    return { assertReceivers: new Set(), testingParams: new Set(), localNames };
  },
  isAssertionCall: (name) => PY_UNITTEST_ASSERT.test(name) || PY_MOCK_ASSERT.test(name),
  looksLikeAssertion: (name) => /^(?:should|check|verify|validate|ensure|expect|must)/i.test(name),
  bindings(source, body) {
    for (let p: Node | null = source; p && p.id !== body.id; p = p.parent) {
      if (p.type === 'function_definition' || p.type === 'lambda') return null;
      if (p.type === 'assignment' || p.type === 'augmented_assignment') {
        const left = p.childForFieldName('left');
        const right = p.childForFieldName('right');
        const span = { from: line(p), to: p.endPosition.row + 1 };
        // `r, other = add(1), 7` pairs element by element; `a, b = add(1)` binds both.
        const lefts = left && (left.type === 'pattern_list' || left.type === 'tuple_pattern') ? left.namedChildren : null;
        const rights = right && (right.type === 'expression_list' || right.type === 'tuple') ? right.namedChildren : null;
        if (lefts && rights && lefts.length === rights.length) {
          const i = rights.findIndex(r => onSpine(PY, source, r));
          return { names: i >= 0 ? identifiersIn(lefts[i], PY_IDS) : [], ...span };
        }
        // `a, b = add(1)` binds both; `r = f(add(1))` binds nothing of add's.
        return { names: right && onSpine(PY, source, right) ? identifiersIn(left, PY_IDS) : [], ...span };
      }
    }
    return null;
  },
  cases(root) {
    const out: Case[] = [];
    for (const n of walk(root)) {
      if (n.type !== 'function_definition') continue;
      const name = n.childForFieldName('name')?.text ?? '';
      const body = n.childForFieldName('body');
      if (!/^test/.test(name) || !body) continue;
      let nested = false;
      for (let p = n.parent; p && !nested; p = p.parent) nested = p.type === 'function_definition';
      if (nested) continue;
      let cls: Node | null = null;
      for (let p = n.parent; p && !cls; p = p.parent) if (p.type === 'class_definition') cls = p;
      const clsName = cls?.childForFieldName('name')?.text;
      const decorators = [n, cls].flatMap(d => d?.parent?.type === 'decorated_definition' ? d.parent.namedChildren.filter(c => c.type === 'decorator').map(c => c.text) : []);
      const skipDecorator = decorators.find(d => /\b(?:mark\.(?:skip|skipif|xfail)|unittest\.(?:skip\w*|expectedFailure)|skip(?:If|Unless)?|expectedFailure)\b/.test(d));
      const skipped = skipDecorator ?? (/\b(?:pytest\.skip|self\.skipTest)\s*\(/.test(body.text) ? 'skip()'
        : /^pytestmark\s*=.*\b(?:skip|skipif|xfail)\b/m.test(root.text) ? 'pytestmark' : undefined);
      out.push({ name: clsName ? `${clsName}.${name}` : name, fn: n, body, ...(skipped ? { skipped } : {}) });
    }
    return out;
  },
  functions(root) {
    // Module-level functions only: a function nested in one test is never resolved by name from another.
    const out: FileFn[] = [];
    for (const n of root.namedChildren) {
      const def = n.type === 'decorated_definition' ? n.childForFieldName('definition') : n;
      if (def?.type !== 'function_definition') continue;
      const name = def.childForFieldName('name')?.text;
      const body = def.childForFieldName('body');
      if (name && body) out.push({ name, fn: def, body });
    }
    return out;
  },
  callee(n) {
    if (n.type !== 'call') return null;
    const fn = n.childForFieldName('function');
    if (fn?.type === 'identifier') return { name: fn.text, receiver: null };
    const attr = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : undefined;
    return attr ? { name: attr, receiver: fn!.childForFieldName('object') } : null;
  },
  callArgs(n) {
    return (n.childForFieldName('arguments')?.namedChildren ?? []).map(a => a.type === 'keyword_argument' ? a.childForFieldName('value') ?? a : a);
  },
  assertions(body) {
    const out: Assertion[] = [];
    const nested = new Set(['function_definition', 'lambda']);
    for (const n of walk(body)) {
      if ((n.type === 'assert_statement' || n.type === 'call' || n.type === 'with_statement') && (inNestedFunction(n, body, nested) || pySwallowed(n, body))) continue;
      if (n.type === 'assert_statement') {
        const cond = n.namedChildren[0]; // the condition, not the message
        if (cond) out.push({ value: cond, line: line(n) });
      } else if (n.type === 'call') {
        const fn = n.childForFieldName('function');
        const last = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : fn?.type === 'identifier' ? fn.text : undefined;
        // A closed list of unittest assertions; a mock's call-record assertions assert no value of the
        // symbol, and `assertRaises(E, f, *args)` passes `f` as a value (no call to classify).
        if (!last || !PY_UNITTEST_ASSERT.test(last) || /^assert(?:Raises|Warns|Logs|NoLogs)/.test(last)) continue;
        // Positional values only: a `msg=` keyword or a trailing message is not an asserted value.
        const positional = (n.childForFieldName('arguments')?.namedChildren ?? []).filter(a => a.type !== 'keyword_argument');
        for (const i of valuePositions(last)) if (positional[i]) out.push({ value: positional[i], line: line(n) });
      } else if (n.type === 'with_statement') {
        // `with pytest.raises(E): subject()` asserts on what the block's LAST statement does; earlier
        // statements in the block are setup.
        const items = n.namedChildren.find(c => c.type === 'with_clause');
        const raises = items && /\b(?:pytest\.(?:raises|warns)|self\.assert(?:Raises|Warns)\w*)\s*\(/.test(items.text);
        const block = n.childForFieldName('body');
        // Only a block whose last statement IS one call asserts that this call raises.
        const sole = pySoleCall(block?.namedChildren.filter(c => c.type !== 'comment').at(-1));
        if (raises && sole) out.push({ value: sole, line: line(n), exact: true });
      }
    }
    return out;
  },
  returns(body) {
    const out: Node[] = [];
    for (const n of walk(body)) if (n.type === 'return_statement' && n.namedChildren[0]) out.push(n.namedChildren[0]);
    return out;
  },
};

const GO_FAIL = /^(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)$/;

const GO_IDS: ReadonlySet<string> = new Set(['identifier']);
const GO_TESTIFY_METHODS = /^(?:Equal|NotEqual|EqualValues|Exactly|Same|NotSame|Contains|NotContains|ElementsMatch|Len|True|False|Nil|NotNil|NoError|Error|ErrorIs|ErrorContains|Empty|NotEmpty|Zero|NotZero|Greater|GreaterOrEqual|Less|LessOrEqual|InDelta|Panics|NotPanics|JSONEq|Regexp)$/;

const GO: Lang = {
  identifierTypes: new Set(['identifier']),
  spineStep(parent, child) {
    if (parent.type === 'parenthesized_expression' || parent.type === 'unary_expression' || parent.type === 'binary_expression') return true;
    if (parent.type === 'selector_expression' || parent.type === 'index_expression' || parent.type === 'type_assertion_expression') {
      const o = parent.childForFieldName('operand');
      return o !== null && sameNode(o, child);
    }
    if (parent.type === 'call_expression') { const f = parent.childForFieldName('function'); return f !== null && sameNode(f, child); }
    return false;
  },
  context(root) {
    const localNames = new Set<string>();
    const testingParams = new Set<string>();
    const assertReceivers = new Set<string>(['assert', 'require']);
    for (const n of walk(root)) {
      if (n.type === 'parameter_declaration') {
        const names = n.childrenForFieldName?.('name') ?? [];
        const typed = /^\*testing\.[TBF]$/.test(n.childForFieldName('type')?.text ?? '');
        for (const nm of names) { localNames.add(nm.text); if (typed) testingParams.add(nm.text); }
      } else if (n.type === 'short_var_declaration' || n.type === 'assignment_statement') {
        const left = identifiersIn(n.childForFieldName('left'), GO_IDS);
        for (const id of left) localNames.add(id);
        // `a := assert.New(t)`: `a.Equal(…)` is a testify assertion without `t`.
        if (/^(?:assert|require)\.New\s*\(/.test(n.childForFieldName('right')?.text ?? '')) for (const id of left) assertReceivers.add(id);
      } else if (n.type === 'var_spec') {
        for (const nm of n.childrenForFieldName?.('name') ?? []) localNames.add(nm.text);
      }
    }
    return { assertReceivers, testingParams, localNames };
  },
  isAssertionCall: (_name, receiver, ctx) => receiver?.type === 'identifier' && ctx.assertReceivers.has(receiver.text),
  looksLikeAssertion: (name, receiver, ctx) => GO_TESTIFY_METHODS.test(name) && !(receiver?.type === 'identifier' && ctx.assertReceivers.has(receiver.text)),
  bindings(source, body) {
    for (let p: Node | null = source; p && p.id !== body.id; p = p.parent) {
      if (p.type === 'func_literal') return null;
      if (p.type === 'short_var_declaration' || p.type === 'assignment_statement' || p.type === 'var_spec') {
        const left = p.childForFieldName('left') ?? null;
        const right = p.childForFieldName('right') ?? p.childForFieldName('value');
        const span = { from: line(p), to: p.endPosition.row + 1 };
        const lefts = left ? left.namedChildren : (p.childrenForFieldName?.('name') ?? []);
        const rights = right ? (right.type === 'expression_list' ? right.namedChildren : [right]) : [];
        // `got, want := Sym(), 3` pairs element by element; `x, err := Sym()` binds both.
        if (rights.length > 1 && lefts.length === rights.length) {
          const i = rights.findIndex(r => onSpine(GO, source, r));
          return { names: i >= 0 ? identifiersIn(lefts[i], GO_IDS) : [], ...span };
        }
        // `x, err := Sym()` binds both; `x := f(Sym())` binds nothing of Sym's.
        return { names: rights.length === 1 && onSpine(GO, source, rights[0]) ? lefts.flatMap(l => identifiersIn(l, GO_IDS)) : [], ...span };
      }
    }
    return null;
  },
  cases(root) {
    const out: Case[] = [];
    const tParams = (fn: Node): string[] => {
      const params = fn.childForFieldName('parameters');
      return (params?.namedChildren ?? []).filter(p => /^\*testing\.[TBF]$/.test(p.childForFieldName('type')?.text ?? ''))
        .flatMap(p => (p.childrenForFieldName?.('name') ?? []).map(x => x.text));
    };
    // `t.Skip()` anywhere in the test turns it off (conservatively, even under a condition).
    const skipIn = (body: Node, ts: string[]): string | undefined => [...walk(body)].find(c => {
      if (c.type !== 'call_expression') return false;
      const f = c.childForFieldName('function');
      const recv = f?.type === 'selector_expression' ? f.childForFieldName('operand') : null;
      return recv?.type === 'identifier' && ts.includes(recv.text) && /^Skip(?:f|Now)?$/.test(f!.childForFieldName('field')?.text ?? '');
    })?.text;
    for (const n of root.namedChildren) {
      if (n.type !== 'function_declaration') continue;
      const name = n.childForFieldName('name')?.text ?? '';
      const body = n.childForFieldName('body');
      if (!/^Test(?:$|[^a-z])/.test(name) || !body) continue;
      const ts = tParams(n);
      const skipped = skipIn(body, ts);
      out.push({ name, fn: n, body, ...(skipped ? { skipped } : {}) });
      // Each `t.Run(name, func(t *testing.T) {…})` is a case of its own: its closure's data flow is
      // not in the enclosing test's overlay.
      let i = 0;
      for (const c of walk(body)) {
        if (c.type !== 'call_expression') continue;
        const f = c.childForFieldName('function');
        const recv = f?.type === 'selector_expression' ? f.childForFieldName('operand') : null;
        if (!(recv?.type === 'identifier' && ts.includes(recv.text) && f!.childForFieldName('field')?.text === 'Run')) continue;
        const args = c.childForFieldName('arguments')?.namedChildren ?? [];
        const lit = args[1];
        const litBody = lit?.type === 'func_literal' ? lit.childForFieldName('body') : null;
        if (!lit || !litBody) continue;
        i++;
        const title = args[0]?.type === 'interpreted_string_literal' ? args[0].text.slice(1, -1) : `#${i}`;
        const subSkipped = skipped ?? skipIn(litBody, tParams(lit));
        out.push({ name: `${name}/${title}`, fn: lit, body: litBody, ...(subSkipped ? { skipped: subSkipped } : {}) });
      }
    }
    return out;
  },
  functions(root) {
    const out: FileFn[] = [];
    for (const n of root.namedChildren) {
      if (n.type !== 'function_declaration') continue;
      const name = n.childForFieldName('name')?.text;
      const body = n.childForFieldName('body');
      if (name && body) out.push({ name, fn: n, body });
    }
    return out;
  },
  callee(n) {
    if (n.type !== 'call_expression') return null;
    const fn = n.childForFieldName('function');
    if (fn?.type === 'identifier') return { name: fn.text, receiver: null };
    const field = fn?.type === 'selector_expression' ? fn.childForFieldName('field')?.text : undefined;
    return field ? { name: field, receiver: fn!.childForFieldName('operand') } : null;
  },
  callArgs(n) {
    return n.childForFieldName('arguments')?.namedChildren ?? [];
  },
  assertions(body, ctx) {
    const out: Assertion[] = [];
    // A subtest's closure (`t.Run(name, func(t *testing.T) {…})`) runs; any other closure may not.
    const isSubtest = (fn: Node): boolean => {
      const call = fn.parent?.parent;
      const f = call?.type === 'call_expression' ? call.childForFieldName('function') : null;
      const recv = f?.type === 'selector_expression' ? f.childForFieldName('operand') : null;
      return recv?.type === 'identifier' && ctx.testingParams.has(recv.text) && f!.childForFieldName('field')?.text === 'Run';
    };
    const nested = new Set(['func_literal']);
    for (const n of walk(body)) {
      if ((n.type === 'call_expression' || n.type === 'if_statement') && inNestedFunction(n, body, nested, isSubtest)) continue;
      if (n.type === 'call_expression') {
        const fn = n.childForFieldName('function');
        const operand = fn?.type === 'selector_expression' ? fn.childForFieldName('operand') : null;
        if (operand?.type === 'identifier' && ctx.assertReceivers.has(operand.text)) {
          // `assert.Equal(t, want, got, msg…)` skips `t`; `a := assert.New(t); a.Equal(want, got)` does not.
          const args = this.callArgs(n);
          const values = operand.text === 'assert' || operand.text === 'require' ? args.slice(1) : args;
          for (const i of valuePositions(fn!.childForFieldName('field')?.text ?? '')) if (values[i]) out.push({ value: values[i], line: line(n) });
        }
      } else if (n.type === 'if_statement') {
        // `if got != want { t.Errorf(…) }`: the condition (and its initializer) is what is asserted —
        // only when the failure is reported on the test's own `*testing.T` (never `fmt.Errorf`, `log.Fatal`).
        // The failure must be a direct statement of this `if`, not inside a nested `if` or closure.
        const consequence = n.childForFieldName('consequence');
        // tree-sitter-go wraps a block's statements in a `statement_list`.
        const stmts = consequence?.namedChildren.flatMap(c => c.type === 'statement_list' ? c.namedChildren : [c]) ?? [];
        const fails = stmts.some(stmt => {
          const c = stmt.type === 'expression_statement' ? stmt.namedChildren[0] : stmt;
          if (c?.type !== 'call_expression') return false;
          const f = c.childForFieldName('function');
          const recv = f?.type === 'selector_expression' ? f.childForFieldName('operand') : null;
          return recv?.type === 'identifier' && ctx.testingParams.has(recv.text) && GO_FAIL.test(f!.childForFieldName('field')?.text ?? '');
        });
        if (!fails) continue;
        // The condition is asserted; the initializer's bindings (`if got := Sym(); got != 9`) reach it
        // through def-use.
        const cond = n.childForFieldName('condition');
        if (cond) out.push({ value: cond, line: line(n) });
      }
    }
    return out;
  },
  returns(body) {
    const out: Node[] = [];
    for (const n of walk(body)) if (n.type === 'return_statement' && n.namedChildren[0]) out.push(n.namedChildren[0]);
    return out;
  },
};

const LANGS: Record<string, Lang> = { TypeScript: JS, JavaScript: JS, Python: PY, Go: GO };

// ── Classifying one test body ───────────────────────────────────────────────────

/**
 * Which calls in one test file are calls to the symbol. A bare call by name is, unless the test file
 * declares that name itself (a local function, variable or parameter shadows it); the file is already
 * linked to the symbol by the index. A member call (`x.name(…)`) is only when its receiver is provably
 * the symbol's: an instance of its class (`new C()`, a variable assigned from one, `C.` for a static),
 * or a namespace the file imports from the symbol's own module. A same-named method on another object
 * (`map.delete(k)` against a production `delete`) is not a call to the symbol, and neither is an
 * assertion call (`expect(…)` against a production `expect`).
 */
interface CallTarget {
  name: string;
  /** Local names a bare call may use for the symbol: the names the file imports it as. */
  bareNames: ReadonlySet<string>;
  receiverOk(receiver: Node, body: Node): boolean;
}

/**
 * Everything about one parsed test file that does not depend on the symbol: its cases, its helpers,
 * which helpers assert on a parameter, its calls by name, and per-function CFGs. Built once per tree,
 * so classifying the file against many changed symbols costs lookups, not re-walks.
 */
interface FileAnalysis {
  ctx: FileContext;
  cases: Case[];
  helpers: Map<string, FileFn>;
  assertingParams: Map<string, Set<number>>;
  /** Some test case or helper in the file makes an assertion a recognizer knows. */
  recognized: boolean;
  callsIn(body: Node, target: CallTarget): Node[];
  bareCallsIn(body: Node, name: string): Node[];
  /** Every call in `body`, with its name and receiver. */
  allCallsIn(body: Node): Array<{ node: Node; name: string; receiver: Node | null }>;
  assertionsOf(body: Node): Assertion[];
  cfgOf(fn: Node): FunctionCfg | undefined;
}

const fileAnalyses = new WeakMap<Node, FileAnalysis>();

function analyzeFile(lang: Lang, language: string, root: Node): FileAnalysis {
  const cached = fileAnalyses.get(root);
  if (cached) return cached;
  const ctx = lang.context(root);
  // Each call once, with its span as plain numbers: reading a node's span is a native call, and
  // bucketing per body below keeps a file of thousands of cases linear.
  const calls: Array<{ node: Node; name: string; receiver: Node | null; start: number; end: number }> = [];
  for (const n of walk(root)) {
    const c = lang.callee(n);
    if (c) calls.push({ node: n, name: c.name, receiver: c.receiver, start: n.startIndex, end: n.endIndex });
  }
  calls.sort((a, b) => a.start - b.start);
  const callsByBody = new Map<number, typeof calls>();
  const callsOfBody = (body: Node): typeof calls => {
    let hit = callsByBody.get(body.id);
    if (!hit) {
      const from = body.startIndex, to = body.endIndex;
      let lo = 0, hi = calls.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (calls[mid].start < from) lo = mid + 1; else hi = mid; }
      hit = [];
      for (let i = lo; i < calls.length && calls[i].start < to; i++) if (calls[i].end <= to) hit.push(calls[i]);
      callsByBody.set(body.id, hit);
    }
    return hit;
  };
  const cfgs = new Map<number, FunctionCfg | undefined>();
  const cfgOf = (fn: Node): FunctionCfg | undefined => {
    if (!cfgs.has(fn.id)) cfgs.set(fn.id, cfgFor(fn, language));
    return cfgs.get(fn.id);
  };
  const assertionCache = new Map<number, Assertion[]>();
  const assertionsOf = (body: Node): Assertion[] => {
    if (!assertionCache.has(body.id)) assertionCache.set(body.id, lang.assertions(body, ctx));
    return assertionCache.get(body.id)!;
  };
  const cases = lang.cases(root);
  const caseFns = new Set(cases.map(c => c.fn.id));
  const helpers = new Map<string, FileFn>();
  for (const f of lang.functions(root)) if (!caseFns.has(f.fn.id) && !helpers.has(f.name)) helpers.set(f.name, f);

  // An assertion helper asserts on one of its parameters.
  const assertingParams = new Map<string, Set<number>>();
  for (const [name, h] of helpers) {
    const asserted = assertionsOf(h.body);
    if (asserted.length === 0) continue;
    const params = paramNames(h.fn);
    const cfg = cfgOf(h.fn);
    const idx = new Set<number>();
    params.forEach((p, i) => {
      if (asserted.some(a => !a.exact && derivedFrom(lang, cfg, h.body, [], a.value, [p]))) idx.add(i);
    });
    if (idx.size > 0) assertingParams.set(name, idx);
  }

  const analysis: FileAnalysis = {
    ctx,
    cases,
    helpers,
    assertingParams,
    // A recognized assertion CALL, value or not (`expect(spy).toHaveBeenCalled()` asserts no value).
    recognized: cases.some(c => assertionsOf(c.body).length > 0) || [...helpers.values()].some(h => assertionsOf(h.body).length > 0)
      || calls.some(c => lang.isAssertionCall(c.name, c.receiver, ctx)),
    callsIn: (body, target) => callsOfBody(body)
      .filter(c => !lang.isAssertionCall(c.name, c.receiver, ctx) && (c.receiver === null
        // A bare call by a name the file imports the symbol as, and never declares itself.
        ? target.bareNames.has(c.name) && !ctx.localNames.has(c.name)
        : c.name === target.name && target.receiverOk(c.receiver, body)))
      .map(c => c.node),
    // A helper in the same file is reached only by a bare call.
    bareCallsIn: (body, name) => callsOfBody(body).filter(c => c.name === name && c.receiver === null).map(c => c.node),
    allCallsIn: (body) => callsOfBody(body),
    assertionsOf,
    cfgOf,
  };
  fileAnalyses.set(root, analysis);
  return analysis;
}

const posixPath = (p: string): string => p.replace(/\\/g, '/');
const withoutExt = (p: string): string => p.replace(/\.(?:[cm]?[jt]sx?|py|go)$/i, '');

/** POSIX `dirname`. */
function dirOf(p: string): string {
  const q = posixPath(p);
  const i = q.lastIndexOf('/');
  return i < 0 ? '' : q.slice(0, i);
}

/** Resolve a relative module specifier against the test file's directory (POSIX, no extension). */
function resolveRelative(testPath: string, spec: string): string {
  const parts = dirOf(testPath) ? dirOf(testPath).split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return withoutExt(parts.join('/'));
}

/**
 * The local names this test file binds to the module at `symbolFile`, by import. Only a module the
 * specifier provably names counts: a JS/TS relative specifier that resolves to the symbol's file (or
 * its directory's index); a Python dotted module whose path ends the symbol's path (a single-segment
 * one only from the same directory); a Go import path from a module (a dotted first segment, never
 * the standard library) ending in the symbol's directory.
 */
function moduleBindings(language: string, text: string, symbolFile: string, testPath: string, goModule?: string): Set<string> {
  const target = withoutExt(posixPath(symbolFile));
  const names = new Set<string>();
  if (language === 'TypeScript' || language === 'JavaScript') {
    const fromModule = (spec: string): boolean => {
      if (!spec.startsWith('.')) return false; // a package, never a repository file
      const resolved = resolveRelative(testPath, spec);
      return resolved === target || (target.endsWith('/index') && resolved === target.slice(0, -'/index'.length));
    };
    for (const m of text.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/g)) if (fromModule(m[2])) names.add(m[1]);
    for (const m of text.matchAll(/import\s+([\w$]+)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g)) if (fromModule(m[2])) names.add(m[1]);
    for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) if (fromModule(m[2])) names.add(m[1]);
  } else if (language === 'Python') {
    const testDir = dirOf(testPath);
    const fromModule = (dotted: string): boolean => {
      const rel = dotted.replace(/\./g, '/');
      if (!dotted.includes('.')) return target === rel || target === (testDir ? `${testDir}/${rel}` : rel);
      return target === rel || target.endsWith(`/${rel}`);
    };
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+(\w+))?/gm)) if (fromModule(m[1])) names.add(m[2] ?? m[1]);
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([^\n#]+)/gm)) {
      for (const part of m[3].replace(/[()]/g, '').split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (!name) continue;
        const dotted = m[2] ? `${m[2]}.${name}` : name;
        const ok = m[1] ? (testDir ? `${testDir}/` : '') + dotted.replace(/\./g, '/') === target : fromModule(dotted);
        if (ok) names.add(alias ?? name);
      }
    }
  } else if (language === 'Go') {
    // The import path must be the symbol's package: `<module>/<dir>` when go.mod names the module;
    // otherwise a module path (a dotted first segment) ending in the symbol's whole directory.
    const fullDir = dirOf(target);
    const dir = fullDir.split('/').pop() ?? '';
    for (const m of text.matchAll(/(?:^|[\s(])(?:(\w+|\.)[ \t]+)?"([^"\n]{1,300})"/gm)) {
      const path = m[2];
      const ok = goModule ? path === (fullDir ? `${goModule}/${fullDir}` : goModule)
        : path.split('/')[0].includes('.') && fullDir !== '' && (path.endsWith(`/${fullDir}`));
      if (!ok || m[1] === '.') continue;
      names.add(m[1] ?? dir);
    }
  }
  return names;
}

const perRootCache = new WeakMap<Node, Map<string, Set<string>>>();

/** Memoize a per-tree, per-key name set (instances of a class, bindings of a module). */
function memoOnRoot(root: Node, key: string, build: () => Set<string>): Set<string> {
  // Keyed by a node object: a tree's root, or one case body (re-used across symbols in one file).
  let m = perRootCache.get(root);
  if (!m) perRootCache.set(root, m = new Map());
  let v = m.get(key);
  if (!v) m.set(key, v = build());
  return v;
}

/**
 * The local names this test file imports the symbol itself as (`import { add as plus } from
 * './math'`, `from shop import price`), resolved like {@link moduleBindings}. Go: the symbol's own
 * name when the test is in the symbol's package. A name imported from anywhere else is not the
 * symbol, and a symbol the file does not import is never matched by a bare call (an under-claim).
 */
function importedNames(language: string, text: string, symbol: { name: string; filePath: string }, testPath: string): Set<string> {
  const target = withoutExt(posixPath(symbol.filePath));
  const out = new Set<string>();
  const add = (list: string, sep: RegExp, ok: boolean): void => {
    if (!ok) return;
    for (const part of list.split(',')) {
      const [name, alias] = part.trim().split(sep);
      if (name === symbol.name) out.add((alias ?? name).trim());
    }
  };
  if (language === 'TypeScript' || language === 'JavaScript') {
    const fromModule = (spec: string): boolean => {
      if (!spec.startsWith('.')) return false;
      const resolved = resolveRelative(testPath, spec);
      return resolved === target || (target.endsWith('/index') && resolved === target.slice(0, -'/index'.length));
    };
    for (const m of text.matchAll(/import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]{0,2000})\}\s*from\s*['"]([^'"\n]{1,300})['"]/g)) add(m[1].replace(/\btype\s+/g, ''), /\s+as\s+/, fromModule(m[2]));
    for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]{0,2000})\}\s*=\s*(?:await\s+import|require)\s*\(\s*['"]([^'"\n]{1,300})['"]\s*\)/g)) add(m[1], /\s*:\s*/, fromModule(m[2]));
  } else if (language === 'Python') {
    const testDir = dirOf(testPath);
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([^\n#)]+)/gm)) {
      const mod = m[1] ? withoutExt(`${testDir ? `${testDir}/` : ''}${'../'.repeat(Math.max(0, m[1].length - 1))}${m[2].replace(/\./g, '/')}`) : m[2].replace(/\./g, '/');
      // A single-segment module only from the test's own directory (or the root); a dotted one by suffix.
      const ok = m[1] ? resolveRelative(testPath, `./${'../'.repeat(Math.max(0, m[1].length - 1))}${m[2].replace(/\./g, '/')}`) === target || mod === target
        : m[2].includes('.') ? target === mod || target.endsWith(`/${mod}`)
        : target === mod || target === (testDir ? `${testDir}/${mod}` : mod);
      add(m[3], /\s+as\s+/, ok);
    }
  } else if (language === 'Go') {
    const pkg = /^\s*package\s+(\w+)/m.exec(text)?.[1] ?? '';
    if (dirOf(posixPath(testPath)) === dirOf(target) && !pkg.endsWith('_test')) out.add(symbol.name);
  }
  return out;
}

/** Local names this file assigns from a constructor of `cls`: its instances. */
function instancesOf(language: string, root: Node, cls: string, ctorNames: ReadonlySet<string>): Set<string> {
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // every regex metacharacter
  const names = [...ctorNames].map(esc).join('|');
  const factories = [...ctorNames].map(n => esc(n.includes('.') ? n.replace(/\.([^.]+)$/, '.New$1') : `New${n}`)).join('|');
  const ctor = language === 'Python' ? new RegExp(`^(?:${names})\\s*\\(`)
    : language === 'Go' ? new RegExp(`^(?:&?(?:${names})\\s*\\{|(?:${factories})\\s*\\()`)
    : new RegExp(`^(?:await\\s+)?new\\s+(?:${names})\\s*[(<]`);
  void cls;
  const out = new Set<string>();
  const assigned = new Map<string, number>();
  for (const n of walk(root)) {
    let pairs: Array<[Node | null, Node | null]> = [];
    if (n.type === 'variable_declarator') pairs = [[n.childForFieldName('name'), n.childForFieldName('value')]];
    else if (n.type === 'assignment_expression' || n.type === 'assignment') pairs = [[n.childForFieldName('left'), n.childForFieldName('right')]];
    else if (n.type === 'short_var_declaration' || n.type === 'assignment_statement') {
      const l = n.childForFieldName('left')?.namedChildren ?? [];
      const r = n.childForFieldName('right')?.namedChildren ?? [];
      if (l.length === r.length) pairs = l.map((x, i) => [x, r[i]] as [Node, Node]);
    }
    for (const [l, r] of pairs) {
      if (l?.type !== 'identifier') continue;
      assigned.set(l.text, (assigned.get(l.text) ?? 0) + 1);
      if (r && ctor.test(r.text)) out.add(l.text);
    }
  }
  // Bound exactly once, to a constructor: a reassigned name may hold anything.
  for (const name of out) if ((assigned.get(name) ?? 0) !== 1) out.delete(name);
  return out;
}

/** The last segment of a (possibly qualified) type or constructor name. */

function callTarget(
  language: string,
  text: string,
  root: Node,
  testPath: string,
  symbol: TestSymbol,
  ctx: FileContext,
): CallTarget {
  const lang = LANGS[language];
  const namespaces = memoOnRoot(root, `module\0${symbol.filePath}\0${testPath}\0${symbol.goModule ?? ''}`, () => moduleBindings(language, text, symbol.filePath, testPath, symbol.goModule));
  // A namespace binding a test shadows with its own declaration (`const math = {…}`) is not the module.
  const namespaceOk = (r: Node): boolean => (lang?.identifierTypes.has(r.type) ?? false) && namespaces.has(r.text) && !ctx.localNames.has(r.text);
  if (symbol.className) {
    const cls = symbol.className;
    // The class must be the symbol's class: imported from its module (under any alias), or reached
    // through a namespace of it — never a test double of the same name declared in the test file.
    const classNames = new Set([...memoOnRoot(root, `names\0${cls}\0${symbol.filePath}\0${testPath}`, () => importedNames(language, text, { name: cls, filePath: symbol.filePath }, testPath))]
      .filter(n => !ctx.localNames.has(n) || language === 'Go'));
    const ctorNames = new Set([...classNames, ...[...namespaces].filter(n => !ctx.localNames.has(n)).map(n => `${n}.${cls}`)]);
    if (ctorNames.size === 0) return { name: symbol.name, bareNames: new Set(), receiverOk: () => false };
    // A method is never called bare; its receiver is `C` (a static), `new C()`, or a name the same
    // test case binds to a constructor of C exactly once (an instance name reused, or reassigned,
    // elsewhere is not proof).
    const isInstance = (r: Node, body: Node): boolean => {
      if (r.type === 'identifier') return classNames.has(r.text) || memoOnRoot(body, `class\0${[...ctorNames].join(',')}`, () => instancesOf(language, body, cls, ctorNames)).has(r.text);
      if (r.type === 'new_expression') return ctorNames.has(r.childForFieldName('constructor')?.text ?? '');
      if (r.type === 'call') return ctorNames.has(r.childForFieldName('function')?.text ?? '');
      if (r.type === 'composite_literal') return ctorNames.has(r.childForFieldName('type')?.text ?? '');
      if (r.type === 'unary_expression' || r.type === 'parenthesized_expression') {
        const inner = r.namedChildren.at(-1);
        return inner ? isInstance(inner, body) : false;
      }
      return false;
    };
    return { name: symbol.name, bareNames: new Set(), receiverOk: isInstance };
  }
  return {
    name: symbol.name,
    bareNames: memoOnRoot(root, `names\0${symbol.name}\0${symbol.filePath}\0${testPath}`, () => importedNames(language, text, symbol, testPath)),
    receiverOk: (r) => namespaceOk(r) || (r.type === 'attribute' && namespaces.has(r.text)),
  };
}

const ASSIGN_TYPES: ReadonlySet<string> = new Set([
  'assignment_expression', 'augmented_assignment_expression', 'assignment', 'augmented_assignment',
  'assignment_statement', 'short_var_declaration', 'variable_declarator',
]);

/** Assignments in a tree by start row: the left side's text and where it starts. Built once per tree. */
const assignmentRows = new WeakMap<Node, Map<number, Array<{ startIndex: number; left: string; value: Node | null }>>>();

function assignmentsOnRow(body: Node, row: number): Array<{ startIndex: number; left: string; value: Node | null }> {
  let root: Node = body;
  while (root.parent) root = root.parent;
  let rows = assignmentRows.get(root);
  if (!rows) {
    rows = new Map();
    for (const n of walk(root)) {
      if (!ASSIGN_TYPES.has(n.type)) continue;
      const left = (n.childForFieldName('left') ?? n.childForFieldName('name'))?.text;
      if (left === undefined) continue;
      const r = n.startPosition.row;
      const value = n.childForFieldName('value') ?? n.childForFieldName('right');
      (rows.get(r) ?? rows.set(r, []).get(r)!).push({ startIndex: n.startIndex, left, value });
    }
    assignmentRows.set(root, rows);
  }
  return rows.get(row) ?? [];
}

/**
 * The value-derivation test for one body: does `value` (a node in `body`) carry a value from one
 * of `sources` (call nodes in `body`)? True when the value contains a source call, or reads a
 * variable the source call's value was bound to, followed through the def-use overlay.
 */
function derivedFrom(lang: Lang, cfg: FunctionCfg | undefined, body: Node, sources: Node[], value: Node, extraSeedVars: string[] = [], exact = false): boolean {
  // An assertion that a call raises is about that call only: the source must BE it.
  if (exact) return sources.some(s => sameNode(s, value));
  if (sources.some(s => onSpine(lang, s, value))) return true;
  // Go `if got := Sym(); got != want`: the initializer's binding is local to the `if`, read in its
  // condition on the same line (the overlay does not link the two).
  const ifStmt = value.parent?.type === 'if_statement' ? value.parent : null;
  const init = ifStmt?.childForFieldName('initializer');
  if (init) {
    const bound = new Set(sources.filter(s => contains(init, s)).flatMap(s => lang.bindings(s, body)?.names ?? []));
    if ([...walk(value)].some(n => lang.identifierTypes.has(n.type) && bound.has(n.text) && onSpine(lang, n, value))) return true;
  }
  if (!cfg) return false;
  const tainted = new Set<string>();
  for (const s of sources) {
    const b = lang.bindings(s, body);
    if (!b) continue;
    for (const name of b.names) {
      // `let r = add(); r = 5;` on one line: the overlay is line-granular, so a reassignment on the
      // binding's own line would carry the taint past it. Such a binding is not seeded.
      const reassigned = assignmentsOnRow(body, b.from - 1).some(a => a.startIndex >= s.endIndex && a.left === name);
      if (reassigned) continue;
      for (const e of cfg.defUse) if (e.variable === name && e.defLine >= b.from && e.defLine <= b.to) tainted.add(`${e.variable}|${e.defLine}`);
    }
  }
  for (const v of extraSeedVars) tainted.add(`${v}|${cfg.paramLine}`);
  if (tainted.size === 0) return false;
  const defVarsAtLine = new Map<number, Set<string>>();
  for (const e of cfg.defUse) (defVarsAtLine.get(e.defLine) ?? defVarsAtLine.set(e.defLine, new Set()).get(e.defLine)!).add(e.variable);
  const usesReached: Array<{ variable: string; line: number }> = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of cfg.defUse) {
      if (!tainted.has(`${e.variable}|${e.defLine}`)) continue;
      if (!usesReached.some(u => u.variable === e.variable && u.line === e.useLine)) {
        usesReached.push({ variable: e.variable, line: e.useLine });
        changed = true;
      }
      // Chain into the definition this use feeds, only when that line defines one variable: on
      // `const a = r, b = 5` the overlay cannot tell which declarator read `r`.
      const fed = e.useInDefLine !== undefined ? defVarsAtLine.get(e.useInDefLine) : undefined;
      // Counted from the syntax tree: the overlay records only definitions that are read later.
      const fedRow = e.useInDefLine !== undefined ? assignmentsOnRow(body, e.useInDefLine - 1) : [];
      // …and only when the read is on the spine of what it defines (`const a = r.x`, not `const a = f(r)`).
      const fedValue = fedRow.length === 1 ? fedRow[0].value : null;
      const onFedSpine = fedValue !== null && [...walk(fedValue)].some(n => lang.identifierTypes.has(n.type) && n.text === e.variable
        && line(n) === e.useLine && onSpine(lang, n, fedValue));
      if (fed && fed.size === 1 && fedRow.length <= 1 && onFedSpine) {
        const key = `${[...fed][0]}|${e.useInDefLine}`;
        if (!tainted.has(key)) { tainted.add(key); changed = true; }
      }
    }
  }
  // A tainted variable read on the value's spine, on the line it is read.
  for (const n of walk(value)) {
    if (!lang.identifierTypes.has(n.type)) continue;
    if (usesReached.some(u => u.variable === n.text && u.line === line(n)) && onSpine(lang, n, value)) return true;
  }
  return false;
}

function cfgFor(fn: Node, language: string): FunctionCfg | undefined {
  try {
    return buildFunctionCfg(fn as unknown as CfgNode, language);
  } catch {
    return undefined;
  }
}

/** Parameter names of a same-file function, in order. */
function paramNames(fn: Node): string[] {
  const params = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter');
  if (!params) return [];
  if (params.type === 'identifier') return [params.text];
  const out: string[] = [];
  for (const p of params.namedChildren) {
    let id: Node | null = p.type === 'identifier' ? p : null;
    for (const d of walk(p)) { if (!id && d.type === 'identifier') id = d; }
    // Go groups names: `a, b int` → both names, the type last.
    if (p.type === 'parameter_declaration') {
      for (const nm of p.childrenForFieldName?.('name') ?? []) out.push(nm.text);
      continue;
    }
    if (id) out.push(id.text);
  }
  return out;
}

/** What a test file mocks, read once per file: module specifiers and mocked names. */
interface MockFacts { modules: string[]; names: Map<string, string> }

const mockFacts = new WeakMap<Node, MockFacts>();

function mockFactsOf(language: string, text: string, root: Node): MockFacts {
  const hit = mockFacts.get(root);
  if (hit) return hit;
  const facts: MockFacts = { modules: [], names: new Map() };
  if (language === 'TypeScript' || language === 'JavaScript') {
    // `vi.mock('./m')`, `vi.mock(import('./m'))`, and an alias (`vi.mock('@/m')`): kept whole, matched below.
    for (const m of text.matchAll(/\b(?:(?:vi|jest)\.(?:mock|doMock|unstable_mockModule)|mock\.module|td\.replace(?:Esm)?)\(\s*(?:import\(\s*)?['"]([^'"\n]{1,300})['"]/g)) facts.modules.push(m[1]);
    // `m.add = vi.fn()` and any other member assignment to the name: the test may replace it.
    for (const m of text.matchAll(/\.([\w$]{1,200})\s*=(?!=)/g)) facts.names.set(m[1], 'assignment');
    for (const m of text.matchAll(/\btd\.replace\([^,\n]{1,300},\s*['"]([\w$]{1,200})['"]/g)) facts.names.set(m[1], 'td.replace');
    for (const m of text.matchAll(/\b(?:sinon\.(?:stub|replace|spy)|mock\.method)\([^,\n]{1,300},\s*['"]([\w$]{1,200})['"]/g)) facts.names.set(m[1], 'stub');
    for (const m of text.matchAll(/\b(?:vi|jest)\.mocked\(\s*([\w$]{1,200})/g)) facts.names.set(m[1], 'vi.mocked');
    for (const m of text.matchAll(/\bspyOn\([^,\n]{1,300},\s*['"]([\w$]{1,200})['"]/g)) facts.names.set(m[1], 'spyOn');
  } else if (language === 'Python') {
    for (const m of text.matchAll(/\bpatch\(\s*['"][\w.]{0,300}\.(\w{1,200})['"]/g)) facts.names.set(m[1], 'patch');
    for (const m of text.matchAll(/\bpatch\.object\([^,\n]{1,300},\s*['"](\w{1,200})['"]/g)) facts.names.set(m[1], 'patch.object');
    for (const m of text.matchAll(/\.(\w{1,200})\s*=(?!=)/g)) facts.names.set(m[1], 'assignment');
    for (const m of text.matchAll(/\bmonkeypatch\.setattr\(\s*(?:['"][\w.]{0,300}\.(\w{1,200})['"]|[^,\n]{1,300},\s*['"](\w{1,200})['"])/g)) facts.names.set(m[1] ?? m[2], 'monkeypatch.setattr');
  }
  mockFacts.set(root, facts);
  return facts;
}

/**
 * How the test file replaces the symbol with a mock, or null: `vi.mock`/`jest.mock` of its module,
 * `vi.mocked(name)`, `spyOn(x, 'name')`, Python `patch('….name')` / `patch.object(x, 'name')`.
 */
function mocksSymbol(language: string, text: string, root: Node, testPath: string, symbol: { name: string; filePath: string }): string | null {
  const facts = mockFactsOf(language, text, root);
  const target = withoutExt(posixPath(symbol.filePath));
  for (const spec of facts.modules) {
    if (spec.startsWith('.')) {
      const resolved = resolveRelative(testPath, spec);
      if (resolved === target || (target.endsWith('/index') && resolved === target.slice(0, -'/index'.length))) return `mock('${spec}')`;
    } else if (withoutExt(spec.split('/').pop() ?? '') === target.split('/').pop()) {
      // An alias specifier (`@/math`) this analysis cannot resolve, ending in the symbol's file name:
      // it may be the symbol's module, so the assertion may consume a mock.
      return `mock('${spec}')`;
    }
  }
  return facts.names.get(symbol.name) ?? null;
}

/** The production symbol being classified. `goModule`: the repository's Go module path (from go.mod). */
export interface TestSymbol { name: string; filePath: string; className?: string; goModule?: string }

export interface CaseEvidence {
  test: string;
  class: EvidenceClass;
  line: number | null;
  recognized: boolean;
  reason: string;
}

/**
 * Class every test case in one test file's source against `symbol` (its name, file and class: a
 * member call counts only when its receiver can be the symbol's, see {@link callTarget}).
 * Returns only the cases that call the symbol (directly or through one same-file helper), plus a
 * `recognizedLanguage` flag; a file with no such case relates to the symbol only by `reaches`.
 */
export async function classifyTestSource(
  language: string,
  path: string,
  text: string,
  symbol: TestSymbol,
  cache?: EvidenceCache,
): Promise<{ parsed: boolean; cases: CaseEvidence[] }> {
  const lang = LANGS[language];
  if (!lang) return { parsed: false, cases: [] };
  let root: Node | null;
  if (cache?.trees.has(path)) root = cache.trees.get(path)!;
  else {
    if (cache) {
      if (cache.parsedBytes + text.length > MAX_PARSE_BYTES_PER_ANSWER) return { parsed: false, cases: [] };
      cache.parsedBytes += text.length;
    }
    root = await sharedParse(language, path, text);
    cache?.trees.set(path, root);
  }
  if (!root) return { parsed: false, cases: [] };

  const symbolName = symbol.name;
  const file = analyzeFile(lang, language, root);
  const target = callTarget(language, text, root, path, symbol, file.ctx);
  const mocked = mocksSymbol(language, text, root, path, symbol);
  const { helpers, assertingParams } = file;

  // A value helper returns a value derived from a direct call to the symbol.
  const valueHelpers = new Set<string>();
  // Helpers that call the symbol but return nothing derived from it: the walk stops there.
  const stoppingHelpers = new Set<string>();
  for (const [name, h] of helpers) {
    const direct = file.callsIn(h.body, target);
    if (direct.length === 0) continue;
    if (lang.returns(h.body).some(r => derivedFrom(lang, file.cfgOf(h.fn), h.body, direct, r))) valueHelpers.add(name);
    else stoppingHelpers.add(name);
  }

  const out: CaseEvidence[] = [];
  const unrecognized = (test: string, reason: string): CaseEvidence => ({ test, class: 'reaches', line: null, recognized: false, reason });
  for (const c of file.cases) {
    const direct = file.callsIn(c.body, target);
    const viaValueHelper = [...valueHelpers].flatMap(h => file.bareCallsIn(c.body, h));
    const viaStopping = [...stoppingHelpers].filter(h => file.bareCallsIn(c.body, h).length > 0);
    if (direct.length === 0 && viaValueHelper.length === 0 && viaStopping.length === 0) continue;

    const sources = [...direct, ...viaValueHelper];
    if (c.skipped) {
      // A test that does not run checks nothing, whatever its body says.
      out.push({ test: c.name, class: 'exercises', line: line(direct[0] ?? viaValueHelper[0] ?? c.fn), recognized: true, reason: `the test calls ${symbolName} but is turned off (${c.skipped.split('\n')[0].slice(0, 80)})` });
      continue;
    }
    const assertions = file.assertionsOf(c.body);
    const assertionHelperCalls = [...assertingParams.keys()].flatMap(h => file.bareCallsIn(c.body, h).map(call => ({ h, call })));
    const callLine = line((direct[0] ?? viaValueHelper[0] ?? c.fn));
    const cfg = sources.length > 0 ? file.cfgOf(c.fn) : undefined;
    // A value from the call flows into a call that looks like an assertion this analysis does not
    // know (`should(r)`, `self.check(r)`, a testify suite's `s.Equal`): not a fact either way.
    const findUnknownForm = () => sources.length > 0 ? file.allCallsIn(c.body).find(k => lang.looksLikeAssertion(k.name, k.receiver, file.ctx)
      && !lang.isAssertionCall(k.name, k.receiver, file.ctx)
      && lang.callArgs(k.node).some(a => derivedFrom(lang, cfg, c.body, sources, a))) : undefined;
    const assertsSomething = assertions.length > 0 || assertionHelperCalls.length > 0
      || file.allCallsIn(c.body).some(k => lang.isAssertionCall(k.name, k.receiver, file.ctx));
    if (!assertsSomething) {
      const unknownForm = findUnknownForm();
      if (unknownForm) {
        out.push(unrecognized(c.name, `a value from ${symbolName} flows into ${unknownForm.name}, an assertion form this analysis does not recognize`));
        continue;
      }
      // A file whose other tests use a recognized form: this test simply asserts nothing. A file with
      // no recognized assertion anywhere may use a form this analysis does not know.
      out.push(file.recognized
        ? { test: c.name, class: 'exercises', line: callLine, recognized: true, reason: `the test calls ${symbolName} and makes no assertion` }
        : unrecognized(c.name, `the test calls ${symbolName}, but no assertion in its file is in a form this analysis recognizes (${ASSERTION_FRAMEWORKS[language]})`));
      continue;
    }
    const hit = sources.length > 0 ? assertions.find(a => derivedFrom(lang, cfg, c.body, sources, a.value, [], a.exact)) : undefined;
    const viaHelper = !hit && sources.length > 0 ? assertionHelperCalls.find(({ h, call }) =>
      lang.callArgs(call).some((arg, i) => assertingParams.get(h)!.has(i) && derivedFrom(lang, cfg, c.body, sources, arg))) : undefined;
    if ((hit || viaHelper) && mocked) {
      // The assertion consumes what a mock returns in place of the symbol, not the symbol's output.
      out.push({ test: c.name, class: 'exercises', line: callLine, recognized: true, reason: `the test file mocks ${symbolName} (${mocked}), so its assertions consume the mock's result` });
      continue;
    }
    if (hit) {
      const helper = viaValueHelper.some(s => contains(hit.value, s)) ? ' (through a helper in the same file)' : '';
      out.push({
        test: c.name, class: 'asserts-on', line: hit.line, recognized: true,
        reason: hit.exact ? `an assertion checks that the call to ${symbolName} raises${helper}` : `an assertion consumes the result of ${symbolName}${helper}`,
      });
      continue;
    }
    if (viaHelper) {
      out.push({ test: c.name, class: 'asserts-on', line: line(viaHelper.call), recognized: true, reason: `the assertion helper ${viaHelper.h} in the same file asserts on the result of ${symbolName}` });
      continue;
    }
    const unknownForm = findUnknownForm();
    if (unknownForm) {
      out.push(unrecognized(c.name, `a value from ${symbolName} flows into ${unknownForm.name}, an assertion form this analysis does not recognize`));
      continue;
    }
    out.push({
      test: c.name, class: 'exercises', line: callLine, recognized: true,
      reason: sources.length === 0
        ? `${symbolName} is called inside the helper ${viaStopping[0]}, which returns nothing derived from it; the walk stops at one helper`
        : `the test calls ${symbolName}, and no recognized assertion uses a value from that call`,
    });
  }
  return { parsed: true, cases: out };
}

// ── A symbol's evidence over the index ──────────────────────────────────────────

/** One answer's reads and parses, shared across the symbols it classifies. */
export interface EvidenceCache {
  files: Map<string, string | null>;
  trees: Map<string, Node | null>;
  /** Bytes of test source parsed for this answer, against {@link MAX_PARSE_BYTES_PER_ANSWER}. */
  parsedBytes: number;
}

/**
 * Test source one answer parses at most. A file past it is listed as not assessed (and so never
 * yields a finding): a byte count, not a clock, so the same repository always gets the same answer.
 */
export const MAX_PARSE_BYTES_PER_ANSWER = 6 * 1024 * 1024;

export function newEvidenceCache(): EvidenceCache {
  return { files: new Map(), trees: new Map(), parsedBytes: 0 };
}

/** Parsed test files kept across answers in one process, reused only while the text is identical. */
const SHARED_TREES = new Map<string, { text: string; root: Node | null }>();
const MAX_SHARED_TREES = 64;

async function sharedParse(language: string, path: string, text: string): Promise<Node | null> {
  const hit = SHARED_TREES.get(path);
  if (hit && hit.text === text) {
    SHARED_TREES.delete(path); // most recently used last
    SHARED_TREES.set(path, hit);
    return hit.root;
  }
  const root = await parse(language, path, text);
  SHARED_TREES.set(path, { text, root });
  while (SHARED_TREES.size > MAX_SHARED_TREES) SHARED_TREES.delete(SHARED_TREES.keys().next().value!);
  return root;
}

/**
 * Class every test relationship of one symbol. `fileText` reads a repository-relative test file
 * (confined to the root). The strongest class wins; every relationship stays listed (capped).
 */
export async function symbolTestEvidence(
  root: string,
  cg: SerializedCallGraph,
  symbol: { id: string; name: string; filePath: string; className?: string },
  cache: EvidenceCache = newEvidenceCache(),
): Promise<SymbolEvidence> {
  const fileCache = cache.files;
  const { direct, reach, truncated } = linkedTestFiles(cg, symbol.id);
  const relationships: TestRelationship[] = [];
  const notAssessed: string[] = [];
  let omittedFiles = 0;
  let strongest: EvidenceClass | null = null;
  let allRecognized = true;

  const read = async (file: string): Promise<string | null> => {
    if (!fileCache.has(file)) {
      fileCache.set(file, await readFileConfined(root, file, MAX_FILE_BYTES).catch(() => null));
    }
    return fileCache.get(file) ?? null;
  };

  // Go: the module path go.mod declares, so an import path is matched exactly.
  if (!cache.files.has('go.mod')) cache.files.set('go.mod', await readFileConfined(root, 'go.mod', 64 * 1024).catch(() => null));
  const goModule = /^\s*module\s+(\S+)/m.exec(cache.files.get('go.mod') ?? '')?.[1];
  const target: TestSymbol = { name: symbol.name, filePath: symbol.filePath, ...(symbol.className ? { className: symbol.className } : {}), ...(goModule ? { goModule } : {}) };
  const directFiles = direct.slice(0, MAX_FILES_PER_SYMBOL);
  omittedFiles += direct.length - directFiles.length;
  for (const file of directFiles) {
    const language = detectLanguage(file);
    if (!ASSERTION_RECOGNITION_LANGUAGES.has(language)) {
      allRecognized = false;
      strongest = strongerClass(strongest, 'reaches');
      relationships.push({ testFile: file, test: null, class: 'reaches', line: null, recognized: false, reason: `assertions in ${language} tests are not recognized` });
      continue;
    }
    const text = await read(file);
    const result = text === null ? null : await classifyTestSource(language, file, text, target, cache);
    if (!result?.parsed) {
      notAssessed.push(file);
      allRecognized = false;
      strongest = strongerClass(strongest, 'reaches');
      relationships.push({ testFile: file, test: null, class: 'reaches', line: null, recognized: false, reason: 'the test file could not be read or parsed, or is past this answer\'s parse budget' });
      continue;
    }
    if (result.cases.length === 0) {
      // The index links the file to the symbol directly, but no test case calls it: it is used in
      // setup, a fixture or a mock factory, or passed as a value. What the tests do with it is unknown.
      strongest = strongerClass(strongest, 'reaches');
      allRecognized = false;
      relationships.push({ testFile: file, test: null, class: 'reaches', line: null, recognized: false, reason: `the file references ${symbol.name}, but no test case calls it directly (setup, a fixture, a mock, or a value passed on); not classed` });
      continue;
    }
    for (const c of result.cases) {
      strongest = strongerClass(strongest, c.class);
      if (!c.recognized) allRecognized = false;
      relationships.push({ testFile: file, test: c.test, class: c.class, line: c.line, recognized: c.recognized, reason: c.reason });
    }
  }
  for (const file of reach) {
    strongest = strongerClass(strongest, 'reaches');
    const recognized = ASSERTION_RECOGNITION_LANGUAGES.has(detectLanguage(file));
    if (!recognized) allRecognized = false;
    relationships.push({ testFile: file, test: null, class: 'reaches', line: null, recognized, reason: `a test in this file reaches ${symbol.name} only through other functions` });
  }

  relationships.sort((a, b) => EVIDENCE_ORDER.indexOf(a.class) - EVIDENCE_ORDER.indexOf(b.class)
    || a.testFile.localeCompare(b.testFile) || (a.test ?? '').localeCompare(b.test ?? ''));
  const kept = relationships.slice(0, MAX_RELATIONSHIPS);
  return {
    symbol: symbol.name,
    file: symbol.filePath,
    strongest,
    allRecognized,
    relationships: kept,
    omittedFiles,
    omittedRelationships: relationships.length - kept.length,
    notAssessed,
    reachTruncated: truncated,
    complete: allRecognized && omittedFiles === 0 && notAssessed.length === 0,
  };
}
