/**
 * Literal reflective dispatch (change: resolve-literal-reflective-dispatch), through the real
 * CallGraphBuilder. Every assertion pairs the edge side with the site side, because the contract is
 * a partition: a recognized construct yields an edge or a site, never both and never neither.
 */
import { describe, it, expect } from 'vitest';
import { CallGraphBuilder, EVENT_CHANNEL_FANOUT_CAP, extractFileDynamicBoundary } from './call-graph.js';
import type { CallEdge } from './call-graph.js';
import {
  DYNAMIC_BOUNDARY_LANG_SPECS,
  REFLECTIVE_RESOLUTION_RULE,
  supportsLiteralReflection,
} from './dynamic-boundary.js';
import { languageSupport } from './language-support.js';

type File = { path: string; language: string; content: string };
type Built = Awaited<ReturnType<CallGraphBuilder['build']>>;

const build = (files: File[]): Promise<Built> => new CallGraphBuilder().build(files);

const reflective = (g: Built): CallEdge[] =>
  g.edges.filter(e => e.synthesizedBy === REFLECTIVE_RESOLUTION_RULE);

/** `caller->callee` names of every literal-reflective edge, sorted. */
const reflectivePairs = (g: Built): string[] =>
  reflective(g)
    .map(e => `${g.nodes.get(e.callerId)?.name}->${g.nodes.get(e.calleeId)?.name}`)
    .sort();

const sitesIn = (g: Built, path: string) => g.dynamicBoundaryByFile?.get(path)?.sites ?? [];

describe('literal dispatch tables become edges', () => {
  it('a TypeScript table indexed by a variable key wires every bound function', async () => {
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
function createUser() { return 1; }
function deleteUser() { return 2; }
const HANDLERS = { create: createUser, remove: deleteUser };
export function dispatch(k: string) {
  return HANDLERS[k]();
}
` }]);
    expect(reflectivePairs(g)).toEqual(['dispatch->createUser', 'dispatch->deleteUser']);
    const edge = reflective(g)[0];
    expect(edge.confidence).toBe('synthesized');
    expect(edge.kind).toBe('calls');
    expect(edge.line).toBe(6);
    expect(sitesIn(g, 'a.ts')).toEqual([]);
  });

  it('a literal key selects only its own entry', async () => {
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
function createUser() { return 1; }
function deleteUser() { return 2; }
export const HANDLERS = { create: createUser, "remove": deleteUser } as const;
function dispatch() { return HANDLERS["remove"](); }
` }]);
    expect(reflectivePairs(g)).toEqual(['dispatch->deleteUser']);
    expect(sitesIn(g, 'a.ts')).toEqual([]);
  });

  it('a Python module-level dict table wires its bound functions', async () => {
    const g = await build([{ path: 'a.py', language: 'Python', content: `
def create_user():
    return 1

def delete_user():
    return 2

HANDLERS = {"create": create_user, "delete": delete_user}

def dispatch(action):
    return HANDLERS[action]()
` }]);
    expect(reflectivePairs(g)).toEqual(['dispatch->create_user', 'dispatch->delete_user']);
    expect(sitesIn(g, 'a.py')).toEqual([]);
  });

  it('a table over the fan-out cap emits nothing and is disclosed as over-cap', async () => {
    const n = EVENT_CHANNEL_FANOUT_CAP + 1;
    const fns = Array.from({ length: n }, (_, i) => `function h${i}() { return ${i}; }`).join('\n');
    const entries = Array.from({ length: n }, (_, i) => `k${i}: h${i}`).join(', ');
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
${fns}
const TABLE = { ${entries} };
function dispatch(k: string) { return TABLE[k](); }
` }]);
    expect(reflective(g)).toEqual([]);
    const sites = sitesIn(g, 'a.ts');
    expect(sites).toHaveLength(1);
    expect(sites[0].refusal).toBe('over-cap');
  });

  it('an entry with a homonym elsewhere binds nothing and is disclosed as ambiguous', async () => {
    const g = await build([
      { path: 'a.ts', language: 'TypeScript', content: `
function run() { return 1; }
function stop() { return 2; }
const TABLE = { run, stop };
function dispatch(k: string) { return TABLE[k](); }
` },
      { path: 'b.ts', language: 'TypeScript', content: 'export function run() { return 3; }' },
    ]);
    expect(reflective(g)).toEqual([]);
    expect(sitesIn(g, 'a.ts').map(s => s.refusal)).toEqual(['ambiguous-target']);
  });

  it('a table that can be rebound, shadowed, or mutated is not a table', async () => {
    const cases = [
      // `let` can be reassigned.
      'let TABLE = { a: f };\nfunction dispatch(k: string) { return TABLE[k](); }',
      // A parameter of the same name shadows the module table.
      'const TABLE = { a: f };\nfunction dispatch(TABLE: any, k: string) { return TABLE[k](); }',
      // An assignment extends it at runtime.
      'const TABLE = { a: f };\nTABLE.b = g;\nfunction dispatch(k: string) { return TABLE[k](); }',
      // A call extends it at runtime.
      'const TABLE = { a: f };\nObject.assign(TABLE, { b: g });\nfunction dispatch(k: string) { return TABLE[k](); }',
    ];
    for (const body of cases) {
      const g = await build([{
        path: 'a.ts', language: 'TypeScript',
        content: `function f() { return 1; }\nfunction g() { return 2; }\n${body}\n`,
      }]);
      expect(reflective(g), body).toEqual([]);
      expect(sitesIn(g, 'a.ts').map(s => s.refusal), body).toEqual(['no-static-target']);
    }
  });
});

describe('a literal member on a self-typed receiver becomes an edge', () => {
  it('TypeScript this["m"]() binds within the enclosing class', async () => {
    const g = await build([
      { path: 'a.ts', language: 'TypeScript', content: `
export class Job {
  run() { return 1; }
  start() { return this["run"](); }
}
` },
      { path: 'b.ts', language: 'TypeScript', content: 'export function run() { return 2; }' },
    ]);
    expect(reflectivePairs(g)).toEqual(['start->run']);
    expect(g.nodes.get(reflective(g)[0].calleeId)?.filePath).toBe('a.ts');
    expect(sitesIn(g, 'a.ts')).toEqual([]);
  });

  it('Python getattr(self, "m")() binds within the class even when the name is common', async () => {
    const g = await build([
      { path: 'a.py', language: 'Python', content: `
class Job:
    def run(self):
        return 1

    def start(self):
        return getattr(self, "run")()
` },
      { path: 'b.py', language: 'Python', content: 'def run():\n    return 2\n' },
      { path: 'c.py', language: 'Python', content: 'def run():\n    return 3\n' },
    ]);
    expect(reflectivePairs(g)).toEqual(['start->run']);
    expect(sitesIn(g, 'a.py')).toEqual([]);
  });

  it('Ruby send(:m) binds on an implicit or self receiver, and not on another object', async () => {
    const g = await build([{ path: 'a.rb', language: 'Ruby', content: `
class Router
  def process
    1
  end

  def route
    send(:process)
  end

  def forward(target)
    target.send(:process)
  end
end
` }]);
    expect(reflectivePairs(g)).toEqual(['route->process']);
    const sites = sitesIn(g, 'a.rb');
    expect(sites).toHaveLength(1);
    expect(sites[0].line).toBe(12);
    expect(sites[0].refusal).toBe('resolvable-but-unbound');
  });

  it('a subclass override makes the target polymorphic, so it is refused', async () => {
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
export class Base {
  run() { return 1; }
  start() { return this["run"](); }
}
export class Child extends Base {
  run() { return 2; }
}
` }]);
    expect(reflective(g)).toEqual([]);
    expect(sitesIn(g, 'a.ts').map(s => s.refusal)).toEqual(['ambiguous-target']);
  });

  it('an inherited method binds to the ancestor when every base is resolved', async () => {
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
export class Base {
  run() { return 1; }
}
export class Child extends Base {
  start() { return this["run"](); }
}
` }]);
    expect(reflectivePairs(g)).toEqual(['start->run']);
  });
});

describe('strict uniqueness, and a call must be a call', () => {
  it('a same-file homonym does not make an ambiguous name unique on an untyped receiver', async () => {
    const g = await build([
      { path: 'a.py', language: 'Python', content: 'def run():\n    return 0\n\ndef dispatch(o):\n    return getattr(o, "run")()\n' },
      { path: 'b.py', language: 'Python', content: 'def run():\n    return 1\n' },
      { path: 'c.py', language: 'Python', content: 'def run():\n    return 2\n' },
      { path: 'd.py', language: 'Python', content: 'def run():\n    return 3\n' },
    ]);
    expect(reflective(g)).toEqual([]);
    expect(sitesIn(g, 'a.py').map(s => s.refusal)).toEqual(['ambiguous-target']);
  });

  it('obtaining a method reference is not a call', async () => {
    const g = await build([
      { path: 'a.rb', language: 'Ruby', content: 'class A\n  def refresh\n    1\n  end\n\n  def grab\n    m = method(:refresh)\n    m\n  end\nend\n' },
      { path: 'b.py', language: 'Python', content: 'class B:\n    def run(self):\n        return 1\n\n    def grab(self):\n        return getattr(self, "run")\n' },
    ]);
    expect(reflective(g)).toEqual([]);
    expect(sitesIn(g, 'b.py')).toEqual([]);
  });

  it('a literal naming no internal target is still disclosed', async () => {
    const g = await build([{ path: 'a.py', language: 'Python', content: 'import requests\n\ndef fetch():\n    return getattr(requests, "get")()\n' }]);
    expect(reflective(g)).toEqual([]);
    const sites = sitesIn(g, 'a.py');
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe('reflective-invoke');
    expect(sites[0].refusal).toBe('unresolved-external');
  });

  it('a concatenated target is never reconstructed', async () => {
    const g = await build([{ path: 'a.py', language: 'Python', content: 'class A:\n    def get_x(self):\n        return 1\n\n    def f(self, name):\n        return getattr(self, "get_" + name)()\n' }]);
    expect(reflective(g)).toEqual([]);
    expect(sitesIn(g, 'a.py').map(s => s.refusal)).toEqual(['no-static-target']);
  });
});

describe('the partition stays total and keyed on the construct', () => {
  it('one bound construct does not retract a second construct in the same caller', async () => {
    const g = await build([
      { path: 'a.py', language: 'Python', content: `
class Job:
    def run(self):
        return 1

    def start(self, other):
        getattr(self, "run")()
        return getattr(other, "run")()
` },
      { path: 'b.py', language: 'Python', content: 'def run():\n    return 2\n' },
    ]);
    expect(reflectivePairs(g)).toEqual(['start->run']);
    const sites = sitesIn(g, 'a.py');
    expect(sites).toHaveLength(1);
    expect(sites[0].line).toBe(8);
    expect(sites[0].refusal).toBe('ambiguous-target');
  });

  it('every recognized construct yields exactly one of edge or site', async () => {
    const content = `
class Job:
    def run(self):
        return 1

    def start(self, other, name):
        getattr(self, "run")()
        getattr(other, "run")()
        getattr(self, name)()
        getattr(self, "missing")()
        return HANDLERS[name]()

def make():
    return 1

HANDLERS = {"make": make}
`;
    const g = await build([{ path: 'a.py', language: 'Python', content }]);
    const edgeLines = new Set(reflective(g).map(e => e.line ?? 0));
    const siteLines = new Set(sitesIn(g, 'a.py').map(s => s.line));
    // Lines 7–11 carry the five constructs.
    for (const line of [7, 8, 9, 10, 11]) {
      expect(edgeLines.has(line) !== siteLines.has(line), `line ${line}`).toBe(true);
    }
    expect([...edgeLines].sort((a, b) => a - b)).toEqual([7, 11]);
  });

  it('one dispatch is not counted twice when a direct call already wires the pair', async () => {
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
export class Job {
  run() { return 1; }
  start() { this.run(); return this["run"](); }
}
` }]);
    const start = [...g.nodes.values()].find(n => n.name === 'start')!.id;
    const run = [...g.nodes.values()].find(n => n.name === 'run')!.id;
    expect(g.edges.filter(e => e.callerId === start && e.calleeId === run)).toHaveLength(1);
    // The construct bound (its pair exists), so it is not also a site.
    expect(sitesIn(g, 'a.ts')).toEqual([]);
  });

  it('a single-file derivation reports a table as file-scoped, never as runtime-computed', async () => {
    const rec = await extractFileDynamicBoundary({
      path: 'a.ts', language: 'TypeScript',
      content: 'function f() { return 1; }\nconst T = { a: f };\nfunction d(k: string) { return T[k](); }\n',
    });
    expect(rec?.sites.map(s => s.refusal)).toEqual(['unresolved-in-file-scope']);
  });
});

describe('additive, deterministic, and registered', () => {
  const FIXTURE: File[] = [
    { path: 'a.ts', language: 'TypeScript', content: `
function createUser() { return 1; }
const HANDLERS = { create: createUser };
export class Job {
  run() { return 1; }
  start(k: string) { HANDLERS[k](); return this["run"](); }
}
` },
    { path: 'b.py', language: 'Python', content: 'class B:\n    def run(self):\n        return 1\n\n    def go(self):\n        return getattr(self, "run")()\n' },
  ];

  it('disabling the rules restores the graph: only literal-reflective edges differ', async () => {
    const strip = (g: Built) => ({
      nodes: [...g.nodes.values()].map(n => `${n.id}|${n.startLine}`).sort(),
      edges: g.edges
        .filter(e => e.synthesizedBy !== REFLECTIVE_RESOLUTION_RULE)
        .map(e => `${e.callerId}|${e.calleeId}|${e.line}|${e.confidence}|${e.synthesizedBy ?? ''}`)
        .sort(),
    });
    const withRules = await build(FIXTURE);
    expect(reflective(withRules).length).toBeGreaterThan(0);

    const saved = new Map<string, Record<string, unknown>>();
    const keys = ['selfSubscriptReceivers', 'selfReceiverArg', 'selfDispatchOnReceiver', 'dispatchTables'] as const;
    for (const lang of ['TypeScript', 'Python']) {
      const spec = DYNAMIC_BOUNDARY_LANG_SPECS[lang] as unknown as Record<string, unknown>;
      saved.set(lang, Object.fromEntries(keys.map(k => [k, spec[k]])));
      for (const k of keys) delete spec[k];
    }
    try {
      const without = await build(FIXTURE);
      expect(reflective(without)).toEqual([]);
      expect(strip(withRules)).toEqual(strip(without));
    } finally {
      for (const [lang, fields] of saved) Object.assign(DYNAMIC_BOUNDARY_LANG_SPECS[lang], fields);
    }
  });

  it('the synthesized edge set does not depend on file order', async () => {
    const key = (g: Built) => reflective(g).map(e => `${e.callerId}|${e.calleeId}|${e.line}`).sort();
    const forward = await build(FIXTURE);
    const reversed = await build([...FIXTURE].reverse());
    expect(key(forward)).toEqual(key(reversed));
  });

  it('the capability is claimed exactly where a rule exists, and each claim fires', async () => {
    const fixtures: Record<string, File> = {
      TypeScript: { path: 'a.ts', language: 'TypeScript', content: 'class A { run() { return 1; } go() { return this["run"](); } }' },
      JavaScript: { path: 'a.js', language: 'JavaScript', content: 'class A { run() { return 1; } go() { return this["run"](); } }' },
      Python: { path: 'a.py', language: 'Python', content: 'class A:\n    def run(self):\n        return 1\n\n    def go(self):\n        return getattr(self, "run")()\n' },
      Ruby: { path: 'a.rb', language: 'Ruby', content: 'class A\n  def run\n    1\n  end\n\n  def go\n    send(:run)\n  end\nend\n' },
    };
    const claimed = Object.keys(DYNAMIC_BOUNDARY_LANG_SPECS).filter(supportsLiteralReflection).sort();
    expect(claimed).toEqual(Object.keys(fixtures).sort());
    for (const [lang, file] of Object.entries(fixtures)) {
      expect(languageSupport(lang).capabilities, lang).toContain('literalReflection');
      expect(reflectivePairs(await build([file])), lang).toEqual(['go->run']);
    }
    for (const lang of ['Go', 'Java', 'PHP', 'C#', 'Rust']) {
      expect(languageSupport(lang).capabilities, lang).not.toContain('literalReflection');
    }
  });
});
