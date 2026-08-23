/**
 * Parity oracle for incremental watch updates (change: fix-transitive-incremental-staleness).
 *
 * The incremental watcher MUST converge to the same call graph that a full
 * `analyze --force` (a from-scratch CallGraphBuilder.build over every file)
 * would produce — for the region a change affects — OR explicitly mark the
 * un-recomputed region stale. These tests assert that convergence against a
 * from-scratch build used as the ground-truth oracle.
 *
 * They FAIL against the pre-fix depth-1 behaviour:
 *   • a newly-added symbol that a prior NON-caller should now resolve to is
 *     never re-resolved (getCallerFiles misses it — it was an `external` edge);
 *   • direct callers past CALLER_REPARSE_LIMIT are silently dropped.
 *
 * DETERMINISM (change: fix-test-suite-hygiene — the once-flaky guard): these tests
 * await `handleChange`, which calls `handleBatch(..., { syncFlush: true })` — the
 * signature AND vector writes run inline and are fully awaited, so convergence is
 * complete when the promise resolves. Every comparison is over a `.sort()`ed edge
 * signature, and each test runs in its own `mkdtemp` root. There is NO time-window
 * or debounce wait, which is what made an earlier version flaky under full-suite
 * load. Do not reintroduce one: assert on the awaited result, never on a timer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EdgeStore } from './edge-store.js';
import { _resetContextCacheForTesting } from './mcp-handlers/utils.js';
import type { CallEdge, FunctionNode } from '../analyzer/call-graph.js';
import { semanticAnswerBytes } from '../analyzer/derived-artifact-equivalence.js';
import { registerRepairHost } from './cold-start-bootstrap.js';
import { computeIndexStaleness } from './mcp-handlers/index-staleness.js';
import { ServeWatchRepairCoordinator } from '../../cli/commands/serve.js';
import * as analyzeApi from '../../api/analyze.js';
import { readEditVerdictStore } from './edit-verdict.js';

// Prevent a real chokidar watcher from opening (handleChange path never starts one,
// but retain an event-complete deterministic watcher harness for the serve/watch
// parity gate below. `ready` resolves on a microtask; tests emit production events
// explicitly and drive debounce timers with Vitest's fake clock.
const chokidarHarness = vi.hoisted(() => ({
  watches: [] as Array<{
    target: unknown;
    handlers: Map<string, Array<(...args: unknown[]) => void>>;
  }>,
}));
vi.mock('chokidar', () => ({
  default: { watch: vi.fn((target: unknown) => {
    const record = { target, handlers: new Map<string, Array<(...args: unknown[]) => void>>() };
    chokidarHarness.watches.push(record);
    const watcher = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const handlers = record.handlers.get(event) ?? [];
        handlers.push(handler);
        record.handlers.set(event, handlers);
        if (event === 'ready') queueMicrotask(() => handler());
        return watcher;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    return watcher;
  }) },
}));

let root: string;
let outputPath: string;

beforeEach(async () => {
  chokidarHarness.watches.length = 0;
  root = await mkdtemp(join(tmpdir(), 'ol-parity-'));
  outputPath = join(root, '.openlore', 'analysis');
  await mkdir(outputPath, { recursive: true });
  // Minimal llm-context.json so the watcher's signature lane doesn't bail.
  await writeFile(
    join(outputPath, 'llm-context.json'),
    JSON.stringify({ signatures: [], callGraph: null }, null, 2),
    'utf-8',
  );
  await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({
    version: '1.0.0',
    projectType: 'nodejs',
    openspecPath: './openspec',
    analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
    generation: { provider: 'openai', model: 'test', domains: 'auto' },
    createdAt: new Date().toISOString(),
    lastRun: null,
  }));
  _resetContextCacheForTesting();
});

afterEach(async () => {
  _resetContextCacheForTesting();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

type Files = Record<string, string>;

/** Write a fixture file-set to disk (relative path → content). */
async function writeFiles(files: Files): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf-8');
  }
}

/** From-scratch ("analyze --force") build over the whole file-set — the oracle. */
async function fullBuild(files: Files): Promise<{ nodes: FunctionNode[]; edges: CallEdge[] }> {
  const { CallGraphBuilder } = await import('../analyzer/call-graph.js');
  const input = Object.entries(files).map(([path, content]) => ({
    path, content, language: path.endsWith('.py') ? 'Python' : 'TypeScript',
  }));
  const r = await new CallGraphBuilder().build(input);
  return { nodes: Array.from(r.nodes.values()), edges: r.edges };
}

/** Read the authoritative post-change source snapshot from disk. */
async function readFiles(paths: readonly string[]): Promise<Files> {
  const files: Files = {};
  for (const rel of [...paths].sort()) files[rel] = await readFile(join(root, rel), 'utf-8');
  return files;
}

/**
 * The host repair barrier used by serve/watch-auto: rebuild the graph from the
 * authoritative post-change bytes, publish it, then resolve the barrier. Tests
 * await this promise directly; there are no debounce guesses or sleeps.
 */
async function fullRepair(files: Files): Promise<{ nodes: FunctionNode[]; edges: CallEdge[] }> {
  const graph = await fullBuild(files);
  const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
  store.clearAll();
  seedStore(store, files, graph);
  store.close();
  _resetContextCacheForTesting();
  return graph;
}

function graphProjection(graph: { nodes: FunctionNode[]; edges: CallEdge[] }): unknown {
  return {
    // EdgeStore's portable production projection deliberately omits synthesized
    // external placeholder nodes while retaining the external call edges.
    nodes: graph.nodes.filter((n) => !n.isExternal)
      .map((n) => ({ id: n.id, name: n.name, file: n.filePath })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: graph.edges.map((e) => ({
      caller: e.callerId, callee: e.calleeId, name: e.calleeName,
      confidence: e.confidence, kind: e.kind ?? 'calls',
    })).sort((a, b) => `${a.caller}\0${a.callee}`.localeCompare(`${b.caller}\0${b.callee}`)),
  };
}

function storedGraphProjection(store: EdgeStore): unknown {
  return graphProjection({ nodes: store.getAllInternalNodes(), edges: store.getAllEdges() });
}

/** Seed the edge store with a complete graph + per-file content hashes. */
function seedStore(store: EdgeStore, files: Files, graph: { nodes: FunctionNode[]; edges: CallEdge[] }): void {
  store.transaction(() => {
    store.insertNodes(graph.nodes);
    store.insertEdges(graph.edges);
    for (const [rel, content] of Object.entries(files)) {
      store.setFileHash(rel, createHash('sha256').update(content).digest('hex'));
    }
  });
}

/** Outgoing edges from a file, reduced to a comparable identity tuple, sorted. */
function outgoingSig(store: EdgeStore, file: string): string[] {
  return store
    .getEdgesForFile(file)
    .outgoing.map((e) => `${e.callerId}->${e.calleeId} (${e.calleeName}, ${e.confidence})`)
    .sort();
}

function oracleOutgoingSig(edges: CallEdge[], file: string): string[] {
  return edges
    .filter((e) => e.callerId.startsWith(`${file}::`))
    .map((e) => `${e.callerId}->${e.calleeId} (${e.calleeName}, ${e.confidence})`)
    .sort();
}

describe('incremental watch converges to analyze --force (parity oracle)', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('persists both surviving caller sites after one completed producer edit', async () => {
    const v1: Files = {
      'src/api.ts': 'export function target() { return 1; }\n',
      'src/a.ts': "import { target } from './api';\nexport function a() { return target(); }\n",
      'src/b.ts': "import { target } from './api';\nexport function b() { return target(); }\n",
    };
    await writeFiles(v1);
    const graph = await fullBuild(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, graph);
    store.close();
    await writeFile(join(outputPath, 'repo-structure.json'), '{}');
    await writeFile(join(outputPath, 'fingerprint.json'), '{}');
    await writeFile(join(outputPath, 'dependency-graph.json'), JSON.stringify({ nodes: [], edges: [] }));

    await writeFiles({ 'src/api.ts': 'export function renamed() { return 1; }\n' });
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false })
      .handleChange(join(root, 'src/api.ts'));

    const verdictStore = await readEditVerdictStore(outputPath);
    const findings = verdictStore?.entries[0]?.findings ?? [];
    expect(findings.map(f => f.code)).toEqual([
      'edit-broken-reference',
      'edit-broken-reference',
    ]);
    expect(findings.map(f => f.location?.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('refreshes export facts and reports only a surviving exact named import', async () => {
    const v1: Files = {
      'src/api.ts': 'export function target() { return 1; }\n',
      'src/use.ts': "import { target } from './api';\nexport function use() { return target(); }\n",
    };
    await writeFiles(v1);
    const graph = await fullBuild(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, graph);
    store.close();
    const apiAbs = join(root, 'src/api.ts');
    const useAbs = join(root, 'src/use.ts');
    await writeFile(join(outputPath, 'repo-structure.json'), '{}');
    await writeFile(join(outputPath, 'fingerprint.json'), '{}');
    await writeFile(join(outputPath, 'dependency-graph.json'), JSON.stringify({
      nodes: [
        { id: apiAbs, file: { path: 'src/api.ts', absolutePath: apiAbs }, exports: [{ name: 'target', isDefault: false, isReExport: false }], metrics: {} },
        { id: useAbs, file: { path: 'src/use.ts', absolutePath: useAbs }, exports: [], metrics: {} },
      ],
      edges: [{ source: useAbs, target: apiAbs, importedNames: ['target'], importedSourceNames: ['target'], isTypeOnly: false, weight: 1 }],
    }));

    await writeFiles({ 'src/api.ts': 'export function renamed() { return 1; }\n' });
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false })
      .handleChange(apiAbs);

    const dependency = JSON.parse(await readFile(join(outputPath, 'dependency-graph.json'), 'utf8'));
    expect(dependency.nodes.find((n: { id: string }) => n.id === apiAbs).exports.map((e: { name: string }) => e.name))
      .toContain('renamed');
    const verdictStore = await readEditVerdictStore(outputPath);
    expect(verdictStore?.entries[0]?.findings.map(f => f.code)).toContain('edit-import-breakage');
  });

  it('reuses canonical dependency node identities when the watcher root is a symlink alias', async () => {
    const aliasParent = await mkdtemp(join(tmpdir(), 'ol-parity-alias-'));
    try {
      const canonicalRoot = await realpath(root);
      const aliasRoot = join(aliasParent, 'repo');
      await symlink(canonicalRoot, aliasRoot, 'dir');
      await writeFiles({
        'src/api.ts': 'export function target() { return 1; }\n',
        'src/use.ts': "import { target } from './api';\nexport function use() { return target(); }\n",
      });
      const apiAbs = join(canonicalRoot, 'src/api.ts');
      const useAbs = join(canonicalRoot, 'src/use.ts');
      await writeFile(join(outputPath, 'dependency-graph.json'), JSON.stringify({
        nodes: [
          { id: apiAbs, file: { path: 'src/api.ts', absolutePath: apiAbs }, exports: [{ name: 'target' }], metrics: {} },
          { id: useAbs, file: { path: 'src/use.ts', absolutePath: useAbs }, exports: [], metrics: {} },
        ],
        edges: [{ source: useAbs, target: apiAbs, importedSourceNames: ['target'] }],
      }));
      const { McpWatcher } = await import('./mcp-watcher.js');
      const watcher = new McpWatcher({ rootPath: aliasRoot, outputPath, embed: false }) as unknown as {
        updateDependencyGraph(files: Array<{ rel: string; content: string }>): Promise<Map<string, Array<{ importerFile: string; importedName: string }>>>;
      };
      const breakages = await watcher.updateDependencyGraph([
        { rel: 'src/api.ts', content: 'export function renamed() { return 1; }\n' },
      ]);
      const dependency = JSON.parse(await readFile(join(outputPath, 'dependency-graph.json'), 'utf8')) as {
        nodes: Array<{ id: string; file?: { path?: string } }>;
      };
      expect(dependency.nodes.filter(node => node.file?.path === 'src/api.ts').map(node => node.id)).toEqual([apiAbs]);
      expect(breakages.get('src/api.ts')).toEqual([{ importerFile: 'src/use.ts', importedName: 'target' }]);
    } finally {
      await rm(aliasParent, { recursive: true, force: true });
    }
  });

  it('compares an aliased named import by its exact source export identity', async () => {
    const v1: Files = {
      'src/api.ts': 'export function target() { return 1; }\n',
      'src/use.ts': "import { target as localTarget } from './api';\nexport function use() { return localTarget(); }\n",
    };
    await writeFiles(v1);
    const graph = await fullBuild(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, graph);
    store.close();
    const apiAbs = join(root, 'src/api.ts');
    const useAbs = join(root, 'src/use.ts');
    await writeFile(join(outputPath, 'repo-structure.json'), '{}');
    await writeFile(join(outputPath, 'fingerprint.json'), '{}');
    await writeFile(join(outputPath, 'dependency-graph.json'), JSON.stringify({
      nodes: [
        { id: apiAbs, file: { path: 'src/api.ts', absolutePath: apiAbs }, exports: [{ name: 'target', isDefault: false, isReExport: false }], metrics: {} },
        { id: useAbs, file: { path: 'src/use.ts', absolutePath: useAbs }, exports: [], metrics: {} },
      ],
      edges: [{ source: useAbs, target: apiAbs, importedNames: ['localTarget'], importedSourceNames: ['target'], weight: 1 }],
    }));
    await writeFiles({ 'src/api.ts': 'export function renamed() { return 1; }\n' });
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false }).handleChange(apiAbs);
    const findings = (await readEditVerdictStore(outputPath))?.entries[0]?.findings ?? [];
    expect(findings).toContainEqual(expect.objectContaining({ code: 'edit-import-breakage', subject: 'target' }));
  });

  it('treats a direct named export converted to an effective named re-export as preserved', async () => {
    const v1: Files = {
      'src/origin.ts': 'export function target() { return 1; }\n',
      'src/api.ts': 'export function target() { return 1; }\n',
      'src/use.ts': "import { target } from './api';\nexport function use() { return target(); }\n",
    };
    await writeFiles(v1);
    const graph = await fullBuild(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, graph);
    store.close();
    const apiAbs = join(root, 'src/api.ts');
    const useAbs = join(root, 'src/use.ts');
    const originAbs = join(root, 'src/origin.ts');
    await writeFile(join(outputPath, 'repo-structure.json'), '{}');
    await writeFile(join(outputPath, 'fingerprint.json'), '{}');
    await writeFile(join(outputPath, 'dependency-graph.json'), JSON.stringify({
      nodes: [
        { id: originAbs, file: { path: 'src/origin.ts', absolutePath: originAbs }, exports: [{ name: 'target' }], metrics: {} },
        { id: apiAbs, file: { path: 'src/api.ts', absolutePath: apiAbs }, exports: [{ name: 'target', isDefault: false, isReExport: false }], metrics: {} },
        { id: useAbs, file: { path: 'src/use.ts', absolutePath: useAbs }, exports: [], metrics: {} },
      ],
      edges: [{ source: useAbs, target: apiAbs, importedNames: ['target'], importedSourceNames: ['target'], weight: 1 }],
    }));
    await writeFiles({ 'src/api.ts': "export { target } from './origin';\n" });
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false }).handleChange(apiAbs);
    const findings = (await readEditVerdictStore(outputPath))?.entries[0]?.findings ?? [];
    expect(findings.filter(finding => finding.code === 'edit-import-breakage')).toEqual([]);
  });

  it('stays silent when a direct export becomes an unresolved star re-export', async () => {
    const v1: Files = {
      'src/origin.ts': 'export function target() { return 1; }\n',
      'src/api.ts': 'export function target() { return 1; }\n',
      'src/use.ts': "import { target } from './api';\nexport function use() { return target(); }\n",
    };
    await writeFiles(v1);
    const graph = await fullBuild(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath)); seedStore(store, v1, graph); store.close();
    const apiAbs = join(root, 'src/api.ts'); const useAbs = join(root, 'src/use.ts'); const originAbs = join(root, 'src/origin.ts');
    await writeFile(join(outputPath, 'repo-structure.json'), '{}'); await writeFile(join(outputPath, 'fingerprint.json'), '{}');
    await writeFile(join(outputPath, 'dependency-graph.json'), JSON.stringify({ nodes: [
      { id: originAbs, exports: [{ name: 'target' }], metrics: {} },
      { id: apiAbs, exports: [{ name: 'target' }], metrics: {} }, { id: useAbs, exports: [], metrics: {} },
    ], edges: [{ source: useAbs, target: apiAbs, importedSourceNames: ['target'] }] }));
    await writeFiles({ 'src/api.ts': "export * from './origin';\n" });
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false }).handleChange(apiAbs);
    expect((await readEditVerdictStore(outputPath))?.entries[0]?.findings.filter(f => f.code === 'edit-import-breakage')).toEqual([]);
  });

  it('recognizes an exact module-level Python named re-export', async () => {
    const v1: Files = {
      'src/origin.py': 'def target():\n    return 1\n',
      'src/api.py': 'def target():\n    return 1\n',
      'src/use.py': 'from .api import target\ndef use():\n    return target()\n',
    };
    await writeFiles(v1);
    const graph = await fullBuild(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath)); seedStore(store, v1, graph); store.close();
    const apiAbs = join(root, 'src/api.py'); const useAbs = join(root, 'src/use.py'); const originAbs = join(root, 'src/origin.py');
    await writeFile(join(outputPath, 'repo-structure.json'), '{}'); await writeFile(join(outputPath, 'fingerprint.json'), '{}');
    await writeFile(join(outputPath, 'dependency-graph.json'), JSON.stringify({ nodes: [
      { id: originAbs, exports: [{ name: 'target' }], metrics: {} },
      { id: apiAbs, exports: [{ name: 'target' }], metrics: {} }, { id: useAbs, exports: [], metrics: {} },
    ], edges: [{ source: useAbs, target: apiAbs, importedSourceNames: ['target'] }] }));
    await writeFiles({ 'src/api.py': 'from .origin import target\n' });
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false }).handleChange(apiAbs);
    expect((await readEditVerdictStore(outputPath))?.entries[0]?.findings.filter(f => f.code === 'edit-import-breakage')).toEqual([]);
  });

  it('reports an exact TypeScript arity mismatch from persisted edge facts', async () => {
    const v1: Files = {
      'src/api.ts': 'export function target(a: number) { return a; }\n',
      'src/use.ts': "import { target } from './api';\nexport function use() { return target(1); }\n",
    };
    await writeFiles(v1);
    const graph = await fullBuild(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, graph);
    store.close();
    await writeFile(join(outputPath, 'repo-structure.json'), '{}');
    await writeFile(join(outputPath, 'fingerprint.json'), '{}');
    await writeFile(join(outputPath, 'dependency-graph.json'), JSON.stringify({ nodes: [], edges: [] }));

    await writeFiles({ 'src/api.ts': 'export function target(a: number, b: number) { return a + b; }\n' });
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false })
      .handleChange(join(root, 'src/api.ts'));

    const verdictStore = await readEditVerdictStore(outputPath);
    expect(verdictStore?.entries[0]?.findings).toMatchObject([{
      code: 'edit-arity-mismatch',
      location: { path: 'src/use.ts', line: 2 },
    }]);
  });

  it('does not persist transient breakage when producer and consumer are one batch', async () => {
    const v1: Files = {
      'src/api.ts': 'export function target() { return 1; }\n',
      'src/use.ts': "import { target } from './api';\nexport function use() { return target(); }\n",
    };
    await writeFiles(v1);
    const graph = await fullBuild(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, graph);
    store.close();
    const apiAbs = join(root, 'src/api.ts');
    const useAbs = join(root, 'src/use.ts');
    await writeFile(join(outputPath, 'repo-structure.json'), '{}');
    await writeFile(join(outputPath, 'fingerprint.json'), '{}');
    await writeFile(join(outputPath, 'dependency-graph.json'), JSON.stringify({
      nodes: [
        { id: apiAbs, file: { path: 'src/api.ts', absolutePath: apiAbs }, exports: [{ name: 'target', isDefault: false, isReExport: false }], metrics: {} },
        { id: useAbs, file: { path: 'src/use.ts', absolutePath: useAbs }, exports: [], metrics: {} },
      ],
      edges: [{ source: useAbs, target: apiAbs, importedNames: ['target'], importedSourceNames: ['target'], isTypeOnly: false, weight: 1 }],
    }));
    await writeFiles({
      'src/api.ts': 'export function renamed() { return 1; }\n',
      'src/use.ts': "import { renamed } from './api';\nexport function use() { return renamed(); }\n",
    });

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: root, outputPath, embed: false });
    await (watcher as unknown as {
      handleBatch(paths: string[], options: { syncFlush: boolean }): Promise<void>;
    }).handleBatch([apiAbs, useAbs], { syncFlush: true });

    const verdictStore = await readEditVerdictStore(outputPath);
    expect(verdictStore?.entries.flatMap(entry => entry.findings)).toEqual([]);
  });

  it('keeps latest unrelated verdicts across batches and invalidates a changed semantic basis', async () => {
    const v1: Files = {
      'src/one.ts': 'export function one() { return 1; }\n',
      'src/two.ts': 'export function two() { return 2; }\n',
      'src/use-one.ts': "import { one } from './one';\nexport function useOne() { return one(); }\n",
      'src/use-two.ts': "import { two } from './two';\nexport function useTwo() { return two(); }\n",
    };
    await writeFiles(v1);
    const graph = await fullBuild(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, graph);
    store.close();
    await writeFile(join(outputPath, 'repo-structure.json'), '{}');
    await writeFile(join(outputPath, 'fingerprint.json'), '{}');
    await writeFile(join(outputPath, 'dependency-graph.json'), JSON.stringify({ nodes: [], edges: [] }));
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: root, outputPath, embed: false });

    await writeFiles({ 'src/one.ts': 'export function oneRenamed() { return 1; }\n' });
    await watcher.handleChange(join(root, 'src/one.ts'));
    await writeFiles({ 'src/two.ts': 'export function twoRenamed() { return 2; }\n' });
    await watcher.handleChange(join(root, 'src/two.ts'));
    expect((await readEditVerdictStore(outputPath))?.entries.map(entry => entry.file)).toEqual([
      'src/one.ts', 'src/two.ts',
    ]);

    await writeFiles({ 'src/use-one.ts': "import { oneRenamed } from './one';\nexport function useOne() { return oneRenamed(); }\n" });
    await watcher.handleChange(join(root, 'src/use-one.ts'));
    expect((await readEditVerdictStore(outputPath))?.entries.map(entry => entry.file)).toEqual([
      'src/two.ts', 'src/use-one.ts',
    ]);
  });

  it('selects a real direct test from the retained full-analysis graph after a production watcher edit', async () => {
    await writeFiles({
      'src/api.ts': 'export function target(a: number) { return a; }\n',
      'src/api.test.ts': "import { target } from './api';\nexport function verifiesTarget() { return target(1); }\n",
    });
    const { runAnalysis } = await import('../../cli/commands/analyze.js');
    await runAnalysis(root, outputPath, { maxFiles: 50, include: [], exclude: [] });
    await writeFiles({ 'src/api.ts': 'export function target(a: number, b: number) { return a + b; }\n' });
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false }).handleChange(join(root, 'src/api.ts'));
    const verdict = (await readEditVerdictStore(outputPath))?.entries.find(entry => entry.file === 'src/api.ts');
    expect(verdict?.boundaries.reachingTestsBasis).toBe('last-full-analysis');
    expect(verdict?.reachingTests).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'src/api.test.ts', test: 'verifiesTarget' }),
    ]));
    expect(verdict?.basis?.map(basis => basis.file)).toContain('src/api.test.ts');
  });

  it('keeps fact basis tied to analyzed snapshots and fails closed when a required snapshot is absent', async () => {
    await writeFiles({ 'src/api.ts': 'new', 'src/use.ts': 'analyzed-caller' });
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: root, outputPath, embed: false }) as unknown as {
      buildVerdictBasis(input: Record<string, unknown>, imports: []): Promise<Array<{ file: string; contentHash: string }> | null>;
    };
    const apiHash = createHash('sha256').update('new').digest('hex');
    const callerHash = createHash('sha256').update('analyzed-caller').digest('hex');
    const input = {
      file: 'src/api.ts', contentHash: apiHash, oldNodes: [], newNodes: [],
      oldIncoming: [{ callerId: 'src/use.ts::u', callerFile: 'src/use.ts', calleeId: 'src/api.ts::f', calleeName: 'f' }],
      postIncoming: [], postOutgoingByCaller: new Map(), recomputedCallerFiles: new Set(['src/use.ts']),
      staleFiles: [], reachingTests: [], basisSnapshots: new Map([['src/api.ts', apiHash], ['src/use.ts', callerHash]]),
    };
    await writeFiles({ 'src/use.ts': 'mutated-after-analysis' });
    expect(await watcher.buildVerdictBasis(input, [])).toContainEqual({ file: 'src/use.ts', contentHash: callerHash });
    expect(await watcher.buildVerdictBasis({ ...input, basisSnapshots: new Map([['src/api.ts', apiHash]]) }, [])).toBeNull();
  });

  it('Scenario 2: a newly-added symbol is resolved by a prior NON-caller', async () => {
    // v1: x calls foo(), which does not exist yet → x→external::foo.
    const v1: Files = {
      'src/x.ts': 'export function useFoo() { return foo(); }\n',
      'src/c.ts': 'export function bar() { return 1; }\n',
    };
    await writeFiles(v1);
    const g1 = await fullBuild(v1);

    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, g1);
    store.close();

    // Sanity: x's call is currently external (not resolved to c).
    const s0 = EdgeStore.open(EdgeStore.dbPath(outputPath));
    expect(outgoingSig(s0, 'src/x.ts').join('\n')).toContain('external::foo');
    s0.close();

    // Edit c.ts to ADD foo. x is NOT a caller of c (its edge was external),
    // so the depth-1 watcher never revisits x.
    const v2: Files = {
      ...v1,
      'src/c.ts': 'export function bar() { return 1; }\nexport function foo() { return 2; }\n',
    };
    await writeFiles({ 'src/c.ts': v2['src/c.ts'] });

    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false }).handleChange(join(root, 'src/c.ts'));

    const oracle = await fullBuild(v2);
    const store2 = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const got = outgoingSig(store2, 'src/x.ts');
    store2.close();

    // x→foo must now resolve to src/c.ts::foo, matching analyze --force.
    expect(got).toEqual(oracleOutgoingSig(oracle.edges, 'src/x.ts'));
    expect(got.join('\n')).toContain('src/c.ts::foo');
    expect(got.join('\n')).not.toContain('external::foo');
  });

  it('Scenario 4 (re-export): a caller through a barrel converges to the full-build re_export edge', async () => {
    // caller imports doWork through an index barrel that re-exports it from impl.
    // A full build resolves caller→impl::doWork at `re_export`. Editing impl must
    // leave the incremental store agreeing with analyze --force — not silently
    // degrading the edge to name_only because the barrel was outside the subset.
    const v1: Files = {
      'src/impl.ts': 'export function doWork() { return 1; }\n',
      'src/index.ts': "export { doWork } from './impl.js';\n",
      'src/caller.ts': "import { doWork } from './index.js';\nexport function run() { return doWork(); }\n",
    };
    await writeFiles(v1);
    const g1 = await fullBuild(v1);

    // Precondition: the full build resolves the barrel call at re_export.
    expect(oracleOutgoingSig(g1.edges, 'src/caller.ts').join('\n')).toContain('src/impl.ts::doWork (doWork, re_export)');

    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, g1);
    store.close();

    // Edit impl.ts (add a sibling function) — caller is a caller of impl, so the
    // incremental path re-resolves caller's edges.
    const v2: Files = {
      ...v1,
      'src/impl.ts': 'export function doWork() { return 2; }\nexport function helper() { return 3; }\n',
    };
    await writeFiles({ 'src/impl.ts': v2['src/impl.ts'] });

    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false }).handleChange(join(root, 'src/impl.ts'));

    const oracle = await fullBuild(v2);
    const store2 = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const got = outgoingSig(store2, 'src/caller.ts');
    store2.close();

    expect(got).toEqual(oracleOutgoingSig(oracle.edges, 'src/caller.ts'));
    expect(got.join('\n')).toContain('src/impl.ts::doWork (doWork, re_export)');
  });

  it('Scenario 3: all direct callers refresh past the old depth-1 limit of 10', async () => {
    // c defines target(); 15 callers each call it. Renaming target() in c must
    // leave EVERY caller resolving to external::target (the symbol is gone),
    // matching analyze --force — not just the first 10.
    const v1: Files = { 'src/c.ts': 'export function target() { return 1; }\n' };
    for (let i = 0; i < 15; i++) {
      v1[`src/caller${i}.ts`] = `export function call${i}() { return target(); }\n`;
    }
    await writeFiles(v1);
    const g1 = await fullBuild(v1);

    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, g1);
    store.close();

    // Rename target → renamed in c.ts.
    const v2: Files = { ...v1, 'src/c.ts': 'export function renamed() { return 1; }\n' };
    await writeFiles({ 'src/c.ts': v2['src/c.ts'] });

    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false }).handleChange(join(root, 'src/c.ts'));

    const oracle = await fullBuild(v2);
    const store2 = EdgeStore.open(EdgeStore.dbPath(outputPath));
    // No caller may still hold a stale edge into src/c.ts::target (deleted node).
    let staleEdges = 0;
    for (let i = 0; i < 15; i++) {
      const sig = outgoingSig(store2, `src/caller${i}.ts`);
      expect(sig).toEqual(oracleOutgoingSig(oracle.edges, `src/caller${i}.ts`));
      if (sig.join('\n').includes('src/c.ts::target')) staleEdges++;
    }
    store2.close();
    expect(staleEdges).toBe(0);
  });
});

describe('incremental-full-repair semantic-answer parity gate', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  async function servedProjection(functionName: string): Promise<string> {
    _resetContextCacheForTesting();
    const { handleGetSubgraph } = await import('./mcp-handlers/graph.js');
    const answer = await handleGetSubgraph(root, functionName, 'downstream', 3) as Record<string, unknown>;
    // These are the stable conclusion fields registered by semantic-answer-v1.
    // Freshness, repair progress, generation identity, and timing are asserted
    // independently and are intentionally not used to make parity pass.
    return semanticAnswerBytes({
      query: answer.query,
      seeds: answer.seeds,
      stats: answer.stats,
      nodes: answer.nodes,
      edges: answer.edges,
      governingDecisions: answer.governingDecisions,
    });
  }

  const initial: Files = {
    'src/service.ts': 'export function target() { return 1; }\n',
    'src/caller.ts': 'export function entry() { return target(); }\n',
  };

  const cases: Array<{
    name: string;
    query: string;
    mutate(live: Set<string>, emit: (event: 'change' | 'add' | 'unlink', path: string) => void): Promise<void>;
  }> = [
    {
      name: 'file edit', query: 'helper',
      async mutate(_live, emit) {
        await writeFiles({ 'src/service.ts': 'export function target() { return 2; }\nexport function helper() { return 3; }\n' });
        emit('change', join(root, 'src/service.ts'));
      },
    },
    {
      name: 'file add', query: 'added',
      async mutate(live, emit) {
        live.add('src/added.ts');
        await writeFiles({ 'src/added.ts': 'export function added() { return target(); }\n' });
        emit('add', join(root, 'src/added.ts'));
      },
    },
    {
      name: 'file delete', query: 'entry',
      async mutate(live, emit) {
        live.delete('src/service.ts');
        const abs = join(root, 'src/service.ts');
        await rm(abs);
        emit('unlink', abs);
      },
    },
    {
      name: 'path rename', query: 'entry',
      async mutate(live, emit) {
        const before = join(root, 'src/caller.ts');
        const after = join(root, 'src/runner.ts');
        await rename(before, after);
        live.delete('src/caller.ts');
        live.add('src/runner.ts');
        // Chokidar reports rename as unlink + add. The serve coordinator must
        // coalesce both receipts into one full publication.
        emit('unlink', before);
        emit('add', after);
      },
    },
  ];

  for (const state of cases) {
    it(`${state.name}: post-barrier graph and served answer equal a fresh full oracle`, async () => {
      await writeFiles(initial);
      const seed = await fullBuild(initial);
      const seeded = EdgeStore.open(EdgeStore.dbPath(outputPath));
      seedStore(seeded, initial, seed);
      seeded.close();

      const live = new Set(Object.keys(initial));
      const { McpWatcher } = await import('./mcp-watcher.js');
      let watcher: InstanceType<typeof McpWatcher> | undefined;
      try {
        let releaseBarrier!: () => void;
        let rejectBarrier!: (error: unknown) => void;
        const barrier = new Promise<void>((resolve, reject) => {
          releaseBarrier = resolve;
          rejectBarrier = reject;
        });
        const analyze = vi.spyOn(analyzeApi, 'openloreAnalyze');
        const coordinator = new ServeWatchRepairCoordinator(() => {
          void analyzeApi.openloreAnalyze({ rootPath: root, force: true })
            .then(releaseBarrier, rejectBarrier);
        });
        watcher = new McpWatcher({
          rootPath: root,
          outputPath,
          embed: false,
          onBatchFlushed: () => coordinator.schedule(),
          onGraphStale: () => coordinator.schedule(),
        });
        await watcher.start();
        const sourceWatch = chokidarHarness.watches.find((watch) => watch.target === root);
        expect(sourceWatch).toBeDefined();
        const emit = (event: 'change' | 'add' | 'unlink', path: string): void => {
          for (const handler of sourceWatch!.handlers.get(event) ?? []) handler(path);
        };

        vi.useFakeTimers();
        await state.mutate(live, emit);
        await vi.advanceTimersByTimeAsync(500);  // watcher publication debounce
        await vi.advanceTimersByTimeAsync(4_000); // serve full-repair debounce
        // The debounce/coalescing boundary is now crossed. The analyzer itself
        // owns real watchdog timers, so restore the clock while awaiting its
        // observable publication barrier.
        vi.useRealTimers();
        await barrier;
        expect(analyze).toHaveBeenCalledTimes(1);
        expect(analyze).toHaveBeenCalledWith({ rootPath: root, force: true });
      } finally {
        vi.useRealTimers();
        await watcher?.stop();
      }

      const postChange = await readFiles([...live]);
      const repaired = await fullBuild(postChange);

      const repairedStore = EdgeStore.open(EdgeStore.dbPath(outputPath));
      expect(semanticAnswerBytes(storedGraphProjection(repairedStore)))
        .toBe(semanticAnswerBytes(graphProjection(repaired)));
      repairedStore.close();
      const acceleratedAnswer = await servedProjection(state.query);

      // Build a second, fresh full oracle from exactly the same post-change bytes
      // and compare the public structural handler's stable conclusion projection.
      const oracle = await fullBuild(postChange);
      const oracleStore = EdgeStore.open(EdgeStore.dbPath(outputPath));
      oracleStore.clearAll();
      seedStore(oracleStore, postChange, oracle);
      expect(semanticAnswerBytes(graphProjection(repaired)))
        .toBe(semanticAnswerBytes(graphProjection(oracle)));
      oracleStore.close();
      expect(acceleratedAnswer).toBe(await servedProjection(state.query));
    });
  }

  it('over-budget state discloses stale serving and accepted repair before convergence', async () => {
    vi.useFakeTimers();
    const files: Files = { 'src/hub.ts': 'export function target() { return 1; }\n' };
    for (let i = 0; i < 5; i++) files[`src/caller${i}.ts`] = `export function call${i}() { return target(); }\n`;
    await writeFiles(files);
    const seeded = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(seeded, files, await fullBuild(files));
    seeded.close();

    let repairRequested = false;
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({
      rootPath: root,
      outputPath,
      embed: false,
      closureBudget: 1,
      onGraphStale: () => { repairRequested = true; },
    });
    const unregister = registerRepairHost(root, staleFiles => watcher.requestColdReadRepair(staleFiles));
    try {
      files['src/hub.ts'] = 'export function renamed() { return 1; }\n';
      await writeFiles({ 'src/hub.ts': files['src/hub.ts'] });
      await watcher.handleChange(join(root, 'src/hub.ts'));

      const staleStore = EdgeStore.open(EdgeStore.dbPath(outputPath));
      const staleFiles = staleStore.getStaleFiles();
      expect(staleFiles).toHaveLength(4);
      const disclosure = await computeIndexStaleness(
        root,
        null,
        { edgeStore: staleStore, artifactMtimeMs: Number.MAX_SAFE_INTEGER },
        [staleFiles[0]],
      );
      staleStore.close();
      expect(disclosure).toMatchObject({
        staleFiles: [staleFiles[0]],
        repairScheduled: true,
        note: expect.stringMatching(/results may omit recent edits/i),
      });
      expect(repairRequested).toBe(false); // scheduled is not converged

      // Force the watcher's documented debounce barrier deterministically.
      await vi.runAllTimersAsync();
      expect(repairRequested).toBe(true);
      const repaired = await fullRepair(await readFiles(Object.keys(files)));
      const converged = EdgeStore.open(EdgeStore.dbPath(outputPath));
      expect(converged.getStaleFiles()).toEqual([]);
      expect(await computeIndexStaleness(
        root,
        null,
        { edgeStore: converged, artifactMtimeMs: Number.MAX_SAFE_INTEGER },
        [staleFiles[0]],
      )).toBeUndefined();
      expect(semanticAnswerBytes(storedGraphProjection(converged)))
        .toBe(semanticAnswerBytes(graphProjection(repaired)));
      converged.close();
    } finally {
      unregister();
      vi.useRealTimers();
    }
  });
});

describe('budget-exceeded incremental update marks the remainder stale (not silently wrong)', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  /** c defines target(); N callers call it. Returns the seeded file-set. */
  async function seedHub(callers: number): Promise<Files> {
    const v1: Files = { 'src/c.ts': 'export function target() { return 1; }\n' };
    for (let i = 0; i < callers; i++) {
      v1[`src/caller${i}.ts`] = `export function call${i}() { return target(); }\n`;
    }
    await writeFiles(v1);
    const g1 = await fullBuild(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, g1);
    store.close();
    return v1;
  }

  it('a change whose closure exceeds the budget flags the un-recomputed callers stale', async () => {
    const v1 = await seedHub(5);
    // Rename target → renamed; only `closureBudget` callers can be re-resolved.
    await writeFiles({ 'src/c.ts': 'export function renamed() { return 1; }\n' });

    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false, closureBudget: 2 })
      .handleChange(join(root, 'src/c.ts'));

    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const stale = store.getStaleFiles();
    // 5 callers − budget 2 = 3 marked stale; the changed file is never stale.
    expect(stale).toHaveLength(3);
    expect(stale).not.toContain('src/c.ts');
    for (const f of stale) expect(Object.keys(v1)).toContain(f);
    // Every stale caller is honestly flagged; no recomputed caller is stale.
    const recomputed = Array.from({ length: 5 }, (_, i) => `src/caller${i}.ts`).filter((c) => !stale.includes(c));
    for (const c of recomputed) expect(store.isFileStale(c)).toBe(false);
    store.close();
  });

  it('a stale region self-heals: re-editing a stale file clears its mark; full clearAll wipes the region', async () => {
    await seedHub(5);
    await writeFiles({ 'src/c.ts': 'export function renamed() { return 1; }\n' });
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: root, outputPath, embed: false, closureBudget: 2 });
    await watcher.handleChange(join(root, 'src/c.ts'));

    let store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const staleBefore = store.getStaleFiles();
    expect(staleBefore.length).toBe(3);
    store.close();

    // Opportunistic self-heal: editing one stale file re-resolves it → mark clears.
    const victim = staleBefore[0];
    const victimAbs = join(root, victim);
    await writeFile(victimAbs, 'export function reworked() { return 0; }\n', 'utf-8');
    await watcher.handleChange(victimAbs);

    store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    expect(store.isFileStale(victim)).toBe(false);
    expect(store.getStaleFiles().length).toBe(2);
    // A full `analyze --force` (clearAll) wipes any remaining stale region.
    store.clearAll();
    expect(store.countStaleFiles()).toBe(0);
    store.close();
  });
});

describe('adversarial regressions (PR #189 review findings)', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('F1: an external consumer of a newly-added symbol is never left silently divergent when the budget is full', async () => {
    // c has placeholder(); two direct callers of c fill a budget of 2. x calls
    // addSym() → external. Editing c to ADD addSym must NOT leave x silently
    // external just because direct callers used up the budget — x is either
    // re-resolved or marked stale.
    const v1: Files = {
      'src/c.ts': 'export function placeholder() { return 0; }\n',
      'src/d0.ts': 'export function call0() { return placeholder(); }\n',
      'src/d1.ts': 'export function call1() { return placeholder(); }\n',
      'src/x.ts': 'export function useAdd() { return addSym(); }\n',
    };
    await writeFiles(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, await fullBuild(v1));
    store.close();

    await writeFiles({ 'src/c.ts': 'export function placeholder() { return 0; }\nexport function addSym() { return 1; }\n' });
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false, closureBudget: 2 })
      .handleChange(join(root, 'src/c.ts'));

    const s = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const xResolved = outgoingSig(s, 'src/x.ts').join('\n').includes('src/c.ts::addSym');
    const xStale = s.isFileStale('src/x.ts');
    s.close();
    // Converge-or-flag: either x now resolves to c::addSym, OR x is flagged stale.
    expect(xResolved || xStale).toBe(true);
  });

  it('F2: adding a duplicate of an existing name_only symbol converges its consumers to analyze --force', async () => {
    // Only zzz defines foo; w calls foo() at name_only. Adding foo() in aaa
    // (sorts before zzz) flips the deterministic tiebreak — w must converge.
    const v1: Files = {
      'src/zzz.ts': 'export function foo() { return 9; }\n',
      'src/w.ts': 'export function useFoo() { return foo(); }\n',
    };
    await writeFiles(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, await fullBuild(v1));
    store.close();

    const v2: Files = { ...v1, 'src/aaa.ts': 'export function foo() { return 1; }\n' };
    await writeFiles({ 'src/aaa.ts': v2['src/aaa.ts'] });
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath: root, outputPath, embed: false }).handleChange(join(root, 'src/aaa.ts'));

    const oracle = await fullBuild(v2);
    const s = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const got = outgoingSig(s, 'src/w.ts');
    const stale = s.isFileStale('src/w.ts');
    s.close();
    // w converges to the same target analyze --force picks (or is honestly stale).
    expect(got.length === 0 || stale || JSON.stringify(got) === JSON.stringify(oracleOutgoingSig(oracle.edges, 'src/w.ts'))).toBe(true);
    if (!stale) expect(got).toEqual(oracleOutgoingSig(oracle.edges, 'src/w.ts'));
  });

  it('deletion clears any stale mark for the removed file (no phantom stale rows)', async () => {
    const v1: Files = { 'src/c.ts': 'export function target() { return 1; }\n' };
    for (let i = 0; i < 5; i++) v1[`src/caller${i}.ts`] = `export function call${i}() { return target(); }\n`;
    await writeFiles(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, await fullBuild(v1));
    store.close();

    await writeFiles({ 'src/c.ts': 'export function renamed() { return 1; }\n' });
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: root, outputPath, embed: false, closureBudget: 2 });
    await watcher.handleChange(join(root, 'src/c.ts'));

    let s = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const stale = s.getStaleFiles();
    expect(stale.length).toBe(3);
    s.close();

    // Delete one stale file → its stale row must be cleared (handleDeletions).
    const victim = stale[0];
    await rm(join(root, victim), { force: true });
    await watcher['handleDeletions']([join(root, victim)]);

    s = EdgeStore.open(EdgeStore.dbPath(outputPath));
    expect(s.isFileStale(victim)).toBe(false);
    expect(s.getStaleFiles()).not.toContain(victim);
    s.close();
  });

  // With the resolver's refuse-to-guess discipline (change: harden-call-resolution-ambiguity),
  // adding a SECOND cross-file definition of a bare-called name makes every such call
  // AMBIGUOUS — the edge disappears — regardless of the added symbol's id sort order.
  // So the old "name_only tiebreak winner" model is gone: a higher-id add is no longer a
  // no-op, and a lower-id add no longer produces a new winner. Both must converge every
  // consumer to "no foo edge" within budget and flag the overflow stale.
  for (const variant of [
    { name: 'higher-id', file: 'src/zzzz.ts' }, // sorts AFTER zzz (was the "LOSES" no-op case)
    { name: 'lower-id', file: 'src/aaa.ts' },   // sorts BEFORE zzz (was the "WINS" case)
  ]) {
    it(`round2: adding a ${variant.name} second definition makes bare callers ambiguous, converging within budget and flagging the overflow stale`, async () => {
      const v1: Files = { 'src/zzz.ts': 'export function foo() { return 9; }\n' };
      for (let i = 0; i < 5; i++) v1[`src/w${i}.ts`] = `export function use${i}() { return foo(); }\n`;
      await writeFiles(v1);
      const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
      seedStore(store, v1, await fullBuild(v1));
      // Seeded state: each consumer resolves foo -> zzz uniquely (name_only).
      for (let i = 0; i < 5; i++) {
        expect(outgoingSig(store, `src/w${i}.ts`).join('\n')).toContain('src/zzz.ts::foo');
      }
      store.close();

      await writeFiles({ [variant.file]: 'export function foo() { return 1; }\n' });
      const { McpWatcher } = await import('./mcp-watcher.js');
      await new McpWatcher({ rootPath: root, outputPath, embed: false, closureBudget: 2 })
        .handleChange(join(root, variant.file));

      const s = EdgeStore.open(EdgeStore.dbPath(outputPath));
      const stale = s.getStaleFiles().filter((f) => f.startsWith('src/w'));
      // 5 consumers all diverge (unique -> ambiguous); budget 2 recomputes 2, flags 3 stale.
      expect(stale).toHaveLength(3);
      // The 2 recomputed consumers converged to NO foo edge (ambiguous), matching a full
      // rebuild — never a guessed edge to either candidate.
      for (let i = 0; i < 5; i++) {
        const rel = `src/w${i}.ts`;
        if (!stale.includes(rel)) {
          const sig = outgoingSig(s, rel).join('\n');
          expect(sig).not.toContain('::foo');
        }
      }
      s.close();

      // Oracle: a full rebuild resolves NO consumer's foo (two candidates = ambiguous).
      const v2: Files = { ...v1, [variant.file]: 'export function foo() { return 1; }\n' };
      const oracle = await fullBuild(v2);
      for (let i = 0; i < 5; i++) {
        expect(oracleOutgoingSig(oracle.edges, `src/w${i}.ts`).join('\n')).not.toContain('::foo');
      }
    });
  }

  it('round2: a present-but-unreadable consumer file is marked stale (not silently emptied + asserted fresh)', async () => {
    const v1: Files = {
      'src/c.ts': 'export function bar() { return 1; }\n',
      'src/x.ts': 'export function useFoo() { return foo(); }\n', // foo external → consumer of an added foo
    };
    await writeFiles(v1);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, v1, await fullBuild(v1));
    store.close();

    // Edit c to ADD foo (x becomes an external consumer in the recompute set),
    // but make x unreadable before the watcher tries to read it.
    await writeFiles({ 'src/c.ts': 'export function bar() { return 1; }\nexport function foo() { return 2; }\n' });
    const { chmod } = await import('node:fs/promises');
    await chmod(join(root, 'src/x.ts'), 0o000);
    try {
      const { McpWatcher } = await import('./mcp-watcher.js');
      await new McpWatcher({ rootPath: root, outputPath, embed: false }).handleChange(join(root, 'src/c.ts'));

      const s = EdgeStore.open(EdgeStore.dbPath(outputPath));
      // Soundness: x could not be recomputed → it is flagged stale, never cleared…
      expect(s.isFileStale('src/x.ts')).toBe(true);
      // …and its existing edge is PRESERVED (not deleted to empty).
      expect(outgoingSig(s, 'src/x.ts').join('\n')).toContain('external::foo');
      s.close();
    } finally {
      await chmod(join(root, 'src/x.ts'), 0o644); // restore so afterEach cleanup works
    }
  });

  it('a file-level anchor in a stale region is not reported fresh', async () => {
    const files: Files = { 'src/c.ts': 'export function target() { return 1; }\n' };
    await writeFiles(files);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, files, await fullBuild(files));
    store.close();

    const { makeFreshnessView } = await import('../decisions/anchor-adapter.js');
    const { anchorFreshness, hashSpan } = await import('../decisions/anchor.js');
    const s = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const fileAnchor = { filePath: 'src/c.ts', contentHash: hashSpan(files['src/c.ts']) };

    expect(anchorFreshness(fileAnchor, makeFreshnessView(s, root)).freshness).toBe('fresh');
    s.markFilesStale(['src/c.ts']);
    const v = anchorFreshness(fileAnchor, makeFreshnessView(s, root));
    expect(v.freshness).toBe('drifted');
    expect(v.staleRegion).toBe(true);
    s.close();
  });
});

describe('IaC files are inert under the incremental watcher (Bicep parity with Terraform)', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('handleChange on a .bicep file neither throws nor wipes the graph — identical to .tf', async () => {
    // IaC is analyze-time only: the watcher excludes it from CALL_GRAPH_LANGS, so a
    // .bicep/.tf change must be a no-op on the edge store (no nodes added, none of a
    // sibling code file's nodes deleted) and must never throw. This locks the safety
    // invariant: .bicep behaves exactly like the long-shipped .tf under watch.
    const ts: Files = { 'src/app.ts': 'export function deploy() { return 1; }\n' };
    await writeFiles(ts);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, ts, await fullBuild(ts));
    const tsNodesBefore = store.getNodesForFile('src/app.ts').length;
    store.close();
    expect(tsNodesBefore).toBeGreaterThan(0);

    // Real IaC files on disk so the watcher actually reads them.
    await writeFiles({
      'infra/main.tf': 'resource "aws_s3_bucket" "b" {}\n',
      'infra/main.bicep': "resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' = {\n  name: 'x'\n}\n",
    });

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: root, outputPath, embed: false });
    // Must resolve without throwing for both ecosystems.
    await watcher.handleChange(join(root, 'infra/main.bicep'));
    await watcher.handleChange(join(root, 'infra/main.tf'));

    const s = EdgeStore.open(EdgeStore.dbPath(outputPath));
    // No edge-store nodes are minted for IaC files…
    expect(s.getNodesForFile('infra/main.bicep')).toHaveLength(0);
    expect(s.getNodesForFile('infra/main.tf')).toHaveLength(0);
    // …and the sibling code file's nodes are untouched (no collateral wipe).
    expect(s.getNodesForFile('src/app.ts').length).toBe(tsNodesBefore);
    s.close();
  });
});

describe('freshness verdicts honor the stale region (FreshnessVerdictsHonorTheStaleRegion)', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('a symbol whose own span is unchanged but lies in a stale region is not reported fresh', async () => {
    const files: Files = { 'src/c.ts': 'export function target() { return 1; }\n' };
    await writeFiles(files);
    const g1 = await fullBuild(files);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    seedStore(store, files, g1);
    store.close();

    const { makeFreshnessView } = await import('../decisions/anchor-adapter.js');
    const { anchorFreshness } = await import('../decisions/anchor.js');
    const { hashSpan } = await import('../decisions/anchor.js');

    // Build a symbol anchor whose contentHash matches the CURRENT span → would be fresh.
    const s = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const node = s.getNodesForFile('src/c.ts')[0];
    const span = files['src/c.ts'].slice(node.startIndex, node.endIndex);
    const anchor = { nodeId: node.id, symbolName: node.name, filePath: node.filePath, contentHash: hashSpan(span) };

    // Without a stale mark → fresh.
    expect(anchorFreshness(anchor, makeFreshnessView(s, root)).freshness).toBe('fresh');

    // Mark the file stale → the unchanged symbol must NOT be fresh.
    s.markFilesStale(['src/c.ts']);
    const verdict = anchorFreshness(anchor, makeFreshnessView(s, root));
    expect(verdict.freshness).not.toBe('fresh');
    expect(verdict.freshness).toBe('drifted');
    expect(verdict.staleRegion).toBe(true);
    s.close();
  });
});
