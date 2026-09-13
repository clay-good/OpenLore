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
  DYNAMIC_BOUNDARY_SCHEMA_VERSION,
  DYNAMIC_BOUNDARY_SITE_CAP,
  REFLECTIVE_RESOLUTION_RULE,
  buildDynamicBoundaryReport,
  supportsLiteralReflection,
  type DynamicBoundarySite,
} from './dynamic-boundary.js';
import { languageSupport } from './language-support.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DYNAMIC_BOUNDARY,
} from '../../constants.js';
import { handleFindDeadCode } from '../services/mcp-handlers/reachability.js';
import {
  loadDynamicBoundaryReport,
  __resetDynamicBoundaryMemo,
} from '../services/mcp-handlers/dynamic-boundary-disclosure.js';

type File = { path: string; language: string; content: string };
type Built = Awaited<ReturnType<CallGraphBuilder['build']>>;

const build = (files: File[]): Promise<Built> => new CallGraphBuilder().build(files);
const ts = (content: string): File[] => [{ path: 'a.ts', language: 'TypeScript', content }];

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
  it('a table indexed by a variable key wires every bound function', async () => {
    const g = await build(ts(`
function createUser() { return 1; }
function deleteUser() { return 2; }
const HANDLERS = { create: createUser, remove: deleteUser };
export function dispatch(k: string) {
  return HANDLERS[k]();
}
`));
    expect(reflectivePairs(g)).toEqual(['dispatch->createUser', 'dispatch->deleteUser']);
    const edge = reflective(g)[0];
    expect(edge.confidence).toBe('synthesized');
    expect(edge.kind).toBe('calls');
    expect(edge.line).toBe(6);
    expect(sitesIn(g, 'a.ts')).toEqual([]);
  });

  it('a literal key selects only its own entry, and a const arrow is a declaration', async () => {
    const g = await build(ts(`
function createUser() { return 1; }
const deleteUser = () => 2;
const HANDLERS = { create: createUser, "remove": deleteUser } as const;
type Action = keyof typeof HANDLERS;
function dispatch() { return HANDLERS["remove"](); }
`));
    expect(reflectivePairs(g)).toEqual(['dispatch->deleteUser']);
    expect(sitesIn(g, 'a.ts')).toEqual([]);
  });

  it('binds by declaration, so a homonym in another file does not matter', async () => {
    const g = await build([
      ...ts('function run() { return 1; }\nfunction stop() { return 2; }\nconst TABLE = { run, stop };\nfunction dispatch(k: string) { return TABLE[k](); }\n'),
      { path: 'b.ts', language: 'TypeScript', content: 'export function run() { return 3; }' },
    ]);
    expect(reflectivePairs(g)).toEqual(['dispatch->run', 'dispatch->stop']);
    expect(reflective(g).every(e => g.nodes.get(e.calleeId)?.filePath === 'a.ts')).toBe(true);
  });

  it('an entry bound by an import is never resolved by name', async () => {
    const g = await build([
      ...ts(`
import { createUser } from 'some-lib';
import { run as removeUser } from './lib';
const HANDLERS = { create: createUser, remove: removeUser };
export function dispatch(k: string) { return HANDLERS[k](); }
`),
      { path: 'b.ts', language: 'TypeScript', content: 'export function createUser() { return 1; }\nexport function removeUser() { return 2; }' },
    ]);
    expect(reflective(g)).toEqual([]);
    expect(refusalsIn(g, 'a.ts')).toEqual(['unresolved-in-file-scope']);
  });

  it('a variable key over the fan-out cap binds nothing; a literal key into that table binds its entry', async () => {
    const n = EVENT_CHANNEL_FANOUT_CAP + 1;
    const fns = Array.from({ length: n }, (_, i) => `function h${i}() { return ${i}; }`).join('\n');
    const entries = Array.from({ length: n }, (_, i) => `k${i}: h${i}`).join(', ');
    const g = await build(ts(`
${fns}
const TABLE = { ${entries} };
function dispatch(k: string) { return TABLE[k](); }
function one() { return TABLE["k3"](); }
`));
    expect(reflectivePairs(g)).toEqual(['one->h3']);
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
      'const TABLE = { a: f };\nfunction dispatch(k: string) { eval("TABLE.b = g"); return TABLE[k](); }',
    ];
    for (const body of cases) {
      const g = await build(ts(`function f() { return 1; }\nfunction g() { return 2; }\nfunction register(t: any) { t.b = g; }\n${body}\n`));
      expect(reflective(g), body).toEqual([]);
      expect(sitesIn(g, 'a.ts').filter(s => s.kind === 'computed-member').map(s => s.refusal), body)
        .toEqual(['no-static-target']);
    }
  });

  it('an entry that is reassigned, or that can reach the table through this, is not local', async () => {
    const cases = [
      'function log() { return 1; }\nfunction debugLog() { return 2; }\nif (Math.random()) log = debugLog;\nconst T = { log };\nexport function d(k: string) { return T[k](); }',
      'function register(this: any) { this.extra = 1; }\nconst T = { register };\nexport function d(k: string) { return T[k](); }',
    ];
    for (const content of cases) {
      const g = await build(ts(content));
      expect(reflective(g), content).toEqual([]);
      expect(refusalsIn(g, 'a.ts'), content).toEqual(['unresolved-in-file-scope']);
    }
  });

  it('keys compare the way JavaScript does, and an escaped key is not guessed at', async () => {
    const numeric = await build(ts('function f() { return 1; }\nfunction g() { return 2; }\nconst T = { 1: f, 2: g };\nexport function d() { return T[1.0](); }\n'));
    expect(reflectivePairs(numeric)).toEqual(['d->f']);

    const template = await build(ts('function f() { return 1; }\nfunction g() { return 2; }\nconst T = { a: f, b: g };\nexport function d() { return T[`a`](); }\n'));
    expect(reflectivePairs(template)).toEqual(['d->f']);

    const escaped = await build(ts('function f() { return 1; }\nconst T = { "\\u0061": f };\nexport function d(k: string) { return T[k](); }\n'));
    expect(reflective(escaped)).toEqual([]);
    expect(refusalsIn(escaped, 'a.ts')).toEqual(['no-static-target']);
  });

  it('a Python module dict is not a table: any importer can mutate it', async () => {
    const g = await build([{ path: 'a.py', language: 'Python', content: 'def create_user():\n    return 1\n\nHANDLERS = {"create": create_user}\n\ndef dispatch(action):\n    return HANDLERS[action]()\n' }]);
    expect(reflective(g)).toEqual([]);
    expect(refusalsIn(g, 'a.py')).toEqual(['no-static-target']);
  });

  it('a module-level dispatch has no caller to attach an edge to', async () => {
    const g = await build(ts('function f() { return 1; }\nconst T = { a: f };\nT[process.argv[2]]();\n'));
    expect(reflective(g)).toEqual([]);
    expect(refusalsIn(g, 'a.ts')).toEqual(['unattributed-caller']);
  });
});

describe('self-typed receivers are never resolved', () => {
  it('this["m"](), getattr(self, "m")() and send(:m) bind nothing', async () => {
    const g = await build([
      { path: 'a.ts', language: 'TypeScript', content: 'export class Job { run() { return 1; } start() { return this["run"](); } }' },
      { path: 'b.py', language: 'Python', content: 'class Job:\n    def go(self):\n        return 1\n\n    def start(self):\n        return getattr(self, "go")()\n' },
      { path: 'c.rb', language: 'Ruby', content: 'class Job\n  def process\n    1\n  end\n\n  def route\n    send(:process)\n  end\nend\n' },
    ]);
    expect(reflective(g)).toEqual([]);
    // Unchanged from before this change: a static-index member access is not recorded, while the
    // reflective calls stay disclosed.
    expect(sitesIn(g, 'a.ts')).toEqual([]);
    expect(refusalsIn(g, 'b.py')).toEqual(['resolvable-but-unbound']);
    expect(refusalsIn(g, 'c.rb')).toEqual(['resolvable-but-unbound']);
  });
});

describe('strict uniqueness, and a call must be a call', () => {
  it('a same-file homonym does not make an ambiguous name unique', async () => {
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
      ...ts('function f() { return 1; }\nconst T = { a: f };\nexport function grab(k: string) { return T[k]; }\n'),
    ]);
    expect(g.edges.filter(e => e.confidence === 'synthesized')).toEqual([]);
    expect(sitesIn(g, 'b.py')).toEqual([]);
  });

  it('a literal naming no internal target is still disclosed', async () => {
    const g = await build([{ path: 'a.py', language: 'Python', content: 'import requests\n\ndef fetch():\n    return getattr(requests, "get")()\n' }]);
    const sites = sitesIn(g, 'a.py');
    expect(sites.map(s => [s.kind, s.refusal])).toEqual([['reflective-invoke', 'unresolved-external']]);
  });

  it('a concatenated target is never reconstructed', async () => {
    const g = await build([{ path: 'a.py', language: 'Python', content: 'class A:\n    def get_x(self):\n        return 1\n\n    def f(self, name):\n        return getattr(self, "get_" + name)()\n' }]);
    expect(refusalsIn(g, 'a.py')).toEqual(['no-static-target']);
  });
});

describe('the partition stays total, keyed on the construct, and honestly counted', () => {
  it('every recognized construct yields exactly one of edge or site', async () => {
    const g = await build([
      ...ts(`
import { ext } from 'lib';
function f() { return 1; }
const STABLE = { a: f };
let LOOSE = { a: f };
const IMPORTED = { a: ext };
export function d(k: string) {
  STABLE[k]();
  LOOSE[k]();
  IMPORTED[k]();
  return STABLE["a"]();
}
`),
    ]);
    // A bound construct is an edge OR, when its pair was already wired, a deduplicated binding; either
    // way it is recorded in the bound list, which is the edge side of the partition.
    const boundLines = new Set((g.dynamicBoundaryByFile?.get('a.ts')?.bound ?? []).map(s => s.line));
    const sites = sitesIn(g, 'a.ts');
    const siteLines = new Set(sites.map(s => s.line));
    for (const line of [8, 9, 10, 11]) {
      expect(boundLines.has(line) !== siteLines.has(line), `line ${line}`).toBe(true);
    }
    expect([...boundLines].sort((a, b) => a - b)).toEqual([8, 11]);
    expect(reflective(g).map(e => e.line)).toEqual([8]);
    expect(sites.map(s => [s.line, s.refusal])).toEqual([[9, 'no-static-target'], [10, 'unresolved-in-file-scope']]);
  });

  it('one dispatch is not counted twice when a direct call already wires the pair', async () => {
    const g = await build(ts('function f() { return 1; }\nconst T = { a: f };\nexport function d(k: string) { f(); return T[k](); }\n'));
    const d = [...g.nodes.values()].find(n => n.name === 'd')!.id;
    const f = [...g.nodes.values()].find(n => n.name === 'f')!.id;
    expect(g.edges.filter(e => e.callerId === d && e.calleeId === f)).toHaveLength(1);
    expect(sitesIn(g, 'a.ts')).toEqual([]);
    expect(g.dynamicBoundaryByFile?.get('a.ts')?.bound?.map(s => s.refusal)).toEqual(['synthesized-binding']);
  });

  it('bound constructs are persisted in their own list, and a bound-only file adds no site to the rollup', async () => {
    const g = await build(ts('function f() { return 1; }\nconst T = { a: f };\nexport function d(k: string) { return T[k](); }\n'));
    const record = g.dynamicBoundaryByFile?.get('a.ts');
    expect(record?.sites).toEqual([]);
    expect(record?.bound).toHaveLength(1);
    const report = buildDynamicBoundaryReport([record!]);
    expect(report?.files).toHaveLength(1);
    expect(report?.totalSites).toBe(0);
    expect(report?.totalFiles).toBe(0);
  });

  it('literal-key dispatches cannot crowd a real boundary out of the listed sites', async () => {
    const calls = (n: number) => Array.from({ length: n }, () => '  T["a"]();').join('\n');
    // A real boundary that is not `eval` — a file that evaluates code has no stable table at all.
    const bound = await build(ts(`function f() { return 1; }\nconst T = { a: f };\nexport function d(o: any, k: string) {\n${calls(DYNAMIC_BOUNDARY_SITE_CAP)}\n  o[k]();\n}\n`));
    expect(bound.dynamicBoundaryByFile?.get('a.ts')?.sites.map(s => s.refusal)).toEqual(['no-static-target']);
    expect(bound.dynamicBoundaryByFile?.get('a.ts')?.totalSites).toBeUndefined();

    const past = await build(ts(`function f() { return 1; }\nconst T = { a: f };\nexport function d(o: any, k: string) {\n${calls(DYNAMIC_BOUNDARY_SITE_CAP + 10)}\n  o[k]();\n}\n`));
    // One unbound computed call, plus the ten constructs past the retention budget that were never decided.
    expect(past.dynamicBoundaryByFile?.get('a.ts')?.sites.map(s => s.refusal)).toEqual(['no-static-target']);
    expect(past.dynamicBoundaryByFile?.get('a.ts')?.totalSites).toBe(11);

    const unbound = await build(ts(`import { ext } from 'lib';\nconst T = { a: ext };\nexport function d(o: any, k: string) {\n${calls(DYNAMIC_BOUNDARY_SITE_CAP + 10)}\n  o[k](); o[k](); o[k]();\n}\n`));
    const record = unbound.dynamicBoundaryByFile?.get('a.ts');
    expect(record?.sites).toHaveLength(DYNAMIC_BOUNDARY_SITE_CAP);
    // All three real boundaries are listed ahead of the deferred literal-key sites.
    expect(record?.sites.filter(s => s.refusal === 'no-static-target')).toHaveLength(3);
    expect(record?.totalSites).toBe(DYNAMIC_BOUNDARY_SITE_CAP + 10 + 3);
  });

  it('a single-file derivation reports a table as file-scoped, never as runtime-computed', async () => {
    const rec = await extractFileDynamicBoundary({
      path: 'a.ts', language: 'TypeScript',
      content: 'function f() { return 1; }\nconst T = { a: f };\nfunction d(k: string) { return T[k](); }\n',
    });
    expect(rec?.sites.map(s => s.refusal)).toEqual(['unresolved-in-file-scope']);
  });

  it('a subset rebuild binds nothing and discloses every candidate', async () => {
    const g = await new CallGraphBuilder().build(
      ts('function f() { return 1; }\nconst T = { a: f };\nexport function d(k: string) { return T[k](); }\n'),
      undefined, undefined, [],
    );
    expect(reflective(g)).toEqual([]);
    expect(refusalsIn(g, 'a.ts')).toEqual(['unresolved-in-file-scope']);
  });
});

describe('a directly-resolved-only consumer still sees what an edge discharged', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ol-literal-'));
    __resetDynamicBoundaryMemo();
  });
  afterEach(async () => {
    __resetDynamicBoundaryMemo();
    await rm(root, { recursive: true, force: true });
  });

  const node = (id: string, name: string): FunctionNode => ({
    id, name, filePath: id.split('::')[0], isAsync: false, language: 'TypeScript',
    startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0,
  });
  const boundSite: DynamicBoundarySite = {
    line: 3, kind: 'computed-member', refusal: 'synthesized-binding', symbolId: 'a.ts::dispatch', evidence: 'T[k]()',
  };

  async function writeArtifacts(files: unknown[]): Promise<void> {
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_DYNAMIC_BOUNDARY), JSON.stringify({
      version: DYNAMIC_BOUNDARY_SCHEMA_VERSION, totalSites: 0, totalFiles: 0, byKind: [], byLanguage: [], files,
    }), 'utf-8');
  }

  it('the default view hides bound constructs; the strict view folds them back in', async () => {
    await writeArtifacts([{ filePath: 'a.ts', language: 'TypeScript', sites: [], bound: [boundSite] }]);
    expect(await loadDynamicBoundaryReport(root)).toBeNull();
    const strict = await loadDynamicBoundaryReport(root, undefined, { directResolvedOnly: true });
    expect(strict?.files[0].sites.map(s => s.refusal)).toEqual(['synthesized-binding']);
  });

  it('an unrecognised refusal from a newer writer does not drop the file', async () => {
    await writeArtifacts([{
      filePath: 'a.ts', language: 'TypeScript',
      sites: [{ line: 2, kind: 'code-eval', refusal: 'a-future-reason', evidence: 'eval(x)', unattributed: true }],
    }]);
    expect((await loadDynamicBoundaryReport(root))?.files).toHaveLength(1);
  });

  it('find_dead_code under directResolvedOnly does not report a table target as high-confidence dead', async () => {
    const nodes = [node('a.ts::main', 'main'), node('a.ts::dispatch', 'dispatch'), node('a.ts::createUser', 'createUser')];
    const edges: CallEdge[] = [
      { callerId: 'a.ts::main', calleeId: 'a.ts::dispatch', calleeName: 'dispatch', confidence: 'import', kind: 'calls' },
      {
        callerId: 'a.ts::dispatch', calleeId: 'a.ts::createUser', calleeName: 'createUser',
        confidence: 'synthesized', kind: 'calls', synthesizedBy: REFLECTIVE_RESOLUTION_RULE,
      },
    ];
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: {
      nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
      stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
    } }), 'utf-8');
    await writeArtifacts([{ filePath: 'a.ts', language: 'TypeScript', sites: [], bound: [boundSite] }]);

    type Dead = { candidateDead: Array<{ name: string; confidence: string; reason?: string }> };
    const lenient = await handleFindDeadCode({ directory: root }) as Dead;
    expect(lenient.candidateDead.find(c => c.name === 'createUser')).toBeUndefined();

    const strict = await handleFindDeadCode({ directory: root, directResolvedOnly: true }) as Dead;
    const hit = strict.candidateDead.find(c => c.name === 'createUser');
    expect(hit?.confidence).toBe('low');
    expect(hit?.reason).toMatch(/computed member dispatch at a\.ts:3/);
  });
});

describe('additive, deterministic, and registered', () => {
  const FIXTURE: File[] = [
    ...ts('function createUser() { return 1; }\nconst HANDLERS = { create: createUser };\nexport function start(k: string) { return HANDLERS[k](); }\n'),
    { path: 'b.ts', language: 'TypeScript', content: 'function stop() { return 1; }\nconst T = { stop };\nexport function go(k: string) { return T[k](); }\n' },
  ];

  it('disabling the rule adds nothing else: only literal-reflective edges differ', async () => {
    const strip = (g: Built) => ({
      nodes: [...g.nodes.values()].map(n => `${n.id}|${n.startLine}`).sort(),
      edges: g.edges
        .filter(e => e.synthesizedBy !== REFLECTIVE_RESOLUTION_RULE)
        .map(e => `${e.callerId}|${e.calleeId}|${e.line}|${e.confidence}|${e.synthesizedBy ?? ''}`)
        .sort(),
    });
    const withRule = await build(FIXTURE);
    expect(reflective(withRule).length).toBe(2);

    const spec = DYNAMIC_BOUNDARY_LANG_SPECS.TypeScript;
    const saved = spec.dispatchTables;
    delete spec.dispatchTables;
    try {
      const without = await build(FIXTURE);
      expect(reflective(without)).toEqual([]);
      expect(strip(withRule)).toEqual(strip(without));
    } finally {
      spec.dispatchTables = saved;
    }
  });

  it('the synthesized edge set does not depend on file order', async () => {
    const key = (g: Built) => reflective(g).map(e => `${e.callerId}|${e.calleeId}|${e.line}`).sort();
    expect(key(await build(FIXTURE))).toEqual(key(await build([...FIXTURE].reverse())));
  });

  it('the capability is claimed exactly where a rule exists, and each claim fires', async () => {
    const table = 'function run() { return 1; }\nconst T = { run };\nfunction go(k) { return T[k](); }\n';
    const fixtures: Record<string, File> = {
      TypeScript: { path: 'a.ts', language: 'TypeScript', content: table },
      JavaScript: { path: 'a.js', language: 'JavaScript', content: table },
    };
    const claimed = Object.keys(DYNAMIC_BOUNDARY_LANG_SPECS).filter(supportsLiteralReflection).sort();
    expect(claimed).toEqual(Object.keys(fixtures).sort());
    for (const [lang, file] of Object.entries(fixtures)) {
      expect(languageSupport(lang).capabilities, lang).toContain('literalReflection');
      expect(reflectivePairs(await build([file])), lang).toEqual(['go->run']);
    }
    for (const lang of ['Python', 'Ruby', 'Go', 'Java', 'PHP', 'C#', 'Rust']) {
      expect(languageSupport(lang).capabilities, lang).not.toContain('literalReflection');
    }
  });
});
