/**
 * Java calls resolve to Kotlin declarations through their JVM names
 * (change: add-kotlin-java-interop-resolution, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import { kotlinAccessorNames, kotlinFacadeName, kotlinJvmMembers } from './kotlin-jvm-names.js';

async function build(files: Record<string, string>) {
  const list = Object.entries(files).map(([path, content]) => ({ path, content, language: path.endsWith('.java') ? 'Java' : 'Kotlin' }));
  const result = await new CallGraphBuilder().build(list);
  const from = (id: string) => result.edges
    .filter(e => e.callerId === id && e.kind === 'calls' && e.confidence !== 'synthesized')
    .map(e => ({ to: e.calleeId, confidence: e.confidence }));
  return { result, from };
}

const java = (body: string, imports = ''): string => `package app;\n${imports}\npublic class Caller {\n  ${body}\n}\n`;

describe('Java calls into Kotlin', () => {
  it('reaches a top-level function through the file facade class', async () => {
    const { from } = await build({
      'lib/Stores.kt': 'package lib\nfun openStore() = 1\n',
      'app/Caller.java': java('int run() { return StoresKt.openStore(); }', 'import lib.StoresKt;'),
    });
    expect(from('app/Caller.java::Caller.run')).toEqual([{ to: 'lib/Stores.kt::openStore', confidence: 'import' }]);
  });

  it('honors `@file:JvmName` and `@JvmName`', async () => {
    const { from } = await build({
      'lib/Stores.kt': '@file:JvmName("Stores")\npackage lib\n@JvmName("open")\nfun openStore() = 1\nfun plain() = 2\n',
      'app/Caller.java': java('int run() { return Stores.open() + Stores.plain() + StoresKt.plain() + Stores.openStore(); }', 'import lib.Stores;'),
    });
    // `StoresKt` does not exist once the facade is renamed, and `openStore` is not its JVM name.
    expect(from('app/Caller.java::Caller.run').filter(e => e.confidence === 'import').map(e => e.to).sort())
      .toEqual(['lib/Stores.kt::openStore', 'lib/Stores.kt::plain']);
  });

  it('reaches an extension function as a static member of the facade', async () => {
    const { from } = await build({
      'lib/Strings.kt': 'package lib\nfun String.slugify() = lowercase()\n',
      'app/Caller.java': java('String run(String s) { return StringsKt.slugify(s); }', 'import lib.StringsKt;'),
    });
    expect(from('app/Caller.java::Caller.run')).toEqual([{ to: 'lib/Strings.kt::String.slugify', confidence: 'import' }]);
  });

  it('reaches an object member through INSTANCE, and directly with @JvmStatic', async () => {
    const { from } = await build({
      'lib/Env.kt': 'package lib\nobject Env {\n  fun port() = 1\n  @JvmStatic\n  fun host() = "h"\n}\n',
      'app/Caller.java': java('void run() { Env.INSTANCE.port(); Env.host(); Env.INSTANCE.host(); }', 'import lib.Env;'),
    });
    const edges = from('app/Caller.java::Caller.run');
    expect(edges.filter(e => e.confidence === 'import').map(e => e.to).sort())
      .toEqual(['lib/Env.kt::Env.host', 'lib/Env.kt::Env.host', 'lib/Env.kt::Env.port']);
  });

  it('reaches a companion member through Companion, a named companion, and @JvmStatic', async () => {
    const { from } = await build({
      'lib/Service.kt': 'package lib\nclass Service {\n  companion object {\n    fun make() = Service()\n    @JvmStatic\n    fun shared() = Service()\n  }\n}\nclass Named {\n  companion object Factory {\n    fun build() = Named()\n  }\n}\n',
      'app/Caller.java': java('void run() { Service.Companion.make(); Service.shared(); Named.Factory.build(); Named.Companion.build(); }', 'import lib.Service;\nimport lib.Named;'),
    });
    expect(from('app/Caller.java::Caller.run').filter(e => e.confidence === 'import').map(e => e.to).sort())
      .toEqual(['lib/Service.kt::Named.build', 'lib/Service.kt::Service.make', 'lib/Service.kt::Service.shared']);
  });

  it('reaches a property through its accessor names when the accessor has a node', async () => {
    const { from } = await build({
      'lib/Config.kt': 'package lib\nval limit: Int\n  get() = compute()\nvar isReady: Boolean = false\n  get() = field\n  set(v) { field = v }\nfun compute() = 1\nconst val MAX = 3\n',
      'app/Caller.java': java('void run() { ConfigKt.getLimit(); ConfigKt.isReady(); ConfigKt.setReady(true); ConfigKt.getMAX(); }', 'import lib.ConfigKt;'),
    });
    expect(from('app/Caller.java::Caller.run').filter(e => e.confidence === 'import').map(e => e.to).sort())
      .toEqual(['lib/Config.kt::<get-isReady>', 'lib/Config.kt::<get-limit>', 'lib/Config.kt::<set-isReady>']);
  });

  it('binds an accessor through a typed Java local, and never by name alone', async () => {
    const { from } = await build({
      'lib/User.kt': 'package lib\nclass User(val id: String) {\n  val count: Int\n    get() = id.length\n}\n',
      'app/Caller.java': java('int typed() { User u = new User("a"); return u.getCount(); }\n  int untyped(Object other) { return other.getCount(); }', 'import lib.User;'),
    });
    expect(from('app/Caller.java::Caller.typed').find(e => e.to === 'lib/User.kt::User.<get-count>')?.confidence).toBe('type_inference');
    expect(from('app/Caller.java::Caller.untyped').some(e => e.to.startsWith('lib/User.kt::'))).toBe(false);
  });

  it('binds nothing when two files give one package the same facade name', async () => {
    const { from } = await build({
      'lib/a/Util.kt': 'package lib\nfun one() = 1\n',
      'lib/b/Util.kt': 'package lib\nfun two() = 2\n',
      'app/Caller.java': java('int run() { return UtilKt.one() + UtilKt.two(); }', 'import lib.UtilKt;'),
    });
    expect(from('app/Caller.java::Caller.run').some(e => e.confidence === 'import')).toBe(false);
  });

  it('binds nothing for a facade the Java file does not import or share a package with', async () => {
    const { from } = await build({
      'lib/Stores.kt': 'package lib\nfun openStore() = 1\n',
      'app/Caller.java': java('int run() { return StoresKt.openStore(); }'),
      'lib/Same.java': 'package lib;\npublic class Same {\n  int run() { return StoresKt.openStore(); }\n}\n',
    });
    expect(from('app/Caller.java::Caller.run').some(e => e.confidence === 'import')).toBe(false);
    expect(from('lib/Same.java::Same.run')).toEqual([{ to: 'lib/Stores.kt::openStore', confidence: 'import' }]);
  });

  it('keeps private, internal, and @JvmSynthetic declarations out of the view', async () => {
    const { from } = await build({
      'lib/Hidden.kt': 'package lib\nprivate fun secret() = 1\ninternal fun moduleOnly() = 2\n@JvmSynthetic\nfun kotlinOnly() = 3\nfun open() = 4\n',
      'app/Caller.java': java('int run() { return HiddenKt.secret() + HiddenKt.moduleOnly() + HiddenKt.kotlinOnly() + HiddenKt.open(); }', 'import lib.HiddenKt;'),
    });
    expect(from('app/Caller.java::Caller.run').filter(e => e.confidence === 'import').map(e => e.to)).toEqual(['lib/Hidden.kt::open']);
  });

  it('binds every arity of a @JvmOverloads function to the one Kotlin function', async () => {
    const { from } = await build({
      'lib/Greet.kt': 'package lib\n@JvmOverloads\nfun greet(name: String, greeting: String = "hi", loud: Boolean = false) = greeting + name\n',
      'app/Caller.java': java('void run() { GreetKt.greet("a"); GreetKt.greet("a", "yo"); GreetKt.greet("a", "yo", true); }', 'import lib.GreetKt;'),
    });
    expect(from('app/Caller.java::Caller.run').map(e => e.to)).toEqual(['lib/Greet.kt::greet', 'lib/Greet.kt::greet', 'lib/Greet.kt::greet']);
  });
});

describe('Kotlin use of Java', () => {
  it('binds a Kotlin call on a Java class and marks its accessors as possibly read by property syntax', async () => {
    const { result, from } = await build({
      'legacy/Account.java': 'package legacy;\npublic class Account {\n  public String getName() { return "n"; }\n  public void setName(String n) {}\n  public boolean isActive() { return true; }\n  public void close() {}\n}\n',
      'legacy/Unused.java': 'package legacy;\npublic class Unused {\n  public String getName() { return "n"; }\n}\n',
      'app/Use.kt': 'package app\nimport legacy.Account\nfun use(a: Account): String {\n  a.close()\n  return a.name\n}\n',
    });
    expect(from('app/Use.kt::use')).toEqual([{ to: 'legacy/Account.java::Account.close', confidence: 'type_inference' }]);
    const flagged = [...result.nodes.values()].filter(n => n.kotlinPropertyAccessor).map(n => n.id).sort();
    expect(flagged).toEqual(['legacy/Account.java::Account.getName', 'legacy/Account.java::Account.isActive', 'legacy/Account.java::Account.setName']);
  });
});

describe('JVM-facing names', () => {
  it('derives the facade class name', () => {
    expect(kotlinFacadeName('a/Stores.kt', 'package a')).toBe('StoresKt');
    expect(kotlinFacadeName('a/my-file.kt', '')).toBe('My_fileKt');
    expect(kotlinFacadeName('a/build.gradle.kts', '')).toBe('Build_gradleKt');
    expect(kotlinFacadeName('a/X.kt', '@file:JvmName("Tools")\npackage a')).toBe('Tools');
  });

  it('derives accessor names', () => {
    expect(kotlinAccessorNames('name')).toEqual({ getter: 'getName', setter: 'setName' });
    expect(kotlinAccessorNames('isReady')).toEqual({ getter: 'isReady', setter: 'setReady' });
    expect(kotlinAccessorNames('island')).toEqual({ getter: 'getIsland', setter: 'setIsland' });
  });

  it('lists members with how Java reaches each', () => {
    const members = kotlinJvmMembers('package a\nfun top() = 1\nobject O {\n  fun m() = 1\n  @JvmStatic\n  fun s() = 2\n}\nclass C {\n  var p = 1\n  companion object {\n    fun c() = 1\n  }\n}\n');
    expect(members.map(m => `${m.access}:${m.owner ? `${m.owner}.` : ''}${m.jvmName}`).sort()).toEqual([
      'companion:C.c', 'facade:top', 'instance:O.m', 'instance:O.s', 'member:C.getP', 'member:C.setP', 'static:O.s',
    ]);
  });
});
