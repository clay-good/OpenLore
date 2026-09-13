/**
 * Literal reflective dispatch (change: resolve-literal-reflective-dispatch), through the real
 * CallGraphBuilder. Every assertion pairs the edge side with the site side, because the contract is
 * a partition: a recognized construct yields an edge or a site, never both and never neither.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallGraphBuilder, EVENT_CHANNEL_FANOUT_CAP, extractFileDynamicBoundary } from './call-graph.js';
import type { CallEdge, FunctionNode } from './call-graph.js';
import {
  DYNAMIC_BOUNDARY_LANG_SPECS,
  DYNAMIC_BOUNDARY_SITE_CAP,
  REFLECTIVE_RESOLUTION_RULE,
  supportsLiteralReflection,
} from './dynamic-boundary.js';
import { languageSupport } from './language-support.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../constants.js';
import { handleFindDeadCode } from '../services/mcp-handlers/reachability.js';

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
const refusalsIn = (g: Built, path: string) => sitesIn(g, path).map(s => s.refusal);

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
const deleteUser = () => 2;
const HANDLERS = { create: createUser, "remove": deleteUser } as const;
type Action = keyof typeof HANDLERS;
function dispatch() { return HANDLERS["remove"](); }
` }]);
    expect(reflectivePairs(g)).toEqual(['dispatch->deleteUser']);
    expect(sitesIn(g, 'a.ts')).toEqual([]);
  });

  it('binds by declaration, so a homonym in another file does not matter', async () => {
    const g = await build([
      { path: 'a.ts', language: 'TypeScript', content: `
function run() { return 1; }
function stop() { return 2; }
const TABLE = { run, stop };
function dispatch(k: string) { return TABLE[k](); }
` },
      { path: 'b.ts', language: 'TypeScript', content: 'export function run() { return 3; }' },
    ]);
    expect(reflectivePairs(g)).toEqual(['dispatch->run', 'dispatch->stop']);
    expect(reflective(g).every(e => g.nodes.get(e.calleeId)?.filePath === 'a.ts')).toBe(true);
  });

  it('an entry bound by an import is never resolved by name', async () => {
    const g = await build([
      { path: 'a.ts', language: 'TypeScript', content: `
import { createUser } from 'some-lib';
import { run as removeUser } from './lib';
const HANDLERS = { create: createUser, remove: removeUser };
export function dispatch(k: string) { return HANDLERS[k](); }
` },
      { path: 'b.ts', language: 'TypeScript', content: 'export function createUser() { return 1; }\nexport function removeUser() { return 2; }' },
    ]);
    expect(reflective(g)).toEqual([]);
    expect(refusalsIn(g, 'a.ts')).toEqual(['unresolved-in-file-scope']);
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
    expect(refusalsIn(g, 'a.ts')).toEqual(['over-cap']);
  });

  it('a table that can change or be reached elsewhere is not a table', async () => {
    const cases = [
      'let TABLE = { a: f };\nfunction dispatch(k: string) { return TABLE[k](); }',
      'export const TABLE = { a: f };\nfunction dispatch(k: string) { return TABLE[k](); }',
      'const TABLE = { a: f };\nexport { TABLE };\nfunction dispatch(k: string) { return TABLE[k](); }',
      'const TABLE = { a: f };\nfunction dispatch(TABLE: any, k: string) { return TABLE[k](); }',
      'const TABLE = { a: f };\nTABLE.b = g;\nfunction dispatch(k: string) { return TABLE[k](); }',
      'const TABLE = { a: f };\nconst alias = TABLE;\nfunction dispatch(k: string) { return TABLE[k](); }',
      'const TABLE = { a: f };\nregister(TABLE);\nfunction dispatch(k: string) { return TABLE[k](); }',
      'const TABLE = { a: f };\nReflect.set(TABLE, "b", g);\nfunction dispatch(k: string) { return TABLE[k](); }',
    ];
    for (const body of cases) {
      const g = await build([{
        path: 'a.ts', language: 'TypeScript',
        content: `function f() { return 1; }\nfunction g() { return 2; }\nfunction register(t: any) { t.b = g; }\n${body}\n`,
      }]);
      expect(reflective(g), body).toEqual([]);
      expect(sitesIn(g, 'a.ts').filter(s => s.kind === 'computed-member').map(s => s.refusal), body)
        .toEqual(['no-static-target']);
    }
  });

  it('a Python module dict is not a table: any importer can mutate it', async () => {
    const g = await build([{ path: 'a.py', language: 'Python', content: `
def create_user():
    return 1

HANDLERS = {"create": create_user}

def dispatch(action):
    return HANDLERS[action]()
` }]);
    expect(reflective(g)).toEqual([]);
    expect(refusalsIn(g, 'a.py')).toEqual(['no-static-target']);
  });

  it('a module-level dispatch has no caller to attach an edge to', async () => {
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
function f() { return 1; }
const T = { a: f };
T[process.argv[2]]();
` }]);
    expect(reflective(g)).toEqual([]);
    expect(refusalsIn(g, 'a.ts')).toEqual(['unattributed-caller']);
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

  it('Ruby send(:m) binds on an implicit receiver, and not on another object', async () => {
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
    expect(sites.map(s => s.line)).toEqual([12]);
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
    expect(refusalsIn(g, 'a.ts')).toEqual(['ambiguous-target']);
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

  it('an ancestor definition and a subclass override together are refused', async () => {
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
export class Base { m() { return 1; } }
export class A extends Base { run() { return this["m"](); } }
export class B extends A { m() { return 2; } }
` }]);
    expect(reflective(g)).toEqual([]);
    expect(refusalsIn(g, 'a.ts')).toEqual(['ambiguous-target']);
  });

  it('a type that lacks the member is disclosed as such, not as "resolves to one symbol"', async () => {
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
export class A { go() { return this["run"](); } }
export class B { run() { return 1; } }
` }]);
    expect(reflective(g)).toEqual([]);
    expect(refusalsIn(g, 'a.ts')).toEqual(['unresolved-in-type']);
  });

  it('this outside the instance context is never the class', async () => {
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
export class A {
  m() { return 1; }
  static s() { return this["m"](); }
  n() { return [1].map(function (this: any) { return this["m"](); }); }
}
export const o = { m() { return 1; }, go() { return this["m"](); } };
` }]);
    expect(reflective(g)).toEqual([]);
  });

  it('two classes sharing a name in one file make the enclosing type ambiguous', async () => {
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
namespace X { export class Job { m() { return 1; } } }
namespace Y { export class Job { run() { return this["m"](); } } }
` }]);
    expect(reflective(g)).toEqual([]);
  });

  it('multiple parents leave the resolution order unknown', async () => {
    const g = await build([{ path: 'a.py', language: 'Python', content: `
class Base:
    def m(self):
        return 1

class Mixin:
    pass

class A(Base, Mixin):
    def run(self):
        return getattr(self, "m")()
` }]);
    expect(reflective(g)).toEqual([]);
    expect(sitesIn(g, 'a.py')).toHaveLength(1);
  });

  it('Ruby singleton methods, class << self, and instance_eval blocks are not instance context', async () => {
    const g = await build([{ path: 'a.rb', language: 'Ruby', content: `
class A
  def m
    1
  end

  def self.s
    send(:m)
  end

  class << self
    def t
      send(:m)
    end
  end

  def run(other)
    other.instance_eval { send(:m) }
  end
end
` }]);
    expect(reflective(g)).toEqual([]);
  });

  it('a staticmethod or classmethod is not instance context', async () => {
    const g = await build([{ path: 'a.py', language: 'Python', content: `
class A:
    def m(self):
        return 1

    @classmethod
    def c(cls):
        return getattr(cls, "m")()

    @staticmethod
    def s(self):
        return getattr(self, "m")()
` }]);
    expect(reflective(g)).toEqual([]);
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
    expect(refusalsIn(g, 'a.py')).toEqual(['ambiguous-target']);
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
    expect(refusalsIn(g, 'a.py')).toEqual(['no-static-target']);
  });
});

describe('the partition stays total, keyed on the construct, and honestly counted', () => {
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
    expect(sites.map(s => [s.line, s.refusal])).toEqual([[8, 'ambiguous-target']]);
  });

  it('every recognized construct yields exactly one of edge or site', async () => {
    const g = await build([{ path: 'a.py', language: 'Python', content: `
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
` }]);
    const edgeLines = new Set(reflective(g).map(e => e.line ?? 0));
    const siteLines = new Set(sitesIn(g, 'a.py').map(s => s.line));
    for (const line of [7, 8, 9, 10, 11]) {
      expect(edgeLines.has(line) !== siteLines.has(line), `line ${line}`).toBe(true);
    }
    expect([...edgeLines]).toEqual([7]);
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
    expect(sitesIn(g, 'a.ts')).toEqual([]);
  });

  it('bindable constructs cannot crowd a real boundary out of the retained sites', async () => {
    const calls = Array.from({ length: DYNAMIC_BOUNDARY_SITE_CAP }, () => '    this["m"]();').join('\n');
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
export class A {
  m() { return 1; }
  run(code: string) {
${calls}
    eval(code);
  }
}
` }]);
    const record = g.dynamicBoundaryByFile?.get('a.ts');
    expect(record?.sites.map(s => s.kind)).toEqual(['code-eval']);
    expect(record?.totalSites).toBeUndefined();
  });

  it('a file total counts unretained constructs but never a construct that bound', async () => {
    const calls = Array.from({ length: DYNAMIC_BOUNDARY_SITE_CAP + 10 }, () => '    this["m"]();').join('\n');
    const g = await build([{ path: 'a.ts', language: 'TypeScript', content: `
export class A {
  m() { return 1; }
  run(code: string) {
${calls}
    eval(code);
  }
}
` }]);
    const record = g.dynamicBoundaryByFile?.get('a.ts');
    expect(record?.sites.map(s => s.kind)).toEqual(['code-eval']);
    // One unbound eval plus the ten constructs past the retention budget, which were never decided.
    expect(record?.totalSites).toBe(11);
  });

  it('a single-file derivation reports a table as file-scoped, never as runtime-computed', async () => {
    const rec = await extractFileDynamicBoundary({
      path: 'a.ts', language: 'TypeScript',
      content: 'function f() { return 1; }\nconst T = { a: f };\nfunction d(k: string) { return T[k](); }\n',
    });
    expect(rec?.sites.map(s => s.refusal)).toEqual(['unresolved-in-file-scope']);
  });

  it('a subset rebuild binds nothing and discloses every candidate', async () => {
    const files: File[] = [{ path: 'a.ts', language: 'TypeScript', content: `
function f() { return 1; }
const T = { a: f };
export class A { m() { return 1; } go(k: string) { T[k](); return this["m"](); } }
` }];
    const g = await new CallGraphBuilder().build(files, undefined, undefined, []);
    expect(reflective(g)).toEqual([]);
    expect(refusalsIn(g, 'a.ts').sort()).toEqual(['resolvable-but-unbound', 'unresolved-in-file-scope']);
  });
});

describe('strict traversal keeps the qualification a bound site used to carry', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-literal-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const node = (id: string, name: string): FunctionNode => ({
    id, name, filePath: id.split('::')[0], isAsync: false, language: 'TypeScript',
    startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0,
  });

  it('a symbol reached only by a literal-reflective edge is never high-confidence dead', async () => {
    const nodes = [node('a.ts::main', 'main'), node('a.ts::dispatch', 'dispatch'), node('a.ts::createUser', 'createUser')];
    const edges: CallEdge[] = [
      { callerId: 'a.ts::main', calleeId: 'a.ts::dispatch', calleeName: 'dispatch', confidence: 'import', kind: 'calls' },
      {
        callerId: 'a.ts::dispatch', calleeId: 'a.ts::createUser', calleeName: 'createUser',
        confidence: 'synthesized', kind: 'calls', synthesizedBy: REFLECTIVE_RESOLUTION_RULE,
      },
    ];
    const callGraph = {
      nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
      stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
    };
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }), 'utf-8');

    type Dead = { candidateDead: Array<{ name: string; confidence: string; reason?: string }> };
    const lenient = await handleFindDeadCode({ directory: root }) as Dead;
    expect(lenient.candidateDead.find(c => c.name === 'createUser')).toBeUndefined();

    const strict = await handleFindDeadCode({ directory: root, directResolvedOnly: true }) as Dead;
    const hit = strict.candidateDead.find(c => c.name === 'createUser');
    expect(hit?.confidence).toBe('low');
    expect(hit?.reason).toMatch(/literal-reflective/);
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

  it('disabling the rules adds nothing else: only literal-reflective edges differ', async () => {
    const strip = (g: Built) => ({
      nodes: [...g.nodes.values()].map(n => `${n.id}|${n.startLine}`).sort(),
      edges: g.edges
        .filter(e => e.synthesizedBy !== REFLECTIVE_RESOLUTION_RULE)
        .map(e => `${e.callerId}|${e.calleeId}|${e.line}|${e.confidence}|${e.synthesizedBy ?? ''}`)
        .sort(),
    });
    const withRules = await build(FIXTURE);
    expect(reflective(withRules).length).toBeGreaterThan(0);

    const keys = ['selfSubscriptReceivers', 'selfReceiverArg', 'selfDispatchOnReceiver', 'dispatchTables', 'selfContext'];
    const saved = new Map<string, Record<string, unknown>>();
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
    expect(key(forward)).toHaveLength(3);
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
