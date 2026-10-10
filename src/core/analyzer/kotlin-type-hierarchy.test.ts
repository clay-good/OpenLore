/**
 * The Kotlin class model matches declared types
 * (change: fix-kotlin-type-hierarchy-fidelity, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';

type Files = Record<string, string>;

async function build(files: Files) {
  const list = Object.entries(files).map(([path, content]) => ({ path, content, language: path.endsWith('.java') ? 'Java' : 'Kotlin' }));
  const result = await new CallGraphBuilder().build(list);
  const classes = result.classes.filter(c => !c.isModule);
  const cls = (name: string) => classes.find(c => c.name === name);
  const targets = (id: string) => result.edges.filter(e => e.callerId === id && (e.kind === 'calls' || e.kind === undefined)).map(e => e.calleeId).sort();
  return { result, classes, cls, targets };
}

describe('Kotlin class model', () => {
  it('does not record an extension receiver as a class, and keeps the receiver type on the node', async () => {
    const { result, classes } = await build({
      'A.kt': 'package a\nfun String.slugify(): String = lowercase()\nfun List<Int>.total(): Int = sum()\nfun Application.module() {}\nfun plain() = 1\n',
    });
    expect(classes.map(c => c.name)).toEqual([]);
    expect(result.nodes.get('A.kt::String.slugify')).toMatchObject({ receiverType: 'String' });
    expect(result.nodes.get('A.kt::String.slugify')?.className).toBeUndefined();
    expect(result.nodes.get('A.kt::Application.module')?.receiverType).toBe('Application');
    // Every package-level function of the file is in one module group.
    const module = result.classes.find(c => c.isModule);
    expect(module?.methodIds).toHaveLength(4);
  });

  it('keeps the owner of an extension whose receiver the repository declares, without a second class record', async () => {
    const { result, classes, targets } = await build({
      'Service.kt': 'package a\nclass UserService {\n  fun find() = 1\n}\n',
      'Ext.kt': 'package a\nfun UserService.describe() = find()\nfun use(s: UserService) = s.describe()\n',
    });
    expect(result.nodes.get('Ext.kt::UserService.describe')).toMatchObject({ className: 'UserService', receiverType: 'UserService' });
    expect(classes.filter(c => c.name === 'UserService').map(c => c.filePath)).toEqual(['Service.kt']);
    // The implicit receiver of the extension is the class, so its member binds.
    expect(targets('Ext.kt::UserService.describe')).toEqual(['Service.kt::UserService.find']);
    expect(targets('Ext.kt::use')).toEqual(['Ext.kt::UserService.describe']);
  });

  it('tells interfaces and superclasses apart', async () => {
    const { cls, result } = await build({
      'A.kt': 'package a\nopen class Base\ninterface Iface\ninterface Marker\nclass A : Base(), Iface, Marker\nobject Registry : Iface\nclass Lib : Runnable, java.io.Closeable\n',
    });
    expect(cls('A')).toMatchObject({ parentClasses: ['Base'], interfaces: ['Iface', 'Marker'] });
    expect(cls('Registry')).toMatchObject({ parentClasses: [], interfaces: ['Iface'], classKind: 'object' });
    // `Runnable` resolves to nothing in the repository: its kind is unknown, and it stays a
    // parent so dispatch treats it as before. A qualified supertype is not recorded.
    expect(cls('Lib')).toMatchObject({ parentClasses: ['Runnable'], interfaces: [], unknownKindSupertypes: ['Runnable'] });
    expect(result.inheritanceEdges.filter(e => e.childId === 'A.kt::A').map(e => `${e.kind}:${e.parentId}`).sort())
      .toEqual(['extends:A.kt::Base', 'implements:A.kt::Iface', 'implements:A.kt::Marker']);
    expect(result.inheritanceEdges.find(e => e.childId === 'A.kt::Registry')?.kind).toBe('implements');
  });

  it('treats a bare supertype that is a class as a superclass', async () => {
    const { cls } = await build({
      'A.kt': 'package a\nopen class Base\nclass Child : Base {\n  constructor() : super()\n}\n',
    });
    expect(cls('Child')).toMatchObject({ parentClasses: ['Base'], interfaces: [] });
  });

  it('records delegation as an implemented interface and marks the class delegating', async () => {
    const { cls, result } = await build({
      'A.kt': 'package a\ninterface Repo {\n  fun load(): String\n  fun save(v: String)\n}\nclass Cached(private val d: Repo) : Repo by d {\n  override fun save(v: String) {}\n}\nclass Plain : Repo {\n  override fun load() = "p"\n  override fun save(v: String) {}\n}\n',
    });
    expect(cls('Cached')).toMatchObject({ interfaces: ['Repo'], parentClasses: [], delegating: true });
    expect(cls('Plain')?.delegating).toBeUndefined();
    const overrides = result.edges.filter(e => e.kind === 'overrides').map(e => `${e.callerId} -> ${e.calleeId}`);
    expect(overrides).toContain('A.kt::Repo.save -> A.kt::Cached.save');
  });

  it('records each class kind', async () => {
    const { classes } = await build({
      'A.kt': [
        'package a',
        'class Plain', 'interface Port', 'fun interface Op { fun run(): Int }', 'object Single',
        'enum class Mode { ON, OFF }', 'data class Point(val x: Int)', 'sealed class Shape', 'sealed interface Event',
        '@JvmInline value class Id(val raw: String)', 'annotation class Tag', 'data object Empty',
        'class Outer {', '  inner class In', '  companion object', '}',
      ].join('\n'),
    });
    expect(Object.fromEntries(classes.map(c => [c.name, c.classKind]))).toEqual({
      Plain: 'class', Port: 'interface', Op: 'functional-interface', Single: 'object', Mode: 'enum',
      Point: 'data', Shape: 'sealed', Event: 'interface', Id: 'value', Tag: 'annotation', Empty: 'object',
      Outer: 'class', 'Outer.In': 'inner',
    });
  });

  it('gives an object expression a class record that takes part in dispatch', async () => {
    const { cls, result, targets } = await build({
      'A.kt': [
        'package a',
        'interface Listener {',
        '  fun on()',
        '}',
        'class Host {',
        '  val first = object : Listener {',
        '    override fun on() { one() }',
        '  }',
        '  fun make(): Listener = object : Listener {',
        '    override fun on() { two() }',
        '  }',
        '}',
        'fun one() {}', 'fun two() {}',
        'fun fire(x: Listener) = x.on()',
      ].join('\n'),
    });
    expect(cls('Host.<anonymous-1>')).toMatchObject({ classKind: 'object-expression', interfaces: ['Listener'] });
    expect(cls('Host.<anonymous-2>')).toMatchObject({ classKind: 'object-expression', interfaces: ['Listener'] });
    expect(targets('A.kt::Host.<anonymous-1>.on')).toEqual(['A.kt::one']);
    expect(targets('A.kt::Host.<anonymous-2>.on')).toEqual(['A.kt::two']);
    // The call is typed `Listener`; class-hierarchy dispatch reaches both overrides.
    const dispatched = result.edges.filter(e => e.callerId === 'A.kt::fire').map(e => e.calleeId).sort();
    expect(dispatched).toEqual(['A.kt::Host.<anonymous-1>.on', 'A.kt::Host.<anonymous-2>.on', 'A.kt::Listener.on']);
  });

  it('names object expressions by their order within the enclosing owner', async () => {
    const { classes } = await build({
      'A.kt': 'package a\ninterface L {\n  fun on()\n}\nval top = object : L {\n  override fun on() {}\n}\nclass A {\n  val x = object : L {\n    override fun on() {}\n  }\n}\nclass B {\n  val y = object : L {\n    override fun on() {}\n  }\n}\n',
    });
    expect(classes.filter(c => c.classKind === 'object-expression').map(c => c.name).sort())
      .toEqual(['<anonymous-1>', 'A.<anonymous-1>', 'B.<anonymous-1>']);
  });

  it('gives an enum entry with a body its own class under the enum', async () => {
    const { cls, result } = await build({
      'A.kt': 'package a\nenum class Mode {\n  ON {\n    override fun label() = "on"\n  },\n  OFF {\n    override fun label() = "off"\n  };\n  abstract fun label(): String\n}\n',
    });
    expect(cls('Mode.ON')).toMatchObject({ classKind: 'enum-entry', parentClasses: ['Mode'] });
    expect(result.nodes.has('A.kt::Mode.ON.label')).toBe(true);
    expect(result.nodes.has('A.kt::Mode.OFF.label')).toBe(true);
    expect(result.nodes.has('A.kt::Mode.label')).toBe(true);
  });

  it('owns a named companion member by the enclosing class and binds both spellings', async () => {
    const { result, cls, targets } = await build({
      'A.kt': 'package a\nclass Outer {\n  companion object Named {\n    fun make() = Outer()\n  }\n}\nfun use() {\n  Outer.make()\n  Outer.Named.make()\n}\n',
    });
    expect(result.nodes.has('A.kt::Outer.make')).toBe(true);
    expect(result.nodes.has('A.kt::Named.make')).toBe(false);
    expect(cls('Outer')?.aliases).toEqual(['Named']);
    expect(targets('A.kt::use')).toEqual(['A.kt::Outer.make', 'A.kt::Outer.make']);
  });

  it('keeps nested classes with the same simple name apart', async () => {
    const { classes, result, targets } = await build({
      'A.kt': [
        'package a',
        'class Request {',
        '  class Builder {',
        '    fun build() = Request()',
        '  }',
        '  fun fresh() = Builder().build()',
        '}',
        'class Response {',
        '  class Builder {',
        '    fun build() = Response()',
        '  }',
        '}',
        'fun use() = Request.Builder().build()',
        'fun other(b: Response.Builder) = b.build()',
      ].join('\n'),
      'B.kt': 'package b\nimport a.Request.Builder\nfun viaImport() = Builder().build()\n',
    });
    expect(classes.map(c => c.name).sort()).toEqual(['Request', 'Request.Builder', 'Response', 'Response.Builder']);
    expect(result.nodes.has('A.kt::Request.Builder.build')).toBe(true);
    expect(result.nodes.has('A.kt::Response.Builder.build')).toBe(true);
    expect(targets('A.kt::use')).toEqual(['A.kt::Request.Builder.<init>', 'A.kt::Request.Builder.build']);
    expect(targets('B.kt::viaImport')).toEqual(['A.kt::Request.Builder.<init>', 'A.kt::Request.Builder.build']);
    // `Builder` alone names two classes of the file: nothing is chosen.
    expect(targets('A.kt::Request.fresh').some(t => t.includes('Response'))).toBe(false);
  });

  it('records a class that declares no function, so its subtypes can be classified', async () => {
    const { cls } = await build({
      'A.kt': 'package a\ninterface Marker\nannotation class Tag\nclass Uses : Marker\n',
    });
    expect(cls('Marker')).toMatchObject({ classKind: 'interface', methodIds: [] });
    expect(cls('Tag')?.classKind).toBe('annotation');
    expect(cls('Uses')?.interfaces).toEqual(['Marker']);
  });

  it('leaves the Java class model unchanged', async () => {
    const { cls } = await build({
      'A.java': 'package a;\ninterface Port { void run(); }\nclass Base { void go() {} }\nclass Impl extends Base implements Port { public void run() {} }\n',
    });
    expect(cls('Impl')).toMatchObject({ parentClasses: ['Base'], interfaces: ['Port'] });
    expect(cls('Impl')?.classKind).toBeUndefined();
  });
});
