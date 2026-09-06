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

function stampOf(overrides: Partial<PartialIndexStamp> = {}): PartialIndexStamp {
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
    absent: ['the call graph'],
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
    const stamp = stampOf({ filesMapped: 3, filesTotal: 3 });
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
    };

    expect(result.error).toBeUndefined();
    expect(result.summary?.totalFiles).toBe(3);
    expect(result.summary?.totalEdges).toBe(1);
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

  it('attaches nothing when there is no partial index', async () => {
    const { dispatchTool } = await import('../tool-dispatch.js');

    const result = await dispatchTool('find_path', { directory: root, from: 'a', to: 'b' }, root) as {
      partialIndex?: unknown;
    };

    expect(result.partialIndex).toBeUndefined();
  });
});
