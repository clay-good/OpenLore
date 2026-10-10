/**
 * Kotlin receivers resolve through declared types
 * (change: add-kotlin-declared-type-receivers, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import { collectKotlinReceiverFields, type KotlinNode } from './kotlin-extract.js';
import { RECEIVER_REGISTRY_LANGUAGES } from './receiver-registry.js';
import { languageSupport } from './language-support.js';

type Files = Record<string, string>;

async function build(files: Files) {
  const list = Object.entries(files).map(([path, content]) => ({ path, content, language: path.endsWith('.java') ? 'Java' : 'Kotlin' }));
  const result = await new CallGraphBuilder().build(list);
  const edges = result.edges.filter(e => e.kind === 'calls' || e.kind === undefined)
    .map(e => ({ from: e.callerId, to: e.calleeId, confidence: e.confidence }));
  return { result, from: (id: string) => edges.filter(e => e.from === id) };
}

const REPO = 'package app\ninterface UserRepository {\n  fun save(n: String): String\n  fun find(id: String): String?\n}\n';

describe('Kotlin declared-type receivers: what binds', () => {
  it('resolves a call on a constructor property', async () => {
    const { from } = await build({
      'Repo.kt': REPO,
      'Service.kt': 'package app\nclass UserService(private val repo: UserRepository) {\n  fun create(n: String) { repo.save(n) }\n}\n',
    });
    expect(from('Service.kt::UserService.create')).toEqual([
      { from: 'Service.kt::UserService.create', to: 'Repo.kt::UserRepository.save', confidence: 'type_inference' },
    ]);
  });

  it('resolves a call on a typed parameter, including a nullable one', async () => {
    const { from } = await build({
      'Repo.kt': REPO,
      'Use.kt': 'package app\nfun use(repo: UserRepository) = repo.find("1")\nfun run(repo: UserRepository?) { repo?.save("x") }\nfun force(repo: UserRepository?) { repo!!.save("x") }\n',
    });
    expect(from('Use.kt::use')[0]).toMatchObject({ to: 'Repo.kt::UserRepository.find', confidence: 'type_inference' });
    expect(from('Use.kt::run')[0]).toMatchObject({ to: 'Repo.kt::UserRepository.save', confidence: 'type_inference' });
    expect(from('Use.kt::force')[0]).toMatchObject({ to: 'Repo.kt::UserRepository.save', confidence: 'type_inference' });
  });

  it('produces a receiver-inferred edge for a `this.<property>` chain', async () => {
    const { from } = await build({
      'Service.kt': 'package app\nclass UserService { fun create(n: String) = n }\n',
      'Controller.kt': 'package app\nclass UserController(private val service: UserService) {\n  fun create(n: String) = this.service.create(n)\n}\n',
    });
    expect(from('Controller.kt::UserController.create')).toEqual([
      { from: 'Controller.kt::UserController.create', to: 'Service.kt::UserService.create', confidence: 'receiver_inferred' },
    ]);
  });

  it('types a body property by its written type, by `lateinit`, by a delegate, and by construction', async () => {
    const { from } = await build({
      'Repo.kt': `${REPO}class DiskRepository : UserRepository {\n  override fun save(n: String) = n\n  override fun find(id: String): String? = null\n}\n`,
      'Holder.kt': [
        'package app',
        'class Holder {',
        '  val written: UserRepository = DiskRepository()',
        '  lateinit var late: UserRepository',
        '  private val lazyRepo: UserRepository by lazy { DiskRepository() }',
        '  val built = DiskRepository()',
        '  fun a() = written.save("a")',
        '  fun b() = late.save("b")',
        '  fun c() = lazyRepo.save("c")',
        '  fun d() = built.save("d")',
        '}',
      ].join('\n'),
    });
    expect(from('Holder.kt::Holder.a')[0].to).toBe('Repo.kt::UserRepository.save');
    expect(from('Holder.kt::Holder.b')[0].to).toBe('Repo.kt::UserRepository.save');
    expect(from('Holder.kt::Holder.c')[0].to).toBe('Repo.kt::UserRepository.save');
    expect(from('Holder.kt::Holder.d')[0].to).toBe('Repo.kt::DiskRepository.save');
  });

  it('finds a member the type inherits from a declared supertype', async () => {
    const { from } = await build({
      'Base.kt': 'package app\nopen class Base { fun shared() = 1 }\n',
      'Child.kt': 'package app\nclass Child : Base() { fun own() = 2 }\n',
      'Use.kt': 'package app\nfun use(c: Child) = c.shared() + c.own()\n',
    });
    expect(from('Use.kt::use').map(e => e.to).sort()).toEqual(['Base.kt::Base.shared', 'Child.kt::Child.own']);
  });

  it('resolves through an imported type and through an import alias', async () => {
    const { from } = await build({
      'lib/Repo.kt': 'package lib\nclass Repo { fun save() = 1 }\n',
      'app/A.kt': 'package app\nimport lib.Repo\nfun a(r: Repo) = r.save()\n',
      'app/B.kt': 'package app\nimport lib.Repo as Store\nfun b(r: Store) = r.save()\n',
    });
    expect(from('app/A.kt::a')[0]).toMatchObject({ to: 'lib/Repo.kt::Repo.save', confidence: 'type_inference' });
    expect(from('app/B.kt::b')[0]).toMatchObject({ to: 'lib/Repo.kt::Repo.save', confidence: 'type_inference' });
  });

  it('types a receiver that is a constructor call', async () => {
    const { from } = await build({
      'A.kt': 'package app\nclass Parser(val text: String) { fun parse() = text }\nfun run() = Parser("x").parse()\n',
    });
    expect(from('A.kt::run').find(e => e.to === 'A.kt::Parser.parse')?.confidence).toBe('type_inference');
  });

  it('uses the parameter of an enclosing function from a nested function', async () => {
    const { from } = await build({
      'Repo.kt': REPO,
      'A.kt': 'package app\nfun outer(repo: UserRepository) {\n  fun inner() = repo.save("x")\n  inner()\n}\n',
    });
    const inner = from('A.kt::outer').find(e => e.confidence === 'same_file')!.to;
    expect(from(inner)[0]).toMatchObject({ to: 'Repo.kt::UserRepository.save', confidence: 'type_inference' });
  });

  it('types a local by the declared return type of a uniquely resolved function', async () => {
    const { from } = await build({
      'lib/Repo.kt': 'package lib\nclass Repo { fun save() = 1 }\nfun open(): Repo = Repo()\nfun guess() = Repo()\n',
      'app/A.kt': [
        'package app',
        'import lib.open',
        'import lib.guess',
        'import lib.Repo',
        'class Factory { fun make(): Repo? = null',
        '  fun viaMember() { val r = make(); r?.save() }',
        '}',
        'fun viaImport() { val r = open(); r.save() }',
        'fun inferredReturn() { val r = guess(); r.save() }',
        'fun reassigned() { var r = open(); r.save() }',
        'fun twice(flag: Boolean) { if (flag) { val r = open(); r.save() } else { val r = guess(); r.save() } }',
        'fun outOfScope(flag: Boolean, r: Any) { if (flag) { val r = open() }; r.save() }',
      ].join('\n'),
    });
    const save = 'lib/Repo.kt::Repo.save';
    expect(from('app/A.kt::viaImport').find(e => e.to === save)?.confidence).toBe('type_inference');
    expect(from('app/A.kt::Factory.viaMember').find(e => e.to === save)?.confidence).toBe('type_inference');
    // `guess` writes no return type, a `var` can be reassigned, and a declaration that has gone
    // out of scope types nothing.
    for (const fn of ['inferredReturn', 'reassigned', 'outOfScope']) {
      expect(from(`app/A.kt::${fn}`).some(e => e.to === save), fn).toBe(false);
    }
    // The first call sees one declaration; the second sees two and is refused.
    expect(from('app/A.kt::twice').filter(e => e.to === save)).toHaveLength(1);
  });

  it('binds a companion member and an object member by type name', async () => {
    const { from } = await build({
      'Service.kt': 'package app\nclass UserService {\n  companion object {\n    fun audit(x: String) = x\n  }\n}\nobject Env {\n  fun port() = 1\n}\n',
      'Fns.kt': 'package app\nfun audit(x: String) = "top"\nfun use() = UserService.audit("x") + Env.port()\n',
    });
    expect(from('Fns.kt::use').map(e => e.to).sort()).toEqual(['Service.kt::Env.port', 'Service.kt::UserService.audit']);
  });
});

describe('Kotlin declared-type receivers: what is refused', () => {
  const lib = 'package app\nclass Repo { fun save() = 1 }\nclass Other { fun save() = 2 }\n';
  const targets = async (source: string) => (await build({ 'Lib.kt': lib, 'A.kt': `package app\n${source}\n` })).from;

  it('refuses a receiver typed only by a smart cast', async () => {
    const from = await targets('fun f(x: Any) { if (x is Repo) x.save() }');
    expect(from('A.kt::f')).toEqual([{ from: 'A.kt::f', to: 'external::x.save', confidence: 'external' }]);
  });

  it('refuses the lambda implicit parameter', async () => {
    const from = await targets('fun f(items: List<Repo>) { items.forEach { it.save() } }');
    expect(from('A.kt::f').some(e => e.to === 'Lib.kt::Repo.save')).toBe(false);
  });

  it('lets a local of the same name hide a parameter and a property', async () => {
    const from = await targets('class C(private val repo: Repo) {\n  fun f(other: Any) {\n    val repo = other\n    repo.save()\n  }\n  fun g() = repo.save()\n}');
    expect(from('A.kt::C.f').some(e => e.to.startsWith('Lib.kt::'))).toBe(false);
    expect(from('A.kt::C.g')[0].to).toBe('Lib.kt::Repo.save');
  });

  it('lets a lambda parameter, a loop variable, and a catch parameter hide a property', async () => {
    const from = await targets([
      'class C(private val repo: Repo, private val e: Repo) {',
      '  fun a(xs: List<Other>) = xs.map { repo -> repo.save() }',
      '  fun b(xs: List<Other>) { for (repo in xs) repo.save() }',
      '  fun c() { try { } catch (e: Exception) { e.save() } }',
      '}',
    ].join('\n'));
    for (const fn of ['a', 'b', 'c']) {
      expect(from(`A.kt::C.${fn}`).some(e => e.to === 'Lib.kt::Repo.save'), fn).toBe(false);
    }
  });

  it('refuses a property declared with two different types', async () => {
    const from = await targets('class C(val repo: Repo) {\n  companion object {\n    val repo: Other = Other()\n  }\n  fun f() = repo.save()\n}');
    expect(from('A.kt::C.f').some(e => e.to.startsWith('Lib.kt::'))).toBe(false);
  });

  it('refuses a local `var` after a reassignment', async () => {
    const from = await targets('fun f(o: Any) {\n  var r = Repo()\n  r = make()\n  r.save()\n}\nfun make(): Repo = Repo()');
    expect(from('A.kt::f').some(e => e.to === 'Lib.kt::Repo.save')).toBe(false);
  });

  it('emits no edge and no external leaf for an unbound `this.<property>` chain', async () => {
    const from = await targets('class C(private val client: HttpClient) {\n  fun f() = this.client.get("u")\n  fun g() = this.missing.save()\n}');
    expect(from('A.kt::C.f')).toEqual([]);
    expect(from('A.kt::C.g')).toEqual([]);
  });

  it('never binds a type the file cannot see', async () => {
    const { from } = await build({
      'lib/Table.kt': 'package lib\nclass Table { fun insert() = 1 }\n',
      'app/A.kt': 'package app\nimport org.jetbrains.exposed.sql.*\nfun f(t: Table) = t.insert()\n',
      'app/B.kt': 'package app\nimport org.jetbrains.exposed.sql.Table\nfun g(t: Table) = t.insert()\n',
    });
    expect(from('app/A.kt::f')).toEqual([{ from: 'app/A.kt::f', to: 'external::t.insert', confidence: 'external' }]);
    expect(from('app/B.kt::g')).toEqual([{ from: 'app/B.kt::g', to: 'external::t.insert', confidence: 'external' }]);
  });

  it('does not bind a function type, a type parameter, or a member the type does not declare', async () => {
    const from = await targets('fun <T> f(cb: (Repo) -> Unit, t: T, r: Repo) { cb.invoke(r); t.save(); r.missing() }');
    expect(from('A.kt::f').every(e => e.confidence === 'external')).toBe(true);
  });
});

describe('Kotlin receiver-field facts', () => {
  it('Kotlin backs the receiverResolution capability', () => {
    expect(RECEIVER_REGISTRY_LANGUAGES.has('Kotlin')).toBe(true);
    expect(languageSupport('Kotlin').capabilities).toContain('receiverResolution');
  });

  it('reads members through the delegation grammar quirk and attributes a companion to its owner', async () => {
    const { result } = await build({
      'A.kt': [
        'package app',
        'interface Store { fun load(): String }',
        'class Cached(private val inner: Store, plain: Store) : Store by inner {',
        '  val audit: Auditor = Auditor()',
        '  companion object {',
        '    val shared: Store = Disk()',
        '  }',
        '  fun warm() = audit.note()',
        '}',
        'class Auditor { fun note() = 1 }',
        'class Disk : Store { override fun load() = "d" }',
      ].join('\n'),
    });
    const warm = result.edges.find(e => e.callerId === 'A.kt::Cached.warm');
    expect(warm?.calleeId).toBe('A.kt::Auditor.note');
    // Direct check of the collector on a hand-built tree is not possible without the parser, so
    // the facts are observed through resolution above; the shape guard below pins the reducer.
    const leaf = (type: string, text: string, children: KotlinNode[] = []): KotlinNode =>
      ({ type, text, startIndex: 0, endIndex: 0, startPosition: { row: 0 }, parent: null, namedChildren: children });
    const tree = leaf('source_file', '', [leaf('class_declaration', '', [
      leaf('type_identifier', 'C'),
      leaf('primary_constructor', '', [
        leaf('class_parameter', '', [leaf('binding_pattern_kind', 'val'), leaf('simple_identifier', 'repo'), leaf('nullable_type', '', [leaf('user_type', '', [leaf('type_identifier', 'Repo')])])]),
        leaf('class_parameter', '', [leaf('simple_identifier', 'plain'), leaf('user_type', '', [leaf('type_identifier', 'Repo')])]),
        leaf('class_parameter', '', [leaf('binding_pattern_kind', 'val'), leaf('simple_identifier', 'cb'), leaf('function_type', '')]),
        leaf('class_parameter', '', [leaf('binding_pattern_kind', 'val'), leaf('simple_identifier', 't'), leaf('user_type', '', [leaf('type_identifier', 't')])]),
      ]),
    ])]);
    expect(collectKotlinReceiverFields(tree)).toEqual([{ className: 'C', field: 'repo', type: 'Repo' }]);
  });
});
