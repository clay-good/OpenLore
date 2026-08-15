/**
 * Tests for openloreAnalyze programmatic API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../core/decisions/atomic-store.js', () => ({ atomicWriteFile: vi.fn() }));

vi.mock('../core/runtime/analysis-generation.js', () => ({
  REQUIRED_ANALYSIS_ARTIFACTS: ['repo-structure.json', 'llm-context.json', 'dependency-graph.json', 'fingerprint.json'],
  publishGeneration: vi.fn(async () => ({ generationId: 'test-generation' })),
}));

vi.mock('../core/services/mcp-handlers/utils.js', () => ({
  computeProjectFingerprint: vi.fn(async () => 'test-fingerprint'),
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

const mockAccess = vi.mocked(access);
const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);
const mockReadOpenLoreConfig = vi.mocked(readOpenLoreConfig);

// ============================================================================
// FIXTURES
// ============================================================================

const ROOT = '/test/project';
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
    });

    it('skips mapper when recent cache exists', async () => {
      await openloreAnalyze({ rootPath: ROOT });
      expect(RepositoryMapper).not.toHaveBeenCalled();
    });

    it('force=true bypasses cache and runs full analysis', async () => {
      await openloreAnalyze({ rootPath: ROOT, force: true });
      expect(RepositoryMapper).toHaveBeenCalled();
    });
  });

  describe('cache miss — stale analysis', () => {
    beforeEach(() => {
      mockAccess.mockResolvedValue(undefined);
      mockStat.mockResolvedValue({ mtime: OLD_MTIME } as Awaited<ReturnType<typeof stat>>);
    });

    it('runs full analysis pipeline', async () => {
      await openloreAnalyze({ rootPath: ROOT });

      expect(RepositoryMapper).toHaveBeenCalled();
      expect(DependencyGraphBuilder).toHaveBeenCalled();
      expect(AnalysisArtifactGenerator).toHaveBeenCalled();
    });
  });

  describe('cache miss — no existing file', () => {
    beforeEach(() => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
    });

    it('runs full analysis pipeline', async () => {
      await openloreAnalyze({ rootPath: ROOT });

      expect(RepositoryMapper).toHaveBeenCalled();
      expect(AnalysisArtifactGenerator).toHaveBeenCalled();
    });

    it('returns analysis result with repo map', async () => {
      const result = await openloreAnalyze({ rootPath: ROOT });
      expect(result.repoMap).toBeDefined();
      expect(result.depGraph).toBeDefined();
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
