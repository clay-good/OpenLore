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
import { readBlobsAtRef, readBlobsPerFile } from '../../utils/git-blobs.js';
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
  /** The file exceeds the read cap at one of the two revisions; it is reported not-assessed. */
  tooLarge?: true;
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
  /** The key before same-title cases were numbered. */
  title?: string;
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
  /** Normalized body length: short bodies are too common to identify a moved test. */
  bodySize?: number;
}

/** A new test case elsewhere in the diff that a removed one may have moved to. */
interface MovedCase { file: string; key: string; disabled: string | null }
/** Bodies shorter than this (normalized) are too common to be evidence that a test moved. */
const MIN_MOVED_BODY = 48;

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
    // `namedChildren` once: `namedChild(i)` is O(i) on a wide node, so a loop over it is quadratic.
    const kids = n.namedChildren;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
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

const STRING_TYPES = new Set(['string', 'template_string', 'interpreted_string_literal', 'raw_string_literal', 'string_literal', 'concatenated_string', 'character_literal', 'rune_literal']);
const NUMBER_TYPES = new Set(['number', 'integer', 'float', 'int_literal', 'float_literal', 'decimal_integer_literal', 'hex_integer_literal', 'decimal_floating_point_literal']);

/** A literal's value, independent of quote style, number spelling, spacing and line endings. */
function literalValue(n: Node, depth = 0): string {
  if (STRING_TYPES.has(n.type)) {
    return 's:' + n.text.replace(/\r\n/g, '\n').replace(/^[a-zA-Z]*(['"`]{1,3})/, '').replace(/(['"`]{1,3})$/, '');
  }
  if (NUMBER_TYPES.has(n.type)) {
    const v = Number(n.text.replace(/_/g, '').replace(/[lLfFdD]$/, ''));
    return Number.isFinite(v) ? 'n:' + v : n.text;
  }
  if (!n.namedChildCount || depth > 50) return n.text;
  return n.type + '(' + n.namedChildren.map(c => literalValue(c, depth + 1)).join(',') + ')';
}

function literalArgs(args: Node | null): string[] {
  return args ? args.namedChildren.filter(isLiteral).map(a => literalValue(a)) : [];
}

/** Literal arguments of an assertion call, without a trailing message string. */
function assertionArgs(args: Node | null): string[] {
  const all = args?.namedChildren ?? [];
  const last = all[all.length - 1];
  const kept = all.length >= 2 && last && STRING_TYPES.has(last.type) && !isLiteral(all[0]) ? all.slice(0, -1)
    : all.length >= 3 && last && STRING_TYPES.has(last.type) ? all.slice(0, -1) : all;
  return kept.filter(isLiteral).map(a => literalValue(a));
}

/** Every literal value inside a node: a test's data table (`each` rows, `parametrize` arguments, a Go table). */
function dataLiterals(n: Node | null | undefined): string[] {
  const out: string[] = [];
  if (!n) return out;
  for (const d of walk(n, c => LITERAL_TYPES.has(c.type))) if (d !== n && LITERAL_TYPES.has(d.type)) out.push(literalValue(d));
  return out;
}

// TypeScript / JavaScript — Vitest, Jest, Mocha.
const JS_CASES = new Set(['it', 'test', 'specify', 'xit', 'xtest', 'xspecify', 'fit', 'ftest']);
const JS_SUITES = new Set(['describe', 'context', 'suite', 'xdescribe', 'xcontext', 'xsuite', 'fdescribe']);
const JS_SKIP_MODS = new Set(['skip', 'todo', 'skipIf', 'runIf', 'failing', 'fails']);
const JS_ASSERT_ROOTS = new Set(['expect', 'assert', 'expectTypeOf', 'assertType']);

/** `it.skip.each(t)` → { root: 'it', mods: ['skip', 'each'], table: t }. */
function jsCallee(call: Node): { root: string; mods: string[]; table?: Node } | null {
  let fn = call.childForFieldName('function');
  const mods: string[] = [];
  let table: Node | undefined;
  if (fn?.type === 'call_expression') { // it.each(table)('name', fn)
    table = fn.childForFieldName('arguments') ?? undefined;
    fn = fn.childForFieldName('function');
  }
  while (fn?.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    if (prop) mods.unshift(prop.text);
    fn = fn.childForFieldName('object');
    if (fn?.type === 'call_expression') fn = fn.childForFieldName('function');
  }
  return fn?.type === 'identifier' ? { root: fn.text, mods, ...(table ? { table } : {}) } : null;
}

/** A title: a string, or a template literal's raw text when it has substitutions. */
function jsTitle(n: Node | null | undefined): string | null {
  return stringValue(n) ?? (n?.type === 'template_string' ? n.text.slice(1, -1) : null);
}

/** `this.skip()` / `ctx.skip()` / `t.skip()` called in a test body (a call node, not text). */
function jsSkipCall(body: Node): boolean {
  for (const d of walk(body)) {
    if (d.type !== 'call_expression') continue;
    const fn = d.childForFieldName('function');
    if (fn?.type !== 'member_expression' || fn.childForFieldName('property')?.text !== 'skip') continue;
    const obj = fn.childForFieldName('object');
    if (obj && (obj.type === 'this' || /^(?:ctx|context|t)$/.test(obj.text))) return true;
  }
  return false;
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
    const obj = fn?.type === 'member_expression' ? fn.childForFieldName('object') : null;
    const isMember = obj?.type === 'identifier' && (JS_ASSERT_ROOTS.has(obj.text)
      || (obj.text === 'chai' && JS_ASSERT_ROOTS.has(fn!.childForFieldName('property')?.text ?? '')));
    if (!isRoot && !isMember) continue;
    count++;
    // `assert.equal(a, 1)` / `assert(x === 1)`: every literal argument. `expect(actual)`: the actual
    // value is not an expected value, so only the chained matcher calls' literals count.
    const head = isRoot ? fn!.text : obj?.text === 'chai' ? fn!.childForFieldName('property')?.text : undefined;
    const actualSide = head === 'expect' || head === 'expectTypeOf';
    if (!actualSide) literals.push(...assertionArgs(n.childForFieldName('arguments')));
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
      const title = jsTitle(args?.namedChildren[0]);
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
            disabled: disabled ?? m.disabled ?? (body && jsSkipCall(body) ? 'skip()' : null),
            focused: focused ?? m.focused,
            assertions: a.count,
            literals: [...dataLiterals(callee.table), ...a.literals],
            bodyHash: hash(body?.text ?? ''), bodySize: (body?.text ?? '').replace(/\s+/g, ' ').trim().length,
          });
          continue; // a test case's body holds no further cases
        }
      }
    }
    const kids = n.namedChildren;
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ n: kids[i], suite: childSuite, disabled: childDisabled, focused: childFocused });
    }
  }
  return out;
}

// Python — pytest, unittest.
const PY_SKIP_DECORATOR = /^@\s*(?:(?:pytest\.)?mark\.(?:skip|skipif|xfail)|unittest\.(?:skip|skipIf|skipUnless|expectedFailure)|skip|skipIf|skipUnless|expectedFailure)\b/;

function pyDecorators(def: Node): string[] {
  const parent = def.parent;
  return parent?.type === 'decorated_definition' ? parent.namedChildren.filter(c => c.type === 'decorator').map(c => c.text) : [];
}

function pyCases(root: Node): TestCase[] {
  const out: TestCase[] = [];
  // A module-level `pytestmark = pytest.mark.skip(...)` disables every test in the file.
  const moduleMark = /^pytestmark\s*=.*\b(?:skip|skipif|xfail)\b/m.test(root.text) ? 'pytestmark' : null;
  for (const n of walk(root)) {
    if (n.type !== 'function_definition') continue;
    const name = n.childForFieldName('name')?.text ?? '';
    if (!/^test/.test(name) || pyDecorators(n).some(d => /\bfixture\b/.test(d))) continue;
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
          // The condition only: `assert x == 1, "message"` keeps 1, not the message.
          const cond = d.namedChildren[0];
          if (cond?.type === 'comparison_operator') literals.push(...cond.namedChildren.filter(isLiteral).map(x => literalValue(x)));
          else if (cond && isLiteral(cond)) literals.push(literalValue(cond));
        } else if (d.type === 'call') {
          const fn = d.childForFieldName('function');
          const last = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : fn?.type === 'identifier' ? fn.text : undefined;
          if (last && (/^assert/.test(last) || (fn?.type === 'attribute' && /^pytest\.(?:raises|warns)$/.test(fn.text)))) {
            count++;
            literals.push(...assertionArgs(d.childForFieldName('arguments')));
          }
        }
      }
    }
    // `parametrize(argnames, argvalues, ids=…)`: the argvalues rows are expected values; names and ids are not.
    for (const dec of n.parent?.type === 'decorated_definition' ? n.parent.namedChildren.filter(c => c.type === 'decorator') : []) {
      if (!/\bparametrize\b/.test(dec.text)) continue;
      let call: Node | undefined;
      for (const d of walk(dec)) if (d.type === 'call') { call = d; break; }
      const positional = call?.childForFieldName('arguments')?.namedChildren.filter(a => a.type !== 'keyword_argument') ?? [];
      literals.unshift(...dataLiterals(positional[1]));
    }
    const skipDecorator = decorators.find(d => PY_SKIP_DECORATOR.test(d));
    const skipCall = body && /\b(?:pytest\.skip|self\.skipTest)\s*\(/.test(body.text);
    out.push({
      key: clsName ? `${clsName}.${name}` : name,
      line: n.startPosition.row + 1,
      disabled: skipDecorator ? skipDecorator.replace(/\(.*$/s, '') : skipCall ? 'skip()' : moduleMark,
      focused: null,
      assertions: count,
      literals,
      bodyHash: hash(body?.text ?? ''), bodySize: (body?.text ?? '').replace(/\s+/g, ' ').trim().length,
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
      literals.push(...assertionArgs(n.childForFieldName('arguments')));
    } else if (GO_FAIL.has(field)) {
      count++;
    } else if (GO_SKIP.has(field)) {
      disabled ??= `t.${field}`;
    }
  }
  // A table-driven test's rows are its expected values: a composite literal the test ranges over,
  // directly or through the variable it is assigned to. Setup literals are not expected values.
  const ranged = new Set<string>();
  const tables: Node[] = [];
  for (const n of walk(body, c => goSubtest(c) !== null)) {
    if (n.type !== 'range_clause') continue;
    const over = n.childForFieldName('right');
    if (over?.type === 'composite_literal') tables.push(over);
    else if (over?.type === 'identifier') ranged.add(over.text);
  }
  for (const n of walk(body, c => goSubtest(c) !== null)) {
    if (n.type !== 'short_var_declaration' && n.type !== 'var_spec' && n.type !== 'assignment_statement') continue;
    const left = (n.childForFieldName('left') ?? n.childForFieldName('name'))?.text ?? '';
    const right = n.childForFieldName('right') ?? n.childForFieldName('value');
    const lit = right?.namedChildren.find(c => c.type === 'composite_literal') ?? (right?.type === 'composite_literal' ? right : undefined);
    if (lit && left.split(/\s*,\s*/).some(name => ranged.has(name))) tables.push(lit);
  }
  for (const t of tables) literals.unshift(...dataLiterals(t));
  out.push({ key, line, disabled, focused: null, assertions: count, literals, bodyHash: hash(body.text), bodySize: body.text.replace(/\s+/g, ' ').trim().length });
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
    const clsAnnotations: string[] = [];
    for (let p: Node | null = n.parent; p; p = p.parent) if (p.type === 'class_declaration') clsAnnotations.push(...javaAnnotations(p));
    const body = n.childForFieldName('body');
    let count = 0;
    const literals: string[] = [];
    if (body) {
      for (const d of walk(body)) {
        if (d.type !== 'method_invocation' || !/^assert/.test(d.childForFieldName('name')?.text ?? '')) continue;
        count++;
        // `assertThat(actual)` names the actual value; `assertEquals(expected, actual)` both.
        if (d.childForFieldName('name')!.text !== 'assertThat') literals.push(...assertionArgs(d.childForFieldName('arguments')));
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
      bodyHash: hash(body?.text ?? ''), bodySize: (body?.text ?? '').replace(/\s+/g, ' ').trim().length,
    });
  }
  return out;
}

/** A file named as a test (not a helper that only lives under a test directory). */
const TEST_FILE_NAME = /(?:[._-](?:test|spec)s?\.[^/]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py)$|Tests?\.java$|(?:^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$)/;

/** Test libraries in an assessed language that are outside the closed table, by an import of theirs. */
const UNSUPPORTED_FRAMEWORKS: Record<string, RegExp> = {
  TypeScript: /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s+)['"](?:node:test|tap|ava|tape|uvu|zora)['"]/,
  Python: /^\s*(?:import\s+nose\b|from\s+nose\b)/m,
  Go: /"github\.com\/(?:onsi\/ginkgo|smartystreets\/goconvey)/,
  Java: /\bimport\s+(?:static\s+)?org\.testng\./,
};
UNSUPPORTED_FRAMEWORKS.JavaScript = UNSUPPORTED_FRAMEWORKS.TypeScript;

const casesCache = new WeakMap<Node, TestCase[]>();
function extractCases(language: string, root: Node): TestCase[] {
  const cached = casesCache.get(root);
  if (cached) return cached;
  const cases = extractCasesUncached(language, root);
  casesCache.set(root, cases);
  return cases;
}

function extractCasesUncached(language: string, root: Node): TestCase[] {
  const raw = language === 'Python' ? pyCases(root)
    : language === 'Go' ? goCases(root)
      : language === 'Java' ? javaCases(root)
        : jsCases(root);
  // Same-named cases (a table of `it` calls, overloads) are told apart by their order.
  const seen = new Map<string, number>();
  return raw.map(c => {
    const k = seen.get(c.key) ?? 0;
    seen.set(c.key, k + 1);
    return { ...c, title: c.key, ...(k ? { key: `${c.key} #${k + 1}` } : {}) };
  });
}

// ── Suppressions ────────────────────────────────────────────────────────────────

const SUPPRESSIONS: Record<string, Array<[label: string, re: RegExp]>> = {
  // A directive opens its comment: prose that mentions `@ts-ignore` is not one.
  TypeScript: [['@ts-ignore', /^\/[/*]+\s*@ts-ignore\b/], ['@ts-expect-error', /^\/[/*]+\s*@ts-expect-error\b/], ['@ts-nocheck', /^\/[/*]+\s*@ts-nocheck\b/],
    ['eslint-disable', /^\/[/*]+\s*eslint-disable(?:-next-line|-line)?\b/], ['biome-ignore', /^\/[/*]+\s*biome-ignore\b/], ['istanbul ignore', /^\/[/*]+\s*(?:istanbul|c8|v8) ignore\b/]],
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
      for (const [label, re] of table) if (re.test(n.text)) out.push({ label, text: n.text.replace(/\s+/g, ' ').trim(), line: n.startPosition.row + 1 });
    } else if (language === 'Java' && (n.type === 'annotation' || n.type === 'marker_annotation')
        && /^(?:java\.lang\.)?SuppressWarnings$/.test(n.childForFieldName('name')?.text ?? '')) {
      out.push({ label: '@SuppressWarnings', text: n.text.replace(/\s+/g, ''), line: n.startPosition.row + 1 });
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
    // Python `except: ...`
    if (s.type === 'expression_statement' && s.text.trim() === '...') return true;
    // `return;`, `return null`, `return 0`, Go `return nil`: a constant stands in for the error.
    if (s.type === 'return_statement') return s.namedChildren.flatMap(c => (c.type === 'expression_list' ? c.namedChildren : [c])).every(isLiteral);
    if (s.type !== 'expression_statement') return false;
    const call = s.text.trim().replace(/^await\s+/, '');
    // `log.Fatal`, `logger.Panicf`: logs, then ends the process or panics — the error is not discarded.
    return re.test(call) && !/^[\w.]*\.(?:Fatal|Panic)\w*\s*\(/.test(call);
  });
}

function enclosingFunction(n: Node): string {
  for (let p = n.parent; p; p = p.parent) {
    const name = p.childForFieldName('name');
    if (name && /function|method|def|constructor/.test(p.type)) return name.text;
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
    const tryNode = n.parent?.type === 'try_statement' || n.parent?.type === 'try_with_resources_statement' ? n.parent : null;
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
  if (/^(?:(?:vitest|jest|vite|playwright|karma|cypress)\.config\.[cm]?[jt]s|karma\.conf\.[cm]?[jt]s|jest\.config\.json|\.mocharc(?:\.\w+)?|pytest\.ini|package\.json)$/.test(name)) return 'test-runner';
  if (/^(?:pyproject\.toml|setup\.cfg|tox\.ini)$/.test(name)) return 'sectioned';
  return null;
}

const IGNORE_KEY = /(?:^|[\s"'{,[-])(?:exclude|excludes|extend-exclude|exclude[_-](?:dirs|files|lines|rules)|ignore|ignores|ignorePatterns|extend-ignore|per-file-ignores|(?:test|coverage|module|watch)PathIgnorePatterns|testIgnore|omit|skip-(?:dirs|files)|norecursedirs|deselect|disable|disabled-checks|--ignore|--deselect|ignore[_-](?:missing[_-]imports|errors))\b/i;
const THRESHOLD = /\b(fail[_-]?under|cov-fail-under|branches|functions|lines|statements|threshold|target|minimum[_-]?coverage|min[_-]?coverage)\b["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)/g;
const CHECK_SECTION = /pytest|coverage|ruff|flake8|pylint|mypy|pycodestyle|bandit|testenv/i;
const TEST_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)(?: run)? test\b|vitest|jest|mocha|pytest|tox\b|go test|cargo test|(?:mvn|mvnw)\b.*\b(?:test|verify)\b|gradlew?\b.*\b(?:test|check)\b|rspec|make (?:test|check)\b|dotnet test|phpunit)/;

/** Lines in `current` that `base` does not have (multiset), with their 1-based line numbers. */
function addedLines(base: string, current: string): Array<{ line: number; text: string }> {
  // A list item that only gained a separator (`"a"` → `"a",`) is the same entry.
  const norm = (l: string) => l.trim().replace(/,$/, '');
  const remaining = new Map<string, number>();
  for (const l of base.split(/\r?\n/)) remaining.set(norm(l), (remaining.get(norm(l)) ?? 0) + 1);
  const out: Array<{ line: number; text: string }> = [];
  current.split(/\r?\n/).forEach((l, i) => {
    const t = norm(l);
    const left = remaining.get(t) ?? 0;
    if (left > 0) remaining.set(t, left - 1);
    else if (t) out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}

/** The check-related keys of a package.json, as text (`null` when it is not valid JSON). */
const PACKAGE_CHECK_KEYS = ['jest', 'c8', 'nyc', 'mocha', 'vitest', 'eslintConfig'];
function packageChecks(text: string): string | null {
  if (!text.trim()) return '';
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    if (!pkg || typeof pkg !== 'object') return '';
    return JSON.stringify(Object.fromEntries(PACKAGE_CHECK_KEYS.filter(k => k in pkg).map(k => [k, pkg[k]])), null, 2);
  } catch {
    return null;
  }
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

/** The key of the object (or YAML/INI section) a threshold sits in: `global`, `./src/a.ts`, `report`. */
function thresholdOwner(text: string, index: number): string {
  let depth = 0;
  for (let i = index - 1; i >= 0 && index - i < 4000; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) {
        const m = /["']?([^"'\s{}:,]+)["']?\s*[:=]\s*$/.exec(text.slice(Math.max(0, i - 200), i));
        return m ? m[1] : '';
      }
      depth--;
    }
  }
  // Indentation-scoped (YAML) or sectioned (INI/TOML): the nearest less-indented key or `[section]`.
  const lines = text.slice(0, index).split(/\r?\n/);
  const own = lines.pop() ?? '';
  const indent = own.length - own.trimStart().length;
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k];
    const sec = /^\s*\[([^\]]+)\]/.exec(l);
    if (sec) return sec[1];
    const ind = l.length - l.trimStart().length;
    if (l.trim() && ind < indent) return l.trim().replace(/:.*$/, '');
  }
  return '';
}

/** Thresholds by `owner/key`, in order of appearance within that owner. */
function thresholds(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const m of text.matchAll(THRESHOLD)) {
    const key = `${thresholdOwner(text, m.index ?? 0)}/${m[1].toLowerCase().replace(/[-_]/g, '')}`;
    (out.get(key) ?? out.set(key, []).get(key)!).push(Number(m[2]));
  }
  return out;
}

interface CiFacts {
  /** Test commands (by their sorted tokens) → where they ran. */
  testSteps: Map<string, { where: string; command: string }>;
  allSteps: Set<string>;
  allowFailure: Set<string>;
  /** Jobs and steps turned off (`if: false`, GitLab `when: manual` / `never`). */
  disabled: Set<string>;
}

/**
 * A command's identity: its program, then its flags (each with the value that follows it), sorted, so
 * flag order and line layout do not matter but which value goes with which flag does.
 */
function commandKey(command: string): string {
  const tokens = command.split(/\s+/).filter(Boolean);
  const head: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('-')) { head.push(t); continue; }
    const next = tokens[i + 1];
    if (!t.includes('=') && next !== undefined && !next.startsWith('-')) { flags.push(`${t} ${next}`); i++; } else flags.push(t);
  }
  return [...head, ...flags.sort()].join(' ');
}

function ciFacts(text: string): CiFacts | null {
  let doc: unknown;
  try { doc = parseYaml(text, { maxAliasCount: 100 }); } catch { return null; }
  const facts: CiFacts = { testSteps: new Map(), allSteps: new Set(), allowFailure: new Set(), disabled: new Set() };
  if (!doc || typeof doc !== 'object') return facts;
  const record = (where: string, run: unknown) => {
    const scripts = (Array.isArray(run) ? run : [run]).filter((r): r is string => typeof r === 'string');
    // One command per line or `&&` / `;` segment; `cmd || true` stays one segment, so it differs.
    for (const c of scripts.flatMap(r => r.split(/\n|&&|;/))) {
      const norm = c.replace(/\s+/g, ' ').trim();
      if (!norm) continue;
      const key = commandKey(norm);
      facts.allSteps.add(key);
      if (TEST_COMMAND.test(norm)) facts.testSteps.set(key, { where, command: norm });
    }
  };
  const truthy = (v: unknown) => v === true || v === 'true' || (typeof v === 'string' && /\$\{\{/.test(v))
    || (!!v && typeof v === 'object' && !Array.isArray(v)); // GitLab `allow_failure: { exit_codes: … }`
  // A constant false condition: `false`, `${{ false }}`, `${{ 0 }}`, `${{ false && … }}`.
  const off = (v: unknown) => v === false || v === 0 || v === 'false' || v === '0'
    || (typeof v === 'string' && /^\$\{\{\s*(?:false|0)\s*(?:&&[^}]*)?\}\}$/.test(v.trim()));
  const jobs = (doc as Record<string, unknown>).jobs;
  if (jobs && typeof jobs === 'object') {
    // GitHub Actions.
    for (const [jobName, job] of Object.entries(jobs as Record<string, unknown>)) {
      if (!job || typeof job !== 'object') continue;
      const j = job as Record<string, unknown>;
      if (truthy(j['continue-on-error'])) facts.allowFailure.add(`job ${jobName}`);
      if (off(j.if)) facts.disabled.add(`job ${jobName}`);
      const steps = Array.isArray(j.steps) ? j.steps : [];
      steps.forEach((s, i) => {
        if (!s || typeof s !== 'object') return;
        const step = s as Record<string, unknown>;
        const label = `job ${jobName}, step ${typeof step.name === 'string' ? step.name : i + 1}`;
        record(label, step.run);
        if (truthy(step['continue-on-error'])) facts.allowFailure.add(label);
        if (off(step.if)) facts.disabled.add(label);
      });
    }
  } else {
    // GitLab CI: every top-level mapping with a script is a job.
    // Hidden `.template` jobs are read too: a job that extends one runs its script.
    for (const [jobName, job] of Object.entries(doc as Record<string, unknown>)) {
      if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
      const j = job as Record<string, unknown>;
      record(`job ${jobName}`, j.script);
      if (truthy(j.allow_failure)) facts.allowFailure.add(`job ${jobName}`);
      const unconditional = (r: unknown) => !!r && typeof r === 'object' && !['if', 'changes', 'exists'].some(k => k in (r as object));
      const rules = Array.isArray(j.rules) ? (j.rules as Array<Record<string, unknown>>) : [];
      const firstUnconditional = rules.find(unconditional);
      if (j.when === 'manual' || j.when === 'never' || (firstUnconditional && (firstUnconditional.when === 'never' || firstUnconditional.when === 'manual'))) {
        facts.disabled.add(`job ${jobName}`);
      }
    }
  }
  return facts;
}

function configRelaxations(path: string, kind: ConfigKind, base: string, current: string): Array<{ line?: number; message: string; discriminator: string }> {
  const out: Array<{ line?: number; message: string; discriminator: string }> = [];
  // package.json: only its test, coverage and lint keys count; lines then refer to that subset.
  const isPackage = /(?:^|\/)package\.json$/.test(path);
  if (isPackage) {
    const b = packageChecks(base);
    const c = packageChecks(current);
    if (b === null || c === null) return out;
    base = b;
    current = c;
  }
  const lines = current.split(/\r?\n/);
  if (kind === 'ci') {
    const before = ciFacts(base);
    const after = ciFacts(current);
    if (!before || !after) return out; // unparsable YAML: disclosed by the caller
    for (const [key, step] of before.testSteps) {
      if (!after.allSteps.has(key)) out.push({ message: `A CI step that ran tests was removed or changed in ${path} (${step.where}): \`${step.command}\`.`, discriminator: `step:${key}` });
    }
    for (const where of after.allowFailure) {
      if (!before.allowFailure.has(where)) out.push({ message: `Failure is now allowed for ${where} in ${path} (continue-on-error / allow_failure).`, discriminator: `allow:${where}` });
    }
    for (const where of after.disabled) {
      if (!before.disabled.has(where)) out.push({ message: `${where[0].toUpperCase()}${where.slice(1)} in ${path} no longer runs on its own (\`if: false\` / \`when: manual\`).`, discriminator: `off:${where}` });
    }
  } else {
    for (const a of addedLines(base, current)) {
      if (a.text.startsWith('#') || a.text.startsWith('//')) continue;
      if (kind === 'sectioned' && !CHECK_SECTION.test(sectionOf(lines, a.line - 1))) continue;
      if (kind === 'ignore-file') {
        out.push({ line: a.line, message: `An ignore pattern was added to ${path}: \`${a.text}\`.`, discriminator: `line:${a.text}` });
        continue;
      }
      const line = isPackage ? undefined : a.line;
      if (IGNORE_KEY.test(governingLine(lines, a.line - 1)) || ((kind === 'sectioned' || kind === 'lint') && /per-file-ignores|exclude/i.test(sectionOf(lines, a.line - 1)))) {
        out.push({ line, message: `An exclude/ignore entry was added to ${path}: \`${a.text}\`.`, discriminator: `line:${a.text}` });
      } else if (kind === 'lint' && !/max-?warnings/i.test(a.text) && lines.slice(0, a.line - 1).some(l => /\brules\b/.test(l))
          && /["']?\s*[:=]\s*\[?\s*["']?(?:off|0)["']?\s*(?:[,\]}]|$)/.test(a.text)) {
        out.push({ line, message: `A lint rule was turned off in ${path}: \`${a.text}\`.`, discriminator: `line:${a.text}` });
      }
    }
  }
  if (kind !== 'lint' && kind !== 'ignore-file') {
    // Each threshold is matched by the object it sits in (`global`, a path) and its key, so moving,
    // reordering or adding entries changes nothing; a lowered or removed one is found. In Codecov,
    // `threshold` is the drop it tolerates: raising it is the relaxation.
    const codecov = /(?:^|\/)\.?codecov\.ya?ml$/.test(path);
    const after = thresholds(current);
    for (const [key, was] of thresholds(base)) {
      const now = after.get(key) ?? [];
      const [owner, name] = [key.slice(0, key.lastIndexOf('/')), key.slice(key.lastIndexOf('/') + 1)];
      const label = owner ? `${name}\` (in \`${owner}\`)` : `${name}\``;
      if (now.length < was.length) {
        out.push({ message: `A coverage threshold \`${label} was removed from ${path}.`, discriminator: `threshold-removed:${key}` });
        continue;
      }
      const inverted = codecov && name === 'threshold';
      const i = was.findIndex((v, k) => (inverted ? now[k] > v : now[k] < v));
      if (i >= 0) out.push({ message: `A coverage threshold \`${label} was ${inverted ? 'raised (a larger tolerated drop)' : 'lowered'} from ${was[i]} to ${now[i]} in ${path}.`, discriminator: `threshold:${key}` });
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
    subject: emittedText(subject), message: emittedText(message),
    // Hashed: unique even when the screened subject is withheld, and never repository text.
    discriminator: hash(discriminator),
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
  /** Test files with findings whose reach the index does not record. */
  const noReach: string[] = [];

  // Bodies of test cases that are new in some test file of the diff: a removed case whose body
  // reappears there was moved (another file, or `mv` + a new name), not removed.
  // Each revision is parsed once, for this pass and the one below.
  const trees = new Map<WeakeningFile, { baseRoot: Node | null; curRoot: Node | null }>();
  const rootsOf = async (f: WeakeningFile, language: string) => {
    let t = trees.get(f);
    if (!t) {
      t = {
        baseRoot: f.base !== null ? await parse(language, f.path, f.base) : null,
        curRoot: f.current !== null ? await parse(language, f.path, f.current) : null,
      };
      trees.set(f, t);
    }
    return t;
  };
  // Each new case can account for one removed case (consumed on use), and only when its body is
  // large enough to be distinctive.
  const movedBodies = new Map<string, MovedCase[]>();
  for (const f of files) {
    const language = detectLanguage(f.path);
    if (f.tooLarge || f.current === null || !isTestFile(f.path) || !ASSESSED_LANGUAGES.has(language)) continue;
    const { baseRoot, curRoot: cur } = await rootsOf(f, language);
    if (!cur || cur.hasError) continue;
    const baseHashes = new Set(baseRoot && !baseRoot.hasError ? extractCases(language, baseRoot).map(c => c.bodyHash) : []);
    for (const c of extractCases(language, cur)) {
      if (baseHashes.has(c.bodyHash) || (c.bodySize ?? 0) < MIN_MOVED_BODY) continue;
      (movedBodies.get(c.bodyHash) ?? movedBodies.set(c.bodyHash, []).get(c.bodyHash)!).push({ file: f.path, key: c.key, disabled: c.disabled });
    }
  }

  for (const f of files) {
    const fileFindings: CheckWeakeningFinding[] = [];
    const push = (): void => {
      if (fileFindings.length > MAX_FINDINGS_PER_FILE) capped += fileFindings.length - MAX_FINDINGS_PER_FILE;
      findings.push(...fileFindings.slice(0, MAX_FINDINGS_PER_FILE));
    };
    if (f.tooLarge) {
      notAssessed.push({ file: emittedText(f.path), shapes: [...CHECK_WEAKENING_CODES], reason: `the file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB at one of the two revisions` });
      continue;
    }
    const kind = checkConfigKind(f.path);
    if (kind && f.current === null && f.base !== null && (kind === 'lint' || kind === 'coverage' || (kind === 'test-runner' && !/package\.json$/.test(f.path)))) {
      // A deleted lint, coverage or test-runner config takes its checks with it.
      fileFindings.push(finding('check-config-relaxed', 'warning', f.path, `The check config ${f.path} was deleted.`, f.path, undefined, 'deleted'));
    } else if (kind && !(kind === 'ci' && f.base === null)) {
      // A deleted workflow is compared against nothing (its test steps are gone); an added config
      // against nothing (its ignore entries are new). A new workflow cannot relax an existing check.
      const base = f.base ?? '';
      const current = f.current ?? '';
      if (kind === 'ci' && (!ciFacts(base) || !ciFacts(current))) {
        notAssessed.push({ file: emittedText(f.path), shapes: ['check-config-relaxed'], reason: 'the workflow is not valid YAML at one of the two revisions' });
      }
      if (/(?:^|\/)package\.json$/.test(f.path) && (packageChecks(base) === null || packageChecks(current) === null)) {
        notAssessed.push({ file: emittedText(f.path), shapes: ['check-config-relaxed'], reason: 'package.json is not valid JSON at one of the two revisions' });
      }
      for (const r of configRelaxations(f.path, kind, base, current)) {
        fileFindings.push(finding('check-config-relaxed', 'warning', r.line ? `${f.path}:${r.line}` : f.path, r.message, f.path, r.line, r.discriminator));
      }
    }

    const language = detectLanguage(f.path);
    const isTest = isTestFile(f.path);
    if (language === 'unknown' || kind) { push(); continue; }
    if (!ASSESSED_LANGUAGES.has(language)) {
      notAssessed.push({ file: emittedText(f.path), shapes: isTest ? [...TEST_SHAPES, ...CODE_SHAPES] : CODE_SHAPES, reason: `${language} is outside the closed language table` });
      push();
      continue;
    }
    const { baseRoot, curRoot } = await rootsOf(f, language);
    if ((f.base !== null && !baseRoot) || (f.current !== null && !curRoot) || baseRoot?.hasError || curRoot?.hasError) {
      // A syntax error (a conflict marker, a half-written edit) would read as removed tests.
      notAssessed.push({ file: emittedText(f.path), shapes: isTest ? [...TEST_SHAPES, ...CODE_SHAPES] : CODE_SHAPES, reason: 'the file has a syntax error, or could not be parsed, at one of the two revisions' });
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
      // A new file's handlers wrap new code: nothing the baseline checked is now discarded.
      const baseSwallows = baseRoot ? swallowedHandlers(language, baseRoot) : [];
      const wrapped = new Set(baseSwallows.map(s => s.key));
      const perFn = new Map<string, number>();
      for (const s of baseSwallows) perFn.set(s.fn, (perFn.get(s.fn) ?? 0) + 1);
      const curSwallows = baseRoot ? swallowedHandlers(language, curRoot) : [];
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

    if (isTest) fileFindings.push(...testShapes(f, language, baseRoot, curRoot, reach, changedIds, notAssessed, noReach, movedBodies));
    push();
  }
  if (capped) boundaries.push(`${capped} check-weakening finding(s) past ${MAX_FINDINGS_PER_FILE} per file were omitted.`);
  if (noReach.length && reach) {
    boundaries.push(`Test findings in ${noReach.slice(0, 5).map(emittedText).join(', ')}${noReach.length > 5 ? ', …' : ''} name no production symbol: the index records none that ${noReach.length > 1 ? 'these test files reach' : 'this test file reaches'}.`);
  }
  return { findings, notAssessed, boundaries };
}

function testShapes(
  f: WeakeningFile, language: string, baseRoot: Node | null, curRoot: Node | null,
  reach: ReachIndex | undefined, changedIds: ReadonlySet<string> | undefined, notAssessed: NotAssessed[], noReach: string[],
  movedBodies?: Map<string, MovedCase[]>,
): CheckWeakeningFinding[] {
  const out: CheckWeakeningFinding[] = [];
  // A test library outside the closed table: its cases and assertions are not recognized, so the
  // file is not-assessed rather than read as having no tests.
  const framework = UNSUPPORTED_FRAMEWORKS[language];
  const foreign = framework && [f.base, f.current].map(t => (t !== null ? framework.exec(t)?.[0] : undefined)).find(Boolean);
  if (foreign) {
    notAssessed.push({ file: emittedText(f.path), shapes: TEST_SHAPES, reason: `a test framework outside the closed table is used (${emittedText(foreign.replace(/\s+/g, ' ').trim())})` });
    return out;
  }
  const baseCases = baseRoot ? extractCases(language, baseRoot) : [];
  const curCases = curRoot ? extractCases(language, curRoot) : [];
  const r = reach?.reachOf(f.path) ?? { recorded: false, symbols: [] };
  const reached = r.symbols.map(s => emittedText(s.name));
  const changed = r.symbols.filter(s => changedIds?.has(s.id)).map(s => emittedText(s.name));
  if (!baseCases.length && !curCases.length) {
    // A helper or fixture under a test directory holds no tests: nothing to assess. A test-shaped
    // file with no recognized case is a framework outside the table.
    if (!TEST_FILE_NAME.test(f.path)) return out;
    notAssessed.push({ file: emittedText(f.path), shapes: TEST_SHAPES, reason: 'no test case of a framework in the closed table was recognized' });
    return out;
  }
  const joined = (fnd: CheckWeakeningFinding, guarded: boolean): CheckWeakeningFinding => {
    if (guarded && !reached.length && !noReach.includes(f.path)) noReach.push(f.path);
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

  /**
   * The new case a removed one moved to, consumed so one copy accounts for one removal: first an
   * unpaired case in this file with the same body (a rename, any size), then one elsewhere in the
   * diff (only for a body large enough to be distinctive).
   */
  const takeMoved = (b: TestCase): MovedCase | undefined => {
    const k = localNew.findIndex(c => c.bodyHash === b.bodyHash);
    if (k >= 0) {
      const c = localNew.splice(k, 1)[0];
      const list = movedBodies?.get(c.bodyHash);
      const own = list?.findIndex(m => m.file === f.path && m.key === c.key) ?? -1;
      if (own >= 0) list!.splice(own, 1);
      return { file: f.path, key: c.key, disabled: c.disabled };
    }
    if ((b.bodySize ?? 0) < MIN_MOVED_BODY) return undefined;
    const list = movedBodies?.get(b.bodyHash);
    const other = list?.findIndex(m => m.file !== f.path) ?? -1;
    return other >= 0 ? list!.splice(other, 1)[0] : undefined;
  };
  let localNew: TestCase[] = [];
  /** A removed case that reappears elsewhere: no removal, unless it came back disabled. */
  const movedFinding = (b: TestCase, m: MovedCase): void => {
    if (m.disabled && !b.disabled) {
      out.push(joined(finding('test-disabled', 'warning', `${m.file}::${m.key}`,
        `Test ${quote(b.key)} moved from ${f.path} to ${m.file} as ${quote(m.key)}, with ${quote(m.disabled)} added.`, m.file, undefined, `${m.key}:skip`), true));
    }
  };

  if (f.current === null) {
    let gone = 0;
    for (const b of baseCases) {
      const m = takeMoved(b);
      if (m) movedFinding(b, m); else gone++;
    }
    if (gone) {
      out.push(joined(finding('test-removed', 'warning', f.path, `Test file ${f.path} was removed (${gone} test case(s)${gone < baseCases.length ? ` not found elsewhere in the diff; ${baseCases.length - gone} moved` : ''}).`, f.path, undefined, 'file'), true));
    }
    return out;
  }
  // Pair base and current cases with the same title: an identical body first, then by order, so a
  // new same-titled test inserted before an old one is not compared against it.
  const pairOf = new Map<TestCase, TestCase>();
  const byTitle = (cases: TestCase[]) => {
    const m = new Map<string, TestCase[]>();
    for (const c of cases) (m.get(c.title ?? c.key) ?? m.set(c.title ?? c.key, []).get(c.title ?? c.key)!).push(c);
    return m;
  };
  const curByTitle = byTitle(curCases);
  for (const [title, bs] of byTitle(baseCases)) {
    const free = [...(curByTitle.get(title) ?? [])];
    const rest: TestCase[] = [];
    for (const b of bs) {
      const k = free.findIndex(c => c.bodyHash === b.bodyHash);
      if (k >= 0) pairOf.set(b, free.splice(k, 1)[0]);
      else rest.push(b);
    }
    rest.forEach((b, k) => { if (free[k]) pairOf.set(b, free[k]); });
  }
  const pairedCur = new Set(pairOf.values());
  localNew = curCases.filter(c => !pairedCur.has(c));
  let evcUnassessed = false;
  for (const b of baseCases) {
    const c = pairOf.get(b);
    if (!c) {
      // Renamed in this file, or moved to another file, with the same body.
      const m = takeMoved(b);
      if (m) { movedFinding(b, m); continue; }
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
      const shown = (v: string | undefined) => (v === undefined ? '(none)' : v.startsWith('s:') ? `"${v.slice(2)}"` : v.startsWith('n:') ? v.slice(2) : v);
      const detail = i >= 0 ? ` (${quote(shown(b.literals[i]))} → ${quote(shown(c.literals[i]))})` : '';
      out.push(joined(finding('expected-value-changed', 'info', `${f.path}::${c.key}`,
        `An expected value in test ${quote(c.key)} changed${detail}, while no production symbol the test file reaches changed (${f.path}:${c.line}).`, f.path, c.line, c.key), true));
    }
  }
  // Focus: a newly focused test silently stops the file's other tests from running.
  if (!baseCases.some(b => b.focused)) {
    const focused = curCases.find(c => c.focused);
    if (focused && curCases.length > 1) {
      const fnd = finding('test-disabled', 'warning', `${f.path}::${focused.key}`,
        `${quote(focused.focused!)} was added to test ${quote(focused.key)}; the other ${curCases.length - 1} test case(s) in ${f.path} no longer run.`, f.path, focused.line, `${focused.key}:focus`);
      out.push(joined({ ...fnd, remediation: `Test ${fnd.subject} is focused, so the other tests in its file do not run; remove the focus marker.` }, true));
    }
  }
  if (evcUnassessed) {
    notAssessed.push({ file: emittedText(f.path), shapes: ['expected-value-changed'], reason: !reach || !changedIds
      ? 'no index (or no changed-symbol set) is available, so a changed expected value cannot be told apart from one updated with its code'
      : 'the index records no production symbol this test file reaches, so a changed expected value cannot be told apart from one updated with its code' });
  }
  return out;
}

// ── Git: the fixed baseline and the changed files ───────────────────────────────

const SHA = /^[0-9a-f]{40,64}$/;
/** git's empty tree, which `resolveBaseRef` returns when there is no base at all. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf899d15f71049056';

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileGit('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return String(stdout);
}

/**
 * The fixed baseline: the merge-base of `baseRef` with the new state. An omitted or `HEAD` base is
 * read as the default branch, so a weakening already committed on this branch is still compared.
 */
export async function resolveWeakeningBaseline(root: string, baseRef: string | undefined, headRef?: string): Promise<{ ref: string; commit: string; note?: string }> {
  const { resolveBaseRefDisclosed } = await import('../drift/git-diff.js');
  const explicit = baseRef && baseRef !== 'HEAD' && baseRef !== 'auto' ? baseRef : undefined;
  const resolution = await resolveBaseRefDisclosed(root, explicit ?? 'auto');
  // An explicit ref that did not resolve gets the automatic baseline (with the fallback disclosed).
  const pinned = explicit && !resolution.fellBack ? explicit : undefined;
  let ref = pinned ? resolution.resolved : resolution.fellBack ? (await resolveBaseRefDisclosed(root, 'auto')).resolved : resolution.resolved;
  const tip = headRef ?? 'HEAD';
  const mergeBase = async (r: string): Promise<string> => {
    try { return (await git(root, ['merge-base', r, tip])).trim(); } catch { return ''; }
  };
  // No default branch and no parent commit (a single-commit repo, a shallow clone): the empty tree
  // would make every file "added", where nothing can be weakened. The current commit is the baseline.
  if (!pinned && ref === EMPTY_TREE) ref = 'HEAD';
  let commit = await mergeBase(ref);
  const noCommonAncestor = !SHA.test(commit);
  let tipSha = '';
  try { tipSha = (await git(root, ['rev-parse', '--verify', `${tip}^{commit}`])).trim(); } catch { /* unborn */ }
  // On the default branch itself the local merge-base is the tip: the agent's own commits would be
  // the baseline. The remote branch, when there is one, is the point those commits started from.
  if (!pinned && SHA.test(commit) && commit === tipSha) {
    for (const remote of ['refs/remotes/origin/HEAD', 'origin/main', 'origin/master']) {
      const mb = await mergeBase(remote);
      if (SHA.test(mb) && mb !== tipSha) { ref = remote; commit = mb; break; }
    }
  }
  if (!SHA.test(commit)) {
    try { commit = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim(); } catch { commit = ref; }
  }
  let note: string | undefined;
  if (!tipSha) {
    note = `${tip} does not name a commit, so there is nothing to compare.`;
  } else if (noCommonAncestor) {
    note = `${ref} shares no history with ${tip}, so the weakening baseline is the tip of ${ref}, not a branch point.`;
  } else if (resolution.fellBack) {
    note = `The base ref '${emittedText(resolution.requested)}' did not resolve, so the weakening baseline is ${ref}.`;
  } else if (!pinned && (ref === 'HEAD~1' || ref === 'HEAD' || !/^(?:main|master|refs\/remotes\/origin\/HEAD|origin\/main|origin\/master)$/.test(ref))) {
    note = `No default branch was found, so the weakening baseline is ${ref}; pass baseRef to compare against the branch point.`;
  } else if (!pinned && commit === tipSha) {
    note = 'The weakening baseline is the current commit (this is the default branch, with no remote ahead of it), so only uncommitted changes are compared; pass baseRef to compare an earlier point.';
  }
  return { ref, commit, ...(note ? { note } : {}) };
}

type Blob = string | null | 'too-large';

/**
 * Read many `ref:path` blobs: one `git cat-file --batch` per ref (the per-file reader is the
 * fallback). Absent → `null`; over the cap → `'too-large'`.
 */
async function readBlobs(root: string, wanted: ReadonlyArray<{ ref: string; path: string }>): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>();
  const byRef = new Map<string, string[]>();
  for (const w of wanted) (byRef.get(w.ref) ?? byRef.set(w.ref, []).get(w.ref)!).push(w.path);
  for (const [ref, paths] of byRef) {
    const unique = [...new Set(paths)];
    const blobs = await readBlobsAtRef(root, ref, unique).catch(() => readBlobsPerFile(root, ref, unique));
    for (const path of unique) {
      const text = blobs.get(path);
      out.set(`${ref}:${path}`, text === undefined ? null : Buffer.byteLength(text, 'utf-8') > MAX_FILE_BYTES ? 'too-large' : text);
    }
  }
  return out;
}

async function inWorkTree(root: string, path: string): Promise<Blob> {
  try {
    const buf = await readFile(safeJoin(root, path));
    return buf.length <= MAX_FILE_BYTES ? buf.toString('utf-8') : 'too-large';
  } catch {
    return null;
  }
}

/** NUL-separated records (`-z`): no path quoting, so no path is dropped. */
function nulRecords(text: string): string[] {
  return text.split('\0').filter(r => r.length > 0);
}

const POLICY_RANK: Record<string, number> = { off: 0, advisory: 1, frozen: 2, blocking: 2 };

/**
 * `.openlore/config.json` itself: a weakening code whose enforcement class the diff lowered
 * (blocking → advisory, advisory → off, or an entry removed) relaxes the check that reports it.
 */
function policyRelaxations(path: string, base: string | null, current: string | null): Array<{ message: string; discriminator: string }> {
  const policyOf = (text: string | null): Record<string, string> => {
    if (!text) return {};
    try {
      const p = (JSON.parse(text) as { enforcement?: { policy?: Record<string, unknown> } })?.enforcement?.policy;
      return p && typeof p === 'object' ? Object.fromEntries(Object.entries(p).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
    } catch {
      return {};
    }
  };
  const before = policyOf(base);
  const after = policyOf(current);
  const out: Array<{ message: string; discriminator: string }> = [];
  for (const code of CHECK_WEAKENING_CODES) {
    const was = before[code] ?? 'advisory';
    const now = after[code] ?? 'advisory';
    if ((POLICY_RANK[now] ?? 1) < (POLICY_RANK[was] ?? 1)) {
      out.push({ message: `The enforcement policy for \`${code}\` was lowered from ${was} to ${now} in ${path}.`, discriminator: `policy:${code}` });
    }
  }
  return out;
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
  const extra: CheckWeakeningFinding[] = [];
  const files: WeakeningFile[] = [];
  let relevant: typeof entries;
  try {
    const records = nulRecords(await git(input.root, gitPathArgs('diff', '--name-status', '-z', '-M', '--diff-filter=ACDMR', baseline.commit, ...(input.headRef ? [input.headRef] : []))));
    for (let i = 0; i < records.length;) {
      const s = records[i].charAt(0);
      if (s === 'R' && i + 2 < records.length) { entries.push({ path: records[i + 2], oldPath: records[i + 1], status: 'renamed' }); i += 3; continue; }
      entries.push({ path: records[i + 1] ?? '', status: s === 'A' ? 'added' : s === 'D' ? 'deleted' : 'modified' });
      i += 2;
    }
    if (!input.headRef) {
      const seen = new Set(entries.map(e => e.path));
      for (const p of nulRecords(await git(input.root, gitPathArgs('ls-files', '-z', '--others', '--exclude-standard')))) {
        if (!seen.has(p)) entries.push({ path: p, status: 'added' });
      }
    }
    const scope = input.files ? new Set(input.files) : null;
    const inScope = entries.filter(e => e.path && (!scope || scope.has(e.path) || (e.oldPath && scope.has(e.oldPath))));
    // The repository's own enforcement policy is a check config too.
    const policy = inScope.find(e => e.path === '.openlore/config.json');
    relevant = inScope
      .filter(e => checkConfigKind(e.path) || detectLanguage(e.path) !== 'unknown')
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (relevant.length > MAX_FILES) boundaries.push(`Check weakening read the first ${MAX_FILES} of ${relevant.length} changed files.`);
    const read = [...relevant.slice(0, MAX_FILES), ...(policy ? [policy] : [])];
    const wanted: Array<{ ref: string; path: string }> = [];
    for (const e of read) {
      if (e.status !== 'added') wanted.push({ ref: baseline.commit, path: e.oldPath ?? e.path });
      if (e.status !== 'deleted' && input.headRef) wanted.push({ ref: input.headRef, path: e.path });
    }
    const blobs = await readBlobs(input.root, wanted);
    const sideOf = async (e: typeof entries[number], side: 'base' | 'current'): Promise<Blob> => {
      if (side === 'base') return e.status === 'added' ? null : blobs.get(`${baseline.commit}:${e.oldPath ?? e.path}`) ?? null;
      if (e.status === 'deleted') return null;
      return input.headRef ? blobs.get(`${input.headRef}:${e.path}`) ?? null : inWorkTree(input.root, e.path);
    };
    const sides: Array<{ path: string; base: Blob; current: Blob; status: ChangedFile['status'] }> = [];
    for (const e of relevant.slice(0, MAX_FILES)) {
      sides.push({ path: e.path, base: await sideOf(e, 'base'), current: await sideOf(e, 'current'), status: e.status });
    }
    // A plain `mv` (not staged) is a deleted file plus an untracked one: pair them by content, as
    // `git diff -M` pairs a staged rename, so the moved file is compared with its old self.
    const lineSet = (t: string) => new Set(t.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
    for (const d of sides.filter(x => x.status === 'deleted' && typeof x.base === 'string')) {
      const ext = d.path.slice(d.path.lastIndexOf('.'));
      const before = lineSet(d.base as string);
      let best: { a: typeof d; score: number } | undefined;
      for (const a of sides) {
        if (a.status !== 'added' || typeof a.current !== 'string' || a.base !== null || !a.path.endsWith(ext)) continue;
        const after = lineSet(a.current);
        let common = 0;
        for (const l of before) if (after.has(l)) common++;
        const score = common / Math.max(1, before.size + after.size - common);
        if (score >= 0.5 && (!best || score > best.score)) best = { a, score };
      }
      if (best) {
        best.a.base = d.base;
        best.a.status = 'renamed';
        d.base = null; // folded into the renamed file
      }
    }
    for (const x of sides) {
      if (x.base === 'too-large' || x.current === 'too-large') { files.push({ path: x.path, base: null, current: null, tooLarge: true }); continue; }
      if (x.base === null && x.current === null) continue;
      files.push({ path: x.path, base: x.base, current: x.current });
    }
    if (!policy && !input.headRef) {
      // `openlore init` gitignores `.openlore/`: its policy then has no baseline to compare with.
      try {
        await readFile(safeJoin(input.root, '.openlore/config.json'));
        const tracked = nulRecords(await git(input.root, gitPathArgs('ls-files', '-z', '--', '.openlore/config.json'))).length > 0;
        if (!tracked) boundaries.push('`.openlore/config.json` is not tracked by git, so a change to its enforcement policy cannot be compared with the baseline; codes it sets to `off` are listed in `silenced`.');
      } catch { /* no config file */ }
    }
    if (policy) {
      const base = await sideOf(policy, 'base');
      const current = await sideOf(policy, 'current');
      if (base !== 'too-large' && current !== 'too-large') {
        for (const r of policyRelaxations(policy.path, base, current)) {
          extra.push(finding('check-config-relaxed', 'warning', policy.path, r.message, policy.path, undefined, r.discriminator));
        }
      }
    }
  } catch (err) {
    return { baseline: { ref: baseline.ref, commit: baseline.commit }, findings: [], notAssessed: [],
      boundaries: [...boundaries, `Check weakening was not assessed: git failed (${emittedText(err instanceof Error ? err.message : String(err))}).`] };
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
    findings: [...extra, ...detected.findings],
    notAssessed: detected.notAssessed,
    boundaries: [...boundaries, ...detected.boundaries],
  };
}
