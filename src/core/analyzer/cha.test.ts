/**
 * Class Hierarchy Analysis — type-hierarchy-resolved polymorphic dispatch
 * (spec: add-type-hierarchy-resolved-dispatch). Exercises the override and
 * virtual-dispatch rules + provenance through the real CallGraphBuilder.build().
 * Plain .test.ts so CI runs it.
 */
import { describe, it, expect } from 'vitest';
import { CallGraphBuilder, callDistance } from './call-graph.js';
import type { CallEdge, FunctionNode } from './call-graph.js';
import { arityFromSignature, CHA_FANOUT_CAP } from './cha.js';

type Built = Awaited<ReturnType<CallGraphBuilder['build']>>;

const build = (content: string): Promise<Built> =>
  new CallGraphBuilder().build([{ path: 'src/shapes.ts', content, language: 'TypeScript' }]);

/** A method node id by `Class.method` (className-qualified). */
const methodId = (b: Built, className: string, method: string): string | undefined =>
  [...b.nodes.values()].find(
    (n: FunctionNode) => n.className === className && n.name === method,
  )?.id;

const fnId = (b: Built, name: string): string | undefined =>
  [...b.nodes.values()].find((n: FunctionNode) => n.className === undefined && n.name === name)?.id;

const edge = (b: Built, fromId?: string, toId?: string): CallEdge | undefined =>
  b.edges.find(e => e.callerId === fromId && e.calleeId === toId);

const synthEdges = (b: Built): CallEdge[] => b.edges.filter(e => e.confidence === 'synthesized');

describe('CHA — method-level override edges', () => {
  it('Override edge connects matching methods only', async () => {
    const b = await build(`
      class Animal {
        speak() { return 'a'; }
        feed() { return 1; }
      }
      class Dog extends Animal {
        speak() { return 'woof'; }
      }
    `);
    const e = edge(b, methodId(b, 'Animal', 'speak'), methodId(b, 'Dog', 'speak'));
    expect(e).toBeDefined();
    expect(e!.kind).toBe('overrides');
    expect(e!.synthesizedBy).toBe('override');
    expect(e!.confidence).toBe('synthesized');
    // feed is not overridden by Dog → no override edge to Dog.speak from Animal.feed
    expect(edge(b, methodId(b, 'Animal', 'feed'), methodId(b, 'Dog', 'speak'))).toBeUndefined();
    // and no override edge for the un-overridden feed at all
    expect(b.edges.some(e2 => e2.synthesizedBy === 'override' && e2.callerId === methodId(b, 'Animal', 'feed'))).toBe(false);
  });

  it('Override edge carries provenance', async () => {
    const b = await build(`
      class Base { run() { return 0; } }
      class Derived extends Base { run() { return 1; } }
    `);
    const e = edge(b, methodId(b, 'Base', 'run'), methodId(b, 'Derived', 'run'))!;
    expect(e.confidence).toBe('synthesized');
    expect(e.kind).toBe('overrides');
    expect(e.synthesizedBy).toBe('override');
  });

  it('Override edges are transitive across a multi-level hierarchy', async () => {
    const b = await build(`
      class A { m() { return 0; } }
      class B extends A { other() { return 1; } }
      class C extends B { m() { return 2; } }
    `);
    // B does not declare m, so A.m must connect directly to C.m (transitive subtree).
    const e = edge(b, methodId(b, 'A', 'm'), methodId(b, 'C', 'm'));
    expect(e).toBeDefined();
    expect(e!.synthesizedBy).toBe('override');
  });

  it('No silent drop on large class pairs', async () => {
    // 16 × 16 = 256 > the old >200 cross-product skip threshold.
    const methods = (n: number, body: string) =>
      Array.from({ length: n }, (_, i) => `  m${i}() { return ${body}; }`).join('\n');
    const b = await build(`
      class Big {
${methods(16, '0')}
      }
      class BigChild extends Big {
${methods(16, '1')}
      }
    `);
    // Every name-matched override must still be emitted (no silent drop).
    for (let i = 0; i < 16; i++) {
      const e = edge(b, methodId(b, 'Big', `m${i}`), methodId(b, 'BigChild', `m${i}`));
      expect(e, `override edge for m${i}`).toBeDefined();
      expect(e!.synthesizedBy).toBe('override');
    }
    // And precise: Big.m0 is NOT wired to the unrelated BigChild.m1 (no cross-product).
    expect(edge(b, methodId(b, 'Big', 'm0'), methodId(b, 'BigChild', 'm1'))).toBeUndefined();
  });
});

describe('CHA — virtual-dispatch edges', () => {
  it('Virtual call resolves to all overrides in the receiver subtree', async () => {
    const b = await build(`
      class Shape { area() { return 0; } }
      class Circle extends Shape { area() { return 1; } }
      class Square extends Shape { area() { return 4; } }
      function compute(shape: Shape) { return shape.area(); }
    `);
    const toCircle = edge(b, fnId(b, 'compute'), methodId(b, 'Circle', 'area'));
    const toSquare = edge(b, fnId(b, 'compute'), methodId(b, 'Square', 'area'));
    expect(toCircle, 'edge to Circle.area').toBeDefined();
    expect(toSquare, 'edge to Square.area').toBeDefined();
    expect(toCircle!.confidence).toBe('synthesized');
    expect(toCircle!.synthesizedBy).toBe('cha-declared-type');
    expect(toCircle!.kind).toBe('calls');
  });

  it('Declared receiver type narrows the target set', async () => {
    const b = await build(`
      class Shape { area() { return 0; } }
      class Circle extends Shape { area() { return 1; } }
      class Square extends Shape { area() { return 4; } }
      function compute(c: Circle) { return c.area(); }
    `);
    // An edge to Circle.area exists (direct or synthesized); none to Square.area.
    const anyToCircle = b.edges.some(e => e.callerId === fnId(b, 'compute') && e.calleeId === methodId(b, 'Circle', 'area'));
    expect(anyToCircle).toBe(true);
    expect(edge(b, fnId(b, 'compute'), methodId(b, 'Square', 'area'))).toBeUndefined();
  });

  it('Unrelated method names produce no edge', async () => {
    const b = await build(`
      class Shape { area() { return 0; } }
      class Circle extends Shape { render() { return 1; } }
      function compute(shape: Shape) { return shape.area(); }
    `);
    expect(edge(b, fnId(b, 'compute'), methodId(b, 'Circle', 'render'))).toBeUndefined();
  });

  it('Calls on external types do not resolve (method not in hierarchy)', async () => {
    const b = await build(`
      class Shape { area() { return 0; } }
      function f(arr: any) { return arr.map((x: number) => x); }
    `);
    // 'map' is declared by no hierarchy class → no virtual-dispatch edge.
    expect(synthEdges(b).filter(e => e.synthesizedBy?.startsWith('cha-'))).toHaveLength(0);
  });

  it('Recovered external receiver type emits nothing even when the method name exists', async () => {
    const b = await build(`
      class Widget { render() { return 1; } }
      // arr has a recovered type Array which is NOT a hierarchy class → no edge,
      // even though Widget declares render.
      function f(arr: Array) { return (arr as any).render(); }
    `);
    expect(b.edges.some(e => e.synthesizedBy?.startsWith('cha-') && e.calleeId === methodId(b, 'Widget', 'render'))).toBe(false);
  });

  it('Precise and over-approximating dispatch are distinguishable', async () => {
    const b = await build(`
      class Shape { area() { return 0; } }
      class Circle extends Shape { area() { return 1; } }
      class Square extends Shape { area() { return 4; } }
      function precise(shape: Shape) { return shape.area(); }
      function loose(x) { return x.area(); }
    `);
    const preciseEdges = b.edges.filter(e => e.callerId === fnId(b, 'precise') && e.synthesizedBy?.startsWith('cha-'));
    const looseEdges = b.edges.filter(e => e.callerId === fnId(b, 'loose') && e.synthesizedBy?.startsWith('cha-'));
    expect(preciseEdges.length).toBeGreaterThan(0);
    expect(preciseEdges.every(e => e.synthesizedBy === 'cha-declared-type')).toBe(true);
    expect(looseEdges.length).toBeGreaterThan(0);
    expect(looseEdges.every(e => e.synthesizedBy === 'cha-name-only')).toBe(true);
  });

  it('Virtual-dispatch edges cost more than a directly-resolved path', async () => {
    const b = await build(`
      class Shape { area() { return 0; } }
      class Circle extends Shape { area() { return 1; } }
      class Square extends Shape { area() { return 4; } }
      function compute(shape: Shape) { return shape.area(); }
    `);
    const chaEdge = b.edges.find(e => e.synthesizedBy === 'cha-declared-type')!;
    const directEdge = b.edges.find(e => e.confidence !== 'synthesized' && e.confidence !== 'external' && Number.isFinite(callDistance(e)))!;
    expect(callDistance(chaEdge)).toBeGreaterThan(callDistance(directEdge));
  });

  it('Ubiquitous method name exceeding the cap is dropped, not guessed', async () => {
    const classes = Array.from({ length: CHA_FANOUT_CAP + 1 }, (_, i) =>
      `class H${i} { handle() { return ${i}; } }`).join('\n');
    const b = await build(`
      ${classes}
      function dispatch(x) { return x.handle(); }
    `);
    // > cap name-only candidates → the whole call site is dropped.
    expect(b.edges.some(e => e.callerId === fnId(b, 'dispatch') && e.synthesizedBy === 'cha-name-only')).toBe(false);
  });

  it('Unresolvable method emits nothing', async () => {
    const b = await build(`
      class Shape { area() { return 0; } }
      function f(x) { return x.frobnicate(); }
    `);
    expect(b.edges.some(e => e.callerId === fnId(b, 'f') && e.synthesizedBy?.startsWith('cha-'))).toBe(false);
  });

  it('declared-type dispatch resolves a cross-directory same-name base via the caller import', async () => {
    // Two `Shape` hierarchies in different directories. The caller takes a `Shape` it
    // imports from its OWN dir, so polymorphic `s.area()` must dispatch only into THAT
    // Shape's subtree (a/Circle) — not the same-named decoy hierarchy in b/ (b/Square).
    // Without import disambiguation the declared-type path unioned every same-named type's
    // subtree under the precise `cha-declared-type` label (the NestJS dogfood finding:
    // false-positive precise edges to wrong-directory same-named classes).
    const b = await new CallGraphBuilder().build([
      { path: 'a/shape.ts', content: `export class Shape { area() { return 0; } }`, language: 'TypeScript' },
      { path: 'a/circle.ts', content: `import { Shape } from './shape'; export class Circle extends Shape { area() { return 1; } }`, language: 'TypeScript' },
      { path: 'b/shape.ts', content: `export class Shape { area() { return 9; } }`, language: 'TypeScript' },
      { path: 'b/square.ts', content: `import { Shape } from './shape'; export class Square extends Shape { area() { return 4; } }`, language: 'TypeScript' },
      { path: 'a/compute.ts', content: `import { Shape } from './shape'; export function compute(s: Shape) { return s.area(); }`, language: 'TypeScript' },
    ]);
    const compute = 'a/compute.ts::compute';
    // Precise dispatch into the imported Shape's subtree.
    const toCircle = b.edges.find(e => e.callerId === compute && e.calleeId === 'a/circle.ts::Circle.area');
    expect(toCircle?.synthesizedBy).toBe('cha-declared-type');
    // No precise edge leaks into the wrong-directory same-named hierarchy.
    expect(b.edges.some(e => e.callerId === compute && e.calleeId === 'b/square.ts::Square.area')).toBe(false);
    expect(b.edges.some(e => e.callerId === compute && e.calleeId === 'b/shape.ts::Shape.area')).toBe(false);
  });

  it('Direct edges are unchanged by CHA synthesis (additive only)', async () => {
    const b = await build(`
      class Shape { area() { return 0; } }
      class Circle extends Shape { area() { return 1; } }
      function helper() { return 7; }
      function compute(shape: Shape) { helper(); return shape.area(); }
    `);
    // The direct call compute → helper keeps its directly-resolved confidence.
    const direct = edge(b, fnId(b, 'compute'), fnId(b, 'helper'));
    expect(direct).toBeDefined();
    expect(direct!.confidence).not.toBe('synthesized');
    // Every CHA edge is confidence 'synthesized' — nothing direct was rewritten.
    for (const e of b.edges.filter(x => x.synthesizedBy?.startsWith('cha-') || x.synthesizedBy === 'override')) {
      expect(e.confidence).toBe('synthesized');
    }
  });
});

describe('CHA — cross-file same-name class resolution', () => {
  // Regression for the dogfood finding (python-patterns observer.Subject vs proxy.Subject):
  // a child whose base name also names an UNRELATED class in another file must resolve
  // its base to the same-file declaration, not a global first-match — else a false
  // override edge links two semantically unrelated classes.
  it('resolves a base class to the same-file declaration, not a same-named class elsewhere', async () => {
    const b = await new CallGraphBuilder().build([
      // File A: an unrelated `Subject` that DOES declare init().
      { path: 'a.ts', content: `export class Subject { init() { return 1; } }`, language: 'TypeScript' },
      // File B: its own `Subject` (with a different method, so it is a ClassNode), plus a
      // Proxy extending the LOCAL Subject — mirrors python-patterns observer/proxy Subject.
      { path: 'b.ts', content: `class Subject { work() { return 0; } } class Proxy extends Subject { init() { return 2; } }`, language: 'TypeScript' },
    ]);
    const aInit = [...b.nodes.values()].find(n => n.id === 'a.ts::Subject.init')?.id;
    const proxyInit = [...b.nodes.values()].find(n => n.id === 'b.ts::Proxy.init')?.id;
    // No override edge from the unrelated a.ts::Subject.init to b.ts::Proxy.init.
    expect(b.edges.some(e => e.synthesizedBy === 'override' && e.callerId === aInit && e.calleeId === proxyInit)).toBe(false);
  });
});

describe('CHA — ambiguous cross-file base names', () => {
  // Regression for the PHP dogfood finding (two unrelated `Logger` interfaces in
  // different namespaces). When a child's base name is NOT declared in the child's
  // file AND is ambiguous (several classes share it across files), resolution must
  // skip — guessing a global first-match both fabricates a false override edge and
  // steals the real one. Bias: false-negatives over false-positives.
  it('recovers a cross-file override edge via same-directory resolution (correct twin)', async () => {
    // Two same-named `Logger` interfaces in different directories, each with an
    // implementer in a SEPARATE file within its own directory. Same-directory
    // resolution must wire each implementer to ITS directory's Logger — recovering
    // the real edge that the bare-name ambiguity-skip would have dropped, without
    // cross-wiring to the other directory's twin.
    const b = await new CallGraphBuilder().build([
      { path: 'a/Logger.ts', content: `export class Logger { log() { return 1; } }`, language: 'TypeScript' },
      { path: 'a/FileLogger.ts', content: `import { Logger } from './Logger'; export class FileLogger extends Logger { log() { return 2; } }`, language: 'TypeScript' },
      { path: 'b/Logger.ts', content: `export class Logger { log() { return 9; } }`, language: 'TypeScript' },
    ]);
    const aLog = 'a/Logger.ts::Logger.log';
    const bLog = 'b/Logger.ts::Logger.log';
    const fileLog = 'a/FileLogger.ts::FileLogger.log';
    expect(b.edges.some(e => e.synthesizedBy === 'override' && e.callerId === aLog && e.calleeId === fileLog)).toBe(true);
    expect(b.edges.some(e => e.synthesizedBy === 'override' && e.callerId === bLog && e.calleeId === fileLog)).toBe(false);
  });

  it('resolves an ambiguous base via the child\'s import, not a global guess', async () => {
    // The child imports `Logger` from './a', so its base is unambiguous DESPITE the name
    // also existing in b.ts: the import is decisive evidence. Resolution wires MyLogger to
    // a.ts::Logger only — never b.ts::Logger.
    const b = await new CallGraphBuilder().build([
      { path: 'a.ts', content: `export class Logger { log() { return 1; } }`, language: 'TypeScript' },
      { path: 'b.ts', content: `export class Logger { log() { return 2; } }`, language: 'TypeScript' },
      { path: 'c.ts', content: `import { Logger } from './a'; class MyLogger extends Logger { log() { return 3; } }`, language: 'TypeScript' },
    ]);
    const myLog = 'c.ts::MyLogger.log';
    expect(b.edges.some(e => e.synthesizedBy === 'override' && e.callerId === 'a.ts::Logger.log' && e.calleeId === myLog)).toBe(true);
    expect(b.edges.some(e => e.synthesizedBy === 'override' && e.callerId === 'b.ts::Logger.log' && e.calleeId === myLog)).toBe(false);
  });

  it('still skips an ambiguous cross-file base when NO import disambiguates it', async () => {
    // Same shape, but the child does NOT import the name (e.g. a global/ambient base). With
    // no decisive evidence and the name ambiguous across directories, resolution skips
    // rather than guess a first-match — false-negatives over false-positives.
    const b = await new CallGraphBuilder().build([
      { path: 'a.ts', content: `export class Logger { log() { return 1; } }`, language: 'TypeScript' },
      { path: 'b.ts', content: `export class Logger { log() { return 2; } }`, language: 'TypeScript' },
      { path: 'c.ts', content: `class MyLogger extends Logger { log() { return 3; } }`, language: 'TypeScript' },
    ]);
    const myLog = 'c.ts::MyLogger.log';
    expect(b.edges.some(e => e.synthesizedBy === 'override' && e.calleeId === myLog)).toBe(false);
  });

  it('an imported cross-directory base outranks a same-named class in the child\'s own dir', async () => {
    // Regression for the dogfood finding: `widgets/sphere.ts` imports its base `Shape` from
    // `../shapes/base`, but a DIFFERENT `Shape` is declared in its own `widgets/` directory.
    // With import-based resolution dead, the same-directory layer wired Sphere to the LOCAL
    // decoy (a false `extends` edge) and dropped the real `Shape.area -> Sphere.area`
    // override. The import must win: Sphere resolves to shapes/base::Shape.
    const b = await new CallGraphBuilder().build([
      { path: 'shapes/base.ts', content: `export class Shape { area() { return 0; } }`, language: 'TypeScript' },
      { path: 'widgets/base.ts', content: `export class Shape { volume() { return 0; } }`, language: 'TypeScript' },
      { path: 'widgets/sphere.ts', content: `import { Shape } from '../shapes/base'; export class Sphere extends Shape { area() { return 12.56; } }`, language: 'TypeScript' },
    ]);
    const sphereArea = 'widgets/sphere.ts::Sphere.area';
    // The real override edge is recovered…
    expect(b.edges.some(e => e.synthesizedBy === 'override' && e.callerId === 'shapes/base.ts::Shape.area' && e.calleeId === sphereArea)).toBe(true);
    // …and no false edge ties Sphere to the local decoy Shape (which only has volume()).
    expect(b.inheritanceEdges.some(e => e.parentId === 'widgets/base.ts::Shape' && e.childId === 'widgets/sphere.ts::Sphere')).toBe(false);
    expect(b.inheritanceEdges.some(e => e.parentId === 'shapes/base.ts::Shape' && e.childId === 'widgets/sphere.ts::Sphere')).toBe(true);
  });
});

describe('CHA — C# hierarchy (override edges)', () => {
  const buildCs = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'Lights.cs', content, language: 'C#' }]);

  it('synthesizes override edges across a C# interface implementation', async () => {
    const b = await buildCs(`
      interface ILight { void SwitchOn(); }
      class LedLight : ILight { public void SwitchOn() {} }
      class HalogenLight : ILight { public void SwitchOn() {} }
    `);
    const iface = methodId(b, 'ILight', 'SwitchOn');
    const led = methodId(b, 'LedLight', 'SwitchOn');
    const halogen = methodId(b, 'HalogenLight', 'SwitchOn');
    const ledEdge = edge(b, iface, led);
    expect(ledEdge, 'ILight.SwitchOn -> LedLight.SwitchOn').toBeDefined();
    expect(ledEdge!.synthesizedBy).toBe('override');
    expect(edge(b, iface, halogen), 'ILight.SwitchOn -> HalogenLight.SwitchOn').toBeDefined();
  });

  it('synthesizes override edges across a C# base class', async () => {
    const b = await buildCs(`
      abstract class Stream { public virtual void Write() {} }
      sealed class TransferStream : Stream { public override void Write() {} }
    `);
    const e = edge(b, methodId(b, 'Stream', 'Write'), methodId(b, 'TransferStream', 'Write'));
    expect(e, 'Stream.Write -> TransferStream.Write').toBeDefined();
    expect(e!.synthesizedBy).toBe('override');
  });
});

describe('CHA — multi-language hierarchy (override edges)', () => {
  // Each language previously had NO branch in extractClassRelationships, so CHA was
  // inert for it (zero inheritance edges). These lock the hierarchy extraction that
  // makes override edges form. Swift/Scala use a concrete base because protocol/trait
  // abstract methods (no body) are not extracted as nodes (documented boundary);
  // Kotlin/PHP interface methods ARE extracted, so the interface idiom works.
  const overrideEdgeNames = (b: Built): Set<string> =>
    new Set(b.edges.filter(e => e.synthesizedBy === 'override').map(e => {
      const caller = [...b.nodes.values()].find(n => n.id === e.callerId);
      const callee = [...b.nodes.values()].find(n => n.id === e.calleeId);
      return `${caller?.className}.${caller?.name}->${callee?.className}.${callee?.name}`;
    }));

  it('Kotlin interface implementation', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'S.kt', language: 'Kotlin', content:
      `interface Shape { fun area(): Double }
       class Circle : Shape { override fun area(): Double { return 1.0 } }` }]);
    expect(overrideEdgeNames(b).has('Shape.area->Circle.area')).toBe(true);
  });

  it('PHP interface implementation', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'S.php', language: 'PHP', content:
      `<?php
       interface Shape { public function area(); }
       class Circle implements Shape { public function area() { return 1; } }` }]);
    expect(overrideEdgeNames(b).has('Shape.area->Circle.area')).toBe(true);
  });

  it('PHP class extends', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'A.php', language: 'PHP', content:
      `<?php
       class Animal { public function speak() { return "a"; } }
       class Dog extends Animal { public function speak() { return "woof"; } }` }]);
    expect(overrideEdgeNames(b).has('Animal.speak->Dog.speak')).toBe(true);
  });

  it('Swift concrete base class override', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'S.swift', language: 'Swift', content:
      `class Base { func speak() -> String { return "b" } }
       class Derived: Base { func speak() -> String { return "d" } }` }]);
    expect(overrideEdgeNames(b).has('Base.speak->Derived.speak')).toBe(true);
  });

  it('Scala concrete base class override', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'S.scala', language: 'Scala', content:
      `class Base { def speak(): String = "b" }
       class Derived extends Base { def speak(): String = "d" }` }]);
    expect(overrideEdgeNames(b).has('Base.speak->Derived.speak')).toBe(true);
  });

  it('Go embedding: anonymous + pointer embeds wire; named fields do not', async () => {
    // Regression for the cobra dogfood: a NAMED field `CompletionOptions CompletionOptions`
    // was misread as an embed (phantom edge + polluted parent_classes). Only anonymous
    // fields (`Base`, `*Mixin`) are embeds; `Name string` is a plain field.
    const b = await new CallGraphBuilder().build([{ path: 'm.go', language: 'Go', content:
      `package m
       type Base struct{}
       func (b Base) Speak() string { return "b" }
       type Mixin struct{}
       func (m Mixin) Help() string { return "h" }
       type Derived struct {
         Base
         *Mixin
         Name string
       }
       func (d Derived) Speak() string { return "d" }` }]);
    const derived = b.classes.find(c => c.name === 'Derived');
    expect(derived?.parentClasses).toEqual(['Base', 'Mixin']); // not 'string'
    expect(overrideEdgeNames(b).has('Base.Speak->Derived.Speak')).toBe(true);
  });

  it('Kotlin qualified supertype (Outer.Inner) does not wire to the outer type', async () => {
    // Regression for the kotlinx.coroutines finding: `Job : CoroutineContext.Element`
    // must NOT create a `Job <: CoroutineContext` edge (which wired extension-function
    // receivers as phantom override bases). A class named `Outer` exists with method m;
    // a class extending the nested `Outer.Inner` must not inherit-link to `Outer`.
    const b = await new CallGraphBuilder().build([{ path: 'Q.kt', language: 'Kotlin', content:
      `class Outer { fun m() {} }
       class C : Outer.Inner { fun m() {} }` }]);
    expect(overrideEdgeNames(b).has('Outer.m->C.m')).toBe(false);
  });
});

describe('arityFromSignature', () => {
  it('counts parameters at the top level', () => {
    expect(arityFromSignature('area()')).toBe(0);
    expect(arityFromSignature('def speak(self):')).toBe(1);
    expect(arityFromSignature('add(a: number, b: number): number')).toBe(2);
    expect(arityFromSignature('public void f(Map<K, V> m, int n)')).toBe(2); // generic comma not counted
    expect(arityFromSignature(undefined)).toBeUndefined();
    expect(arityFromSignature('noParens')).toBeUndefined();
  });

  it('skips the Go receiver group and counts the actual method parameters', () => {
    expect(arityFromSignature('func (s *Server) handle(w http.ResponseWriter, r *http.Request)')).toBe(2);
    expect(arityFromSignature('func (s Server) ready() bool')).toBe(0);
    expect(arityFromSignature('func /* receiver */ (s Server) ready() bool')).toBe(0);
    expect(arityFromSignature('func /* one */ /* two */ (s Server) ready() bool')).toBe(0);
    expect(arityFromSignature('func(a int)')).toBe(1);
    expect(arityFromSignature('func()')).toBe(0);
  });

  it('filters arity-mismatched Go embed overrides while keeping matching ones', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'server.go', language: 'Go', content: `package server
      type Base struct{}
      func (b Base) Handle(w int, r int) {}
      func (b Base) Ready() bool { return true }
      type Derived struct { Base }
      func (d Derived) Handle(w int) {}
      func (d Derived) Ready() bool { return false }
    ` }]);
    const overrides = new Set(b.edges.filter(e => e.synthesizedBy === 'override').map(e => `${e.callerId}->${e.calleeId}`));

    expect(overrides.has('server.go::Base.Handle->server.go::Derived.Handle')).toBe(false);
    expect(overrides.has('server.go::Base.Ready->server.go::Derived.Ready')).toBe(true);
  });
});
