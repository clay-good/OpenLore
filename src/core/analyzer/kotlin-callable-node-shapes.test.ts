/**
 * Kotlin executable bodies are graph nodes, and static call shapes produce edges
 * (change: add-kotlin-callable-node-shapes, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { CallGraphBuilder, _findEnclosingFunctionForTesting } from './call-graph.js';
import type { FunctionNode } from './call-graph-types.js';

type Files = Record<string, string>;

async function build(files: Files) {
  const list = Object.entries(files).map(([path, content]) => ({ path, content, language: 'Kotlin' }));
  const result = await new CallGraphBuilder().build(list);
  const edges = result.edges.filter(e => e.kind === 'calls' || e.kind === undefined)
    .map(e => ({ from: e.callerId, to: e.calleeId, confidence: e.confidence, callType: e.callType }));
  const targets = (id: string) => edges.filter(e => e.from === id).map(e => e.to).sort();
  return { result, edges, targets, node: (id: string) => result.nodes.get(id) };
}

describe('Kotlin body nodes', () => {
  it('attributes a call in an init block to the constructor node', async () => {
    const { targets, node } = await build({
      'A.kt': 'package a\nclass UserService(private val repo: String) {\n  init {\n    warmUp()\n  }\n  private fun warmUp() {}\n}\n',
    });
    expect(node('A.kt::UserService.<init>')).toMatchObject({ name: '<init>', className: 'UserService', synthetic: true });
    expect(targets('A.kt::UserService.<init>')).toEqual(['A.kt::UserService.warmUp']);
  });

  it('gives a class with no written constructor an implied one, and an interface none', async () => {
    const { node } = await build({
      'A.kt': 'package a\nclass Plain {\n  fun f() = 1\n}\ninterface Port {\n  fun g(): Int\n}\nobject Single {\n  val x = compute()\n}\nfun compute() = 1\n',
    });
    expect(node('A.kt::Plain.<init>')?.synthetic).toBe(true);
    expect(node('A.kt::Port.<init>')).toBeUndefined();
    expect(node('A.kt::Single.<init>')?.synthetic).toBe(true);
  });

  it('attributes property initializers, default arguments, and supertype arguments to the constructor', async () => {
    const { targets } = await build({
      'A.kt': [
        'package a',
        'open class Base(val seed: Int)',
        'class Child(val x: Int = dflt()) : Base(mk()) {',
        '  val size = calc()',
        '  constructor(s: String) : this(s.length) {',
        '    sec()',
        '  }',
        '  fun member() = other()',
        '}',
        'fun dflt() = 1', 'fun mk() = 2', 'fun calc() = 3', 'fun sec() = 4', 'fun other() = 5',
      ].join('\n'),
    });
    expect(targets('A.kt::Child.<init>')).toEqual(['A.kt::Base.<init>', 'A.kt::calc', 'A.kt::dflt', 'A.kt::mk', 'A.kt::sec']);
    expect(targets('A.kt::Child.member')).toEqual(['A.kt::other']);
  });

  it('creates getter and setter nodes for accessors with a body, in both layouts', async () => {
    const { targets, node } = await build({
      'A.kt': [
        'package a',
        'class Holder {',
        '  var label: String = ""',
        '    get() = field.trim()',
        '    set(v) { field = normalize(v) }',
        '  val size: Int get() = calc()',
        '  var plain: Int = 0',
        '    private set',
        '  private fun normalize(v: String) = v',
        '  private fun calc() = 1',
        '}',
        'val topLevel: Int get() = compute()',
        'fun compute() = 2',
      ].join('\n'),
    });
    expect(targets('A.kt::Holder.<set-label>')).toEqual(['A.kt::Holder.normalize']);
    expect(targets('A.kt::Holder.<get-size>')).toEqual(['A.kt::Holder.calc']);
    expect(node('A.kt::Holder.<get-label>')?.synthetic).toBe(true);
    expect(node('A.kt::Holder.<set-plain>')).toBeUndefined();
    expect(targets('A.kt::<get-topLevel>')).toEqual(['A.kt::compute']);
  });

  it('creates a node for a function-typed property and binds calls to it', async () => {
    const { targets, node } = await build({
      'A.kt': [
        'package a',
        'class Service {',
        '  private val audit: (String) -> Unit = { line -> record(line) }',
        '  private val check = fun(x: Int): Int { return verify(x) }',
        '  fun run() { audit("a"); audit.invoke("b"); check(1) }',
        '  private fun record(line: String) {}',
        '  private fun verify(x: Int) = x',
        '}',
        'val handler: (Int) -> Int = { twice(it) }',
        'fun twice(x: Int) = x * 2',
        'fun use() = handler(2) + handler.invoke(3)',
      ].join('\n'),
    });
    expect(node('A.kt::Service.audit')?.synthetic).toBeUndefined();
    expect(targets('A.kt::Service.audit')).toEqual(['A.kt::Service.record']);
    expect(targets('A.kt::Service.check')).toEqual(['A.kt::Service.verify']);
    expect(targets('A.kt::Service.run')).toEqual(['A.kt::Service.audit', 'A.kt::Service.audit', 'A.kt::Service.check']);
    expect(targets('A.kt::handler')).toEqual(['A.kt::twice']);
    expect(targets('A.kt::use')).toEqual(['A.kt::handler', 'A.kt::handler']);
  });

  it('creates a file initializer node for package-level property initializers', async () => {
    const { targets, node } = await build({
      'A.kt': 'package a\nval first = one()\nconst val LIMIT = 3\nval second: Int = two()\nfun one() = 1\nfun two() = 2\n',
    });
    expect(node('A.kt::<clinit>')?.synthetic).toBe(true);
    expect(targets('A.kt::<clinit>')).toEqual(['A.kt::one', 'A.kt::two']);
  });

  it('attributes a companion initializer to the class initializer node', async () => {
    const { targets } = await build({
      'A.kt': 'package a\nclass Registry {\n  companion object {\n    val shared = load()\n    fun load() = 1\n  }\n}\n',
    });
    expect(targets('A.kt::Registry.<clinit>')).toEqual(['A.kt::Registry.load']);
  });

  it('creates a script-body node that holds the top-level calls of a .kts file', async () => {
    const { targets, node } = await build({
      'build.gradle.kts': 'fun helper() = 1\nval x = helper()\nprintln(helper())\ntasks.register("a") { helper() }\n',
    });
    expect(node('build.gradle.kts::<script>')?.synthetic).toBe(true);
    expect(targets('build.gradle.kts::<script>').filter(t => t.endsWith('::helper'))).toHaveLength(3);
    expect(node('build.gradle.kts::<clinit>')).toBeUndefined();
  });

  it('stores a backtick name without backticks and marks a suspend function asynchronous', async () => {
    const { node } = await build({
      'A.kt': 'package a\nclass T {\n  fun `creates a user`() {}\n  suspend fun load() {}\n  fun plain() {}\n}\n',
    });
    expect(node('A.kt::T.creates a user')?.name).toBe('creates a user');
    expect(node('A.kt::T.load')?.isAsync).toBe(true);
    expect(node('A.kt::T.plain')?.isAsync).toBe(false);
  });

  it('does not change the identifier of any named function', async () => {
    const source = 'package a\nclass A(val x: Int) {\n  init { f() }\n  val p = g()\n  var q: Int = 0\n    get() = field\n  fun f() {}\n  fun g() = 1\n  companion object {\n    fun make() = A(1)\n  }\n}\nfun String.ext() = length\nfun top() = A(2).f()\n';
    const { result } = await build({ 'A.kt': source });
    const named = [...result.nodes.values()].filter(n => !n.isExternal && !n.synthetic).map(n => n.id).sort();
    expect(named).toEqual(['A.kt::A.f', 'A.kt::A.g', 'A.kt::A.make', 'A.kt::String.ext', 'A.kt::top']);
  });

  it('keeps every span nested in or disjoint from every other, so each offset has one owner', async () => {
    const source = [
      'package a',
      'class A(val x: Int = d()) : B(m()) {',
      '  init { i() }',
      '  val p = listOf(1).map { fun inner() = n(); inner() }',
      '  var q: Int = 0',
      '    get() = g()',
      '  fun f() { val l = { h() } }',
      '}',
      'open class B(v: Int)',
      'val t = top()',
    ].join('\n');
    const { result } = await build({ 'A.kt': source });
    const nodes = [...result.nodes.values()].filter(n => !n.isExternal) as FunctionNode[];
    const intervals = nodes.flatMap(n => [{ n, s: n.startIndex, e: n.endIndex }, ...(n.bodySpans ?? []).map(b => ({ n, s: b.start, e: b.end }))]);
    for (const a of intervals) {
      for (const b of intervals) {
        if (a === b) continue;
        const disjoint = a.e <= b.s || b.e <= a.s;
        const nested = (a.s <= b.s && b.e <= a.e) || (b.s <= a.s && a.e <= b.e);
        expect(disjoint || nested, `${a.n.id} [${a.s},${a.e}) overlaps ${b.n.id} [${b.s},${b.e})`).toBe(true);
      }
    }
    const owner = (text: string) => _findEnclosingFunctionForTesting(nodes, source.indexOf(text))?.id;
    expect(owner('d()')).toBe('A.kt::A.<init>');
    expect(owner('m()')).toBe('A.kt::A.<init>');
    expect(owner('i()')).toBe('A.kt::A.<init>');
    expect(owner('listOf')).toBe('A.kt::A.<init>');
    expect(owner('n()')).toContain('inner');
    expect(owner('g()')).toBe('A.kt::A.<get-q>');
    expect(owner('h()')).toBe('A.kt::A.f');
    expect(owner('top()')).toBe('A.kt::<clinit>');
  });
});

describe('Kotlin static call shapes', () => {
  it('resolves a constructor call to the constructor node, through an import as well', async () => {
    const { edges } = await build({
      'lib/Service.kt': 'package lib\nclass UserService(val name: String)\n',
      'app/Main.kt': 'package app\nimport lib.UserService\nfun main() { val svc = UserService("x") }\n',
      'app/Other.kt': 'package app\nfun other() { val svc = UserService("x") }\n',
    });
    expect(edges.find(e => e.from === 'app/Main.kt::main')).toMatchObject({ to: 'lib/Service.kt::UserService.<init>', confidence: 'import' });
    // Not imported and not in the package: the class is not visible, so nothing binds.
    expect(edges.find(e => e.from === 'app/Other.kt::other')).toMatchObject({ to: 'external::UserService', confidence: 'external' });
  });

  it('lets a function win over a class of the same name', async () => {
    const { targets } = await build({
      'A.kt': 'package a\nclass Widget\nfun Widget(size: Int): Widget = Widget()\nfun use() = Widget(3)\n',
    });
    expect(targets('A.kt::use')).toEqual(['A.kt::Widget']);
  });

  it('emits a reference edge for each callable reference form', async () => {
    const { edges } = await build({
      'A.kt': [
        'package a',
        'class Printer {',
        '  fun emit(x: Int) {}',
        '  fun own() = listOf(1).forEach(this::emit)',
        '}',
        'fun report(x: Int) {}',
        'fun use(p: Printer) {',
        '  listOf(1, 2).forEach(::report)',
        '  listOf(1).forEach(p::emit)',
        '  val member = Printer::emit',
        '  val make = ::Printer',
        '  val kind = Printer::class',
        '}',
      ].join('\n'),
    });
    const refs = edges.filter(e => e.callType === 'reference').map(e => `${e.from} -> ${e.to}`).sort();
    expect(refs).toEqual([
      'A.kt::Printer.own -> A.kt::Printer.emit',
      'A.kt::use -> A.kt::Printer.<init>',
      'A.kt::use -> A.kt::Printer.emit',
      'A.kt::use -> A.kt::Printer.emit',
      'A.kt::use -> A.kt::report',
    ]);
  });

  it('resolves an infix call only to a function declared infix', async () => {
    const { targets } = await build({
      'A.kt': [
        'package a',
        'infix fun Int.times2(o: Int) = this * o * 2',
        'fun Int.plain(o: Int) = this + o',
        'class Box(val v: Int) {',
        '  infix fun join(o: Box) = Box(v + o.v)',
        '}',
        'fun use(a: Box, b: Box) {',
        '  5 times2 2',
        '  5 plain 2',
        '  a join b',
        '  1 to 2',
        '  1 shl 2',
        '}',
      ].join('\n'),
    });
    // `plain` is not infix, and `to` / `shl` are library functions: no edge and no external leaf.
    expect(targets('A.kt::use')).toEqual(['A.kt::Box.join', 'A.kt::Int.times2']);
  });

  it('emits no edge for an operator call or a property access', async () => {
    const { targets } = await build({
      'A.kt': [
        'package a',
        'class Box(val v: Int) {',
        '  operator fun plus(o: Box) = Box(v + o.v)',
        '  operator fun get(i: Int) = v',
        '  val doubled: Int get() = v * 2',
        '}',
        'fun use(a: Box, b: Box): Int {',
        '  val c = a + b',
        '  return c[0] + c.doubled',
        '}',
      ].join('\n'),
    });
    expect(targets('A.kt::use')).toEqual([]);
  });

  it('links a subclass constructor to its superclass constructor', async () => {
    const { targets } = await build({
      'A.kt': 'package a\nopen class Base(v: Int)\nclass One : Base(1)\nclass Two : Base {\n  constructor() : super(2)\n}\nclass Lib : java.lang.RuntimeException("x")\n',
    });
    expect(targets('A.kt::One.<init>')).toEqual(['A.kt::Base.<init>']);
    expect(targets('A.kt::Two.<init>')).toEqual(['A.kt::Base.<init>']);
    // A library superclass leaves no edge and no external leaf.
    expect(targets('A.kt::Lib.<init>')).toEqual([]);
  });

  it('types a call inside an init block through a plain constructor parameter', async () => {
    const { targets } = await build({
      'A.kt': 'package a\nclass Repo {\n  fun open() = 1\n}\nclass Service(repo: Repo) {\n  val handle = repo.open()\n  init {\n    repo.open()\n  }\n}\n',
    });
    expect(targets('A.kt::Service.<init>')).toEqual(['A.kt::Repo.open', 'A.kt::Repo.open']);
  });
});
