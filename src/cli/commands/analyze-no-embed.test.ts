/**
 * Regression test for the `--no-embed` flag.
 *
 * Bug: `analyze --no-embed` used to skip the entire index-building step, which
 * meant no BM25 keyword index was written and orient() later failed with
 * "No analysis found". `--no-embed` must build a keyword-only (BM25) index
 * (null embedder), not skip indexing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted so the vi.mock factories below (which are hoisted to the top of the
// module) can safely reference these spies.
const { buildMock, fromEnvMock, fromConfigMock } = vi.hoisted(() => ({
  buildMock: vi.fn(),
  fromEnvMock: vi.fn(),
  fromConfigMock: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    section: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(),
    success: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access:    vi.fn().mockResolvedValue(undefined),
    stat:      vi.fn().mockResolvedValue({ mtime: new Date() }),
    mkdir:     vi.fn().mockResolvedValue(undefined),
    readFile:  vi.fn().mockResolvedValue('{}'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    // `mkdir` above is stubbed, so nothing real exists to open. These cover the streaming
    // artifact writer (`json-stream.ts`), which writes via a temp file handle + rename rather
    // than `writeFile` — without them analyze aborts at the artifact write and never reaches
    // what these cases actually assert.
    open: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue({ bytesWritten: 0 }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

// fileExists(false) → getAnalysisAge null (fresh analysis) AND spec indexing skipped.
vi.mock('../../utils/command-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/command-helpers.js')>();
  return {
    ...actual,
    fileExists: vi.fn().mockResolvedValue(false),
    getAnalysisAge: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('../../core/analyzer/repository-mapper.js', () => ({
  RepositoryMapper: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      map: vi.fn().mockResolvedValue({
        allFiles: [], highValueFiles: [], metadata: { projectName: 'proj' },
        summary: { totalFiles: 1, analyzedFiles: 1, skippedFiles: 0, languages: [] },
      }),
    });
  }),
}));

vi.mock('../../core/analyzer/dependency-graph.js', () => ({
  DependencyGraphBuilder: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      build: vi.fn().mockResolvedValue({
        statistics: { nodeCount: 2, edgeCount: 1, clusterCount: 0, cycleCount: 0, avgDegree: 1 },
      }),
    });
  }),
}));

// callGraph WITH nodes so runEmbedStep reaches VectorIndex.build.
const CALL_GRAPH = {
  nodes: [{ id: 'a.ts::f', name: 'f', filePath: 'a.ts', line: 1, kind: 'function', calls: [] }],
  hubFunctions: [], entryPoints: [],
  stats: { totalNodes: 1, totalEdges: 0 },
};

vi.mock('../../core/analyzer/artifact-generator.js', () => ({
  AnalysisArtifactGenerator: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      generateAndSave: vi.fn().mockResolvedValue({
        repoStructure: {
          architecture: { pattern: 'unknown' }, domains: [], uiComponents: [],
          schemas: [], routeInventory: { total: 0, byMethod: {}, byFramework: {}, routes: [] },
          middleware: [], envVars: [],
        },
        llmContext: { callGraph: CALL_GRAPH, signatures: [] },
      }),
    });
  }),
  repoStructureToRepoMap: vi.fn().mockReturnValue({}),
}));

vi.mock('../../core/analyzer/architecture-writer.js', () => ({
  buildArchitectureOverview: vi.fn().mockReturnValue({}),
  writeArchitectureMd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/analyzer/codebase-digest.js', () => ({
  generateCodebaseDigest: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../core/analyzer/ui-component-extractor.js', () => ({ extractUIComponents: vi.fn().mockResolvedValue([]) }));
vi.mock('../../core/analyzer/schema-extractor.js', () => ({ extractSchemas: vi.fn().mockResolvedValue([]) }));
vi.mock('../../core/analyzer/http-route-parser.js', () => ({
  buildRouteInventory: vi.fn().mockResolvedValue({ total: 0, byMethod: {}, byFramework: {}, routes: [] }),
  extractAllHttpEdges: vi.fn().mockResolvedValue({ calls: [], routes: [], edges: [] }),
}));
vi.mock('../../core/analyzer/middleware-extractor.js', () => ({ extractMiddleware: vi.fn().mockResolvedValue([]) }));
vi.mock('../../core/analyzer/env-extractor.js', () => ({ extractEnvVars: vi.fn().mockResolvedValue([]) }));
vi.mock('../../core/analyzer/ai-config-generator.js', () => ({
  generateAiConfigs: vi.fn().mockResolvedValue([]), AI_TOOL_TARGETS: [],
}));

vi.mock('../../core/services/config-manager.js', () => ({ readOpenLoreConfig: vi.fn() }));

vi.mock('../../core/analyzer/vector-index.js', () => ({
  VectorIndex: { build: buildMock, exists: vi.fn().mockReturnValue(false) },
}));

vi.mock('../../core/analyzer/embedding-service.js', () => ({
  EmbeddingService: { fromEnv: fromEnvMock, fromConfig: fromConfigMock },
}));

vi.mock('../../core/analyzer/spec-vector-index.js', () => ({
  SpecVectorIndex: { build: vi.fn().mockResolvedValue({ recordCount: 0, hasEmbeddings: false }), exists: vi.fn().mockReturnValue(false) },
}));

import { analyzeCommand } from './analyze.js';

const FAKE_CONFIG = {
  version: '1.0.0', projectType: 'nodejs' as const, openspecPath: './openspec',
  analysis: { maxFiles: 100000, includePatterns: [], excludePatterns: [] },
  generation: { provider: 'openai' as const, model: 'gpt-4', domains: 'auto' as const },
  createdAt: new Date().toISOString(), lastRun: null,
};

describe('analyze --no-embed builds a keyword (BM25) index', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    buildMock.mockReset().mockResolvedValue({
      hasEmbeddings: false,
      total: CALL_GRAPH.stats.totalNodes,
      productionFunctions: CALL_GRAPH.stats.totalNodes,
      testFunctions: 0,
      signatureOnlySymbols: 0,
      reused: 0,
      embedded: 0,
    });
    fromEnvMock.mockReset().mockImplementation(() => { throw new Error('no embedder'); });
    fromConfigMock.mockReset().mockReturnValue(null);
    const cfgMod = await import('../../core/services/config-manager.js');
    vi.mocked(cfgMod.readOpenLoreConfig).mockResolvedValue(FAKE_CONFIG);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/fake/root');
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
    // analyzeCommand is a module-level singleton; commander retains --embed
    // between parseAsync() calls, so a prior --no-embed test would leave
    // embed=false and pollute the default-path test. Reset to the declared
    // default (true).
    analyzeCommand.setOptionValue('embed', true);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    consoleSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('still calls VectorIndex.build (does NOT skip indexing) with --no-embed', async () => {
    await analyzeCommand.parseAsync(['--no-embed'], { from: 'user' });
    expect(buildMock).toHaveBeenCalledTimes(1);
  });

  it('builds with a null embedder under --no-embed (keyword-only, no embedding attempt)', async () => {
    await analyzeCommand.parseAsync(['--no-embed'], { from: 'user' });
    // 6th positional arg (index 5) is the embedding service — must be null.
    expect(buildMock.mock.calls[0][5]).toBeNull();
    // --no-embed must not even attempt to resolve an embedder.
    expect(fromEnvMock).not.toHaveBeenCalled();
    expect(fromConfigMock).not.toHaveBeenCalled();
  });

  it('also builds the index by default (no flag), falling back to BM25 when no embedder', async () => {
    await analyzeCommand.parseAsync([], { from: 'user' });
    expect(buildMock).toHaveBeenCalledTimes(1);
    // Default path DOES attempt to resolve an embedder (then falls back).
    expect(fromEnvMock).toHaveBeenCalled();
  });

  it('prints the same function count as the call graph when no extra populations are indexed', async () => {
    await analyzeCommand.parseAsync(['--no-embed'], { from: 'user' });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Function index built [keyword] (${CALL_GRAPH.stats.totalNodes} functions)`),
    );
  });
});
