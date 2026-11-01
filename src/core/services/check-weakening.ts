/**
 * Check-weakening findings (change: add-check-weakening-findings).
 *
 * A diff can make checks pass by weakening the checks instead of fixing the code: a test removed or
 * skipped, assertions dropped, an expected value edited, a suppression comment added, an error
 * caught and discarded, or a test/lint/coverage/CI config relaxed. This module reports each of those
 * shapes as a registered advisory finding, computed against a FIXED baseline: the merge-base of the
 * requested base (or of the default branch when none is given) with the new state. Never the agent's
 * own last commit, which would hide a weakening done in two steps.
 *
 * Every shape is a fact about the diff, worded neutrally: a legitimate test cleanup produces the same
 * fact, and the reader decides. Each test-shape finding names the production symbols the weakened
 * test file reaches in the index (its `tested_by` edges and their forward call closure), so the
 * receipt says what the test was guarding. A file in a language or framework outside the closed
 * tables is reported `not-assessed`, never as free of weakening.
 *
 * Detection reads syntax trees (tree-sitter) for test cases, assertions, comments and catch blocks,
 * and a parsed YAML document for CI workflows. No test is run and no LLM is used.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type Parser from 'tree-sitter';
import { safeJoin } from '../../utils/path-confinement.js';
import { execFileGit } from '../../utils/git-exec.js';
import { gitPathArgs } from '../../utils/git-args.js';
import { detectLanguage } from '../analyzer/language-detection.js';
import { isTestFile } from '../analyzer/test-file.js';
import { getExceptionParser } from '../analyzer/exception-flow.js';
import { parseWithBudget, type BudgetableParser } from '../analyzer/parse-budget.js';
import type { SerializedCallGraph } from '../analyzer/call-graph.js';
import type { ChangedFile } from '../../types/index.js';
import { emittedText } from './generated-file-guard.js';
import type { GovernanceFinding } from './mcp-handlers/enforcement-policy.js';

type Node = Parser.SyntaxNode;

export const CHECK_WEAKENING_CODES = [
  'test-removed',
  'test-disabled',
  'assertions-reduced',
  'expected-value-changed',
  'suppression-added',
  'error-swallowed',
  'check-config-relaxed',
] as const;
export type CheckWeakeningCode = typeof CHECK_WEAKENING_CODES[number];

export const CHECK_WEAKENING_SOURCE = 'check-weakening';

/** A finding plus the production symbols the affected test file reaches. */
export interface CheckWeakeningFinding extends GovernanceFinding {
  code: CheckWeakeningCode;
  /** Production symbols the test file reaches in the index (first {@link MAX_REACH_NAMES}). */
  reaches?: string[];
  /** The subset of `reaches` that this diff also changes. */
  reachesChanged?: string[];
}

export interface NotAssessed {
  file: string;
  shapes: CheckWeakeningCode[];
  reason: string;
}

export interface CheckWeakeningResult {
  /** The fixed baseline the shapes were computed against. */
  baseline: { ref: string; commit: string };
  findings: CheckWeakeningFinding[];
  notAssessed: NotAssessed[];
  boundaries: string[];
}

/** One changed file: its text at the baseline and in the new state (`null` when absent there). */
export interface WeakeningFile {
  path: string;
  base: string | null;
  current: string | null;
}

/** Which production symbols a test file reaches, from the index. */
export interface ReachIndex {
  reachOf(testFile: string): { recorded: boolean; symbols: Array<{ id: string; name: string }> };
}

const TEST_SHAPES: CheckWeakeningCode[] = ['test-removed', 'test-disabled', 'assertions-reduced', 'expected-value-changed'];
const CODE_SHAPES: CheckWeakeningCode[] = ['suppression-added', 'error-swallowed'];
/** Languages with a test-case, assertion, comment and handler adapter below. */
const ASSESSED_LANGUAGES = new Set(['TypeScript', 'JavaScript', 'Python', 'Go', 'Java']);

const MAX_FILES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FINDINGS_PER_FILE = 20;
const MAX_REACH_NAMES = 10;
const MAX_REACH_NODES = 2000;
const MAX_REACH_DEPTH = 12;

// ── Test cases ──────────────────────────────────────────────────────────────────

interface TestCase {
  /** Suite path and name, unique within the file. */
  key: string;
  line: number;
  /** A skip/ignore/disable marker applies (on the case, an enclosing suite, or a skip call in its body). */
  disabled: string | null;
  /** A focus marker (`.only`, `fit`) applies: the file's other tests stop running. */
  focused: string | null;
  assertions: number;
  /** Literal arguments of the assertions, in source order. */
  literals: string[];
  /** Hash of the body text, to tell a renamed test from a removed one. */
  bodyHash: string;
}

function hash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string' || n.type === 'interpreted_string_literal' || n.type === 'raw_string_literal' || n.type === 'string_literal') {
    return n.text.replace(/^[a-zA-Z]*(['"`]{1,3})/, '').replace(/(['"`]{1,3})$/, '');
  }
  if (n.type === 'template_string' && !n.namedChildren.some(c => c.type === 'template_substitution')) {
    return n.text.slice(1, -1);
  }
  return null;
}

/** Iterative pre-order walk (no recursion: a deep tree must not overflow the stack). */
function* walk(root: Node, skip?: (n: Node) => boolean): Generator<Node> {
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    yield n;
    if (n !== root && skip?.(n)) continue;
    for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i)!);
  }
}

const LITERAL_TYPES = new Set([
  // TypeScript / JavaScript
  'string', 'number', 'true', 'false', 'null', 'regex', 'template_string', 'undefined',
  // Python
  'integer', 'float', 'none', 'concatenated_string',
  // Go
  'interpreted_string_literal', 'raw_string_literal', 'int_literal', 'float_literal', 'rune_literal', 'nil',
  // Java
  'string_literal', 'decimal_integer_literal', 'hex_integer_literal', 'decimal_floating_point_literal',
  'null_literal', 'character_literal',
]);
const COMPOSITE_TYPES = new Set(['array', 'object', 'list', 'tuple', 'dictionary', 'set', 'pair', 'unary_expression', 'unary_operator']);
const COMPOSITE_PARTS = new Set(['property_identifier', 'string_fragment', 'string_content', 'string_start', 'string_end', 'escape_sequence']);

/** A literal value, or a composite (array, object, negative number) built only of literals. */
function isLiteral(n: Node): boolean {
  if (LITERAL_TYPES.has(n.type)) return n.type !== 'template_string' || !n.namedChildren.some(c => c.type === 'template_substitution');
  if (!COMPOSITE_TYPES.has(n.type)) return false;
  for (const d of walk(n)) {
    if (d === n) continue;
    if (!LITERAL_TYPES.has(d.type) && !COMPOSITE_TYPES.has(d.type) && !COMPOSITE_PARTS.has(d.type)) return false;
  }
  return true;
}

function literalArgs(args: Node | null): string[] {
  return args ? args.namedChildren.filter(isLiteral).map(a => a.text) : [];
}

// TypeScript / JavaScript — Vitest, Jest, Mocha.
const JS_CASES = new Set(['it', 'test', 'specify', 'xit', 'xtest', 'xspecify', 'fit', 'ftest']);
const JS_SUITES = new Set(['describe', 'context', 'suite', 'xdescribe', 'xcontext', 'xsuite', 'fdescribe']);
const JS_SKIP_MODS = new Set(['skip', 'todo', 'skipIf', 'runIf']);
const JS_ASSERT_ROOTS = new Set(['expect', 'assert', 'expectTypeOf', 'assertType']);

/** `it.skip.each(t)` → { root: 'it', mods: ['skip', 'each'] }. */
function jsCallee(call: Node): { root: string; mods: string[] } | null {
  let fn = call.childForFieldName('function');
  const mods: string[] = [];
  if (fn?.type === 'call_expression') fn = fn.childForFieldName('function'); // it.each(table)('name', fn)
  while (fn?.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    if (prop) mods.unshift(prop.text);
    fn = fn.childForFieldName('object');
    if (fn?.type === 'call_expression') fn = fn.childForFieldName('function');
  }
  return fn?.type === 'identifier' ? { root: fn.text, mods } : null;
}

function jsMarkers(c: { root: string; mods: string[] }): { disabled: string | null; focused: string | null } {
  const label = [c.root, ...c.mods.filter(m => m !== 'each')].join('.');
  const disabled = c.root.startsWith('x') || c.mods.some(m => JS_SKIP_MODS.has(m)) ? label : null;
  const focused = (c.root.startsWith('f') && c.root !== 'function') || c.mods.includes('only') ? label : null;
  return { disabled, focused };
}

function jsAssertions(body: Node): { count: number; literals: string[] } {
  let count = 0;
  const literals: string[] = [];
  for (const n of walk(body)) {
    if (n.type !== 'call_expression') continue;
    const fn = n.childForFieldName('function');
    const isRoot = fn?.type === 'identifier' && JS_ASSERT_ROOTS.has(fn.text);
    const isMember = fn?.type === 'member_expression' && fn.childForFieldName('object')?.type === 'identifier'
      && JS_ASSERT_ROOTS.has(fn.childForFieldName('object')!.text);
    if (!isRoot && !isMember) continue;
    count++;
    // `assert.equal(a, 1)` / `assert(x === 1)`: every literal argument. `expect(actual)`: the actual
    // value is not an expected value, so only the chained matcher calls' literals count.
    const actualSide = isRoot && (fn!.text === 'expect' || fn!.text === 'expectTypeOf');
    if (!actualSide) literals.push(...literalArgs(n.childForFieldName('arguments')));
    let cur: Node = n;
    while (cur.parent && (cur.parent.type === 'member_expression' || (cur.parent.type === 'call_expression' && cur.parent.childForFieldName('function')?.id === cur.id))) {
      cur = cur.parent;
      if (cur.type === 'call_expression') literals.push(...literalArgs(cur.childForFieldName('arguments')));
    }
  }
  return { count, literals };
}

function jsCases(root: Node): TestCase[] {
  const out: TestCase[] = [];
  const stack: Array<{ n: Node; suite: string[]; disabled: string | null; focused: string | null }> = [{ n: root, suite: [], disabled: null, focused: null }];
  while (stack.length) {
    const { n, suite, disabled, focused } = stack.pop()!;
    let childSuite = suite;
    let childDisabled = disabled;
    let childFocused = focused;
    if (n.type === 'call_expression') {
      const callee = jsCallee(n);
      const args = n.childForFieldName('arguments');
      const title = stringValue(args?.namedChild(0));
      if (callee && title !== null && (JS_CASES.has(callee.root) || JS_SUITES.has(callee.root))) {
        const m = jsMarkers(callee);
        if (JS_SUITES.has(callee.root)) {
          childSuite = [...suite, title];
          childDisabled = disabled ?? m.disabled;
          childFocused = focused ?? m.focused;
        } else {
          const body = args!.namedChildren.find(a => a.type === 'arrow_function' || a.type === 'function_expression' || a.type === 'function');
          const a = body ? jsAssertions(body) : { count: 0, literals: [] };
          out.push({
            key: [...suite, title].join(' > '),
            line: n.startPosition.row + 1,
            disabled: disabled ?? m.disabled ?? (body && /\b(?:ctx|context|this|t)\.skip\s*\(/.test(body.text) ? 'skip()' : null),
            focused: focused ?? m.focused,
            assertions: a.count,
            literals: a.literals,
            bodyHash: hash(body?.text ?? ''),
          });
          continue; // a test case's body holds no further cases
        }
      }
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      stack.push({ n: n.namedChild(i)!, suite: childSuite, disabled: childDisabled, focused: childFocused });
    }
  }
  return out;
}

// Python — pytest, unittest.
const PY_SKIP_DECORATOR = /^@\s*(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.(?:skip|skipIf|skipUnless|expectedFailure)|skip|skipIf|skipUnless|expectedFailure)\b/;

function pyDecorators(def: Node): string[] {
  const parent = def.parent;
  return parent?.type === 'decorated_definition' ? parent.namedChildren.filter(c => c.type === 'decorator').map(c => c.text) : [];
}

function pyCases(root: Node): TestCase[] {
  const out: TestCase[] = [];
  for (const n of walk(root)) {
    if (n.type !== 'function_definition') continue;
    const name = n.childForFieldName('name')?.text ?? '';
    if (!/^test/.test(name)) continue;
    let nested = false;
    for (let p = n.parent; p && !nested; p = p.parent) nested = p.type === 'function_definition';
    if (nested) continue;
    const cls = n.parent?.parent?.type === 'class_definition' ? n.parent.parent
      : n.parent?.parent?.parent?.type === 'class_definition' ? n.parent.parent.parent : null;
    const clsName = cls?.childForFieldName('name')?.text;
    const decorators = [...pyDecorators(n), ...(cls ? pyDecorators(cls) : [])];
    const body = n.childForFieldName('body');
    let count = 0;
    const literals: string[] = [];
    if (body) {
      for (const d of walk(body, c => c.type === 'function_definition')) {
        if (d.type === 'assert_statement') {
          count++;
          for (const c of d.namedChildren) {
            if (c.type === 'comparison_operator') literals.push(...c.namedChildren.filter(isLiteral).map(x => x.text));
            else if (isLiteral(c)) literals.push(c.text);
          }
        } else if (d.type === 'call') {
          const fn = d.childForFieldName('function');
          const last = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : fn?.type === 'identifier' ? fn.text : undefined;
          if (last && (/^assert/.test(last) || (fn?.type === 'attribute' && /^pytest\.(?:raises|warns)$/.test(fn.text)))) {
            count++;
            literals.push(...literalArgs(d.childForFieldName('arguments')));
          }
        }
      }
    }
    const skipDecorator = decorators.find(d => PY_SKIP_DECORATOR.test(d));
    const skipCall = body && /\b(?:pytest\.skip|self\.skipTest)\s*\(/.test(body.text);
    out.push({
      key: clsName ? `${clsName}.${name}` : name,
      line: n.startPosition.row + 1,
      disabled: skipDecorator ? skipDecorator.replace(/\(.*$/s, '') : skipCall ? 'skip()' : null,
      focused: null,
      assertions: count,
      literals,
      bodyHash: hash(body?.text ?? ''),
    });
  }
  return out;
}

// Go — testing, testify.
const GO_FAIL = new Set(['Error', 'Errorf', 'Fatal', 'Fatalf', 'Fail', 'FailNow']);
const GO_SKIP = new Set(['Skip', 'Skipf', 'SkipNow']);

function goSubtest(n: Node): { title: string; body: Node } | null {
  if (n.type !== 'call_expression') return null;
  const fn = n.childForFieldName('function');
  if (fn?.type !== 'selector_expression' || fn.childForFieldName('field')?.text !== 'Run') return null;
  const args = n.childForFieldName('arguments');
  const title = stringValue(args?.namedChild(0));
  const body = args?.namedChild(1);
  return title !== null && body?.type === 'func_literal' ? { title, body } : null;
}

function goCase(key: string, line: number, body: Node, out: TestCase[]): void {
  let count = 0;
  let disabled: string | null = null;
  const literals: string[] = [];
  const subtests: Array<{ title: string; body: Node; line: number }> = [];
  for (const n of walk(body, c => goSubtest(c) !== null)) {
    const sub = n !== body ? goSubtest(n) : null;
    if (sub) { subtests.push({ ...sub, line: n.startPosition.row + 1 }); continue; }
    if (n.type !== 'call_expression') continue;
    const fn = n.childForFieldName('function');
    if (fn?.type !== 'selector_expression') continue;
    const field = fn.childForFieldName('field')?.text ?? '';
    const operand = fn.childForFieldName('operand');
    if (operand?.type === 'identifier' && (operand.text === 'assert' || operand.text === 'require')) {
      count++;
      literals.push(...literalArgs(n.childForFieldName('arguments')));
    } else if (GO_FAIL.has(field)) {
      count++;
    } else if (GO_SKIP.has(field)) {
      disabled ??= `t.${field}`;
    }
  }
  out.push({ key, line, disabled, focused: null, assertions: count, literals, bodyHash: hash(body.text) });
  for (const s of subtests) goCase(`${key}/${s.title}`, s.line, s.body, out);
}

function goCases(root: Node): TestCase[] {
  const out: TestCase[] = [];
  for (const n of root.namedChildren) {
    if (n.type !== 'function_declaration') continue;
    const name = n.childForFieldName('name')?.text ?? '';
    const body = n.childForFieldName('body');
    if (/^Test(?:$|[^a-z])/.test(name) && body) goCase(name, n.startPosition.row + 1, body, out);
  }
  return out;
}

// Java — JUnit 4/5, AssertJ.
const JAVA_TEST_ANNOTATIONS = new Set(['Test', 'ParameterizedTest', 'RepeatedTest', 'TestFactory', 'TestTemplate']);
const JAVA_DISABLED = /^(?:Disabled\w*|Ignore)$/;

function javaAnnotations(decl: Node | null): string[] {
  const mods = decl?.namedChildren.find(c => c.type === 'modifiers');
  return mods ? mods.namedChildren.filter(c => c.type === 'marker_annotation' || c.type === 'annotation')
    .map(a => (a.childForFieldName('name')?.text ?? '').replace(/^.*\./, '')) : [];
}

function javaCases(root: Node): TestCase[] {
  const out: TestCase[] = [];
  for (const n of walk(root)) {
    if (n.type !== 'method_declaration') continue;
    const annotations = javaAnnotations(n);
    if (!annotations.some(a => JAVA_TEST_ANNOTATIONS.has(a))) continue;
    const cls = n.parent?.parent;
    const clsAnnotations = cls?.type === 'class_declaration' ? javaAnnotations(cls) : [];
    const body = n.childForFieldName('body');
    let count = 0;
    const literals: string[] = [];
    if (body) {
      for (const d of walk(body)) {
        if (d.type !== 'method_invocation' || !/^assert/.test(d.childForFieldName('name')?.text ?? '')) continue;
        count++;
        // `assertThat(actual)` names the actual value; `assertEquals(expected, actual)` both.
        if (d.childForFieldName('name')!.text !== 'assertThat') literals.push(...literalArgs(d.childForFieldName('arguments')));
        let cur: Node = d;
        while (cur.parent?.type === 'method_invocation' && cur.parent.childForFieldName('object')?.id === cur.id) {
          cur = cur.parent;
          literals.push(...literalArgs(cur.childForFieldName('arguments')));
        }
      }
    }
    const disabled = [...annotations, ...clsAnnotations].find(a => JAVA_DISABLED.test(a));
    const clsName = cls?.childForFieldName('name')?.text;
    const name = n.childForFieldName('name')?.text ?? '';
    out.push({
      key: clsName ? `${clsName}.${name}` : name,
      line: n.startPosition.row + 1,
      disabled: disabled ? `@${disabled}` : null,
      focused: null,
      assertions: count,
      literals,
      bodyHash: hash(body?.text ?? ''),
    });
  }
  return out;
}

function extractCases(language: string, root: Node): TestCase[] {
  const raw = language === 'Python' ? pyCases(root)
    : language === 'Go' ? goCases(root)
      : language === 'Java' ? javaCases(root)
        : jsCases(root);
  // Same-named cases (a table of `it` calls, overloads) are told apart by their order.
  const seen = new Map<string, number>();
  return raw.map(c => {
    const k = seen.get(c.key) ?? 0;
    seen.set(c.key, k + 1);
    return k ? { ...c, key: `${c.key} #${k + 1}` } : c;
  });
}

// ── Suppressions ────────────────────────────────────────────────────────────────

const SUPPRESSIONS: Record<string, Array<[label: string, re: RegExp]>> = {
  TypeScript: [['@ts-ignore', /@ts-ignore\b/], ['@ts-expect-error', /@ts-expect-error\b/], ['@ts-nocheck', /@ts-nocheck\b/],
    ['eslint-disable', /\beslint-disable(?:-next-line|-line)?\b/], ['biome-ignore', /\bbiome-ignore\b/], ['istanbul ignore', /\b(?:istanbul|c8|v8) ignore\b/]],
  Python: [['# noqa', /#\s*noqa\b/], ['# type: ignore', /#\s*type:\s*ignore\b/], ['# pylint: disable', /#\s*pylint:\s*disable\b/],
    ['# pragma: no cover', /#\s*pragma:\s*no\s*cover\b/], ['# nosec', /#\s*nosec\b/]],
  Go: [['//nolint', /\/\/\s*nolint\b/], ['//lint:ignore', /\/\/\s*lint:ignore\b/], ['#nosec', /#nosec\b/]],
  Java: [['// NOSONAR', /\bNOSONAR\b/], ['// CHECKSTYLE:OFF', /\bCHECKSTYLE:OFF\b/]],
};
SUPPRESSIONS.JavaScript = SUPPRESSIONS.TypeScript;

interface Marker { label: string; text: string; line: number }

function suppressionMarkers(language: string, root: Node): Marker[] {
  const out: Marker[] = [];
  const table = SUPPRESSIONS[language] ?? [];
  for (const n of walk(root)) {
    if (n.type === 'comment' || n.type === 'line_comment' || n.type === 'block_comment') {
      for (const [label, re] of table) if (re.test(n.text)) out.push({ label, text: n.text.trim(), line: n.startPosition.row + 1 });
    } else if (language === 'Java' && (n.type === 'annotation' || n.type === 'marker_annotation')
        && /^(?:java\.lang\.)?SuppressWarnings$/.test(n.childForFieldName('name')?.text ?? '')) {
      out.push({ label: '@SuppressWarnings', text: n.text, line: n.startPosition.row + 1 });
    }
  }
  return out;
}

// ── Swallowed errors ────────────────────────────────────────────────────────────

/** Calls that only log: the closed per-language logging-call list. */
const LOG_CALL: Record<string, RegExp> = {
  TypeScript: /^(?:console|logger|log|this\.logger|this\.log)\.\w+\s*\(/,
  Python: /^(?:print|(?:logging|logger|log|self\.logger|self\.log)\.\w+)\s*\(/,
  Go: /^(?:fmt\.(?:Print|Fprint)\w*|log\.\w+|logger\.\w+|\w+\.Log\w*)\s*\(/,
  Java: /^(?:(?:System\.(?:out|err))\.print\w*|(?:log|LOG|logger|LOGGER|this\.log|this\.logger)\.\w+|\w+\.printStackTrace)\s*\(/,
};
LOG_CALL.JavaScript = LOG_CALL.TypeScript;

/** A handler body that discards the error: empty, or only logging calls and a constant `return`. */
function onlyLogs(language: string, block: Node | null | undefined): boolean {
  if (!block) return true;
  const re = LOG_CALL[language];
  // tree-sitter-go wraps a block's statements in a `statement_list`.
  const statements = block.namedChildren.flatMap(c => (c.type === 'statement_list' ? c.namedChildren : [c]));
  return statements.every(s => {
    if (s.type === 'comment' || s.type === 'pass_statement' || s.type === 'empty_statement') return true;
    // `return;`, `return null`, `return 0`, Go `return nil`: a constant stands in for the error.
    if (s.type === 'return_statement') return s.namedChildren.flatMap(c => (c.type === 'expression_list' ? c.namedChildren : [c])).every(isLiteral);
    if (s.type !== 'expression_statement') return false;
    return re.test(s.text.trim());
  });
}

function enclosingFunction(n: Node): string {
  for (let p = n.parent; p; p = p.parent) {
    const name = p.childForFieldName('name');
    if (name && /function|method|def/.test(p.type)) return name.text;
    if (p.type === 'arrow_function' && p.parent?.type === 'variable_declarator') return p.parent.childForFieldName('name')?.text ?? '<anonymous>';
  }
  return '<module>';
}

const CALL_TYPES = new Set(['call_expression', 'call', 'method_invocation']);
function firstCall(n: Node | null | undefined): string | null {
  if (!n) return null;
  for (const d of walk(n)) if (CALL_TYPES.has(d.type)) return d.text.split('\n')[0].slice(0, 80);
  return null;
}

interface Swallow { key: string; fn: string; call: string; line: number }

function swallowedHandlers(language: string, root: Node): Swallow[] {
  const out: Swallow[] = [];
  for (const n of walk(root)) {
    if (language === 'Go') {
      // `if err != nil { }` (or only logging), right after or around the call that returned err.
      if (n.type !== 'if_statement') continue;
      const cond = n.childForFieldName('condition')?.text.replace(/\s+/g, ' ') ?? '';
      if (!/^\w*[eE]rr\w* != nil$/.test(cond)) continue;
      const consequence = n.childForFieldName('consequence');
      if (!onlyLogs(language, consequence)) continue;
      const guarded = n.childForFieldName('initializer') ?? n.previousNamedSibling;
      const call = firstCall(guarded);
      if (call) out.push({ key: `${enclosingFunction(n)}\0${hash(guarded!.text)}`, fn: enclosingFunction(n), call, line: n.startPosition.row + 1 });
      continue;
    }
    const isHandler = n.type === 'catch_clause' || n.type === 'except_clause';
    if (!isHandler) continue;
    const block = n.type === 'except_clause' ? n.namedChildren.find(c => c.type === 'block') : n.childForFieldName('body');
    if (!onlyLogs(language, block)) continue;
    const tryNode = n.parent?.type === 'try_statement' ? n.parent : null;
    const tryBody = tryNode?.childForFieldName('body') ?? tryNode?.namedChildren.find(c => c.type === 'block') ?? null;
    const call = firstCall(tryBody);
    if (!call) continue;
    out.push({ key: `${enclosingFunction(n)}\0${hash(tryBody!.text)}`, fn: enclosingFunction(n), call, line: n.startPosition.row + 1 });
  }
  return out;
}

// ── Config relaxation ───────────────────────────────────────────────────────────

type ConfigKind = 'ci' | 'lint' | 'test-runner' | 'coverage' | 'ignore-file' | 'sectioned';

/** The closed table of check config files. */
export function checkConfigKind(path: string): ConfigKind | null {
  const p = path.replace(/\\/g, '/');
  const name = p.split('/').pop() ?? '';
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /(^|\/)\.gitlab-ci\.ya?ml$/.test(p)) return 'ci';
  if (/^\.(?:eslint|stylelint)ignore$/.test(name)) return 'ignore-file';
  if (/^(?:\.eslintrc(?:\.\w+)?|eslint\.config\.[cm]?[jt]s|\.golangci\.ya?ml|\.?ruff\.toml|\.flake8|\.pylintrc|pylintrc|mypy\.ini|biome\.jsonc?)$/.test(name)) return 'lint';
  if (/^(?:\.nycrc(?:\.\w+)?|\.c8rc(?:\.\w+)?|\.coveragerc|\.?codecov\.ya?ml)$/.test(name)) return 'coverage';
  if (/^(?:(?:vitest|jest|vite|playwright|karma|cypress)\.config\.[cm]?[jt]s|jest\.config\.json|\.mocharc(?:\.\w+)?|pytest\.ini|package\.json)$/.test(name)) return 'test-runner';
  if (/^(?:pyproject\.toml|setup\.cfg|tox\.ini)$/.test(name)) return 'sectioned';
  return null;
}

const IGNORE_KEY = /(?:^|[\s"'{,[-])(?:exclude|excludes|extend-exclude|exclude[_-](?:dirs|files|lines|rules)|ignore|ignores|ignorePatterns|extend-ignore|per-file-ignores|(?:test|coverage|module|watch)PathIgnorePatterns|testIgnore|omit|skip-(?:dirs|files)|norecursedirs|deselect|disable|disabled-checks|--ignore|--deselect)\b/i;
const THRESHOLD = /\b(fail[_-]?under|cov-fail-under|branches|functions|lines|statements|threshold|minimum[_-]?coverage|min[_-]?coverage)\b["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)/g;
const CHECK_SECTION = /pytest|coverage|ruff|flake8|pylint|mypy|pycodestyle|bandit|testenv/i;
const TEST_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)(?: run)? test\b|vitest|jest|mocha|pytest|tox\b|go test|cargo test|(?:mvn|mvnw)\b.*\b(?:test|verify)\b|gradlew?\b.*\b(?:test|check)\b|rspec|make (?:test|check)\b|dotnet test|phpunit)/;

/** Lines in `current` that `base` does not have (multiset), with their 1-based line numbers. */
function addedLines(base: string, current: string): Array<{ line: number; text: string }> {
  const remaining = new Map<string, number>();
  for (const l of base.split(/\r?\n/)) remaining.set(l.trim(), (remaining.get(l.trim()) ?? 0) + 1);
  const out: Array<{ line: number; text: string }> = [];
  current.split(/\r?\n/).forEach((l, i) => {
    const t = l.trim();
    const left = remaining.get(t) ?? 0;
    if (left > 0) remaining.set(t, left - 1);
    else if (t) out.push({ line: i + 1, text: t });
  });
  return out;
}

const LIST_ITEM = /^(?:-\s|["'`][^"'`]*["'`],?$|[\w./*-]+,?$)/;

/** The key a line belongs to: the line itself when it is not a list item, else the line opening its list. */
function governingLine(lines: string[], index: number): string {
  const own = lines[index].trim();
  if (!LIST_ITEM.test(own)) return own;
  for (let i = index - 1; i >= 0 && index - i < 200; i--) {
    const t = lines[i].trim();
    if (t && !LIST_ITEM.test(t)) return t;
  }
  return own;
}

function sectionOf(lines: string[], index: number): string {
  for (let i = index; i >= 0; i--) {
    const m = /^\s*\[([^\]]+)\]/.exec(lines[i]);
    if (m) return m[1];
  }
  return '';
}

function thresholds(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const m of text.matchAll(THRESHOLD)) {
    const key = m[1].toLowerCase().replace(/[-_]/g, '');
    (out.get(key) ?? out.set(key, []).get(key)!).push(Number(m[2]));
  }
  return out;
}

interface CiFacts { testSteps: Map<string, string>; allSteps: Set<string>; allowFailure: Set<string> }

function ciFacts(text: string): CiFacts | null {
  let doc: unknown;
  try { doc = parseYaml(text, { maxAliasCount: 100 }); } catch { return null; }
  const facts: CiFacts = { testSteps: new Map(), allSteps: new Set(), allowFailure: new Set() };
  if (!doc || typeof doc !== 'object') return facts;
  const record = (where: string, run: unknown) => {
    const commands = (Array.isArray(run) ? run : [run]).filter((r): r is string => typeof r === 'string');
    for (const c of commands) {
      const norm = c.replace(/\s+/g, ' ').trim();
      facts.allSteps.add(norm);
      if (TEST_COMMAND.test(norm)) facts.testSteps.set(norm, where);
    }
  };
  const truthy = (v: unknown) => v === true || v === 'true' || (typeof v === 'string' && /\$\{\{/.test(v));
  const jobs = (doc as Record<string, unknown>).jobs;
  if (jobs && typeof jobs === 'object') {
    // GitHub Actions.
    for (const [jobName, job] of Object.entries(jobs as Record<string, unknown>)) {
      if (!job || typeof job !== 'object') continue;
      const j = job as Record<string, unknown>;
      if (truthy(j['continue-on-error'])) facts.allowFailure.add(`job ${jobName}`);
      const steps = Array.isArray(j.steps) ? j.steps : [];
      steps.forEach((s, i) => {
        if (!s || typeof s !== 'object') return;
        const step = s as Record<string, unknown>;
        const label = `job ${jobName}, step ${typeof step.name === 'string' ? step.name : i + 1}`;
        record(label, step.run);
        if (truthy(step['continue-on-error'])) facts.allowFailure.add(label);
      });
    }
  } else {
    // GitLab CI: every top-level mapping with a script is a job.
    for (const [jobName, job] of Object.entries(doc as Record<string, unknown>)) {
      if (!job || typeof job !== 'object' || jobName.startsWith('.')) continue;
      const j = job as Record<string, unknown>;
      record(`job ${jobName}`, j.script);
      if (j.allow_failure === true) facts.allowFailure.add(`job ${jobName}`);
    }
  }
  return facts;
}

function configRelaxations(path: string, kind: ConfigKind, base: string, current: string): Array<{ line?: number; message: string; discriminator: string }> {
  const out: Array<{ line?: number; message: string; discriminator: string }> = [];
  const lines = current.split(/\r?\n/);
  if (kind === 'ci') {
    const before = ciFacts(base);
    const after = ciFacts(current);
    if (!before || !after) return out; // unparsable YAML: disclosed by the caller
    for (const [step, where] of before.testSteps) {
      if (!after.allSteps.has(step)) out.push({ message: `A CI step that ran tests was removed or changed in ${path} (${where}): \`${step}\`.`, discriminator: `step:${step}` });
    }
    for (const where of after.allowFailure) {
      if (!before.allowFailure.has(where)) out.push({ message: `Failure is now allowed for ${where} in ${path} (continue-on-error / allow_failure).`, discriminator: `allow:${where}` });
    }
  } else {
    for (const a of addedLines(base, current)) {
      if (a.text.startsWith('#') || a.text.startsWith('//')) continue;
      if (kind === 'sectioned' && !CHECK_SECTION.test(sectionOf(lines, a.line - 1))) continue;
      if (kind === 'ignore-file') {
        out.push({ line: a.line, message: `An ignore pattern was added to ${path}: \`${a.text}\`.`, discriminator: `line:${a.text}` });
        continue;
      }
      if (IGNORE_KEY.test(governingLine(lines, a.line - 1))) {
        out.push({ line: a.line, message: `An exclude/ignore entry was added to ${path}: \`${a.text}\`.`, discriminator: `line:${a.text}` });
      } else if (kind === 'lint' && /["']?\s*[:=]\s*\[?\s*["']?(?:off|0)["']?\s*(?:[,\]}]|$)/.test(a.text)) {
        out.push({ line: a.line, message: `A lint rule was turned off in ${path}: \`${a.text}\`.`, discriminator: `line:${a.text}` });
      }
    }
  }
  if (kind !== 'lint' && kind !== 'ignore-file') {
    const before = thresholds(base);
    for (const [key, values] of thresholds(current)) {
      values.forEach((v, i) => {
        const was = before.get(key)?.[i];
        if (was !== undefined && v < was) out.push({ message: `A coverage threshold \`${key}\` was lowered from ${was} to ${v} in ${path}.`, discriminator: `threshold:${key}:${i}` });
      });
    }
  }
  return out;
}

// ── Detection over the changed files ────────────────────────────────────────────

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

/** Production symbols reached by a test file, from `tested_by` edges and their forward call closure. */
export function reachIndexFromGraph(cg: SerializedCallGraph): ReachIndex {
  const nodes = new Map(cg.nodes.map(n => [n.id, n]));
  const direct = new Map<string, Set<string>>();
  const calls = new Map<string, string[]>();
  for (const e of cg.edges) {
    if (e.kind === 'tested_by') {
      const file = e.calleeId.endsWith('::*') ? e.calleeId.slice(0, -3) : nodes.get(e.calleeId)?.filePath;
      if (file) (direct.get(file) ?? direct.set(file, new Set()).get(file)!).add(e.callerId);
    } else if ((!e.kind || e.kind === 'calls') && e.calleeId) {
      (calls.get(e.callerId) ?? calls.set(e.callerId, []).get(e.callerId)!).push(e.calleeId);
    }
  }
  return {
    reachOf(testFile) {
      const seeds = direct.get(testFile);
      if (!seeds?.size) return { recorded: false, symbols: [] };
      const depth = new Map<string, number>([...seeds].map(id => [id, 0]));
      const queue = [...seeds].sort();
      for (let i = 0; i < queue.length && depth.size < MAX_REACH_NODES; i++) {
        const d = depth.get(queue[i])!;
        if (d >= MAX_REACH_DEPTH) continue;
        for (const next of calls.get(queue[i]) ?? []) {
          const n = nodes.get(next);
          if (!n || n.isExternal || n.isTest || depth.has(next)) continue;
          depth.set(next, d + 1);
          queue.push(next);
        }
      }
      return { recorded: true, symbols: queue.filter(id => nodes.has(id)).map(id => ({ id, name: nodes.get(id)!.name })) };
    },
  };
}

function finding(
  code: CheckWeakeningCode, severity: GovernanceFinding['severity'], subject: string, message: string,
  path: string, line: number | undefined, discriminator: string,
): CheckWeakeningFinding {
  return {
    code, severity, source: CHECK_WEAKENING_SOURCE,
    subject: emittedText(subject), message: emittedText(message), discriminator: emittedText(discriminator),
    location: line === undefined ? { path: emittedText(path) } : { path: emittedText(path), line },
  };
}

function quote(text: string): string {
  return '`' + text.replace(/`/g, "'").slice(0, 120) + '`';
}

/**
 * Detect every weakening shape over the changed files. Pure except for loading the tree-sitter
 * grammars; `reach` joins each test finding to what the test guarded, and `changedIds` is the set of
 * production symbols the diff changes (an expected value updated with its code is not reported).
 */
export async function detectWeakeningShapes(
  files: readonly WeakeningFile[],
  reach: ReachIndex | undefined,
  changedIds: ReadonlySet<string> | undefined,
): Promise<{ findings: CheckWeakeningFinding[]; notAssessed: NotAssessed[]; boundaries: string[] }> {
  const findings: CheckWeakeningFinding[] = [];
  const notAssessed: NotAssessed[] = [];
  const boundaries: string[] = [];
  let capped = 0;

  for (const f of files) {
    const fileFindings: CheckWeakeningFinding[] = [];
    const push = (): void => {
      if (fileFindings.length > MAX_FINDINGS_PER_FILE) capped += fileFindings.length - MAX_FINDINGS_PER_FILE;
      findings.push(...fileFindings.slice(0, MAX_FINDINGS_PER_FILE));
    };
    const kind = checkConfigKind(f.path);
    if (kind && f.base !== null && f.current !== null) {
      if (kind === 'ci' && (!ciFacts(f.base) || !ciFacts(f.current))) {
        notAssessed.push({ file: f.path, shapes: ['check-config-relaxed'], reason: 'the workflow is not valid YAML at one of the two revisions' });
      }
      for (const r of configRelaxations(f.path, kind, f.base, f.current)) {
        fileFindings.push(finding('check-config-relaxed', 'warning', r.line ? `${f.path}:${r.line}` : f.path, r.message, f.path, r.line, r.discriminator));
      }
    }

    const language = detectLanguage(f.path);
    const isTest = isTestFile(f.path);
    if (language === 'unknown' || kind) { push(); continue; }
    if (!ASSESSED_LANGUAGES.has(language)) {
      notAssessed.push({ file: f.path, shapes: isTest ? [...TEST_SHAPES, ...CODE_SHAPES] : CODE_SHAPES, reason: `${language} is outside the closed language table` });
      push();
      continue;
    }
    const baseRoot = f.base !== null ? await parse(language, f.path, f.base) : null;
    const curRoot = f.current !== null ? await parse(language, f.path, f.current) : null;
    if ((f.base !== null && !baseRoot) || (f.current !== null && !curRoot)) {
      notAssessed.push({ file: f.path, shapes: isTest ? [...TEST_SHAPES, ...CODE_SHAPES] : CODE_SHAPES, reason: 'the file could not be parsed at one of the two revisions' });
      push();
      continue;
    }

    if (curRoot) {
      // suppression-added: marker comments the baseline did not have (matched by their text).
      const before = new Map<string, number>();
      for (const m of baseRoot ? suppressionMarkers(language, baseRoot) : []) before.set(m.text, (before.get(m.text) ?? 0) + 1);
      for (const m of suppressionMarkers(language, curRoot)) {
        const left = before.get(m.text) ?? 0;
        if (left > 0) { before.set(m.text, left - 1); continue; }
        fileFindings.push(finding('suppression-added', 'info', `${f.path}:${m.line}`, `A ${quote(m.label)} suppression was added at ${f.path}:${m.line}.`, f.path, m.line, `${m.label}:${m.text}`));
      }
      // error-swallowed: a function holds more error-discarding handlers than at the baseline; the
      // extra ones are those around a call the baseline did not so wrap (an edited try body that was
      // already swallowed keeps the count and is not reported).
      const baseSwallows = baseRoot ? swallowedHandlers(language, baseRoot) : [];
      const wrapped = new Set(baseSwallows.map(s => s.key));
      const perFn = new Map<string, number>();
      for (const s of baseSwallows) perFn.set(s.fn, (perFn.get(s.fn) ?? 0) + 1);
      const curSwallows = swallowedHandlers(language, curRoot);
      const curPerFn = new Map<string, number>();
      for (const s of curSwallows) curPerFn.set(s.fn, (curPerFn.get(s.fn) ?? 0) + 1);
      const extra = new Map([...curPerFn].map(([fn, n]) => [fn, n - (perFn.get(fn) ?? 0)]));
      for (const s of curSwallows) {
        if (wrapped.has(s.key) || (extra.get(s.fn) ?? 0) <= 0) continue;
        extra.set(s.fn, extra.get(s.fn)! - 1);
        fileFindings.push(finding('error-swallowed', 'warning', `${f.path}:${s.line}`,
          `An error from ${quote(s.call)} in ${quote(s.fn)} is now caught and only logged or ignored (${f.path}:${s.line}).`, f.path, s.line, s.key));
      }
    }

    if (isTest) fileFindings.push(...testShapes(f, language, baseRoot, curRoot, reach, changedIds, notAssessed));
    push();
  }
  if (capped) boundaries.push(`${capped} check-weakening finding(s) past ${MAX_FINDINGS_PER_FILE} per file were omitted.`);
  return { findings, notAssessed, boundaries };
}

function testShapes(
  f: WeakeningFile, language: string, baseRoot: Node | null, curRoot: Node | null,
  reach: ReachIndex | undefined, changedIds: ReadonlySet<string> | undefined, notAssessed: NotAssessed[],
): CheckWeakeningFinding[] {
  const out: CheckWeakeningFinding[] = [];
  const baseCases = baseRoot ? extractCases(language, baseRoot) : [];
  const curCases = curRoot ? extractCases(language, curRoot) : [];
  const r = reach?.reachOf(f.path) ?? { recorded: false, symbols: [] };
  const reached = r.symbols.map(s => s.name);
  const changed = r.symbols.filter(s => changedIds?.has(s.id)).map(s => s.name);
  const joined = (fnd: CheckWeakeningFinding, guarded: boolean): CheckWeakeningFinding => {
    if (!guarded || !reached.length) return fnd;
    const tail = changed.length
      ? ` The test file reaches ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}, in code this diff changes.`
      : ` The test file reaches ${reached.slice(0, 3).join(', ')}${reached.length > 3 ? ` and ${reached.length - 3} more` : ''}.`;
    return {
      ...fnd,
      ...(changed.length && fnd.severity === 'warning' ? { severity: 'error' as const } : {}),
      message: emittedText(fnd.message + tail),
      reaches: reached.slice(0, MAX_REACH_NAMES),
      ...(changed.length ? { reachesChanged: changed.slice(0, MAX_REACH_NAMES) } : {}),
    };
  };

  if (f.current === null) {
    if (baseCases.length) {
      out.push(joined(finding('test-removed', 'warning', f.path, `Test file ${f.path} was removed (${baseCases.length} test case(s)).`, f.path, undefined, 'file'), true));
    }
    return out;
  }
  const cur = new Map(curCases.map(c => [c.key, c]));
  const baseKeys = new Set(baseCases.map(c => c.key));
  const newBodies = new Set(curCases.filter(c => !baseKeys.has(c.key)).map(c => c.bodyHash));
  let evcUnassessed = false;
  for (const b of baseCases) {
    const c = cur.get(b.key);
    if (!c) {
      if (newBodies.has(b.bodyHash)) continue; // renamed, same body
      out.push(joined(finding('test-removed', 'warning', `${f.path}::${b.key}`, `Test ${quote(b.key)} was removed from ${f.path}.`, f.path, b.line, b.key), true));
      continue;
    }
    if (c.disabled && !b.disabled) {
      out.push(joined(finding('test-disabled', 'warning', `${f.path}::${c.key}`, `${quote(c.disabled)} was added to test ${quote(c.key)} (${f.path}:${c.line}).`, f.path, c.line, `${c.key}:skip`), true));
    }
    if (c.assertions < b.assertions) {
      out.push(joined(finding('assertions-reduced', 'warning', `${f.path}::${c.key}`,
        `Test ${quote(c.key)} has ${c.assertions} assertion(s), down from ${b.assertions} (${f.path}:${c.line}).`, f.path, c.line, c.key), true));
    } else if (c.assertions === b.assertions && c.literals.join('\0') !== b.literals.join('\0')) {
      if (!r.recorded || !changedIds) { evcUnassessed = true; continue; }
      if (changed.length) continue; // the code it checks changed too: an expected value updated with its code
      const i = c.literals.findIndex((l, k) => l !== b.literals[k]);
      const detail = i >= 0 && b.literals[i] !== undefined ? ` (${quote(b.literals[i])} → ${quote(c.literals[i])})` : '';
      out.push(joined(finding('expected-value-changed', 'info', `${f.path}::${c.key}`,
        `An expected value in test ${quote(c.key)} changed${detail}, while no production symbol the test file reaches changed (${f.path}:${c.line}).`, f.path, c.line, c.key), true));
    }
  }
  // Focus: a newly focused test silently stops the file's other tests from running.
  if (!baseCases.some(b => b.focused)) {
    const focused = curCases.find(c => c.focused);
    if (focused && curCases.length > 1) {
      out.push(joined(finding('test-disabled', 'warning', `${f.path}::${focused.key}`,
        `${quote(focused.focused!)} was added to test ${quote(focused.key)}; the other ${curCases.length - 1} test case(s) in ${f.path} no longer run.`, f.path, focused.line, `${focused.key}:focus`), true));
    }
  }
  if (evcUnassessed) {
    notAssessed.push({ file: f.path, shapes: ['expected-value-changed'], reason: 'the index records no production symbol this test file reaches, so a changed expected value cannot be told apart from one updated with its code' });
  }
  return out;
}

// ── Git: the fixed baseline and the changed files ───────────────────────────────

const SHA = /^[0-9a-f]{40,64}$/;

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileGit('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return String(stdout);
}

/**
 * The fixed baseline: the merge-base of `baseRef` with the new state. An omitted or `HEAD` base is
 * read as the default branch, so a weakening already committed on this branch is still compared.
 */
export async function resolveWeakeningBaseline(root: string, baseRef: string | undefined, headRef?: string): Promise<{ ref: string; commit: string; note?: string }> {
  const { resolveBaseRef } = await import('../drift/git-diff.js');
  const explicit = baseRef && baseRef !== 'HEAD' && baseRef !== 'auto' ? baseRef : undefined;
  const ref = await resolveBaseRef(root, explicit ?? 'auto');
  let commit = '';
  try { commit = (await git(root, ['merge-base', ref, headRef ?? 'HEAD'])).trim(); } catch { /* no common ancestor */ }
  if (!SHA.test(commit)) {
    try { commit = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim(); } catch { commit = ref; }
  }
  const note = !explicit && (ref === 'HEAD~1' || !/^(?:main|master|refs\/remotes\/origin\/HEAD|origin\/main|origin\/master)$/.test(ref))
    ? `No default branch was found, so the weakening baseline is ${ref}; pass baseRef to compare against the branch point.`
    : undefined;
  return { ref, commit, ...(note ? { note } : {}) };
}

async function atRef(root: string, ref: string, path: string): Promise<string | null> {
  try {
    const size = Number((await git(root, ['cat-file', '-s', `${ref}:${path}`])).trim());
    if (!(size <= MAX_FILE_BYTES)) return null;
    return await git(root, ['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

async function inWorkTree(root: string, path: string): Promise<string | null> {
  try {
    const buf = await readFile(safeJoin(root, path));
    return buf.length <= MAX_FILE_BYTES ? buf.toString('utf-8') : null;
  } catch {
    return null;
  }
}

/**
 * Compute the check-weakening facts for a change: the working tree (or `headRef`) against the fixed
 * baseline. `root` must be the repository root (git prints repository-relative paths). Never throws
 * on a git failure; a failure is returned as a boundary with no findings.
 */
export async function checkWeakening(input: {
  root: string;
  baseRef?: string;
  headRef?: string;
  callGraph?: SerializedCallGraph;
  /** Restrict to these repository-relative paths. */
  files?: readonly string[];
}): Promise<CheckWeakeningResult> {
  const boundaries: string[] = [];
  const baseline = await resolveWeakeningBaseline(input.root, input.baseRef, input.headRef);
  if (baseline.note) boundaries.push(baseline.note);
  const entries: Array<{ path: string; oldPath?: string; status: ChangedFile['status'] }> = [];
  try {
    const out = await git(input.root, gitPathArgs('diff', '--name-status', '-M', '--diff-filter=ACDMR', baseline.commit, ...(input.headRef ? [input.headRef] : [])));
    for (const line of out.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      const s = parts[0].charAt(0);
      if (s === 'R' && parts.length >= 3) entries.push({ path: parts[2], oldPath: parts[1], status: 'renamed' });
      else entries.push({ path: parts[1], status: s === 'A' ? 'added' : s === 'D' ? 'deleted' : 'modified' });
    }
    if (!input.headRef) {
      const seen = new Set(entries.map(e => e.path));
      for (const p of (await git(input.root, gitPathArgs('ls-files', '--others', '--exclude-standard'))).split('\n').map(s => s.trim()).filter(Boolean)) {
        if (!seen.has(p)) entries.push({ path: p, status: 'added' });
      }
    }
  } catch (err) {
    return { baseline: { ref: baseline.ref, commit: baseline.commit }, findings: [], notAssessed: [],
      boundaries: [...boundaries, `Check weakening was not assessed: git diff failed (${err instanceof Error ? err.message : String(err)}).`] };
  }
  const scope = input.files ? new Set(input.files) : null;
  const relevant = entries
    .filter(e => !scope || scope.has(e.path) || (e.oldPath && scope.has(e.oldPath)))
    .filter(e => checkConfigKind(e.path) || detectLanguage(e.path) !== 'unknown')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (relevant.length > MAX_FILES) boundaries.push(`Check weakening read the first ${MAX_FILES} of ${relevant.length} changed files.`);

  const files: WeakeningFile[] = [];
  for (const e of relevant.slice(0, MAX_FILES)) {
    const base = e.status === 'added' ? null : await atRef(input.root, baseline.commit, e.oldPath ?? e.path);
    const current = e.status === 'deleted' ? null
      : input.headRef ? await atRef(input.root, input.headRef, e.path) : await inWorkTree(input.root, e.path);
    if (base === null && current === null) continue;
    files.push({ path: e.path, base, current });
  }

  // Production symbols this change modifies, at symbol granularity where the index allows.
  let changedIds: Set<string> | undefined;
  if (input.callGraph && input.headRef) {
    boundaries.push('Against a head ref, the changed production symbols are not computed, so expected-value-changed was not assessed.');
  } else if (input.callGraph) {
    try {
      const { narrowToChangedSymbols, seedsFromFiles } = await import('./mcp-handlers/test-impact.js');
      const prodPaths = new Set(files.filter(f => !isTestFile(f.path)).map(f => f.path));
      const narrowed = await narrowToChangedSymbols(input.root, baseline.commit,
        relevant.filter(e => prodPaths.has(e.path)), input.callGraph, seedsFromFiles(input.callGraph, [...prodPaths]));
      changedIds = new Set(narrowed.seeds.filter(s => !narrowed.unchangedSeedIds?.has(s.id)).map(s => s.id));
    } catch {
      boundaries.push('The changed production symbols could not be computed, so expected-value-changed was not assessed.');
    }
  } else {
    boundaries.push('No index is available, so test findings do not name the symbols they reach and expected-value-changed was not assessed.');
  }
  const reach = input.callGraph ? reachIndexFromGraph(input.callGraph) : undefined;
  const detected = await detectWeakeningShapes(files, reach, changedIds);
  if (detected.findings.some(f => f.reaches)) {
    boundaries.push('A test\'s reach is read from the index per test file (its tested_by edges and their call closure), not per test case, and reflects the last analysis.');
  }
  return {
    baseline: { ref: baseline.ref, commit: baseline.commit },
    findings: detected.findings,
    notAssessed: detected.notAssessed,
    boundaries: [...boundaries, ...detected.boundaries],
  };
}
