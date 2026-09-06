/**
 * Tests for openloreAnalyze programmatic API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join, resolve } from 'node:path';
import { openloreAnalyze } from './analyze.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn().mockResolvedValue(undefined),
    realpath: vi.fn(async (path: string) => path),
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../core/services/config-manager.js', () => ({
  readOpenLoreConfig: vi.fn(),
}));

vi.mock('../core/runtime/advisory-lock.js', () => ({
  withAnalysisLock: vi.fn(async (_dir: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../core/runtime/analysis-ownership.js', () => ({
  acquireAnalysisOwnership: vi.fn(),
}));

vi.mock('../core/decisions/atomic-store.js', () => ({ atomicWriteFile: vi.fn() }));

vi.mock('../core/runtime/analysis-generation.js', () => ({
  REQUIRED_ANALYSIS_ARTIFACTS: ['repo-structure.json', 'llm-context.json', 'dependency-graph.json', 'fingerprint.json'],
  publishGeneration: vi.fn(async () => ({ generationId: 'test-generation' })),
  readGenerationSnapshot: vi.fn(async (_dir: string, _required: string[], read: () => Promise<unknown>) => ({
    state: 'ok', value: await read(), generationId: 'test-generation', compatibility: 'manifest', coherence: 'full',
  })),
}));

vi.mock('../core/services/mcp-handlers/utils.js', () => ({
  computeProjectFingerprint: vi.fn(async () => 'test-fingerprint'),
  isCacheFresh: vi.fn(async () => false),
}));

vi.mock('../core/analyzer/analysis-core.js', () => ({
  runAnalysisCore: vi.fn(),
  isAnalysisCacheFresh: vi.fn(async () => false),
  analysisConfigFingerprintInput: vi.fn((_configured, include, exclude, maxFiles) => ({
    includePatterns: include, excludePatterns: exclude, maxFiles,
  })),
  analysisGeneratedExcludes: vi.fn(() => ['.openlore/analysis/**', 'openspec/**']),
}));

vi.mock('../core/analyzer/analysis-indexes.js', () => ({
  buildAnalysisIndexes: vi.fn(async () => ({ functionIndex: 'built', textIndex: 'built', specIndex: 'built', degraded: [] })),
}));

vi.mock('../core/analyzer/repository-mapper.js', () => ({
  RepositoryMapper: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, { map: vi.fn() });
  }),
}));

vi.mock('../core/analyzer/dependency-graph.js', () => ({
  DependencyGraphBuilder: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, { build: vi.fn() });
  }),
}));

vi.mock('../core/analyzer/artifact-generator.js', () => ({
  AnalysisArtifactGenerator: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, { generateAndSave: vi.fn() });
  }),
  repoStructureToRepoMap: vi.fn().mockImplementation((rs: Record<string, unknown>) => {
    const stats = (rs.statistics ?? {}) as Record<string, number>;
    return {
      metadata: { projectName: '', projectType: 'nodejs', rootPath: '', analyzedAt: '', version: '' },
      summary: {
        totalFiles: stats.totalFiles ?? 0,
        analyzedFiles: stats.analyzedFiles ?? 0,
        skippedFiles: stats.skippedFiles ?? 0,
        languages: [], frameworks: [], directories: [],
      },
      highValueFiles: [], entryPoints: [], schemaFiles: [], configFiles: [],
      clusters: { byDirectory: {}, byDomain: {}, byLayer: { presentation: [], business: [], data: [], infrastructure: [] } },
      allFiles: [],
    };
  }),
}));

import { access, stat, readFile } from 'node:fs/promises';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { RepositoryMapper } from '../core/analyzer/repository-mapper.js';
import { DependencyGraphBuilder } from '../core/analyzer/dependency-graph.js';
import { AnalysisArtifactGenerator } from '../core/analyzer/artifact-generator.js';
import { acquireAnalysisOwnership } from '../core/runtime/analysis-ownership.js';
import { readGenerationSnapshot } from '../core/runtime/analysis-generation.js';
import { isAnalysisCacheFresh, runAnalysisCore } from '../core/analyzer/analysis-core.js';
import { buildAnalysisIndexes } from '../core/analyzer/analysis-indexes.js';

const mockAccess = vi.mocked(access);
const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);
const mockReadOpenLoreConfig = vi.mocked(readOpenLoreConfig);
const mockAcquireAnalysisOwnership = vi.mocked(acquireAnalysisOwnership);
const mockReadGenerationSnapshot = vi.mocked(readGenerationSnapshot);
const mockIsCacheFresh = vi.mocked(isAnalysisCacheFresh);
const mockRunAnalysisCore = vi.mocked(runAnalysisCore);
const mockOwnershipUpdate = vi.fn().mockResolvedValue(undefined);
const mockOwnershipRelease = vi.fn().mockResolvedValue(undefined);

// ============================================================================
// FIXTURES
// ============================================================================

const ROOT = resolve('/test/project');
const MOCK_CONFIG = { version: '1.0.0', openspecPath: './openspec' };
const MOCK_REPO_STRUCTURE = JSON.stringify({ architecture: { pattern: 'layered' }, domains: [] });
const MOCK_DEP_GRAPH = JSON.stringify({
  statistics: {
    nodeCount: 1,
    edgeCount: 0,
    clusterCount: 0,
    cycleCount: 0,
    avgDegree: 0,
    density: 0,
  },
});
const MOCK_ARTIFACTS = {
  repoStructure: { architecture: { pattern: 'layered' }, domains: [] },
  llmContext: { callGraph: null },
};
const OLD_MTIME = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
const RECENT_MTIME = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago

function setupMocks() {
  mockIsCacheFresh.mockResolvedValue(false);
  mockOwnershipUpdate.mockResolvedValue(undefined);
  mockOwnershipRelease.mockResolvedValue(undefined);
  mockAcquireAnalysisOwnership.mockResolvedValue({
    state: 'owned',
    payload: {
      repository: ROOT,
      pid: process.pid,
      startedAt: '2026-08-15T00:00:00.000Z',
      heartbeatAt: '2026-08-15T00:00:00.000Z',
      stage: 'starting',
      progressPath: join(ROOT, '.openlore', 'runtime', 'analysis-progress.json'),
    },
    waitedMs: 0,
    update: mockOwnershipUpdate,
    release: mockOwnershipRelease,
  });
  mockReadOpenLoreConfig.mockResolvedValue(
    MOCK_CONFIG as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never
  );

  vi.mocked(RepositoryMapper).mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      map: vi.fn().mockResolvedValue({
        allFiles: [],
        highValueFiles: [],
        summary: { totalFiles: 1, analyzedFiles: 1, skippedFiles: 0, languages: ['typescript'] },
      }),
    });
  });

  vi.mocked(DependencyGraphBuilder).mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      build: vi.fn().mockResolvedValue({
        statistics: {
          nodeCount: 1,
          edgeCount: 0,
          clusterCount: 0,
          cycleCount: 0,
          avgDegree: 0,
          density: 0,
        },
      }),
    });
  });

  vi.mocked(AnalysisArtifactGenerator).mockImplementation(function (this: unknown) {
    Object.assign(this as object, { generateAndSave: vi.fn().mockResolvedValue(MOCK_ARTIFACTS) });
  });
  mockRunAnalysisCore.mockResolvedValue({
    repoMap: {
      allFiles: [], highValueFiles: [], entryPoints: [], schemaFiles: [], configFiles: [],
      metadata: { projectName: '', projectType: 'nodejs', rootPath: ROOT, analyzedAt: '', version: '' },
      summary: { totalFiles: 1, analyzedFiles: 1, skippedFiles: 0, languages: [], frameworks: [], directories: [] },
      clusters: { byDirectory: {}, byDomain: {}, byLayer: { presentation: [], business: [], data: [], infrastructure: [] } },
    },
    depGraph: JSON.parse(MOCK_DEP_GRAPH),
    artifacts: MOCK_ARTIFACTS as never,
    duration: 1,
  });
}

// ============================================================================
// TESTS
// ============================================================================

describe('openloreAnalyze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  describe('config validation', () => {
    it('throws if no openlore config found', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      mockReadOpenLoreConfig.mockResolvedValue(
        null as unknown as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never
      );

      await expect(openloreAnalyze({ rootPath: ROOT })).rejects.toThrow();
    });
  });

  describe('cache hit — recent analysis', () => {
    beforeEach(() => {
      mockAccess.mockResolvedValue(undefined);
      mockStat.mockResolvedValue({ mtime: RECENT_MTIME } as Awaited<ReturnType<typeof stat>>);
      mockReadFile.mockImplementation((path) => {
        const p = String(path);
        if (p.includes('dependency-graph')) return Promise.resolve(MOCK_DEP_GRAPH);
        return Promise.resolve(MOCK_REPO_STRUCTURE);
      });
      mockIsCacheFresh.mockResolvedValue(true);
    });

    it('skips mapper when recent cache exists', async () => {
      const result = await openloreAnalyze({ rootPath: ROOT });
      expect(mockRunAnalysisCore).not.toHaveBeenCalled();
      expect(mockAcquireAnalysisOwnership).not.toHaveBeenCalled();
      expect(result.fromCache).toBe(true);
      expect(buildAnalysisIndexes).toHaveBeenCalled();
      expect(buildAnalysisIndexes).toHaveBeenCalledWith(expect.not.objectContaining({ keywordOnly: true }));
    });

    it('returns cached index degradation disclosures', async () => {
      vi.mocked(buildAnalysisIndexes).mockResolvedValueOnce({
        functionIndex: 'built', textIndex: 'skipped', specIndex: 'built',
        degraded: [{ index: 'text', reason: 'index write failed' }],
      });
      const result = await openloreAnalyze({ rootPath: ROOT });
      expect(result.indexDegradations).toEqual([{ index: 'text', reason: 'index write failed' }]);
    });

    it('binds cached index validation to the consumed analysis generation', async () => {
      await openloreAnalyze({ rootPath: ROOT });
      expect(buildAnalysisIndexes).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'test-generation' }));
    });

    it('discloses a missing dependency graph instead of fabricating an empty graph', async () => {
      mockAccess.mockImplementation(async path => {
        if (String(path).includes('dependency-graph.json')) throw new Error('ENOENT');
      });
      const result = await openloreAnalyze({ rootPath: ROOT });
      expect(result).toMatchObject({
        fromCache: true,
        degraded: { artifact: 'dependency-graph.json', reason: 'missing' },
      });
      expect(result.depGraph).toBeUndefined();
    });

    it('force=true bypasses cache and runs full analysis', async () => {
      await openloreAnalyze({ rootPath: ROOT, force: true });
      expect(mockRunAnalysisCore).toHaveBeenCalled();
    });

    it('rebuilds instead of serving a TTL-fresh mixed generation', async () => {
      mockReadGenerationSnapshot.mockResolvedValueOnce({
        state: 'analysis-changed', message: 'changed',
      });
      await openloreAnalyze({ rootPath: ROOT });
      expect(mockRunAnalysisCore).toHaveBeenCalled();
      expect(mockAcquireAnalysisOwnership).toHaveBeenCalled();
    });
  });

  describe('cache miss — stale analysis', () => {
    beforeEach(() => {
      mockAccess.mockResolvedValue(undefined);
      mockStat.mockResolvedValue({ mtime: OLD_MTIME } as Awaited<ReturnType<typeof stat>>);
    });

    it('runs full analysis pipeline', async () => {
      await openloreAnalyze({ rootPath: ROOT });

      expect(mockRunAnalysisCore).toHaveBeenCalled();
    });
  });

  describe('cache miss — no existing file', () => {
    beforeEach(() => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
    });

    it('runs full analysis pipeline', async () => {
      await openloreAnalyze({ rootPath: ROOT });

      expect(mockRunAnalysisCore).toHaveBeenCalled();
    });

    it('checks freshness against a custom analysis output directory', async () => {
      await openloreAnalyze({ rootPath: ROOT, outputPath: 'custom-analysis' });
      expect(mockIsCacheFresh).toHaveBeenCalledWith(ROOT, join(ROOT, 'custom-analysis'), {
        includePatterns: [], excludePatterns: [], maxFiles: 100000,
      });
    });

    it('returns analysis result with repo map', async () => {
      const result = await openloreAnalyze({ rootPath: ROOT });
      expect(result.repoMap).toBeDefined();
      expect(result.depGraph).toBeDefined();
      expect(result.fromCache).toBe(false);
      expect(buildAnalysisIndexes).toHaveBeenCalledWith(expect.not.objectContaining({ keywordOnly: true }));
    });

    it('holds repository ownership across the full analysis and releases it', async () => {
      await openloreAnalyze({ rootPath: ROOT });

      expect(mockAcquireAnalysisOwnership).toHaveBeenCalledWith(
        ROOT,
        join(ROOT, '.openlore', 'analysis'),
        { stage: 'starting' },
      );
      expect(mockAcquireAnalysisOwnership.mock.invocationCallOrder[0]).toBeLessThan(
        mockRunAnalysisCore.mock.invocationCallOrder[0],
      );
      expect(mockOwnershipRelease).toHaveBeenCalledOnce();
    });

    it('does no analysis when another frontend owns the repository', async () => {
      mockAcquireAnalysisOwnership.mockResolvedValueOnce({
        state: 'in-progress',
        owner: {
          repository: ROOT,
          pid: 4321,
          startedAt: '2026-08-15T00:00:00.000Z',
          heartbeatAt: '2026-08-15T00:00:01.000Z',
          stage: 'dependency-graph',
          progressPath: join(ROOT, '.openlore', 'runtime', 'analysis-progress.json'),
        },
        elapsedMs: 1_000,
        heartbeatAgeMs: 25,
        progressPath: join(ROOT, '.openlore', 'runtime', 'analysis-progress.json'),
      });

      const error = await openloreAnalyze({ rootPath: ROOT })
        .then(() => { throw new Error('expected analysis contention'); })
        .catch(value => value as Error & { code?: string });
      expect(error).toMatchObject({ name: 'OpenLoreError', code: 'pipeline-failed' });
      expect(error.cause).toMatchObject({
        name: 'AnalysisInProgressError', code: 'ANALYSIS_IN_PROGRESS',
        owner: { pid: 4321, stage: 'dependency-graph' },
      });
      expect(mockRunAnalysisCore).not.toHaveBeenCalled();
    });

    it('releases repository ownership when analysis fails', async () => {
      mockRunAnalysisCore.mockRejectedValueOnce(new Error('scan failed'));

      await expect(openloreAnalyze({ rootPath: ROOT })).rejects.toMatchObject({
        code: 'pipeline-failed',
        cause: expect.objectContaining({ message: 'scan failed' }),
      });
      expect(mockOwnershipRelease).toHaveBeenCalledOnce();
    });
  });

  describe('progress callbacks', () => {
    beforeEach(() => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
    });

    it('fires progress events during analysis', async () => {
      const events: Array<{ step: string; status: string }> = [];
      await openloreAnalyze({
        rootPath: ROOT,
        onProgress: (e) => events.push({ step: e.step, status: e.status }),
      });
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.step.includes('Scanning') || e.step.includes('Building'))).toBe(
        true
      );
    });
  });
});
