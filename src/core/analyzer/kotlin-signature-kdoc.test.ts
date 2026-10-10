/**
 * Kotlin declarations carry exact signatures and KDoc
 * (change: fix-kotlin-signature-and-kdoc-fidelity, issue #546).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import { KOTLIN_STDLIB_CALLS } from './call-graph-builtins.js';
import { parseKdoc, scanKotlinDeclarations } from './kotlin-source.js';
import { extractSignatures } from './signature-extractor.js';

async function build(files: Record<string, string>) {
  const list = Object.entries(files).map(([path, content]) => ({ path, content, language: 'Kotlin' }));
  const result = await new CallGraphBuilder().build(list);
  const targets = (id: string) => result.edges.filter(e => e.callerId === id && e.kind !== 'tested_by' && e.kind !== 'overrides').map(e => e.calleeId).sort();
  return { result, node: (id: string) => result.nodes.get(id), targets };
}

describe('Kotlin function node signatures', () => {
  it('does not cut the signature at a brace inside an annotation argument', async () => {
    const { node } = await build({ 'A.kt': 'class C(val service: S) {\n  @GetMapping("/{id}")\n  fun get(id: String): String = service.find(id)\n}\n' });
    expect(node('A.kt::C.get')?.signature).toBe('@GetMapping("/{id}")\nfun get(id: String): String');
  });

  it('never includes an expression body or a block body', async () => {
    const { node } = await build({
      'A.kt': 'fun risky(): Int = runCatching { repo.size() }.getOrElse { 0 }\nfun block(a: Int): Int {\n  return a\n}\nfun inferred(a: Int) = a * 2\nfun defaults(cb: () -> Unit = { println("x") }, n: Int = 1) {}\n',
    });
    expect(node('A.kt::risky')?.signature).toBe('fun risky(): Int');
    expect(node('A.kt::block')?.signature).toBe('fun block(a: Int): Int');
    expect(node('A.kt::inferred')?.signature).toBe('fun inferred(a: Int)');
    // A default value is part of the parameter list, braces and all.
    expect(node('A.kt::defaults')?.signature).toBe('fun defaults(cb: () -> Unit = { println("x") }, n: Int = 1)');
  });

  it('records modifiers, visibility, type parameters, parameters, and the return type', async () => {
    const { node } = await build({
      'A.kt': 'open class C {\n  protected inline fun <reified T> load(id: String, vararg tags: String): T? = null\n  fun plain() {}\n}\nfun <K, V : Any> Map<K, V>.pick(key: K): V? where K : Comparable<K> = get(key)\n',
    });
    expect(node('A.kt::C.load')).toMatchObject({
      visibility: 'protected',
      modifiers: ['inline'],
      typeParameters: ['T'],
      parameters: [{ name: 'id', type: 'String' }, { name: 'tags', type: 'String', isVararg: true }],
      returnType: 'T?',
      signature: 'protected inline fun <reified T> load(id: String, vararg tags: String): T?',
    });
    expect(node('A.kt::C.plain')).toMatchObject({ visibility: 'public' });
    expect(node('A.kt::C.plain')?.modifiers).toBeUndefined();
    expect(node('A.kt::Map<K, V>.pick')?.signature).toBe('fun <K, V : Any> Map<K, V>.pick(key: K): V? where K : Comparable<K>');
  });

  it('records KDoc as the docstring, before or after annotations', async () => {
    const { node } = await build({
      'A.kt': [
        'class C {',
        '  /**',
        '   * Computes a thing.',
        '   *',
        '   * More detail that is not the summary.',
        '   * @param x the input',
        '   *   continued',
        '   * @return the result',
        '   * @throws IllegalStateException when broken',
        '   */',
        '  @JvmStatic',
        '  fun documented(x: Int): Int = x',
        '',
        '  @Deprecated("old")',
        '  /** After the annotation. */',
        '  fun after() {}',
        '',
        '  // Not a docstring.',
        '  fun lineComment() {}',
        '',
        '  /* Not KDoc either. */',
        '  fun blockComment() {}',
        '',
        '  /** Belongs to the property. */',
        '  val p = 1',
        '',
        '  fun undocumented() {}',
        '}',
      ].join('\n'),
    });
    expect(node('A.kt::C.documented')?.docstring).toBe('Computes a thing.');
    expect(node('A.kt::C.documented')?.docTags).toEqual([
      { tag: 'param', name: 'x', text: 'the input continued' },
      { tag: 'return', text: 'the result' },
      { tag: 'throws', name: 'IllegalStateException', text: 'when broken' },
    ]);
    expect(node('A.kt::C.after')?.docstring).toBe('After the annotation.');
    expect(node('A.kt::C.lineComment')?.docstring).toBeUndefined();
    expect(node('A.kt::C.blockComment')?.docstring).toBeUndefined();
    expect(node('A.kt::C.undocumented')?.docstring).toBeUndefined();
  });
});

describe('Kotlin standard-library call noise', () => {
  it('creates no external leaf for a scope function and still attributes the call inside it', async () => {
    const { result, targets } = await build({ 'A.kt': 'fun helper(x: Int) = x\nfun use(x: Int?) { x?.let { helper(it) }; listOf(1).forEach { helper(it) }; require(x != null) }\n' });
    expect(targets('A.kt::use')).toEqual(['A.kt::helper', 'A.kt::helper']);
    expect([...result.nodes.values()].filter(n => n.isExternal).map(n => n.name)).toEqual([]);
  });

  it('still binds a project function that has a standard-library name and is in scope', async () => {
    const { targets } = await build({
      'util/Fns.kt': 'package util\nfun <T> T.let(block: (T) -> Unit) = block(this)\nfun require(flag: Boolean) {}\n',
      'app/A.kt': 'package app\nimport util.let\nimport util.require\nfun use(x: Int) { x.let { }; require(true) }\n',
    });
    expect(targets('app/A.kt::use').sort()).toEqual(['util/Fns.kt::T.let', 'util/Fns.kt::require']);
  });

  it('keeps an unresolved call to a name a project type commonly declares', async () => {
    const { targets } = await build({ 'A.kt': 'fun use(repo: Any) { repo.find(1); repo.get(2) }\n' });
    expect(targets('A.kt::use')).toEqual(['external::repo.find', 'external::repo.get']);
    for (const name of ['get', 'find', 'add', 'contains', 'size', 'first', 'replace', 'save']) expect(KOTLIN_STDLIB_CALLS.has(name), name).toBe(false);
  });
});

describe('Kotlin signature inventory', () => {
  const source = [
    'package a',
    '/** A user. */',
    'data class User(val id: String, var name: String = "x")',
    'sealed interface Event',
    'fun interface Op { fun run(): Int }',
    'enum class Mode { ON }',
    '@JvmInline value class Id(val raw: String)',
    'annotation class Tag(val value: String)',
    'object Registry {',
    '  const val LIMIT: Int = 3',
    '  internal fun lookup(key: String): User? = null',
    '}',
    'typealias Handler = (String) -> Unit',
    'class Service private constructor(private val repo: Repo) {',
    '  constructor(repo: Repo, seed: String) : this(repo)',
    '  lateinit var late: Repo',
    '  fun run() {',
    '    val local = 1',
    '    fun nested() = local',
    '  }',
    '}',
    'private val hidden = 1',
  ].join('\n');

  it('lists functions, constructors, properties, every class kind, and type aliases', () => {
    const entries = scanKotlinDeclarations(source).map(d => `${d.kind}:${d.owner ? `${d.owner}.` : ''}${d.name}`);
    expect(entries).toEqual([
      'class:User', 'constructor:User.User', 'interface:Event', 'interface:Op', 'function:Op.run', 'enum:Mode',
      'class:Id', 'constructor:Id.Id', 'class:Tag', 'constructor:Tag.Tag', 'object:Registry',
      'property:Registry.LIMIT', 'function:Registry.lookup', 'typealias:Handler', 'class:Service',
      'constructor:Service.Service', 'constructor:Service.Service', 'property:Service.late', 'function:Service.run',
      'property:hidden',
    ]);
  });

  it('carries the structured header on each inventory entry', () => {
    const { entries } = extractSignatures('A.kt', source);
    const by = (name: string, kind?: string) => entries.find(e => e.name === name && (!kind || e.kind === kind));
    expect(by('User', 'class')).toMatchObject({ signature: 'data class User(val id: String, var name: String = "x")', docstring: 'A user.', visibility: 'public', modifiers: ['data'] });
    expect(by('lookup')).toMatchObject({ kind: 'method', owner: 'Registry', visibility: 'internal', returnType: 'User?', parameters: [{ name: 'key', type: 'String' }] });
    expect(by('Handler')).toMatchObject({ kind: 'type', returnType: '(String) -> Unit' });
    expect(by('LIMIT')).toMatchObject({ kind: 'const', returnType: 'Int', modifiers: ['const'] });
    expect(by('Op', 'interface')?.modifiers).toEqual(['fun']);
    expect(entries.filter(e => e.name === 'constructor').map(e => e.signature)).toContain('constructor(id: String, name: String)');
    expect(entries.some(e => e.name === 'nested' || e.name === 'local')).toBe(false);
    expect(by('hidden')?.visibility).toBe('private');
  });

  it('agrees with the parse tree on the header of every class-level function of every Kotlin fixture', async () => {
    const roots = ['./fixtures/kotlin-reference/', './fixtures/kotlin-syntax/'].map(r => fileURLToPath(new URL(r, import.meta.url)));
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = `${dir}/${name}`.replace('//', '/');
      return statSync(path).isDirectory() ? walk(path) : name.endsWith('.kt') ? [path] : [];
    });
    let compared = 0;
    for (const path of roots.flatMap(walk)) {
      if (path.endsWith('when-guards.kt')) continue; // the one listed grammar gap
      const content = readFileSync(path, 'utf-8');
      const result = await new CallGraphBuilder().build([{ path: 'F.kt', content, language: 'Kotlin' }]);
      for (const declaration of scanKotlinDeclarations(content).filter(d => d.kind === 'function')) {
        const node = [...result.nodes.values()].find(n => !n.isExternal && !n.synthetic && n.name === declaration.name
          && n.startIndex <= declaration.offset && declaration.offset < n.endIndex
          && n.signature?.includes('fun'));
        expect(node, `${path}: ${declaration.name}`).toBeDefined();
        expect(node!.signature, `${path}: ${declaration.name}`).toBe(declaration.signature);
        expect(node!.parameters ?? [], `${path}: ${declaration.name} parameters`).toEqual(declaration.parameters);
        expect(node!.returnType, `${path}: ${declaration.name} return type`).toBe(declaration.type);
        expect(node!.visibility, `${path}: ${declaration.name} visibility`).toBe(declaration.visibility);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(80);
  });
});

describe('parseKdoc', () => {
  it('splits the summary from the block tags', () => {
    expect(parseKdoc('/** One line. */')).toEqual({ summary: 'One line.', tags: [] });
    expect(parseKdoc('/**\n * First\n * second.\n *\n * Body.\n * @see Other\n * @sample a.b.c\n */')).toEqual({
      summary: 'First second.', tags: [{ tag: 'see', text: 'Other' }, { tag: 'sample', text: 'a.b.c' }],
    });
    expect(parseKdoc('/** @property name the name */')).toEqual({ summary: '', tags: [{ tag: 'property', name: 'name', text: 'the name' }] });
    expect(parseKdoc('/* not kdoc */')).toBeUndefined();
    expect(parseKdoc('/** */')).toBeUndefined();
  });
});
