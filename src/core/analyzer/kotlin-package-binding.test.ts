/**
 * Kotlin package binding (change: fix-kotlin-package-binding-soundness, issue #546).
 *
 * A call edge labeled `import` or `same_file` for Kotlin must name a declaration the file can
 * really see. Each case builds the graph through the real extractor and import bridge.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import {
  KOTLIN_EXTENSION_PREFIX, KOTLIN_EXTERNAL_PREFIX, KOTLIN_FUNCTION_PREFIX, KOTLIN_MEMBER_PREFIX,
  KOTLIN_PROPERTY_PREFIX, buildBaseImportMap, decodeKotlinCallable,
} from './import-resolver-bridge.js';
import { KOTLIN_DEFAULT_IMPORT_PACKAGES, scanKotlinFile } from './kotlin-source.js';

type Files = Record<string, string>;

async function build(files: Files) {
  const list = Object.entries(files).map(([path, content]) => ({ path, content, language: path.endsWith('.java') ? 'Java' : 'Kotlin' }));
  const result = await new CallGraphBuilder().build(list);
  const edges = result.edges
    .filter(e => e.kind === 'calls' || e.kind === undefined)
    .map(e => ({ from: e.callerId, to: e.calleeId, confidence: e.confidence }));
  const from = (id: string) => edges.filter(e => e.from === id);
  return { result, edges, from, scope: (path: string) => buildBaseImportMap(list).get(path) };
}

describe('Kotlin package binding: a receiver call never binds through a bare name', () => {
  it('does not bind `client.get(...)` to a same-package member named `get`', async () => {
    const { from } = await build({
      'web/UserController.kt': 'package com.acme\nclass UserController { fun get(id: String): String = id }\n',
      'web/Fetch.kt': 'package com.acme\nimport io.ktor.client.HttpClient\nsuspend fun fetch(client: HttpClient) = client.get("http://orders")\n',
    });
    expect(from('web/Fetch.kt::fetch')).toEqual([{ from: 'web/Fetch.kt::fetch', to: 'external::client.get', confidence: 'external' }]);
  });

  it('does not bind `this.service.create(n)` to the enclosing method', async () => {
    const { from } = await build({
      'C.kt': 'package a\nclass UserService { fun create(n: String) = n }\nclass UserController(private val service: UserService) { fun create(n: String) = this.service.create(n) }\n',
    });
    expect(from('C.kt::UserController.create').some(e => e.to === 'C.kt::UserController.create')).toBe(false);
  });

  it('does not bind a receiver call to a package-level function of the same name', async () => {
    const { from } = await build({
      'A.kt': 'package a\nfun load(): Int = 1\nfun use(loader: java.util.ServiceLoader<Any>) { loader.load() }\n',
    });
    expect(from('A.kt::use').every(e => e.confidence === 'external')).toBe(true);
  });

  it('does not bind an unresolved receiver chain by name across the repository', async () => {
    const { from } = await build({
      'A.kt': 'package a\nfun main() { server().start(true) }\nfun server(): Any = 1\n',
      'B.kt': 'package b\ninterface Plugin { fun start(wait: Boolean) }\n',
    });
    expect(from('A.kt::main').find(e => e.to.includes('Plugin'))).toBeUndefined();
    expect(from('A.kt::main').find(e => e.to === 'A.kt::server')?.confidence).toBe('same_file');
  });
});

describe('Kotlin package binding: a bare call binds only what is in scope', () => {
  it('does not bind a bare call to a member of an unrelated class', async () => {
    const { from } = await build({
      'A.kt': 'package a\nclass Service { val audit: (String) -> Unit = {}\n fun create() { audit("x") } }\n',
      'B.kt': 'package a\nclass Repo { private fun audit(x: String) {} }\n',
    });
    // `audit` is the function-typed property of the caller's own class, never `Repo.audit`.
    expect(from('A.kt::Service.create')).toEqual([{ from: 'A.kt::Service.create', to: 'A.kt::Service.audit', confidence: 'same_file' }]);
  });

  it('keeps a default-import name external when another package declares it', async () => {
    const { from } = await build({
      'util/Lists.kt': 'package util\nfun listOf(first: String): List<String> = emptyList()\nfun require(x: Boolean) {}\n',
      'app/Main.kt': 'package app\nfun main() { listOf("a"); require(true) }\n',
    });
    // Neither binds to the project functions of that name. Both are standard-library calls, so
    // they leave no external leaf either (change: fix-kotlin-signature-and-kdoc-fidelity).
    expect(from('app/Main.kt::main')).toEqual([]);
  });

  it('binds a default-import name to a project function the file imports', async () => {
    const { from } = await build({
      'util/Lists.kt': 'package util\nfun listOf(first: String): List<String> = emptyList()\n',
      'app/Main.kt': 'package app\nimport util.listOf\nfun main() { listOf("a") }\n',
    });
    expect(from('app/Main.kt::main')).toEqual([{ from: 'app/Main.kt::main', to: 'util/Lists.kt::listOf', confidence: 'import' }]);
  });

  it('binds a same-package function in another file at import confidence', async () => {
    const { from } = await build({
      'a/One.kt': 'package a\nfun one() = two()\n',
      'a/Two.kt': 'package a\nfun two() = 2\n',
    });
    expect(from('a/One.kt::one')).toEqual([{ from: 'a/One.kt::one', to: 'a/Two.kt::two', confidence: 'import' }]);
  });

  it('indexes modified, generic, and suspend package-level functions', async () => {
    const { from, scope } = await build({
      'a/Load.kt': 'package a\ninternal suspend fun <T> load(id: String): T = TODO()\nenum class Color { RED }\n',
      'b/Use.kt': 'package b\nimport a.load\nimport a.Color\nsuspend fun use() { load<String>("x"); Color.valueOf("RED") }\n',
    });
    expect(from('b/Use.kt::use').find(e => e.to === 'a/Load.kt::load')?.confidence).toBe('import');
    expect(scope('b/Use.kt')?.get('Color')).toBe('a/Load.kt');
    expect(scope('b/Use.kt')?.has('class')).toBe(false);
  });

  it('does not let a private package-level function bind from another file', async () => {
    const { from } = await build({
      'a/Hidden.kt': 'package a\nprivate fun secret() = 1\nfun open() = secret()\n',
      'a/Other.kt': 'package a\nfun other() = secret()\n',
    });
    expect(from('a/Hidden.kt::open')[0]).toMatchObject({ to: 'a/Hidden.kt::secret', confidence: 'same_file' });
    expect(from('a/Other.kt::other')).toEqual([{ from: 'a/Other.kt::other', to: 'external::secret', confidence: 'external' }]);
  });

  it('binds a bare call to a member of the caller\'s own class before a package function', async () => {
    const { from } = await build({
      'a/Fns.kt': 'package a\nfun render() = "top"\n',
      'a/View.kt': 'package a\nclass View { fun render() = "member"\n fun show() = render() }\n',
    });
    expect(from('a/View.kt::View.show')).toEqual([{ from: 'a/View.kt::View.show', to: 'a/View.kt::View.render', confidence: 'same_file' }]);
  });

  it('binds a bare call to a function nested in the caller before anything else', async () => {
    const { from } = await build({
      'a/Fns.kt': 'package a\nfun step() = 1\n',
      'a/Outer.kt': 'package a\nfun outer(): Int {\n  fun step() = 2\n  return step()\n}\n',
    });
    const target = from('a/Outer.kt::outer')[0];
    expect(target.confidence).toBe('same_file');
    expect(target.to.startsWith('a/Outer.kt::')).toBe(true);
  });

  it('prefers the file\'s own declaration when the package declares the name in two files', async () => {
    const { from } = await build({
      'src/main/kotlin/a/Fixture.kt': 'package a\nfun fixture() = 1\nfun useMain() = fixture()\n',
      'src/test/kotlin/a/Fixture.kt': 'package a\nfun fixture() = 2\nfun useTest() = fixture()\n',
      'src/main/kotlin/a/Third.kt': 'package a\nfun third() = fixture()\n',
    });
    expect(from('src/main/kotlin/a/Fixture.kt::useMain')[0].to).toBe('src/main/kotlin/a/Fixture.kt::fixture');
    expect(from('src/test/kotlin/a/Fixture.kt::useTest')[0].to).toBe('src/test/kotlin/a/Fixture.kt::fixture');
    // A third file sees two candidates and binds neither.
    expect(from('src/main/kotlin/a/Third.kt::third')).toEqual([
      { from: 'src/main/kotlin/a/Third.kt::third', to: 'external::fixture', confidence: 'external' },
    ]);
  });
});

describe('Kotlin package binding: imports', () => {
  it('binds an imported extension function at import confidence in every importing file', async () => {
    const { from } = await build({
      'util/Strings.kt': 'package com.acme.util\nfun String.slugify(): String = lowercase()\n',
      'a/One.kt': 'package com.acme.a\nimport com.acme.util.slugify\nfun one(name: String) = name.slugify()\n',
      'b/Two.kt': 'package com.acme.b\nimport com.acme.util.slugify\nclass Two(val title: String) { fun key() = title.slugify() }\n',
    });
    expect(from('a/One.kt::one')[0]).toMatchObject({ confidence: 'import' });
    expect(from('a/One.kt::one')[0].to).toContain('util/Strings.kt::');
    expect(from('b/Two.kt::Two.key')[0]).toMatchObject({ confidence: 'import' });
    expect(from('b/Two.kt::Two.key')[0].to).toBe(from('a/One.kt::one')[0].to);
  });

  it('does not bind an extension function that is not in scope', async () => {
    const { from } = await build({
      'util/Strings.kt': 'package com.acme.util\nfun String.slugify(): String = lowercase()\n',
      'a/One.kt': 'package com.acme.a\nfun one(name: String) = name.slugify()\n',
    });
    expect(from('a/One.kt::one')).toEqual([{ from: 'a/One.kt::one', to: 'external::name.slugify', confidence: 'external' }]);
  });

  it('binds a unique package function through a wildcard import', async () => {
    const { from } = await build({
      'repo/Stores.kt': 'package com.acme.repo\nfun openStore() = 1\n',
      'App.kt': 'package com.acme\nimport com.acme.repo.*\nfun module() = openStore()\n',
    });
    expect(from('App.kt::module')).toEqual([{ from: 'App.kt::module', to: 'repo/Stores.kt::openStore', confidence: 'import' }]);
  });

  it('lets an explicit import win over a wildcard import and over the same package', async () => {
    const { from } = await build({
      'repo/Stores.kt': 'package com.acme.repo\nfun openStore() = 1\n',
      'other/Stores.kt': 'package com.acme.other\nfun openStore() = 2\n',
      'Local.kt': 'package com.acme\nfun openStore() = 3\n',
      'App.kt': 'package com.acme\nimport com.acme.repo.*\nimport com.acme.other.openStore\nfun module() = openStore()\n',
    });
    expect(from('App.kt::module')[0].to).toBe('other/Stores.kt::openStore');
  });

  it('lets the same package win over a wildcard import', async () => {
    const { from } = await build({
      'repo/Stores.kt': 'package com.acme.repo\nfun openStore() = 1\n',
      'Local.kt': 'package com.acme\nfun openStore() = 3\n',
      'App.kt': 'package com.acme\nimport com.acme.repo.*\nfun module() = openStore()\n',
    });
    expect(from('App.kt::module')[0].to).toBe('Local.kt::openStore');
  });

  it('binds nothing when two wildcard imports both declare the name', async () => {
    const { from } = await build({
      'x/A.kt': 'package x\nfun make() = 1\n',
      'y/B.kt': 'package y\nfun make() = 2\n',
      'App.kt': 'package app\nimport x.*\nimport y.*\nfun module() = make()\n',
    });
    expect(from('App.kt::module')).toEqual([{ from: 'App.kt::module', to: 'external::make', confidence: 'external' }]);
  });

  it('binds an aliased import under the alias only', async () => {
    const { from } = await build({
      'util/Fns.kt': 'package util\nfun compute() = 1\n',
      'App.kt': 'package app\nimport util.compute as calc\nfun module() = calc() + compute()\n',
    });
    const targets = from('App.kt::module').map(e => e.to).sort();
    expect(targets).toEqual(['external::compute', 'util/Fns.kt::compute']);
  });

  it('lets an import of a library symbol shadow a same-package function of that name', async () => {
    const { from, scope } = await build({
      'web/Controller.kt': 'package com.acme\nfun get(path: String) = path\n',
      'web/Routes.kt': 'package com.acme\nimport io.ktor.server.routing.get\nfun routes() { get("/health") }\n',
    });
    expect(scope('web/Routes.kt')?.has(`${KOTLIN_EXTERNAL_PREFIX}get`)).toBe(true);
    expect(from('web/Routes.kt::routes')).toEqual([{ from: 'web/Routes.kt::routes', to: 'external::get', confidence: 'external' }]);
  });

  it('binds a member imported by name to its owner', async () => {
    const { from, scope } = await build({
      'cfg/Env.kt': 'package cfg\nobject Env { fun port() = 8080 }\n',
      'App.kt': 'package app\nimport cfg.Env.port\nfun main() = port()\n',
    });
    expect(scope('App.kt')?.get(`${KOTLIN_MEMBER_PREFIX}port`)).toBe('cfg/Env.kt\0Env');
    expect(from('App.kt::main')).toEqual([{ from: 'App.kt::main', to: 'cfg/Env.kt::Env.port', confidence: 'import' }]);
  });

  it('binds `Type.member()` through an imported or same-package type', async () => {
    const { from } = await build({
      'cfg/Env.kt': 'package cfg\nobject Env { fun port() = 8080 }\n',
      'App.kt': 'package app\nimport cfg.Env\nfun main() = Env.port()\n',
    });
    expect(from('App.kt::main')).toEqual([{ from: 'App.kt::main', to: 'cfg/Env.kt::Env.port', confidence: 'import' }]);
  });

  it('binds a Kotlin call on an imported Java class', async () => {
    const { from } = await build({
      'legacy/Tool.java': 'package legacy;\npublic class Tool { public static int run() { return 1; } }\n',
      'App.kt': 'package app\nimport legacy.Tool\nfun main() = Tool.run()\n',
    });
    expect(from('App.kt::main')).toEqual([{ from: 'App.kt::main', to: 'legacy/Tool.java::Tool.run', confidence: 'import' }]);
  });

  it('records each namespace separately, with the declaring keyword offset', async () => {
    const source = 'package a\nval limit = 3\nfun limit() = 4\nfun String.limit() = 5\n';
    const { scope } = await build({ 'a/Decl.kt': source, 'a/Use.kt': 'package a\nfun use() = limit()\n' });
    const map = scope('a/Use.kt')!;
    expect(decodeKotlinCallable(map.get(`${KOTLIN_FUNCTION_PREFIX}limit`))).toEqual({ file: 'a/Decl.kt', name: 'limit', offsets: [source.indexOf('fun limit')] });
    expect(decodeKotlinCallable(map.get(`${KOTLIN_EXTENSION_PREFIX}limit`))?.offsets).toEqual([source.indexOf('fun String')]);
    expect(decodeKotlinCallable(map.get(`${KOTLIN_PROPERTY_PREFIX}limit`))?.offsets).toEqual([source.indexOf('val limit')]);
  });
});

describe('scanKotlinFile', () => {
  it('lists package-level declarations only', () => {
    const header = scanKotlinFile([
      'package com.acme.`in`.util',
      'import a.b.C',
      'import a.b.d as e',
      'import a.b.*',
      '// fun commented() {}',
      'val text = "fun inString() {}"',
      'class Outer(val x: Int = run { 1 }) {',
      '  fun member() {}',
      '  companion object { fun make() = Outer() }',
      '  class Nested',
      '}',
      'fun `with spaces`(a: Int) = a',
      'fun <T : Comparable<T>> Map<String, List<T>>?.deep(): T? = null',
      'fun (Int) -> String.callIt(): String = this(1)',
      'val handler = fun(x: Int) = x',
      'val kind = Outer::class',
      'val anon = object : Runnable { override fun run() {} }',
      'private const val LIMIT = 10',
      'typealias Handler = (String) -> Unit',
      '@JvmName("renamed") @Suppress("x")',
      'internal inline fun annotated() {}',
    ].join('\n'));
    expect(header.packageName).toBe('com.acme.in.util');
    expect(header.imports).toEqual([
      { fqn: 'a.b.C', wildcard: false },
      { fqn: 'a.b.d', wildcard: false, alias: 'e' },
      { fqn: 'a.b', wildcard: true },
    ]);
    expect(header.declarations.map(d => `${d.kind}:${d.receiverType ? `${d.receiverType}.` : ''}${d.name}`)).toEqual([
      'property:text', 'class:Outer', 'function:with spaces', 'function:Map<String, List<T>>.deep',
      'function:(   ) -> String.callIt', 'property:handler', 'property:kind', 'property:anon',
      'property:LIMIT', 'typealias:Handler', 'function:annotated',
    ]);
    const annotated = header.declarations.at(-1)!;
    expect(annotated.modifiers).toEqual(['internal', 'inline']);
    expect(annotated.annotations).toEqual(['JvmName', 'Suppress']);
    expect(header.declarations.find(d => d.name === 'LIMIT')?.modifiers).toEqual(['private', 'const']);
  });

  it('does not read the end of the previous declaration as a modifier', () => {
    const header = scanKotlinFile('class A(private val inner: B) : B by inner\nclass C\nval x = open\nfun f() {}\n');
    expect(header.declarations.map(d => [d.name, d.modifiers])).toEqual([['A', []], ['C', []], ['x', []], ['f', []]]);
  });

  it('agrees with the parse tree on the package-level functions of every Kotlin fixture', async () => {
    const roots = ['./fixtures/kotlin-reference/', './fixtures/kotlin-syntax/', './fixtures/kotlin/'].map(r => fileURLToPath(new URL(r, import.meta.url)));
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = `${dir}/${name}`.replace('//', '/');
      return statSync(path).isDirectory() ? walk(path) : /\.kts?$/.test(name) ? [path] : [];
    });
    let compared = 0;
    for (const path of roots.flatMap(walk)) {
      const content = readFileSync(path, 'utf-8');
      // `when` guards are the one listed grammar gap; the tree is not a valid oracle there.
      if (path.endsWith('when-guards.kt')) continue;
      const result = await new CallGraphBuilder().build([{ path: 'F.kt', content, language: 'Kotlin' }]);
      const scanned = scanKotlinFile(content).declarations.filter(d => d.kind === 'function');
      for (const declaration of scanned) {
        const node = [...result.nodes.values()].find(n =>
          !n.isExternal && n.name === declaration.name.replaceAll('`', '') && n.startIndex <= declaration.offset && declaration.offset < n.endIndex);
        expect(node, `${path}: ${declaration.name}`).toBeDefined();
        compared++;
      }
      // Every graph function that is not inside another declaration is one the scanner found.
      // Named `fun` declarations only: constructors, accessors, and callable properties are
      // other declaration kinds, and a script body contains everything.
      const topLevel = [...result.nodes.values()].filter(n => !n.isExternal && !n.synthetic
        && ![...result.nodes.values()].some(o => o !== n && !o.isExternal && !o.synthetic && o.startIndex <= n.startIndex && n.endIndex <= o.endIndex)
        && /^(?:(?:@\S+(?:\([^)]*\))?|[a-z]+)\s+)*fun\b/.test(content.slice(n.startIndex, n.endIndex))
        && lineIndent(content, n.startIndex) === 0);
      for (const node of topLevel) {
        const found = scanned.some(d => node.startIndex <= d.offset && d.offset < node.endIndex);
        expect(found, `${path}: tree function ${node.name} at column 0 is missing from the scanner`).toBe(true);
      }
    }
    expect(compared).toBeGreaterThan(40);
  });

  it('names the ten Kotlin default-import packages', () => {
    expect(KOTLIN_DEFAULT_IMPORT_PACKAGES).toHaveLength(10);
    expect(KOTLIN_DEFAULT_IMPORT_PACKAGES).toContain('kotlin.collections');
    expect(KOTLIN_DEFAULT_IMPORT_PACKAGES).toContain('java.lang');
  });
});

function lineIndent(content: string, offset: number): number {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  return offset - lineStart;
}
