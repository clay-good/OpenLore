/**
 * Tests for McpWatcher — handleChange / handleBatch (unit, no real FS watcher).
 *
 * Spec 13.1 reshaped the watcher: a single coalescing queue (enqueue → flush →
 * handleBatch) replaces the per-file timer map, and the vector update goes
 * through VectorIndex.updateFiles (row-level) on a decoupled lane rather than
 * reEmbed → VectorIndex.build. These tests track the new surface; the
 * freshness/coalescing guarantees themselves live in
 * mcp-watcher-incremental.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { LLMContext } from '../analyzer/artifact-generator.js';
import type { SerializedCallGraph } from '../analyzer/call-graph.js';
import { EdgeStore } from './edge-store.js';
import { SpecIndexLockTimeoutError } from '../analyzer/spec-vector-index.js';

/**
 * An absolute fixture root ON THIS PLATFORM.
 *
 * A POSIX literal such as '/tmp/proj' is NOT an absolute Windows path, so safeJoin's
 * lexical containment check (resolved.startsWith(absDir + sep)) can never hold there:
 * resolve() turns the child into a drive-rooted path while the root keeps its leading
 * slash, so every watcher construction throws "Path traversal blocked". Same class as
 * the mock-safeJoin fix in 513b12dc.
 *
 * resolve() is a no-op on POSIX and yields a drive-rooted path on win32, so these tests
 * assert identical behaviour on both platforms rather than being skipped on one.
 */
const FIXTURE_ROOT = resolve('/tmp/proj');
import type { CallEdge } from '../analyzer/call-graph.js';
import { _resetContextCacheForTesting } from './mcp-handlers/utils.js';

// ── chokidar mock (prevents real FS watcher from opening) ────────────────────

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => {
      const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
      const watcher = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
          // Fire 'ready' synchronously so start() resolves in tests
          if (event === 'ready') handler();
          return watcher;
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      return watcher;
    }),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<LLMContext> = {}): LLMContext {
  return {
    phase1_survey: { purpose: '', files: [], totalTokens: 0 },
    phase2_deep:   { purpose: '', files: [], totalTokens: 0 },
    phase3_validation: { purpose: '', files: [], totalTokens: 0 },
    signatures: [],
    ...overrides,
  };
}

function makeCallGraph(): SerializedCallGraph {
  return {
    nodes: [], edges: [], classes: [], inheritanceEdges: [],
    hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
}

async function setupProject(ctx: LLMContext): Promise<{ rootPath: string; outputPath: string; contextPath: string }> {
  const rootPath = await mkdtemp(join(tmpdir(), 'mcp-watcher-test-'));
  const outputPath = join(rootPath, '.openlore', 'analysis');
  await mkdir(outputPath, { recursive: true });
  const contextPath = join(outputPath, 'llm-context.json');
  await writeFile(contextPath, JSON.stringify(ctx, null, 2), 'utf-8');
  return { rootPath, outputPath, contextPath };
}

beforeEach(() => {
  _resetContextCacheForTesting();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('McpWatcher.handleChange', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    _resetContextCacheForTesting();
  });

  it('updates signatures for a changed TypeScript file', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'auth.ts');
    await writeFile(srcFile, 'export function login(user: string): boolean { return true; }', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    const entry = updated.signatures?.find(s => s.path === 'src/auth.ts');
    expect(entry).toBeDefined();
    expect(entry!.path).toBe('src/auth.ts');
    expect(entry!.language).toBe('TypeScript');
  });

  it('records spec-index staleness when a spec file changes', async () => {
    const { rootPath, outputPath } = await setupProject(makeContext());
    const specDir = join(rootPath, 'openspec', 'specs', 'auth');
    await mkdir(specDir, { recursive: true });
    const specFile = join(specDir, 'spec.md');
    await writeFile(specFile, '# Auth\n\n## Purpose\n\nAuthentication.\n', 'utf8');
    const { SpecVectorIndex } = await import('../analyzer/spec-vector-index.js');
    await SpecVectorIndex.build(outputPath, join(rootPath, 'openspec', 'specs'), null);

    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath, outputPath }).handleChange(specFile);

    expect(await SpecVectorIndex.freshness(outputPath)).toMatchObject({
      changedFileCount: 1,
      changedFiles: ['openspec/specs/auth/spec.md'],
    });
  });

  it('tracks the configured spec root and indexed ADRs, but ignores change deltas', async () => {
    const { rootPath, outputPath } = await setupProject(makeContext());
    const openspecRoot = join(rootPath, 'docs', 'spec-root');
    const specsDir = join(openspecRoot, 'specs', 'auth');
    const decisionsDir = join(openspecRoot, 'decisions');
    const changeDir = join(openspecRoot, 'changes', 'draft', 'specs', 'auth');
    await mkdir(specsDir, { recursive: true });
    await mkdir(decisionsDir, { recursive: true });
    await mkdir(changeDir, { recursive: true });
    const specFile = join(specsDir, 'spec.md');
    const adrFile = join(decisionsDir, 'adr-0001-cache.md');
    const deltaFile = join(changeDir, 'spec.md');
    await writeFile(specFile, '# Auth\n\n## Purpose\n\nAuthentication.\n', 'utf8');
    await writeFile(adrFile, '# ADR-0001: Cache policy\n\nUse a bounded cache.\n', 'utf8');
    await writeFile(deltaFile, '# Draft delta\n', 'utf8');
    const { SpecVectorIndex } = await import('../analyzer/spec-vector-index.js');
    await SpecVectorIndex.build(outputPath, join(openspecRoot, 'specs'), null, undefined, decisionsDir);

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({
      rootPath,
      outputPath,
      openspecPath: 'docs/spec-root',
    });
    await watcher.handleChange(specFile);
    await watcher.handleChange(adrFile);
    await watcher.handleChange(deltaFile);

    expect(await SpecVectorIndex.freshness(outputPath)).toMatchObject({
      changedFileCount: 2,
      changedFiles: [
        'docs/spec-root/decisions/adr-0001-cache.md',
        'docs/spec-root/specs/auth/spec.md',
      ],
    });
  });

  it('records spec changes before a mixed batch takes the bulk fallback', async () => {
    const { rootPath, outputPath } = await setupProject(makeContext());
    const specDir = join(rootPath, 'openspec', 'specs', 'auth');
    const srcDir = join(rootPath, 'src');
    await mkdir(specDir, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    const specFile = join(specDir, 'spec.md');
    const srcFile = join(srcDir, 'auth.ts');
    await writeFile(specFile, '# Auth\n\n## Purpose\n\nAuthentication.\n', 'utf8');
    await writeFile(srcFile, 'export function auth() {}\n', 'utf8');
    const { SpecVectorIndex } = await import('../analyzer/spec-vector-index.js');
    await SpecVectorIndex.build(outputPath, join(rootPath, 'openspec', 'specs'), null);

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({
      rootPath,
      outputPath,
      bulkThreshold: 1,
      onGraphStale: () => {},
    });
    await (watcher as unknown as {
      flushBatchWithBusyRetry(batch: string[], deletions: string[]): Promise<void>;
    }).flushBatchWithBusyRetry([srcFile, specFile], []);

    expect(await SpecVectorIndex.freshness(outputPath)).toMatchObject({
      changedFileCount: 1,
      changedFiles: ['openspec/specs/auth/spec.md'],
    });
  });

  it('fires onBatchFlushed with changed paths on a real change, not on a no-op', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath } = await setupProject(ctx);

    const flushed: string[][] = [];
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({
      rootPath,
      outputPath,
      onBatchFlushed: (paths) => flushed.push(paths),
    });

    // Real source change → callback fires with the abs path.
    const srcFile = join(rootPath, 'svc.ts');
    await writeFile(srcFile, 'export function go() { return 1; }', 'utf-8');
    await watcher.handleChange(srcFile);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toContain(srcFile);

    // A test file is a no-op (skipped before any work) → callback must NOT fire.
    const testFile = join(rootPath, 'svc.test.ts');
    await writeFile(testFile, 'export function t() {}', 'utf-8');
    await watcher.handleChange(testFile);
    expect(flushed).toHaveLength(1);
  });

  it('does not touch callGraph when patching signatures', async () => {
    const cg = makeCallGraph();
    const ctx = makeContext({ callGraph: cg });
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    const srcFile = join(rootPath, 'index.ts');
    await writeFile(srcFile, 'export function foo() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(updated.callGraph).toEqual(cg);
  });

  it('preserves non-empty callGraph edges when patching signatures', async () => {
    const cg = makeCallGraph();
    cg.edges = [
      { callerId: 'src/a.ts::foo', calleeId: 'src/b.ts::bar', calleeName: 'bar', confidence: 'name_only' },
    ];
    cg.stats.totalEdges = 1;
    const ctx = makeContext({ callGraph: cg });
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    // Change a file unrelated to the edge above
    const srcFile = join(rootPath, 'other.ts');
    await writeFile(srcFile, 'export function baz() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(updated.callGraph?.edges).toHaveLength(1);
    expect(updated.callGraph?.edges?.[0].callerId).toBe('src/a.ts::foo');
    expect(updated.callGraph?.edges?.[0].calleeId).toBe('src/b.ts::bar');
    expect(updated.callGraph?.edges?.[0].calleeName).toBe('bar');
  });

  it('updates signatures when call-graph.db is absent (backward compat)', async () => {
    // No call-graph.db present — SQLite edge store not yet initialized.
    // Signature updates must still work regardless of DB presence.
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'service.ts');
    await writeFile(srcFile, 'export function doWork() { return 1; }', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(updated.signatures?.some(s => s.path === 'src/service.ts')).toBe(true);
  });

  it('replaces an existing signature entry for the same file', async () => {
    const ctx = makeContext({
      signatures: [{ path: 'src/foo.ts', language: 'TypeScript', entries: [] }],
    });
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'foo.ts');
    await writeFile(srcFile, 'export function bar() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    const entries = updated.signatures?.filter(s => s.path === 'src/foo.ts');
    expect(entries).toHaveLength(1);   // no duplicate
  });

  it('inserts a new entry when the file was not previously indexed', async () => {
    const ctx = makeContext({
      signatures: [{ path: 'src/other.ts', language: 'TypeScript', entries: [] }],
    });
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    const srcFile = join(rootPath, 'new.ts');
    await writeFile(srcFile, 'export function baz() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(updated.signatures?.some(s => s.path === 'new.ts')).toBe(true);
    expect(updated.signatures?.some(s => s.path === 'src/other.ts')).toBe(true);
  });

  it('skips test files and does not write llm-context.json', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);
    const before = await readFile(contextPath, 'utf-8');

    const testFile = join(rootPath, 'auth.test.ts');
    await writeFile(testFile, 'it("test", () => {})', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(testFile);

    const after = await readFile(contextPath, 'utf-8');
    expect(after).toBe(before);   // unchanged
  });

  it('skips files with unknown language', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);
    const before = await readFile(contextPath, 'utf-8');

    const txtFile = join(rootPath, 'notes.txt');
    await writeFile(txtFile, 'some text', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(txtFile);

    const after = await readFile(contextPath, 'utf-8');
    expect(after).toBe(before);
  });

  it('skips a GitHub Actions workflow file change (IaC is analyze-time only)', async () => {
    // A `.github/workflows/*.yml` edit must be a no-op for the incremental watcher —
    // detectLanguage returns 'unknown' for it, so it never reaches the call-graph /
    // node-deletion path (the proposal's safety claim; same posture as all IaC YAML).
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);
    const before = await readFile(contextPath, 'utf-8');

    const wfDir = join(rootPath, '.github', 'workflows');
    await mkdir(wfDir, { recursive: true });
    const wfFile = join(wfDir, 'ci.yml');
    await writeFile(wfFile, 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await expect(watcher.handleChange(wfFile)).resolves.not.toThrow();

    const after = await readFile(contextPath, 'utf-8');
    expect(after).toBe(before);   // unchanged — workflow file skipped
  });

  it('warns to stderr and does not throw when llm-context.json is missing', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'mcp-watcher-missing-'));
    const outputPath = join(rootPath, '.openlore', 'analysis');
    // Do NOT create outputPath — simulate analyze never having been run

    const srcFile = join(rootPath, 'foo.ts');
    await writeFile(srcFile, 'export function x() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await expect(watcher.handleChange(srcFile)).resolves.not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('run analyze first'));
  });

  it('warns to stderr and does not throw when llm-context.json is corrupted', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'mcp-watcher-corrupt-'));
    const outputPath = join(rootPath, '.openlore', 'analysis');
    await mkdir(outputPath, { recursive: true });
    await writeFile(join(outputPath, 'llm-context.json'), '{ invalid json !!!', 'utf-8');

    const srcFile = join(rootPath, 'foo.ts');
    await writeFile(srcFile, 'export function x() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await expect(watcher.handleChange(srcFile)).resolves.not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('run analyze first'));
  });

  // ── SQLite edge update path ───────────────────────────────────────────────────

  it('updates edges in call-graph.db when DB is present and content changed', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath } = await setupProject(ctx);

    // Seed the DB with a stale edge from src/a.ts to src/b.ts (relative paths — DB convention)
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const staleEdge: CallEdge = {
      callerId: 'src/a.ts::foo',
      calleeId: 'src/b.ts::bar',
      calleeName: 'bar',
      confidence: 'name_only',
    };
    store.insertEdges([staleEdge]);
    store.close();

    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'a.ts');
    // New content: foo no longer exists, only baz
    await writeFile(srcFile, 'export function baz() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    // Stale edge (foo → bar) should be gone since we deleted edges for src/a.ts
    const store2 = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const { outgoing } = store2.getEdgesForFile('src/a.ts');
    store2.close();
    // baz() doesn't call anything → 0 outgoing edges; stale edge was removed
    expect(outgoing.filter(e => e.calleeName === 'bar')).toHaveLength(0);
  });

  it('recomputes the CFG/def-use overlay on a file edit, matching a fresh build (spec: incrementality)', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath } = await setupProject(ctx);
    await mkdir(join(rootPath, 'src'), { recursive: true });
    const rel = 'src/calc.ts';
    const srcFile = join(rootPath, rel);

    const { CallGraphBuilder } = await import('../analyzer/call-graph.js');
    // Seed the DB with the v1 overlay + node + file hash so the watcher sees a real change.
    const v1 = 'export function calc(a: number) {\n  let x = a;\n  return x;\n}';
    await writeFile(srcFile, v1, 'utf-8');
    const buildOverlay = async (content: string) => {
      const r = await new CallGraphBuilder().build([{ path: rel, content, language: 'TypeScript' }]);
      return { nodes: Array.from(r.nodes.values()), cfgs: r.cfgs! };
    };
    const { createHash } = await import('node:crypto');
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const b1 = await buildOverlay(v1);
    store.insertNodes(b1.nodes);
    store.insertCfgs([...b1.cfgs].map(([id, cfg]) => ({ functionId: id, filePath: rel, cfg })));
    store.setFileHash(rel, createHash('sha256').update(v1).digest('hex'));
    store.close();

    // Edit the file: add a reassignment so the overlay genuinely changes.
    const v2 = 'export function calc(a: number) {\n  let x = a;\n  x = x + 1;\n  return x;\n}';
    await writeFile(srcFile, v2, 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath, outputPath }).handleChange(srcFile);

    // The persisted overlay must equal a fresh full build of v2 (intra-procedural
    // ⇒ incremental == full), and must NOT be the stale v1.
    const expected = await buildOverlay(v2);
    const store2 = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const stored = store2.getCfg('src/calc.ts::calc');
    store2.close();
    expect(stored).toBeTruthy();
    expect(stored).toEqual(expected.cfgs.get('src/calc.ts::calc'));
    // v1 had `return x` depend on def@2; v2 must now depend on the x=x+1 def@3.
    const toReturn = stored!.defUse.filter(e => e.variable === 'x' && e.useLine === 4);
    expect(toReturn.every(e => e.defLine === 3)).toBe(true);
  });

  it('a C# edit refreshes (does NOT wipe) its nodes/overlay — watcher graph-lang coverage', async () => {
    // C# (.cs) matches SOURCE_EXTENSIONS, so the watcher must also graph it,
    // otherwise editing a .cs file made buildGraphSubset return empty and the
    // swap wiped the file's nodes + overlay (graph-coverage regression).
    const ctx = makeContext();
    const { rootPath, outputPath } = await setupProject(ctx);
    await mkdir(join(rootPath, 'src'), { recursive: true });
    const rel = 'src/A.cs';
    const srcFile = join(rootPath, rel);
    const { CallGraphBuilder } = await import('../analyzer/call-graph.js');
    const { createHash } = await import('node:crypto');
    const v1 = 'class A { int f(int a){ int x=a; return x; } }';
    await writeFile(srcFile, v1, 'utf-8');
    const r = await new CallGraphBuilder().build([{ path: rel, content: v1, language: 'C#' }]);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    store.insertNodes(Array.from(r.nodes.values()));
    store.insertCfgs([...r.cfgs!].map(([id, cfg]) => ({ functionId: id, filePath: rel, cfg })));
    store.setFileHash(rel, createHash('sha256').update(v1).digest('hex'));
    store.close();

    await writeFile(srcFile, 'class A { int f(int a){ int x=a; x=x+1; return x; } }', 'utf-8');
    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath, outputPath }).handleChange(srcFile);

    const store2 = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const nodes = store2.getNodesForFile(rel);
    const overlay = store2.getCfg('src/A.cs::A.f');
    store2.close();
    expect(nodes.length).toBe(1);   // node preserved, not wiped
    expect(overlay).toBeTruthy();   // overlay refreshed, not wiped
  });

  it('skips re-index when file content is unchanged (hash cache hit)', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'stable.ts');
    const content = 'export function stable() {}';
    await writeFile(srcFile, content, 'utf-8');

    // Seed hash cache with the same content (relative path — DB convention)
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const { createHash } = await import('node:crypto');
    store.setFileHash('src/stable.ts', createHash('sha256').update(content).digest('hex'));
    store.close();

    const before = await readFile(contextPath, 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    // llm-context.json must not be written: the only changed file was a no-op
    // autosave (hash hit), so the batch has nothing to persist.
    const after = await readFile(contextPath, 'utf-8');
    expect(after).toBe(before);
  });
});

// ── Vector update path (updateVectors → VectorIndex.updateFiles) ────────────────

describe('McpWatcher vector update (Spec 13.1 — row-level updateFiles)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
    vi.resetModules();
    _resetContextCacheForTesting();
  });

  it('calls VectorIndex.updateFiles with a null embedder when no embedding service is available (BM25 refresh)', async () => {
    const cg = makeCallGraph();
    const ctx = makeContext({ callGraph: cg });
    const { rootPath, outputPath } = await setupProject(ctx);

    await mkdir(join(outputPath, 'vector-index'), { recursive: true });
    await writeFile(join(outputPath, 'vector-index', '.keep'), '', 'utf-8');

    const mockUpdate = vi.fn().mockResolvedValue({ embedded: 0, reused: 0, total: 1, hasEmbeddings: false });
    vi.doMock('../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), updateFiles: mockUpdate },
    }));
    vi.doMock('../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockImplementation(() => { throw new Error('no EMBED_BASE_URL'); }),
        fromConfig: vi.fn().mockReturnValue(null),
      },
    }));
    vi.doMock('./config-manager.js', () => ({
      readOpenLoreConfig: vi.fn().mockResolvedValue(null),
    }));

    const srcFile = join(rootPath, 'index.ts');
    await writeFile(srcFile, 'export function foo() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    expect(mockUpdate).toHaveBeenCalledWith(
      outputPath,
      expect.any(Array),   // changed nodes (empty here — no edge store)
      expect.any(Set),     // changed file paths
      expect.any(Array),   // signatures
      expect.any(Set),     // hub ids
      expect.any(Set),     // entry ids
      null,                // embedder unavailable → BM25 refresh
      expect.any(Map),     // file contents
    );
  });

  it('calls VectorIndex.updateFiles with the embedder when one is available', async () => {
    const cg = makeCallGraph();
    const ctx = makeContext({ callGraph: cg });
    const { rootPath, outputPath } = await setupProject(ctx);

    await mkdir(join(outputPath, 'vector-index'), { recursive: true });
    await writeFile(join(outputPath, 'vector-index', '.keep'), '', 'utf-8');

    const mockUpdate = vi.fn().mockResolvedValue({ embedded: 3, reused: 1, total: 4, hasEmbeddings: true });
    const mockEmbedSvc = {};

    vi.doMock('../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), updateFiles: mockUpdate },
    }));
    vi.doMock('../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockReturnValue(mockEmbedSvc),
        fromConfig: vi.fn(),
      },
    }));
    vi.doMock('./config-manager.js', () => ({
      readOpenLoreConfig: vi.fn().mockResolvedValue(null),
    }));

    const srcFile = join(rootPath, 'index.ts');
    await writeFile(srcFile, 'export function foo() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    expect(mockUpdate).toHaveBeenCalledWith(
      outputPath,
      expect.any(Array),
      expect.any(Set),
      expect.any(Array),
      expect.any(Set),
      expect.any(Set),
      mockEmbedSvc,
      expect.any(Map),
    );
  });

  it('logs an embed error and does not throw when VectorIndex.updateFiles throws', async () => {
    const cg = makeCallGraph();
    const ctx = makeContext({ callGraph: cg });
    const { rootPath, outputPath } = await setupProject(ctx);

    await mkdir(join(outputPath, 'vector-index'), { recursive: true });
    await writeFile(join(outputPath, 'vector-index', '.keep'), '', 'utf-8');

    vi.doMock('../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        updateFiles: vi.fn().mockRejectedValue(new Error('LanceDB connection failed')),
      },
    }));
    vi.doMock('../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockReturnValue({}),
        fromConfig: vi.fn(),
      },
    }));
    vi.doMock('./config-manager.js', () => ({
      readOpenLoreConfig: vi.fn().mockResolvedValue(null),
    }));

    const srcFile = join(rootPath, 'index.ts');
    await writeFile(srcFile, 'export function foo() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await expect(watcher.handleChange(srcFile)).resolves.not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('embed error'),
    );
  });
});

// ── Coalescing queue (Spec 13.1) ───────────────────────────────────────────────

describe('McpWatcher coalescing queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid changes to the same file into a single batch flush', async () => {
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: FIXTURE_ROOT, debounceMs: 200, embed: false });
     
    const spy = vi.spyOn(watcher as any, 'handleBatch').mockResolvedValue(undefined);
    const enqueue = (watcher as unknown as { enqueue(p: string): void }).enqueue.bind(watcher);

    for (let i = 0; i < 5; i++) enqueue(join(FIXTURE_ROOT, 'src', 'foo.ts'));

    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('coalesces changes across DIFFERENT files into ONE batch (G2)', async () => {
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: FIXTURE_ROOT, debounceMs: 200, embed: false });
     
    const spy = vi.spyOn(watcher as any, 'handleBatch').mockResolvedValue(undefined);
    const enqueue = (watcher as unknown as { enqueue(p: string): void }).enqueue.bind(watcher);

    enqueue(join(FIXTURE_ROOT, 'src', 'a.ts'));
    enqueue(join(FIXTURE_ROOT, 'src', 'b.ts'));

    await vi.runAllTimersAsync();
    // One flush carrying both paths — not one flush per file.
    expect(spy).toHaveBeenCalledTimes(1);
    const batch = spy.mock.calls[0][0] as string[];
    expect(new Set(batch)).toEqual(new Set([join(FIXTURE_ROOT, 'src', 'a.ts'), join(FIXTURE_ROOT, 'src', 'b.ts')]));
  });

  it('processes changes that arrive while a flush is in flight (no drop, single-flight)', async () => {
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: FIXTURE_ROOT, debounceMs: 100, embed: false });

    let resolveFirst!: () => void;
    const firstCall = new Promise<void>(r => { resolveFirst = r; });
    let calls = 0;
     
    vi.spyOn(watcher as any, 'handleBatch').mockImplementation(async () => {
      calls++;
      if (calls === 1) await firstCall;
    });
    const enqueue = (watcher as unknown as { enqueue(p: string): void }).enqueue.bind(watcher);

    enqueue(join(FIXTURE_ROOT, 'src', 'a.ts'));
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1); // first flush running, blocked

    // New change arrives while busy — accumulates in pending, not dropped.
    enqueue(join(FIXTURE_ROOT, 'src', 'b.ts'));
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1); // still single-flight

    resolveFirst();
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(2); // pending 'b.ts' flushed after the first finished
  });

  it('retries SQLITE_BUSY, then defers the batch without dropping it', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: FIXTURE_ROOT, debounceMs: 100, embed: false });

    let calls = 0;
    const handleBatch = vi.spyOn(watcher as any, 'handleBatch').mockImplementation(async () => {
      calls++;
      if (calls <= 4) throw new Error('SQLITE_BUSY: database is locked');
    });
    const enqueue = (watcher as unknown as { enqueue(p: string): void }).enqueue.bind(watcher);

    enqueue(join(FIXTURE_ROOT, 'src', 'contended.ts'));
    await vi.runAllTimersAsync();

    expect(handleBatch).toHaveBeenCalledTimes(5);
    expect(handleBatch.mock.calls[4][0]).toEqual([join(FIXTURE_ROOT, 'src', 'contended.ts')]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('deferred 1 change(s)'));
    stderr.mockRestore();
  });

  it('defers a batch when the spec-index lock times out', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: FIXTURE_ROOT, debounceMs: 100, embed: false });
    const specFile = join(FIXTURE_ROOT, 'openspec', 'specs', 'auth', 'spec.md');
    vi.spyOn(watcher as any, 'recordSpecIndexChanges')
      .mockRejectedValue(new SpecIndexLockTimeoutError(30_000));

    await (watcher as unknown as {
      flushBatchWithBusyRetry(batch: string[], deletions: string[]): Promise<void>;
    }).flushBatchWithBusyRetry([specFile], []);

    expect((watcher as unknown as { pending: Set<string> }).pending.has(specFile)).toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('deferred 1 change(s)'));
    stderr.mockRestore();
  });
});

describe('McpWatcher SQLite contention', () => {
  it('retries after a real write lock outlives busy_timeout', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const ctx = makeContext({ callGraph: makeCallGraph() });
    const { rootPath, outputPath } = await setupProject(ctx);
    const srcFile = join(rootPath, 'contended.ts');
    await writeFile(srcFile, 'export function contended() { return 1; }', 'utf-8');
    EdgeStore.openForAnalyze(EdgeStore.dbPath(outputPath)).close();

    const childScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked\\n');
      setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 5500);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, EdgeStore.dbPath(outputPath)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', () => resolve());
      child.stderr.once('data', (chunk) => reject(new Error(String(chunk))));
    });

    try {
      const { McpWatcher } = await import('./mcp-watcher.js');
      const watcher = new McpWatcher({ rootPath, outputPath, embed: false });
      await (watcher as unknown as {
        flushBatchWithBusyRetry(batch: string[], deletions: string[]): Promise<void>;
      }).flushBatchWithBusyRetry([srcFile], []);

      const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
      try {
        expect(store.getFileHash('contended.ts')).not.toBeNull();
      } finally {
        store.close();
      }
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('deferred 1 change(s)'));
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      stderr.mockRestore();
    }
  }, 15_000);
});

// ── start / stop ──────────────────────────────────────────────────────────────

describe('McpWatcher start/stop', () => {
  it('starts without throwing and stop resolves', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: FIXTURE_ROOT });
    await expect(watcher.start()).resolves.not.toThrow();
    await expect(watcher.stop()).resolves.not.toThrow();
  });

  it('discloses a batch that remains contended during shutdown', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { McpWatcher } = await import('./mcp-watcher.js');
      const watcher = new McpWatcher({ rootPath: FIXTURE_ROOT, embed: false });
      vi.spyOn(watcher as any, 'handleBatch').mockRejectedValue(new Error('SQLITE_LOCKED: database table is locked'));
      (watcher as unknown as { enqueue(path: string): void }).enqueue(join(FIXTURE_ROOT, 'src', 'a.ts'));

      const stopped = watcher.stop();
      await vi.runAllTimersAsync();
      await stopped;

      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('stopped with 1 change(s)'));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('run analyze to reconcile'));
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('isIgnoredRelPath — build/dependency dirs are never watched (EMFILE guard)', () => {
  // These dirs can hold hundreds of thousands of files; watching them recursively
  // EMFILEs on the first tool call. Regression guard for the proxilion (Rust,
  // 75GB target/) first-run failure. Paths are RELATIVE to the watch root.
  const ignored = [
    'target',                                   // the dir itself must match
    'target/debug/build/foo.rs',                // Rust
    'node_modules/pkg/index.js',                // JS deps
    'dist/bundle.js',                           // JS build
    'build/output.js',
    '.next/server/page.js',                     // Next.js
    'coverage/lcov.info',
    '.venv/lib/python3.12/site.py',             // Python venv
    '__pycache__/mod.cpython-312.pyc',
    '.mypy_cache/x.json',
    'vendor/golang.org/x/net/http.go',          // Go vendored
    '.gradle/caches/x.jar',                      // JVM
    'obj/Debug/app.dll',                        // .NET
    '.git/objects/ab/cdef',                     // VCS
    '.openlore/analysis/llm-context.json',
    'crates/proxy/target/debug/x.rs',           // nested target/ deep in the tree
  ];

  const watched = [
    'src/main.rs',
    'crates/proxy/src/forwarder/siem.rs',
    'src/index.ts',
    'lib/handler.py',
    'pkg/server.go',
    'src/my-target-helper.rs',                  // 'target' as a substring, not a segment
    'src/build-config.ts',                      // 'build' as a substring, not a segment
  ];

  it('ignores known build/dependency/cache/VCS directories (incl. the dir itself + nested)', async () => {
    const { isIgnoredRelPath } = await import('./mcp-watcher.js');
    for (const p of ignored) {
      expect(isIgnoredRelPath(p), `${p} should be ignored`).toBe(true);
    }
  });

  it('still watches genuine source files (no substring false-positives)', async () => {
    const { isIgnoredRelPath } = await import('./mcp-watcher.js');
    for (const p of watched) {
      expect(isIgnoredRelPath(p), `${p} should be watched`).toBe(false);
    }
    // The watch root itself ('' or '.') must not be ignored.
    expect(isIgnoredRelPath('')).toBe(false);
    expect(isIgnoredRelPath('.')).toBe(false);
  });

  it('ignores test-file suffixes', async () => {
    const { isIgnoredRelPath } = await import('./mcp-watcher.js');
    expect(isIgnoredRelPath('src/foo.test.ts')).toBe(true);
    expect(isIgnoredRelPath('src/foo.spec.js')).toBe(true);
  });

  it('handles windows-style separators', async () => {
    const { isIgnoredRelPath } = await import('./mcp-watcher.js');
    expect(isIgnoredRelPath('target\\debug\\x.rs')).toBe(true);
    expect(isIgnoredRelPath('src\\main.rs')).toBe(false);
  });
});

describe('McpWatcher — real chokidar prunes build dirs (does not FD-storm target/)', () => {
  // The real EMFILE fix: chokidar must PRUNE an ignored directory subtree, not
  // descend into it and open FDs for every file before pruning. Uses the real
  // chokidar (not the module mock above) via a fresh dynamic import in an
  // isolated module registry.
  it('watches source but never opens target/ children', async () => {
    const { mkdtemp: mkdtempReal, writeFile: writeFileReal, mkdir: mkdirReal } = await import('node:fs/promises');
    const { tmpdir: tmpdirReal } = await import('node:os');
    const { join: pjoin } = await import('node:path');

    const root = await mkdtempReal(pjoin(tmpdirReal(), 'mcp-prune-'));
    await mkdirReal(pjoin(root, 'src'), { recursive: true });
    await mkdirReal(pjoin(root, 'target', 'debug', 'deps'), { recursive: true });
    await writeFileReal(pjoin(root, 'src', 'main.rs'), 'fn main() {}');
    for (let i = 0; i < 40; i++) {
      await writeFileReal(pjoin(root, 'target', 'debug', 'deps', `f${i}.rs`), '// gen');
    }

    // Use the real chokidar + the real ignore predicate, not the vi.mock.
    const chokidarMod = await vi.importActual<typeof import('chokidar')>('chokidar');
    const chokidar = chokidarMod.default;
    const { isIgnoredRelPath } = await import('./mcp-watcher.js');
    const { relative: prel, sep } = await import('node:path');

    const seen: string[] = [];
    const w = chokidar.watch(root, {
      ignored: (p: string) => isIgnoredRelPath(prel(root, p)),
      ignoreInitial: false,
      persistent: true,
    });
    w.on('add', (p: string) => seen.push(p));
    await new Promise<void>((res) => w.on('ready', () => res()));
    await w.close();

    expect(seen.some((p) => p.endsWith('main.rs'))).toBe(true);
    expect(seen.some((p) => p.includes(`${sep}target${sep}`))).toBe(false);
  });
});
