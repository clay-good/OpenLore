import { describe, it, expect } from 'vitest';
import { extractFileDynamicBoundary } from './call-graph.js';
import {
  DYNAMIC_BOUNDARY_KINDS,
  DYNAMIC_BOUNDARY_KIND_LABEL,
  DYNAMIC_BOUNDARY_REFUSALS,
  DYNAMIC_BOUNDARY_REFUSAL_LABEL,
  DYNAMIC_BOUNDARY_LANG_SPECS,
  DYNAMIC_BOUNDARY_LANGUAGES,
  DYNAMIC_BOUNDARY_EVIDENCE_MAX,
  DYNAMIC_BOUNDARY_SITE_CAP,
  DYNAMIC_BOUNDARY_DENSITY_CEILING_PER_KLOC,
  supportsDynamicBoundary,
  triggersFor,
  hasImportEvidence,
  toEvidence,
  finalizeDynamicBoundarySites,
  buildFileDynamicBoundary,
  buildDynamicBoundaryReport,
  type DynamicBoundaryKind,
  type DynamicBoundarySite,
  type FileDynamicBoundary,
} from './dynamic-boundary.js';

/** Extract one in-memory file's sites; `[]` when the file records none. */
async function sitesOf(
  path: string,
  language: string,
  content: string,
): Promise<DynamicBoundarySite[]> {
  const rec = await extractFileDynamicBoundary({ path, content, language });
  return rec?.sites ?? [];
}

const kindsOf = (sites: DynamicBoundarySite[]): DynamicBoundaryKind[] =>
  [...new Set(sites.map(s => s.kind))].sort();

describe('the vocabulary is closed and source-declared', () => {
  it('every declared kind has a label and every label a kind', () => {
    expect(Object.keys(DYNAMIC_BOUNDARY_KIND_LABEL).sort())
      .toEqual([...DYNAMIC_BOUNDARY_KINDS].sort());
    expect(Object.keys(DYNAMIC_BOUNDARY_REFUSAL_LABEL).sort())
      .toEqual([...DYNAMIC_BOUNDARY_REFUSALS].sort());
  });

  it('no matcher table declares a kind outside the vocabulary', () => {
    const declared = new Set<string>(DYNAMIC_BOUNDARY_KINDS);
    for (const [language, spec] of Object.entries(DYNAMIC_BOUNDARY_LANG_SPECS)) {
      const emitted = [
        ...Object.values(spec.calleeKinds),
        ...Object.values(spec.dottedKinds ?? {}),
        ...Object.values(spec.constructorKinds ?? {}),
        ...(spec.gatedMethods ?? []).map(g => g.kind),
      ];
      for (const k of emitted) {
        expect(declared, `${language} emits an undeclared kind "${k}"`).toContain(k);
      }
    }
  });

  it('the supported-language list is derived from the table, not hand-listed', () => {
    expect([...DYNAMIC_BOUNDARY_LANGUAGES])
      .toEqual(Object.keys(DYNAMIC_BOUNDARY_LANG_SPECS).sort());
    expect(supportsDynamicBoundary('Python')).toBe(true);
    // Honesty: an unmatched language reads as UNSUPPORTED, never as "clean".
    expect(supportsDynamicBoundary('Rust')).toBe(false);
    expect(supportsDynamicBoundary('Klingon')).toBe(false);
  });

  it('every rule is reachable through the source pre-scan', () => {
    // The pre-scan is an optimisation that can silently DISABLE a rule: a construct whose token is
    // absent from the trigger set never fires, and the matcher reports a clean file. Assert the
    // triggers cover every rule the table declares.
    for (const [language, spec] of Object.entries(DYNAMIC_BOUNDARY_LANG_SPECS)) {
      const triggers = triggersFor(spec);
      // Sound direction only: a rule is reachable when some trigger is a SUBSTRING of its name, so
      // any source containing the construct necessarily contains the trigger. The reverse would pass
      // a trigger the source need not carry.
      // Sound direction only: a rule is reachable when some trigger is a SUBSTRING of its name (so
      // any source containing the construct necessarily contains the trigger), or is that name with
      // the call paren appended, which is likewise implied by the construct.
      const covers = (token: string): boolean =>
        triggers.some(t => token.includes(t) || t === `${token}(`);
      for (const name of Object.keys(spec.calleeKinds)) {
        expect(covers(name), `${language}: no trigger reaches callee rule "${name}"`).toBe(true);
      }
      for (const name of Object.keys(spec.dottedKinds ?? {})) {
        expect(covers(name), `${language}: no trigger reaches dotted rule "${name}"`).toBe(true);
      }
      for (const name of Object.keys(spec.constructorKinds ?? {})) {
        expect(covers(name), `${language}: no trigger reaches constructor rule "${name}"`).toBe(true);
      }
      // Gated and DI rules key on their import evidence, which `triggersFor` folds in wholesale.
      for (const gate of spec.gatedMethods ?? []) {
        for (const req of gate.requires) expect(triggers).toContain(req);
      }
      for (const pkg of spec.diPackages ?? []) expect(triggers).toContain(pkg);
      if (spec.computedCalleeTypes?.length) {
        expect(triggers.length, `${language}: computed-member rule with no triggers`).toBeGreaterThan(0);
      }
    }
  });

  it('every declared container-resolution rule is grounded in a framework, not a bare name', () => {
    for (const [language, spec] of Object.entries(DYNAMIC_BOUNDARY_LANG_SPECS)) {
      if (spec.diMethods?.length) {
        expect(spec.diPackages?.length, `${language} names DI methods with no DI packages`)
          .toBeGreaterThan(0);
      }
      for (const gate of spec.gatedMethods ?? []) {
        expect(gate.requires.length, `${language} gate for ${gate.methods} has no import evidence`)
          .toBeGreaterThan(0);
      }
    }
  });
});

describe('per-language matching', () => {
  it('Python: getattr, eval, importlib, setattr and a computed subscript call', async () => {
    const sites = await sitesOf('a.py', 'Python', `
import importlib

def dispatch(handler, action, name):
    getattr(handler, action)()
    eval("1 + 1")
    importlib.import_module(name)
    setattr(handler, name, None)
    TABLE[action]()
`);
    expect(kindsOf(sites)).toEqual([
      'code-eval', 'computed-member', 'dynamic-import', 'metaprogrammed-definition',
      'reflective-invoke',
    ]);
    for (const s of sites) expect(s.symbolId).toContain('dispatch');
  });

  it('Ruby: send, instance_eval and define_method on any receiver', async () => {
    const sites = await sitesOf('a.rb', 'Ruby', `
class Router
  def route(target, action)
    target.send(action)
    instance_eval("puts 1")
    self.class.define_method(:generated) { 1 }
  end
end
`);
    expect(kindsOf(sites)).toEqual(['code-eval', 'metaprogrammed-definition', 'reflective-invoke']);
  });

  it('TypeScript: eval, new Function, Proxy, Reflect and a computed member call', async () => {
    const sites = await sitesOf('a.ts', 'TypeScript', `
export function run(handlers: Record<string, () => void>, name: string) {
  eval('1');
  new Function('return 1');
  new Proxy({}, {});
  Reflect.get(handlers, name);
  handlers[name]();
}
`);
    expect(kindsOf(sites)).toEqual([
      'code-eval', 'computed-member', 'metaprogrammed-definition', 'reflective-invoke',
    ]);
  });

  it('JavaScript shares the TypeScript rules', async () => {
    const sites = await sitesOf('a.js', 'JavaScript', `
function run(handlers, name) {
  handlers[name]();
}
`);
    expect(kindsOf(sites)).toEqual(['computed-member']);
  });

  it('Go: reflect.Value.Call only when reflect is imported', async () => {
    const withReflect = await sitesOf('a.go', 'Go', `
package main

import "reflect"

func run(v reflect.Value) {
	v.MethodByName("Handle").Call(nil)
}
`);
    expect(kindsOf(withReflect)).toEqual(['reflective-invoke']);

    const without = await sitesOf('b.go', 'Go', `
package main

type queue struct{}

func (q queue) Call(x int) int { return x }

func run(q queue) int { return q.Call(1) }
`);
    expect(without).toEqual([]);
  });
});

describe('grounding: a bare callee name is never enough', () => {
  it('an ordinary map lookup is not a container resolution', async () => {
    const sites = await sitesOf('a.ts', 'TypeScript', `
export class Cache {
  private cache = new Map<string, number>();
  read(key: string) {
    const hit = this.cache.get(key);
    return Promise.resolve(hit);
  }
}
`);
    expect(sites).toEqual([]);
  });

  it('the same .get() IS a container resolution once a DI package is imported', async () => {
    const sites = await sitesOf('a.ts', 'TypeScript', `
import { Container } from 'inversify';

const container = new Container();

export function boot() {
  return container.get('UserService');
}
`);
    expect(kindsOf(sites)).toEqual(['container-resolution']);
  });

  it('a method merely named eval on another object is not JavaScript eval', async () => {
    const sites = await sitesOf('a.ts', 'TypeScript', `
export function run(engine: { eval(s: string): number }) {
  return engine.eval('1 + 1');
}
`);
    expect(sites).toEqual([]);
  });

  it('a statically-indexed member call is not a computed member', async () => {
    const sites = await sitesOf('a.ts', 'TypeScript', `
export function run(handlers: Array<() => void>, table: Record<string, () => void>) {
  handlers[0]();
  table['known']();
}
`);
    expect(sites).toEqual([]);
  });
});

describe('attribution', () => {
  it('a construct outside any function is marked module-level, never silently unattributed', async () => {
    const sites = await sitesOf('a.py', 'Python', `
import importlib
mod = importlib.import_module(NAME)
`);
    expect(sites).toHaveLength(1);
    expect(sites[0].moduleLevel).toBe(true);
    expect(sites[0].symbolId).toBeUndefined();
  });

  it('a site carries the line of its construct', async () => {
    const sites = await sitesOf('a.py', 'Python', `def f(o, a):
    return getattr(o, a)()
`);
    expect(sites).toHaveLength(1);
    expect(sites[0].line).toBe(2);
  });
});

describe('the partition is decided by resolution outcome', () => {
  const candidate = (over: Partial<Parameters<typeof finalizeDynamicBoundarySites>[0][0]> = {}) => ({
    kind: 'reflective-invoke' as const,
    line: 3,
    startIndex: 10,
    evidence: 'getattr(o, "process")()',
    symbolId: 'a.py::caller',
    ...over,
  });

  it('a candidate the resolver bound to an internal symbol is retracted', () => {
    const sites = finalizeDynamicBoundarySites(
      [candidate({ literalTarget: 'process' })],
      { resolvedToEdge: () => true, countSymbolsNamed: () => 1 },
    );
    expect(sites).toEqual([]);
  });

  it('a literal that resolves to nothing is still a boundary, with its refusal reason', () => {
    const sites = finalizeDynamicBoundarySites(
      [candidate({ literalTarget: 'process' })],
      { resolvedToEdge: () => false, countSymbolsNamed: () => 0 },
    );
    expect(sites).toHaveLength(1);
    expect(sites[0].refusal).toBe('unresolved-external');
  });

  it('a literal that resolves ambiguously is a boundary, not a guess', () => {
    const sites = finalizeDynamicBoundarySites(
      [candidate({ literalTarget: 'run' })],
      { resolvedToEdge: () => false, countSymbolsNamed: () => 4 },
    );
    expect(sites[0].refusal).toBe('ambiguous-target');
  });

  it('a construct with no static selector refuses for that reason', () => {
    const sites = finalizeDynamicBoundarySites(
      [candidate()],
      { resolvedToEdge: () => false, countSymbolsNamed: () => 0 },
    );
    expect(sites[0].refusal).toBe('no-static-target');
  });

  it('no matched construct yields neither an edge nor a site', () => {
    // The exhaustive statement of the partition: over every refusal path, a candidate that is not
    // retracted MUST appear as a site. There is no third outcome.
    for (const counts of [0, 1, 5]) {
      for (const target of [undefined, 'process']) {
        const sites = finalizeDynamicBoundarySites(
          [candidate({ literalTarget: target })],
          { resolvedToEdge: () => false, countSymbolsNamed: () => counts },
        );
        expect(sites).toHaveLength(1);
        expect(DYNAMIC_BOUNDARY_REFUSALS).toContain(sites[0].refusal);
      }
    }
  });

  it('Ruby send with a literal symbol is a site today — the resolver emits no edge for it', async () => {
    // The sibling change `resolve-literal-reflective-dispatch` is what turns this into an edge. Until
    // it lands the graph really does carry nothing for this call, so the honest answer is a site.
    const sites = await sitesOf('a.rb', 'Ruby', `
class Router
  def process; end
  def route(target)
    target.send(:process)
  end
end
`);
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('reflective-invoke');
    // `process` IS defined here, so the honest reason is "resolves, but no edge was bound" — never
    // "resolves to no symbol in this index", which would be a false statement about a symbol that
    // is plainly right there.
    expect(sites[0].refusal).toBe('resolvable-but-unbound');
  });
});

describe('evidence is safe before it is persisted', () => {
  const ESC = String.fromCharCode(27);

  it('redacts a credential and strips terminal control sequences', () => {
    const key = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const { evidence } = toEvidence(`eval("${key}")${ESC}[2J`);
    expect(evidence).not.toContain(key);
    expect(evidence).not.toContain(ESC);
    expect(evidence).toContain('eval(');
  });

  it('truncates over-long evidence and marks it', () => {
    const { evidence, truncated } = toEvidence('eval("' + 'x'.repeat(500) + '")');
    expect(truncated).toBe(true);
    expect(evidence.length).toBe(DYNAMIC_BOUNDARY_EVIDENCE_MAX + 1); // + the ellipsis
  });

  it('a credential in an eval string never reaches an extracted site', async () => {
    const sites = await sitesOf('a.py', 'Python', `
def f():
    eval("token = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'")
`);
    expect(sites).toHaveLength(1);
    expect(JSON.stringify(sites)).not.toContain('sk-ant-api03-BBBB');
  });
});

describe('bounding and rollup', () => {
  const site = (line: number, kind: DynamicBoundaryKind = 'code-eval'): DynamicBoundarySite => ({
    line, kind, refusal: 'no-static-target', evidence: 'eval(x)', moduleLevel: true,
  });

  it('a file over the site cap keeps the exact count and discloses truncation', () => {
    const many = Array.from({ length: DYNAMIC_BOUNDARY_SITE_CAP + 7 }, (_, i) => site(i + 1));
    const rec = buildFileDynamicBoundary('a.py', 'Python', many)!;
    expect(rec.sites).toHaveLength(DYNAMIC_BOUNDARY_SITE_CAP);
    expect(rec.truncated).toBe(true);
    expect(rec.totalSites).toBe(DYNAMIC_BOUNDARY_SITE_CAP + 7);
  });

  it('a file with no sites produces no record', () => {
    expect(buildFileDynamicBoundary('a.py', 'Python', [])).toBeUndefined();
  });

  it('a clean repository produces no report at all', () => {
    expect(buildDynamicBoundaryReport([])).toBeUndefined();
    expect(buildDynamicBoundaryReport([
      { filePath: 'a.py', language: 'Python', sites: [] },
    ])).toBeUndefined();
  });

  it('the rollup counts the exact total, orders kinds by the vocabulary, and sorts files', () => {
    const records: FileDynamicBoundary[] = [
      { filePath: 'z.py', language: 'Python', sites: [site(1, 'code-eval')] },
      {
        filePath: 'a.rb', language: 'Ruby',
        sites: [site(2, 'reflective-invoke'), site(3, 'code-eval')],
        totalSites: 9, truncated: true,
      },
    ];
    const report = buildDynamicBoundaryReport(records)!;
    expect(report.totalFiles).toBe(2);
    expect(report.totalSites).toBe(10); // 1 + the truncated file's exact 9
    expect(report.byKind.map(k => k.kind)).toEqual(['reflective-invoke', 'code-eval']);
    expect(report.files.map(f => f.filePath)).toEqual(['a.rb', 'z.py']);
    expect(report.byLanguage[0].language).toBe('Ruby'); // 9 sites > 1
  });

  it('the report is byte-identical for the same records in a different order', () => {
    const a: FileDynamicBoundary = { filePath: 'a.py', language: 'Python', sites: [site(1)] };
    const b: FileDynamicBoundary = { filePath: 'b.rb', language: 'Ruby', sites: [site(2)] };
    expect(JSON.stringify(buildDynamicBoundaryReport([a, b])))
      .toBe(JSON.stringify(buildDynamicBoundaryReport([b, a])));
  });
});

describe('the matcher is additive to the graph', () => {
  /**
   * The load-bearing invariant: recording a boundary must never change what the graph SAYS. The
   * A/B is real — the language's spec is removed from the table (which is the only thing that
   * enables the matcher for a language), the same source is extracted again, and the emitted nodes
   * and edges are compared. Anything less would assert the property by inspection.
   */
  async function extractWithAndWithout(path: string, language: string, content: string) {
    const { CallGraphBuilder } = await import('./call-graph.js');
    const build = async () => {
      const g = await new CallGraphBuilder().build([{ path, content, language }]);
      return {
        nodes: [...g.nodes.values()].map(n => `${n.id}|${n.name}|${n.startLine}`).sort(),
        edges: g.edges.map(e => `${e.callerId}|${e.calleeName}|${e.line}|${e.confidence}`).sort(),
        boundary: g.dynamicBoundaryByFile?.get(path),
      };
    };
    const withMatcher = await build();
    const spec = DYNAMIC_BOUNDARY_LANG_SPECS[language];
    delete DYNAMIC_BOUNDARY_LANG_SPECS[language];
    try {
      const without = await build();
      return { withMatcher, without };
    } finally {
      DYNAMIC_BOUNDARY_LANG_SPECS[language] = spec;
    }
  }

  it('every node and edge is identical with the matcher on and off; only the sites differ', async () => {
    const { withMatcher, without } = await extractWithAndWithout('a.py', 'Python', `
import importlib

def dispatch(handler, action, name):
    getattr(handler, action)()
    eval("1 + 1")
    importlib.import_module(name)
    TABLE[action]()
    return handler

def target():
    return 1
`);
    expect(withMatcher.nodes).toEqual(without.nodes);
    expect(withMatcher.edges).toEqual(without.edges);
    expect(withMatcher.boundary?.sites.length).toBeGreaterThan(0);
    expect(without.boundary).toBeUndefined();
  });

  it('a language with no matcher records nothing and is unchanged', async () => {
    const rec = await extractFileDynamicBoundary({
      path: 'a.rs',
      language: 'Rust',
      content: 'fn main() { let x = 1; }',
    });
    expect(rec).toBeUndefined();
  });
});

describe('the density budget', () => {
  it('stays within the declared ceiling on every language fixture', async () => {
    // A matcher over the ceiling is matching an ordinary idiom, not a boundary. Measured per
    // fixture rather than asserted, so a future rule that fires on common code fails here.
    const fixtures: Array<[string, string, string]> = [
      ['a.ts', 'TypeScript', `
export class Repo {
  private cache = new Map<string, number>();
  get(key: string) { return this.cache.get(key); }
  set(key: string, v: number) { this.cache.set(key, v); }
  async load(id: string) { return Promise.resolve(this.get(id)); }
  list() { return [...this.cache.keys()].map(k => this.get(k)).filter(Boolean); }
  clear() { this.cache.clear(); }
  size() { return this.cache.size; }
}
`],
      ['a.py', 'Python', `
class Repo:
    def __init__(self):
        self._cache = {}

    def get(self, key):
        return self._cache.get(key)

    def set(self, key, value):
        self._cache[key] = value

    def load(self, ident):
        return self.get(ident)

    def keys(self):
        return sorted(self._cache.keys())
`],
      ['a.rb', 'Ruby', `
class Repo
  def initialize
    @cache = {}
  end

  def get(key)
    @cache[key]
  end

  def set(key, value)
    @cache[key] = value
  end

  def load(id)
    get(id)
  end
end
`],
      ['a.go', 'Go', `
package repo

type Repo struct{ cache map[string]int }

func (r *Repo) Get(k string) int { return r.cache[k] }
func (r *Repo) Set(k string, v int) { r.cache[k] = v }
func (r *Repo) Load(id string) int { return r.Get(id) }
`],
    ];
    for (const [path, language, content] of fixtures) {
      const rec = await extractFileDynamicBoundary({ path, content, language });
      const kloc = Math.max(content.split('\n').length, 1) / 1000;
      const density = (rec?.sites.length ?? 0) / kloc;
      expect(density, `${language} fires ${rec?.sites.length ?? 0} times on ordinary code`)
        .toBeLessThanOrEqual(DYNAMIC_BOUNDARY_DENSITY_CEILING_PER_KLOC);
    }
  });
});

describe('import evidence, not a substring', () => {
  it('a package named in a comment or a string is not a binding', () => {
    expect(hasImportEvidence("// we support inversify and tsyringe\n", 'inversify', 'js')).toBe(false);
    expect(hasImportEvidence("if (f.includes('inversify')) {}\n", 'inversify', 'js')).toBe(false);
    expect(hasImportEvidence("import { Container } from 'inversify';\n", 'inversify', 'js')).toBe(true);
    expect(hasImportEvidence("const c = require('awilix');\n", 'awilix', 'js')).toBe(true);
    expect(hasImportEvidence("import x from '@nestjs/common/foo';\n", '@nestjs/common', 'js')).toBe(true);
  });

  it('recognises each language its own way', () => {
    expect(hasImportEvidence('import injector\n', 'injector', 'python')).toBe(true);
    expect(hasImportEvidence('# injector is nice\n', 'injector', 'python')).toBe(false);
    expect(hasImportEvidence('import java.lang.reflect.Method;\n', 'java.lang.reflect', 'jvm')).toBe(true);
    expect(hasImportEvidence('// java.lang.reflect is used\n', 'java.lang.reflect', 'jvm')).toBe(false);
    expect(hasImportEvidence('using System.Reflection;\n', 'System.Reflection', 'jvm')).toBe(true);
    expect(hasImportEvidence('import "reflect"\n', '"reflect"', 'go')).toBe(true);
    expect(hasImportEvidence('\t"reflect"\n', '"reflect"', 'go')).toBe(true);
    expect(hasImportEvidence('// uses "reflect" heavily\n', '"reflect"', 'go')).toBe(false);
    expect(hasImportEvidence('use Psr\\Container;\n', 'Psr', 'php')).toBe(true);
  });

  it('a file that merely mentions a DI package records no container resolution', async () => {
    // The exact defect dogfooding found: this repository's own framework-detection code names
    // `inversify` in a string comparison, which a substring gate read as a DI binding and turned
    // every `map.get(k)` in the file into a site.
    const sites = await sitesOf('a.ts', 'TypeScript', `
export function detect(frameworks: string[], cache: Map<string, number>) {
  if (frameworks.some(f => f.toLowerCase().includes('inversify'))) return cache.get('di');
  return cache.get('none');
}
`);
    expect(sites).toEqual([]);
  });

  it('Object.defineProperty is ordinary JavaScript, not a recorded boundary', async () => {
    const sites = await sitesOf('a.ts', 'TypeScript', `
export function stub(target: object) {
  Object.defineProperty(target, 'isTTY', { value: false, configurable: true });
}
`);
    expect(sites).toEqual([]);
  });
});

describe('an import inside a string literal is not a binding', () => {
  it('a file whose fixture text quotes a DI import records no container resolution', async () => {
    // The second dogfooding defect: this module's own test file quotes an `inversify` import inside
    // a template-literal fixture, and a whole-source scan read that as a binding — turning every
    // `map.get(k)` in the test file into a site.
    const sites = await sitesOf('a.ts', 'TypeScript', `
import { readFile } from 'node:fs/promises';

const FIXTURE = \`
import { Container } from 'inversify';
const container = new Container();
\`;

export async function run(cache: Map<string, string>) {
  await readFile('x');
  return cache.get('key') + FIXTURE;
}
`);
    expect(sites).toEqual([]);
  });

  it('a real import in the same file still binds', async () => {
    const sites = await sitesOf('a.ts', 'TypeScript', `
import { Container } from 'inversify';

const container = new Container();

export function boot() {
  return container.get('UserService');
}
`);
    expect(kindsOf(sites)).toEqual(['container-resolution']);
  });

  it('a CommonJS require still binds, through the source fallback', async () => {
    const sites = await sitesOf('a.js', 'JavaScript', `
const { createContainer } = require('awilix');

const container = createContainer();

function boot() {
  return container.resolve('userService');
}
`);
    expect(kindsOf(sites)).toEqual(['container-resolution']);
  });
});

describe('the remaining declared languages match', () => {
  it('PHP: call_user_func, eval, and a variable callee', async () => {
    const sites = await sitesOf('a.php', 'PHP', `<?php
function dispatch($fn, $name) {
    call_user_func($fn);
    eval('$x = 1;');
    $fn();
}
`);
    expect(kindsOf(sites)).toEqual(['code-eval', 'computed-member', 'reflective-invoke']);
  });

  it('Java: Method.invoke and Class.forName, gated on the reflection import', async () => {
    const withImport = await sitesOf('A.java', 'Java', `
import java.lang.reflect.Method;

class Dispatcher {
    void run(Method m, Object target) throws Exception {
        m.invoke(target);
        Class.forName("com.example.Plugin");
    }
}
`);
    expect(kindsOf(withImport)).toEqual(['dynamic-import', 'reflective-invoke']);

    // The same `.invoke(` with no reflection import is an ordinary method call.
    const without = await sitesOf('B.java', 'Java', `
class Task {
    void invoke() {}
    void run(Task t) { t.invoke(); }
}
`);
    expect(without.some(s => s.kind === 'reflective-invoke')).toBe(false);
  });

  it('C#: MethodInfo.Invoke gated on System.Reflection', async () => {
    const sites = await sitesOf('A.cs', 'C#', `
using System.Reflection;

class Dispatcher {
    void Run(MethodInfo m, object target) {
        m.Invoke(target, null);
    }
}
`);
    expect(kindsOf(sites)).toEqual(['reflective-invoke']);

    const without = await sitesOf('B.cs', 'C#', `
class Command {
    void Invoke() {}
    void Run(Command c) { c.Invoke(); }
}
`);
    expect(without).toEqual([]);
  });
});

describe('the refusal reason is never a false statement', () => {
  it('a target defined in the file reports resolvable-but-unbound, not "resolves to no symbol"', async () => {
    const sites = await sitesOf('a.py', 'Python', `
def run():
    return 1

def dispatch(o):
    return getattr(o, "run")()
`);
    expect(sites[0].refusal).toBe('resolvable-but-unbound');
  });

  it('a single-file derivation never claims a repository-wide absence', async () => {
    // `extractFileDynamicBoundary` is the watcher's lane: it sees one file, so it cannot know
    // whether `handle` exists elsewhere. Saying "resolves to no symbol in this index" would be a
    // claim it never checked — and one the full build would not make for the same file.
    const sites = await sitesOf('a.py', 'Python', `
def dispatch(o):
    return getattr(o, "handle")()
`);
    expect(sites[0].refusal).toBe('unresolved-in-file-scope');
  });

  it('the dispatch selector is read positionally, not "the first string anywhere"', async () => {
    // `getattr(o, name, "fallback")` dispatches on a RUNTIME name; the literal is a default value.
    // Reading it as the target would report a dispatch to a symbol this call never reaches.
    const sites = await sitesOf('a.py', 'Python', `
def dispatch(o, name):
    return getattr(o, name, "fallback")()
`);
    expect(sites[0].refusal).toBe('no-static-target');
  });

  it('an eval body is code, not a dispatch target', async () => {
    const sites = await sitesOf('a.py', 'Python', 'def f():\n    eval("a + b")\n');
    expect(sites[0].kind).toBe('code-eval');
    expect(sites[0].refusal).toBe('no-static-target');
  });
});

describe('an ordinary call cannot erase a site', () => {
  it('a resolved call sharing a line and a name with the selector does not retract it', async () => {
    // The retraction key must not be caller+line+name: an edge carries no column, so the ordinary
    // `run()` below would erase the `getattr` and leave NEITHER an edge nor a site — the exact
    // silence this module exists to remove.
    const sites = await sitesOf('a.py', 'Python', `
def run():
    return 1

def dispatch(o):
    x = getattr(o, "run"); run()
    return x
`);
    expect(sites.some(s => s.kind === 'reflective-invoke')).toBe(true);
  });
});

describe('dynamic import', () => {
  it('TypeScript: a non-literal specifier is a boundary, a literal one is not', async () => {
    const dynamic = await sitesOf('a.ts', 'TypeScript', `
export async function load(spec: string) {
  return import(spec);
}
`);
    expect(kindsOf(dynamic)).toEqual(['dynamic-import']);

    const staticImport = await sitesOf('b.ts', 'TypeScript', `
export async function load() {
  return import('./known.js');
}
`);
    expect(staticImport).toEqual([]);
  });

  it('JavaScript: require with a computed specifier is a boundary', async () => {
    const sites = await sitesOf('a.js', 'JavaScript', `
function load(name) {
  return require(name);
}
`);
    expect(kindsOf(sites)).toEqual(['dynamic-import']);
    expect(await sitesOf('b.js', 'JavaScript', "const fs = require('node:fs');\n")).toEqual([]);
  });

  it('Python: __import__ with a computed name is a boundary', async () => {
    const sites = await sitesOf('a.py', 'Python', 'def load(n):\n    return __import__(n)\n');
    expect(kindsOf(sites)).toEqual(['dynamic-import']);
    expect(await sitesOf('b.py', 'Python', 'def load():\n    return __import__("os")\n')).toEqual([]);
  });
});

describe('an over-cap file reports its true scale', () => {
  it('caps the retained sites and discloses the exact match count', async () => {
    const body = Array.from({ length: DYNAMIC_BOUNDARY_SITE_CAP + 12 },
      (_, i) => `    getattr(o, n${i})()`).join('\n');
    const rec = await extractFileDynamicBoundary({
      path: 'a.py',
      language: 'Python',
      content: `def dispatch(o, ${Array.from({ length: DYNAMIC_BOUNDARY_SITE_CAP + 12 }, (_, i) => `n${i}`).join(', ')}):\n${body}\n`,
    });
    expect(rec!.sites).toHaveLength(DYNAMIC_BOUNDARY_SITE_CAP);
    expect(rec!.truncated).toBe(true);
    // The exact figure, not the retained length — a bounded list must never read as the whole set.
    expect(rec!.totalSites).toBe(DYNAMIC_BOUNDARY_SITE_CAP + 12);
  });
});
