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

/** One test case: its name, the function node holding its body, and the body. */
interface Case { name: string; fn: Node; body: Node }

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
  /** The call is itself a recognized assertion (never a call to the symbol under test). */
  isAssertionCall(name: string, receiver: Node | null): boolean;
  /** Recognized assertions within `body`: each asserted value node, with the assertion's line. */
  assertions(body: Node): Array<{ value: Node; line: number }>;
  /** Return statements' values in a function body. */
  returns(body: Node): Node[];
  /** The statement that defines a variable from `n`, if `n` sits in one (its start line is the def line). */
  defStatement(n: Node, body: Node): Node | null;
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

function jsTitle(n: Node | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string') return n.text.slice(1, -1);
  if (n.type === 'template_string') return n.text.slice(1, -1);
  return null;
}

const JS: Lang = {
  identifierTypes: new Set(['identifier', 'shorthand_property_identifier']),
  isAssertionCall: (name, receiver) => (receiver === null && JS_ASSERT_ROOTS.has(name))
    || (receiver?.type === 'identifier' && (JS_ASSERT_ROOTS.has(receiver.text) || receiver.text === 'chai')),
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
      for (let p = n.parent; p; p = p.parent) {
        if (p.type !== 'call_expression') continue;
        const pr = jsRoot(p);
        const pt = jsTitle(p.childForFieldName('arguments')?.namedChildren[0]);
        if (pr && JS_SUITES.has(pr) && pt !== null) suites.unshift(pt);
      }
      out.push({ name: [...suites, title].join(' > '), fn, body });
    }
    return out;
  },
  functions(root) {
    const out: FileFn[] = [];
    for (const n of walk(root)) {
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
    const out: Array<{ value: Node; line: number }> = [];
    for (const n of walk(body)) {
      if (n.type !== 'call_expression') continue;
      const fn = n.childForFieldName('function');
      const obj = fn?.type === 'member_expression' ? fn.childForFieldName('object') : null;
      const isRoot = fn?.type === 'identifier' && JS_ASSERT_ROOTS.has(fn.text);
      const isMember = obj?.type === 'identifier' && (JS_ASSERT_ROOTS.has(obj.text)
        || (obj.text === 'chai' && JS_ASSERT_ROOTS.has(fn!.childForFieldName('property')?.text ?? '')));
      if (!isRoot && !isMember) continue;
      // `expect(actual)…toBe(expected)`: the actual value and every chained matcher argument.
      for (const a of this.callArgs(n)) out.push({ value: a, line: line(n) });
      let cur: Node = n;
      while (cur.parent && (cur.parent.type === 'member_expression'
        || (cur.parent.type === 'call_expression' && cur.parent.childForFieldName('function')?.id === cur.id)
        || cur.parent.type === 'await_expression')) {
        cur = cur.parent;
        if (cur.type === 'call_expression') for (const a of this.callArgs(cur)) out.push({ value: a, line: line(n) });
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
  defStatement(n, body) {
    for (let p: Node | null = n; p && p.id !== body.id; p = p.parent) {
      if (p.type === 'lexical_declaration' || p.type === 'variable_declaration') return p;
      if (p.type === 'assignment_expression' || p.type === 'augmented_assignment_expression') return p;
      if (JS_FN_TYPES.has(p.type) && p.id !== n.id) return null;
    }
    return null;
  },
};

const PY: Lang = {
  identifierTypes: new Set(['identifier']),
  isAssertionCall: (name) => /^assert/.test(name),
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
      out.push({ name: clsName ? `${clsName}.${name}` : name, fn: n, body });
    }
    return out;
  },
  functions(root) {
    const out: FileFn[] = [];
    for (const n of walk(root)) {
      if (n.type !== 'function_definition') continue;
      const name = n.childForFieldName('name')?.text;
      const body = n.childForFieldName('body');
      if (name && body) out.push({ name, fn: n, body });
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
    const out: Array<{ value: Node; line: number }> = [];
    for (const n of walk(body)) {
      if (n.type === 'assert_statement') {
        const cond = n.namedChildren[0]; // the condition, not the message
        if (cond) out.push({ value: cond, line: line(n) });
      } else if (n.type === 'call') {
        const fn = n.childForFieldName('function');
        const last = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : fn?.type === 'identifier' ? fn.text : undefined;
        if (last && /^assert/.test(last)) for (const a of this.callArgs(n)) out.push({ value: a, line: line(n) });
      } else if (n.type === 'with_statement') {
        // `with pytest.raises(E): subject()` asserts on what the block does.
        const items = n.namedChildren.find(c => c.type === 'with_clause');
        const raises = items && /\bpytest\.(?:raises|warns)\s*\(/.test(items.text);
        const block = n.childForFieldName('body');
        if (raises && block) out.push({ value: block, line: line(n) });
      }
    }
    return out;
  },
  returns(body) {
    const out: Node[] = [];
    for (const n of walk(body)) if (n.type === 'return_statement' && n.namedChildren[0]) out.push(n.namedChildren[0]);
    return out;
  },
  defStatement(n, body) {
    for (let p: Node | null = n; p && p.id !== body.id; p = p.parent) {
      if (p.type === 'assignment' || p.type === 'augmented_assignment') return p;
      if (p.type === 'function_definition' || p.type === 'lambda') return null;
    }
    return null;
  },
};

const GO_FAIL = /^(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)$/;

const GO: Lang = {
  identifierTypes: new Set(['identifier']),
  isAssertionCall: (_name, receiver) => receiver?.type === 'identifier' && (receiver.text === 'assert' || receiver.text === 'require'),
  cases(root) {
    const out: Case[] = [];
    for (const n of root.namedChildren) {
      if (n.type !== 'function_declaration') continue;
      const name = n.childForFieldName('name')?.text ?? '';
      const body = n.childForFieldName('body');
      if (/^Test(?:$|[^a-z])/.test(name) && body) out.push({ name, fn: n, body });
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
  assertions(body) {
    const out: Array<{ value: Node; line: number }> = [];
    for (const n of walk(body)) {
      if (n.type === 'call_expression') {
        const fn = n.childForFieldName('function');
        const operand = fn?.type === 'selector_expression' ? fn.childForFieldName('operand') : null;
        if (operand?.type === 'identifier' && (operand.text === 'assert' || operand.text === 'require')) {
          for (const a of this.callArgs(n).slice(1)) out.push({ value: a, line: line(n) }); // skip `t`
        }
      } else if (n.type === 'if_statement') {
        // `if got != want { t.Errorf(…) }`: the condition (and its initializer) is what is asserted.
        const consequence = n.childForFieldName('consequence');
        const fails = consequence && [...walk(consequence)].some(c => c.type === 'call_expression'
          && c.childForFieldName('function')?.type === 'selector_expression'
          && GO_FAIL.test(c.childForFieldName('function')!.childForFieldName('field')?.text ?? ''));
        if (!fails) continue;
        const cond = n.childForFieldName('condition');
        const init = n.childForFieldName('initializer');
        if (cond) out.push({ value: cond, line: line(n) });
        if (init) out.push({ value: init, line: line(n) });
      }
    }
    return out;
  },
  returns(body) {
    const out: Node[] = [];
    for (const n of walk(body)) if (n.type === 'return_statement' && n.namedChildren[0]) out.push(n.namedChildren[0]);
    return out;
  },
  defStatement(n, body) {
    for (let p: Node | null = n; p && p.id !== body.id; p = p.parent) {
      if (p.type === 'short_var_declaration' || p.type === 'assignment_statement' || p.type === 'var_spec') return p;
      if (p.type === 'func_literal') return null;
    }
    return null;
  },
};

const LANGS: Record<string, Lang> = { TypeScript: JS, JavaScript: JS, Python: PY, Go: GO };

// ── Classifying one test body ───────────────────────────────────────────────────

/**
 * Which calls in one test file are calls to the symbol. A bare call by name is (the file is already
 * linked to the symbol by the index). A member call (`x.name(…)`) is only when its receiver can be
 * the symbol's: the file names the symbol's class, for a method; or the receiver is a namespace the
 * file imports from the symbol's own module, for a module function. A same-named method on another
 * object (`map.delete(k)` against a production `delete`) is not a call to the symbol.
 */
interface CallTarget { name: string; receiverOk(receiver: Node): boolean }

/**
 * Everything about one parsed test file that does not depend on the symbol: its cases, its helpers,
 * which helpers assert on a parameter, its calls by name, and per-function CFGs. Built once per tree,
 * so classifying the file against many changed symbols costs lookups, not re-walks.
 */
interface FileAnalysis {
  cases: Case[];
  helpers: Map<string, FileFn>;
  assertingParams: Map<string, Set<number>>;
  callsIn(body: Node, target: CallTarget): Node[];
  bareCallsIn(body: Node, name: string): Node[];
  assertionsOf(body: Node): Array<{ value: Node; line: number }>;
  cfgOf(fn: Node): FunctionCfg | undefined;
}

const fileAnalyses = new WeakMap<Node, FileAnalysis>();

function analyzeFile(lang: Lang, language: string, root: Node): FileAnalysis {
  const cached = fileAnalyses.get(root);
  if (cached) return cached;
  const callsByName = new Map<string, Array<{ node: Node; receiver: Node | null }>>();
  for (const n of walk(root)) {
    const c = lang.callee(n);
    if (c) (callsByName.get(c.name) ?? callsByName.set(c.name, []).get(c.name)!).push({ node: n, receiver: c.receiver });
  }
  const cfgs = new Map<number, FunctionCfg | undefined>();
  const cfgOf = (fn: Node): FunctionCfg | undefined => {
    if (!cfgs.has(fn.id)) cfgs.set(fn.id, cfgFor(fn, language));
    return cfgs.get(fn.id);
  };
  const assertionCache = new Map<number, Array<{ value: Node; line: number }>>();
  const assertionsOf = (body: Node): Array<{ value: Node; line: number }> => {
    if (!assertionCache.has(body.id)) assertionCache.set(body.id, lang.assertions(body));
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
      if (asserted.some(a => derivedFrom(lang, cfg, h.body, [], a.value, [p]) || [...walk(a.value)].some(n => lang.identifierTypes.has(n.type) && n.text === p))) idx.add(i);
    });
    if (idx.size > 0) assertingParams.set(name, idx);
  }

  const analysis: FileAnalysis = {
    cases,
    helpers,
    assertingParams,
    // A bare call by name is a call to the symbol (the file is already linked to it by the index); a
    // member call only when its receiver can be the symbol's (see callTarget).
    callsIn: (body, target) => (callsByName.get(target.name) ?? [])
      .filter(c => contains(body, c.node) && !lang.isAssertionCall(target.name, c.receiver)
        && (c.receiver === null || target.receiverOk(c.receiver)))
      .map(c => c.node),
    // A helper in the same file is reached only by a bare call.
    bareCallsIn: (body, name) => (callsByName.get(name) ?? [])
      .filter(c => c.receiver === null && contains(body, c.node))
      .map(c => c.node),
    assertionsOf,
    cfgOf,
  };
  fileAnalyses.set(root, analysis);
  return analysis;
}

function stem(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return base.replace(/\.[cm]?[jt]sx?$|\.py$|\.go$/i, '').replace(/\.(?:js|ts)$/i, '');
}

/** The local names this file binds to the module at `symbolFile` (namespace, default, `require`). */
function moduleBindings(language: string, text: string, symbolFile: string): Set<string> {
  const want = stem(symbolFile);
  const dir = symbolFile.replace(/\\/g, '/').split('/').slice(-2, -1)[0] ?? '';
  const names = new Set<string>();
  const fromModule = (spec: string): boolean => {
    const s = stem(spec);
    return s === want || (s === 'index' && want === 'index') || (want === 'index' && spec.replace(/\/+$/, '').split('/').pop() === dir);
  };
  if (language === 'TypeScript' || language === 'JavaScript') {
    for (const m of text.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/g)) if (fromModule(m[2])) names.add(m[1]);
    for (const m of text.matchAll(/import\s+([\w$]+)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g)) if (fromModule(m[2])) names.add(m[1]);
    for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) if (fromModule(m[2])) names.add(m[1]);
  } else if (language === 'Python') {
    for (const m of text.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) {
      if (m[1].split('.').pop() === want) names.add(m[2] ?? m[1]);
    }
    for (const m of text.matchAll(/^\s*from\s+[\w.]+\s+import\s+([^\n]+)/gm)) {
      for (const part of m[1].replace(/[()]/g, '').split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (name === want) names.add(alias ?? name);
      }
    }
  } else if (language === 'Go') {
    // A package is referred to by its name, conventionally its directory's name.
    if (dir) names.add(dir);
    for (const m of text.matchAll(/(\w+)\s+"[^"]*\/([\w-]+)"/g)) if (m[2] === dir) names.add(m[1]);
  }
  return names;
}

function callTarget(language: string, text: string, symbol: { name: string; filePath: string; className?: string }): CallTarget {
  const lang = LANGS[language];
  if (symbol.className) {
    const cls = symbol.className;
    const named = new RegExp(`(?<![\\w$])${cls.replace(/[$]/g, '\\$')}(?![\\w$])`).test(text);
    return { name: symbol.name, receiverOk: () => named };
  }
  const bindings = moduleBindings(language, text, symbol.filePath);
  return {
    name: symbol.name,
    receiverOk: (r) => lang !== undefined && lang.identifierTypes.has(r.type) && bindings.has(r.text),
  };
}

/**
 * The value-derivation test for one body: does `value` (a node in `body`) carry a value from one
 * of `sources` (call nodes in `body`)? True when the value contains a source call, or reads a
 * variable whose definition the def-use overlay traces back to a statement holding one.
 */
function derivedFrom(lang: Lang, cfg: FunctionCfg | undefined, body: Node, sources: Node[], value: Node, extraSeedVars: string[] = []): boolean {
  if (sources.some(s => contains(value, s))) return true;
  if (!cfg) return false;
  const seedLines = new Set<number>();
  for (const s of sources) {
    const def = lang.defStatement(s, body);
    if (def) seedLines.add(line(def));
  }
  const tainted = new Set<string>();
  for (const e of cfg.defUse) if (seedLines.has(e.defLine)) tainted.add(`${e.variable}|${e.defLine}`);
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
      if (e.useInDefLine !== undefined) {
        for (const w of defVarsAtLine.get(e.useInDefLine) ?? []) {
          const key = `${w}|${e.useInDefLine}`;
          if (!tainted.has(key)) { tainted.add(key); changed = true; }
        }
      }
    }
  }
  // A tainted variable read inside the value, on the line it is read.
  for (const n of walk(value)) {
    if (!lang.identifierTypes.has(n.type)) continue;
    if (usesReached.some(u => u.variable === n.text && u.line === line(n))) return true;
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
  symbol: { name: string; filePath: string; className?: string },
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
  const target = callTarget(language, text, symbol);
  const file = analyzeFile(lang, language, root);
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
  for (const c of file.cases) {
    const direct = file.callsIn(c.body, target);
    const viaValueHelper = [...valueHelpers].flatMap(h => file.bareCallsIn(c.body, h));
    const viaStopping = [...stoppingHelpers].filter(h => file.bareCallsIn(c.body, h).length > 0);
    if (direct.length === 0 && viaValueHelper.length === 0 && viaStopping.length === 0) continue;

    const sources = [...direct, ...viaValueHelper];
    const assertions = file.assertionsOf(c.body);
    const assertionHelperCalls = [...assertingParams.keys()].flatMap(h => file.bareCallsIn(c.body, h).map(call => ({ h, call })));
    const callLine = line((direct[0] ?? viaValueHelper[0] ?? c.fn));
    if (assertions.length === 0 && assertionHelperCalls.length === 0) {
      out.push({
        test: c.name, class: 'reaches', line: null, recognized: false,
        reason: `the test calls ${symbolName}, but no assertion this analysis recognizes is in it (${ASSERTION_FRAMEWORKS[language]})`,
      });
      continue;
    }
    const cfg = sources.length > 0 ? file.cfgOf(c.fn) : undefined;
    const hit = sources.length > 0 ? assertions.find(a => derivedFrom(lang, cfg, c.body, sources, a.value)) : undefined;
    if (hit) {
      const helper = viaValueHelper.some(s => contains(hit.value, s)) ? ' (through a helper in the same file)' : '';
      out.push({ test: c.name, class: 'asserts-on', line: hit.line, recognized: true, reason: `an assertion consumes the output of ${symbolName}${helper}` });
      continue;
    }
    const viaHelper = sources.length > 0 ? assertionHelperCalls.find(({ h, call }) =>
      lang.callArgs(call).some((arg, i) => assertingParams.get(h)!.has(i) && derivedFrom(lang, cfg, c.body, sources, arg))) : undefined;
    if (viaHelper) {
      out.push({ test: c.name, class: 'asserts-on', line: line(viaHelper.call), recognized: true, reason: `the assertion helper ${viaHelper.h} in the same file asserts on the output of ${symbolName}` });
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
const MAX_SHARED_TREES = 32;

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
    const result = text === null ? null : await classifyTestSource(language, file, text, symbol, cache);
    if (!result?.parsed) {
      notAssessed.push(file);
      allRecognized = false;
      strongest = strongerClass(strongest, 'reaches');
      relationships.push({ testFile: file, test: null, class: 'reaches', line: null, recognized: false, reason: 'the test file could not be read or parsed, or is past this answer\'s parse budget' });
      continue;
    }
    if (result.cases.length === 0) {
      strongest = strongerClass(strongest, 'reaches');
      relationships.push({ testFile: file, test: null, class: 'reaches', line: null, recognized: true, reason: `the file references ${symbol.name}, but no test case calls it by name` });
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
    relationships.push({ testFile: file, test: null, class: 'reaches', line: null, recognized, reason: `the test reaches ${symbol.name} only through other functions` });
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
  };
}
