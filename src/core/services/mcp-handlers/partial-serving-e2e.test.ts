/**
 * The partial first-run index serves real facts, and the receipt reaches every transport
 * (change: refine-first-run-partial-serving).
 *
 * Its own file because it drives the REAL handlers through the REAL dispatcher: the sibling
 * unit file mocks `./utils.js` wholesale, and a `vi.doMock` survives `vi.resetModules()`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushPartialIndex, type PartialIndexStamp } from '../../runtime/partial-index.js';

function stampOf(analysisDir: string, overrides: Partial<PartialIndexStamp> = {}): PartialIndexStamp {
  return {
    partial: true,
    phase: 'extractors',
    buildPhase: 'extractors',
    filesExtracted: 0,
    filesTotal: 240,
    filesMapped: 238,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    analysisDir,
    ...overrides,
  };
}

describe('the flushed facts are actually served, and the receipt rides the result', () => {
  let root: string;
  let analysisDir: string;

  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(join(tmpdir(), 'openlore-partial-facts-'));
    analysisDir = join(root, '.openlore', 'analysis');
    await mkdir(analysisDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A partial index holding a real dependency graph, as a first build would flush. */
  async function plantWithGraph(): Promise<void> {
    const stamp = stampOf(analysisDir, { filesMapped: 3, filesTotal: 3 });
    await flushPartialIndex(analysisDir, {
      repoStructure: { projectName: 'demo', domains: [{ name: 'core', files: ['src/a.ts'] }] },
      llmContext: { phase1_survey: { purpose: 'partial', files: [] }, partial: stamp },
      dependencyGraph: {
        nodes: [{ id: 'src/a.ts' }, { id: 'src/b.ts' }, { id: 'src/c.ts' }],
        edges: [{ source: 'src/a.ts', target: 'src/b.ts' }],
        clusters: [{ id: 'core', name: 'core', files: ['src/a.ts', 'src/b.ts'] }],
        cycles: [],
        statistics: { nodeCount: 3, edgeCount: 1, clusterCount: 1, cycleCount: 0, avgDegree: 0.7 },
      },
      stamp,
    });
  }

  it('get_architecture_overview answers from the partial graph instead of fabricating zeroes', async () => {
    // The regression this guards: with a partial CONTEXT but no published dependency graph,
    // the `!depGraph && !ctx` guard fell through and the overview was built from `?? []` /
    // `?? 0` defaults — a fabricated negative with no error and no boundary, while the real
    // graph sat unread in the partial index.
    const { _resetJsonArtifactCacheForTesting } = await import('./artifact-cache.js');
    const { _resetContextCacheForTesting } = await import('./utils.js');
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    _resetJsonArtifactCacheForTesting();
    _resetContextCacheForTesting();
    await plantWithGraph();

    const result = await handleGetArchitectureOverview(root) as {
      error?: string;
      summary?: { totalFiles: number; totalEdges: number };
      globalEntryPoints?: unknown;
      criticalHubs?: unknown;
      omitted?: string[];
    };

    expect(result.error).toBeUndefined();
    expect(result.summary?.totalFiles).toBe(3);
    expect(result.summary?.totalEdges).toBe(1);
    // And the half it CANNOT know is omitted, not reported as empty. `criticalHubs: []` reads as
    // "this repository has no hubs"; `role: 'internal'` on every cluster reads as an
    // architectural finding. Both are derived from a call graph that does not exist yet.
    expect(result.globalEntryPoints).toBeUndefined();
    expect(result.criticalHubs).toBeUndefined();
    expect(result.omitted).toContain('criticalHubs');
  });

  it('dispatchTool attaches the receipt, so every transport carries it', async () => {
    // The receipt is attached below the handlers and above the transports. That is what makes
    // it reach the serve daemon's `sendJson` and every CLI wrapper, not just stdio MCP.
    const { _resetJsonArtifactCacheForTesting } = await import('./artifact-cache.js');
    const { _resetContextCacheForTesting } = await import('./utils.js');
    const { dispatchTool } = await import('../tool-dispatch.js');
    _resetJsonArtifactCacheForTesting();
    _resetContextCacheForTesting();
    await plantWithGraph();

    const result = await dispatchTool('get_architecture_overview', { directory: root }, root) as {
      partialIndex?: { partial: boolean; buildPhase: string; detail: string };
    };

    expect(result.partialIndex?.partial).toBe(true);
    expect(result.partialIndex?.buildPhase).toBe('extractors');
    expect(result.partialIndex?.detail).toContain('first analysis is still running');
  });

  it('a not-ready tool is told the build is running, not to start one', async () => {
    const { _resetContextCacheForTesting } = await import('./utils.js');
    const { dispatchTool } = await import('../tool-dispatch.js');
    _resetContextCacheForTesting();
    await plantWithGraph();

    // `find_path` needs a call graph, which a partial index never has: it must still refuse —
    // but the refusal now arrives with the receipt rather than "run openlore analyze" alone.
    const result = await dispatchTool('find_path', { directory: root, from: 'a', to: 'b' }, root) as {
      notReady?: boolean;
      partialIndex?: { detail: string };
    };

    expect(result.notReady).toBe(true);
    expect(result.partialIndex?.detail).toContain('first analysis is still running');
  });

  it('orient — which refuses before ever reading the context — still carries the receipt', async () => {
    // The headline path, and the one the ALS receipt CANNOT cover: `orient` returns not-ready
    // on a missing search index before it calls `readCachedContext`, so nothing marks the
    // request. It is the cold-path disk check in `dispatchTool` that must answer here — without
    // it, the first tool a new user reaches for during their first build still says
    // "run openlore analyze".
    const { _resetContextCacheForTesting } = await import('./utils.js');
    const { dispatchTool } = await import('../tool-dispatch.js');
    _resetContextCacheForTesting();
    await plantWithGraph();

    const result = await dispatchTool('orient', { directory: root, task: 'anything' }, root) as {
      notReady?: boolean;
      partialIndex?: { detail: string };
    };

    expect(result.notReady).toBe(true);
    expect(result.partialIndex?.detail).toContain('first analysis is still running');
  });

  it('a handler that reports a bare error, with no not-ready shape, still carries it', async () => {
    // About eighteen handlers report an unusable index as a plain `{error}` string rather than
    // the structured not-ready shape. Every one of them says "re-run analyze" during a build
    // that is already running unless the cold-path check covers bare errors too.
    const { dispatchTool } = await import('../tool-dispatch.js');
    await plantWithGraph();

    const result = await dispatchTool('get_refactor_report', { directory: root }, root) as {
      error?: string;
      partialIndex?: { detail: string };
    };

    expect(typeof result.error).toBe('string');
    expect(result.partialIndex?.detail).toContain('first analysis is still running');
  });

  it('never stamps an answer with another repository\'s receipt', async () => {
    // A federated read consults a PEER repository's context. If that peer is mid-build, the
    // request-scoped note fires for the peer — and without this check the local, complete answer
    // would carry a receipt reading "this repository's first analysis is still running", with
    // the peer's file counts.
    const { notePartialIndexServed, withPartialReceiptScope } = await import('./partial-request.js');
    const { dispatchTool } = await import('../tool-dispatch.js');

    const foreign = { ...stampOf('/some/other/repo/.openlore/analysis') };
    const result = await withPartialReceiptScope(async () => {
      notePartialIndexServed(foreign);
      return dispatchTool('find_path', { directory: root, from: 'a', to: 'b' }, root);
    }) as { partialIndex?: unknown };

    expect(result.partialIndex).toBeUndefined();
  });

  it('attaches nothing when there is no partial index', async () => {
    const { dispatchTool } = await import('../tool-dispatch.js');

    const result = await dispatchTool('find_path', { directory: root, from: 'a', to: 'b' }, root) as {
      partialIndex?: unknown;
    };

    expect(result.partialIndex).toBeUndefined();
  });
});
