/**
 * Tests for openloreRun programmatic API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openloreRun } from './run.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access:    vi.fn(),
    stat:      vi.fn(),
    readFile:  vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir:     vi.fn().mockResolvedValue(undefined),
    realpath:  vi.fn(async (path: string) => path),
  };
});

vi.mock('../core/services/project-detector.js', () => ({
  detectProjectType: vi.fn(),
  getProjectTypeName: vi.fn(),
}));

vi.mock('../core/services/config-manager.js', () => ({
  getDefaultConfig: vi.fn(),
  readOpenLoreConfig: vi.fn(),
  writeOpenLoreConfig: vi.fn(),
  openloreConfigExists: vi.fn(),
  openspecDirExists: vi.fn(),
  createOpenSpecStructure: vi.fn(),
}));

vi.mock('../core/services/gitignore-manager.js', () => ({
  gitignoreExists: vi.fn(),
  isInGitignore: vi.fn(),
  addToGitignore: vi.fn(),
  ensureGitignored: vi.fn(),
}));

vi.mock('../core/services/llm-service.js', () => ({
  createLLMService: vi.fn(),
}));

vi.mock('../core/runtime/advisory-lock.js', () => ({
  withAnalysisLock: vi.fn(async (_dir: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../core/decisions/atomic-store.js', () => ({ atomicWriteFile: vi.fn() }));

vi.mock('../core/runtime/analysis-generation.js', () => ({
  REQUIRED_ANALYSIS_ARTIFACTS: ['repo-structure.json', 'llm-context.json', 'dependency-graph.json', 'fingerprint.json'],
  publishGeneration: vi.fn(async () => ({ generationId: 'test-generation' })),
  readGenerationSnapshot: vi.fn(async (_dir: string, _required: string[], read: () => Promise<unknown>) => ({
    state: 'ok', value: await read(), generationId: 'test-generation', compatibility: 'manifest', coherence: 'full',
  })),
}));

vi.mock('../core/runtime/analysis-ownership.js', () => ({
  acquireAnalysisOwnership: vi.fn(),
}));

vi.mock('../core/analyzer/repository-mapper.js', () => ({
  RepositoryMapper: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { map: vi.fn() });
  }),
}));

vi.mock('../core/analyzer/dependency-graph.js', () => ({
  DependencyGraphBuilder: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { build: vi.fn() });
  }),
}));

vi.mock('../core/analyzer/artifact-generator.js', () => ({
  AnalysisArtifactGenerator: vi.fn().mockImplementation(function(this: unknown) {
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

vi.mock('../core/generator/spec-pipeline.js', () => ({
  SpecGenerationPipeline: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { run: vi.fn() });
  }),
}));

vi.mock('../core/generator/openspec-format-generator.js', () => ({
  OpenSpecFormatGenerator: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateSpecs: vi.fn() });
  }),
}));

vi.mock('../core/generator/openspec-writer.js', () => ({
  OpenSpecWriter: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { writeSpecs: vi.fn() });
  }),
}));

vi.mock('../core/generator/adr-generator.js', () => ({
  ADRGenerator: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateADRs: vi.fn() });
  }),
}));

vi.mock('../core/services/mcp-handlers/utils.js', () => ({
  isCacheFresh: vi.fn(),
  computeProjectFingerprint: vi.fn(async () => 'test-fingerprint'),
}));

import { access, stat, readFile } from 'node:fs/promises';
import { isCacheFresh } from '../core/services/mcp-handlers/utils.js';
import { detectProjectType, getProjectTypeName } from '../core/services/project-detector.js';
import { getDefaultConfig, readOpenLoreConfig, writeOpenLoreConfig, openloreConfigExists, openspecDirExists, createOpenSpecStructure } from '../core/services/config-manager.js';
import { gitignoreExists, isInGitignore, addToGitignore, ensureGitignored } from '../core/services/gitignore-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { RepositoryMapper } from '../core/analyzer/repository-mapper.js';
import { DependencyGraphBuilder } from '../core/analyzer/dependency-graph.js';
import { AnalysisArtifactGenerator } from '../core/analyzer/artifact-generator.js';
import { SpecGenerationPipeline } from '../core/generator/spec-pipeline.js';
import { OpenSpecFormatGenerator } from '../core/generator/openspec-format-generator.js';
import { OpenSpecWriter } from '../core/generator/openspec-writer.js';
import { acquireAnalysisOwnership } from '../core/runtime/analysis-ownership.js';

const mockAccess = vi.mocked(access);
const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);
const mockDetectProjectType = vi.mocked(detectProjectType);
const mockGetProjectTypeName = vi.mocked(getProjectTypeName);
const mockGetDefaultConfig = vi.mocked(getDefaultConfig);
const mockReadOpenLoreConfig = vi.mocked(readOpenLoreConfig);
const mockWriteOpenLoreConfig = vi.mocked(writeOpenLoreConfig);
const mockOpenLoreConfigExists = vi.mocked(openloreConfigExists);
const mockOpenspecDirExists = vi.mocked(openspecDirExists);
const mockCreateOpenSpecStructure = vi.mocked(createOpenSpecStructure);
const mockGitignoreExists = vi.mocked(gitignoreExists);
const mockIsInGitignore = vi.mocked(isInGitignore);
const mockAddToGitignore = vi.mocked(addToGitignore);
const mockEnsureGitignored = vi.mocked(ensureGitignored);
const mockCreateLLMService = vi.mocked(createLLMService);
const mockIsCacheFresh = vi.mocked(isCacheFresh);
const mockAcquireAnalysisOwnership = vi.mocked(acquireAnalysisOwnership);
const mockOwnershipUpdate = vi.fn().mockResolvedValue(undefined);
const mockOwnershipRelease = vi.fn().mockResolvedValue(undefined);

// ============================================================================
// FIXTURES
// ============================================================================

const ROOT = '/test/project';
const RECENT_MTIME = new Date(Date.now() - 5 * 60 * 1000);  // 5 min ago
const OLD_MTIME    = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

const MOCK_CONFIG = { version: '1.0.0', openspecPath: './openspec', llm: {} };
const MOCK_REPO_STRUCTURE = { projectType: 'nodejs', architecture: { pattern: 'layered' }, domains: [], frameworks: [] };
const MOCK_LLM_CONTEXT = {
  phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
  phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
  phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
};
const MOCK_PIPELINE_RESULT = {
  survey: { projectCategory: 'web-backend', frameworks: [], suggestedDomains: [] },
  entities: [], services: [], endpoints: [],
  architecture: { systemPurpose: 'test', architectureStyle: 'layered', layerMap: [], dataFlow: '', integrations: [], securityModel: '', keyDecisions: [] },
  metadata: { totalTokens: 200, estimatedCost: 0.02, duration: 2000, completedStages: [], skippedStages: [] },
};
const MOCK_WRITE_REPORT = {
  timestamp: new Date().toISOString(), openspecVersion: '1.0.0', openloreVersion: '1.0.0',
  filesWritten: ['openspec/auth/spec.md'], filesSkipped: [], filesBackedUp: [], filesMerged: [],
  configUpdated: true, validationErrors: [], warnings: [], nextSteps: [],
};
const MOCK_REPO_MAP = {
  allFiles: [], highValueFiles: [],
  summary: { totalFiles: 5, analyzedFiles: 5, skippedFiles: 0, languages: ['typescript'] },
};
const MOCK_DEP_GRAPH = { statistics: { nodeCount: 5, edgeCount: 3, clusterCount: 1, cycleCount: 0, avgDegree: 0.6 } };
const MOCK_LLM_SERVICE = {
  completeJSON: vi.fn(),
  complete: vi.fn(),
  getTokenUsage: vi.fn().mockReturnValue({ totalTokens: 200 }),
  getCostTracking: vi.fn().mockReturnValue({ estimatedCost: 0.02 }),
  saveLogs: vi.fn().mockResolvedValue(undefined),
};

function setupMocks({ configExists = false, analysisRecent = false } = {}) {
  mockAcquireAnalysisOwnership.mockResolvedValue({
    state: 'owned', payload: {} as never, waitedMs: 0,
    update: mockOwnershipUpdate, release: mockOwnershipRelease,
  });
  // Init mocks
  mockDetectProjectType.mockResolvedValue({ projectType: 'nodejs' } as Awaited<ReturnType<typeof detectProjectType>>);
  mockGetProjectTypeName.mockReturnValue('nodejs');
  mockOpenLoreConfigExists.mockResolvedValue(configExists);
  mockGetDefaultConfig.mockReturnValue(MOCK_CONFIG as ReturnType<typeof getDefaultConfig>);
  mockReadOpenLoreConfig.mockResolvedValue(MOCK_CONFIG as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);
  mockWriteOpenLoreConfig.mockResolvedValue(undefined);
  mockOpenspecDirExists.mockResolvedValue(false);
  mockCreateOpenSpecStructure.mockResolvedValue(undefined);
  mockGitignoreExists.mockResolvedValue(false);
  mockIsInGitignore.mockResolvedValue(false);
  mockAddToGitignore.mockResolvedValue(true);
  mockEnsureGitignored.mockResolvedValue('created');

  // Analysis mocks
  const mtime = analysisRecent ? RECENT_MTIME : OLD_MTIME;
  mockIsCacheFresh.mockResolvedValue(analysisRecent);
  mockAccess.mockResolvedValue(undefined);
  mockStat.mockResolvedValue({ mtime } as Awaited<ReturnType<typeof stat>>);
  mockReadFile.mockImplementation((path) => {
    const p = String(path);
    if (p.includes('repo-structure')) return Promise.resolve(JSON.stringify(MOCK_REPO_STRUCTURE));
    if (p.includes('llm-context')) return Promise.resolve(JSON.stringify(MOCK_LLM_CONTEXT));
    if (p.includes('dependency-graph')) return Promise.resolve(JSON.stringify(MOCK_DEP_GRAPH));
    return Promise.resolve('{}');
  });

  vi.mocked(RepositoryMapper).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { map: vi.fn().mockResolvedValue(MOCK_REPO_MAP) });
  });
  vi.mocked(DependencyGraphBuilder).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { build: vi.fn().mockResolvedValue(MOCK_DEP_GRAPH) });
  });
  vi.mocked(AnalysisArtifactGenerator).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateAndSave: vi.fn().mockResolvedValue({ repoStructure: MOCK_REPO_STRUCTURE }) });
  });

  // Generation mocks
  mockCreateLLMService.mockReturnValue(MOCK_LLM_SERVICE as unknown as ReturnType<typeof createLLMService>);
  vi.mocked(SpecGenerationPipeline).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { run: vi.fn().mockResolvedValue(MOCK_PIPELINE_RESULT) });
  });
  vi.mocked(OpenSpecFormatGenerator).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateSpecs: vi.fn().mockReturnValue([]) });
  });
  vi.mocked(OpenSpecWriter).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { writeSpecs: vi.fn().mockResolvedValue(MOCK_WRITE_REPORT) });
  });

  process.env.ANTHROPIC_API_KEY = 'test-key';
}

// ============================================================================
// TESTS
// ============================================================================

describe('openloreRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  // --------------------------------------------------------------------------
  // STEP 1: INITIALIZATION
  // --------------------------------------------------------------------------

  describe('Step 1 — Initialization', () => {
    it('creates config when none exists', async () => {
      setupMocks({ configExists: false, analysisRecent: true });
      const result = await openloreRun({ rootPath: ROOT });

      expect(result.init.created).toBe(true);
      expect(mockWriteOpenLoreConfig).toHaveBeenCalled();
    });

    it('delegates .openlore/ gitignore handling to ensureGitignored when creating config', async () => {
      setupMocks({ configExists: false, analysisRecent: true });
      await openloreRun({ rootPath: ROOT });

      expect(mockEnsureGitignored).toHaveBeenCalledWith(ROOT, '.openlore/', expect.any(String));
    });

    it('skips init when config exists and force=false', async () => {
      setupMocks({ configExists: true, analysisRecent: true });
      const result = await openloreRun({ rootPath: ROOT });

      expect(result.init.created).toBe(false);
      expect(mockWriteOpenLoreConfig).not.toHaveBeenCalled();
    });

    it('force=true re-creates config even if it exists', async () => {
      setupMocks({ configExists: true, analysisRecent: true });
      const result = await openloreRun({ rootPath: ROOT, force: true });

      expect(result.init.created).toBe(true);
      expect(mockWriteOpenLoreConfig).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // STEP 2: ANALYSIS
  // --------------------------------------------------------------------------

  describe('Step 2 — Analysis', () => {
    it('skips analysis when recent cache exists', async () => {
      setupMocks({ configExists: true, analysisRecent: true });
      const result = await openloreRun({ rootPath: ROOT });

      expect(result.analysis.duration).toBe(0);
      expect(RepositoryMapper).not.toHaveBeenCalled();
    });

    it('runs full analysis when cache is stale', async () => {
      setupMocks({ configExists: true, analysisRecent: false });
      await openloreRun({ rootPath: ROOT });

      expect(RepositoryMapper).toHaveBeenCalled();
      expect(DependencyGraphBuilder).toHaveBeenCalled();
      expect(AnalysisArtifactGenerator).toHaveBeenCalled();
      expect(mockAcquireAnalysisOwnership).toHaveBeenCalledWith(ROOT, expect.any(String), { stage: 'starting' });
      expect(mockOwnershipRelease).toHaveBeenCalledOnce();
    });

    it('does no analysis when another frontend owns the repository', async () => {
      setupMocks({ configExists: true, analysisRecent: false });
      mockAcquireAnalysisOwnership.mockResolvedValueOnce({
        state: 'in-progress', owner: { pid: 4321, stage: 'artifacts' } as never,
        elapsedMs: 1000, heartbeatAgeMs: 25, progressPath: null,
      });

      await expect(openloreRun({ rootPath: ROOT })).rejects.toMatchObject({
        name: 'AnalysisInProgressError', code: 'ANALYSIS_IN_PROGRESS',
      });
      expect(RepositoryMapper).not.toHaveBeenCalled();
    });

    it('reanalyze=true bypasses fresh cache', async () => {
      setupMocks({ configExists: true, analysisRecent: true });
      await openloreRun({ rootPath: ROOT, reanalyze: true });

      expect(RepositoryMapper).toHaveBeenCalled();
    });

    it('runs analysis when no cache exists', async () => {
      setupMocks({ configExists: true });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      await openloreRun({ rootPath: ROOT });

      expect(RepositoryMapper).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // STEP 3: GENERATION
  // --------------------------------------------------------------------------

  describe('Step 3 — Generation', () => {
    it('returns mock report on dry run without running pipeline', async () => {
      setupMocks({ configExists: true, analysisRecent: true });
      const result = await openloreRun({ rootPath: ROOT, dryRun: true });

      expect(result.generation.report.filesWritten).toHaveLength(0);
      expect(SpecGenerationPipeline).not.toHaveBeenCalled();
    });

    it('throws if no LLM API key', async () => {
      setupMocks({ configExists: true, analysisRecent: true });
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;

      await expect(openloreRun({ rootPath: ROOT })).rejects.toThrow(/API key/i);
    });

    it('runs pipeline and writes specs on happy path', async () => {
      setupMocks({ configExists: true, analysisRecent: true });
      const result = await openloreRun({ rootPath: ROOT });

      expect(SpecGenerationPipeline).toHaveBeenCalled();
      expect(OpenSpecWriter).toHaveBeenCalled();
      expect(result.generation.report).toBeDefined();
    });

    it('throws on pipeline failure', async () => {
      setupMocks({ configExists: true, analysisRecent: true });
      vi.mocked(SpecGenerationPipeline).mockImplementation(function(this: unknown) {
        Object.assign(this as object, { run: vi.fn().mockRejectedValue(new Error('LLM error')) });
      });

      await expect(openloreRun({ rootPath: ROOT })).rejects.toThrow(/LLM error|Pipeline/i);
    });
  });

  // --------------------------------------------------------------------------
  // RESULT SHAPE
  // --------------------------------------------------------------------------

  describe('result shape', () => {
    it('returns all three step results and duration', async () => {
      setupMocks({ configExists: true, analysisRecent: true });
      const result = await openloreRun({ rootPath: ROOT });

      expect(result.init).toBeDefined();
      expect(result.analysis).toBeDefined();
      expect(result.generation).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // --------------------------------------------------------------------------
  // PROGRESS CALLBACKS
  // --------------------------------------------------------------------------

  describe('progress callbacks', () => {
    it('fires init, analysis, and generation events', async () => {
      setupMocks({ configExists: true, analysisRecent: true });
      const steps = new Set<string>();
      await openloreRun({
        rootPath: ROOT,
        onProgress: e => steps.add(e.step),
      });

      expect(steps.has('Initialization')).toBe(true);
      expect(steps.has('Analysis')).toBe(true);
      expect(steps.has('Generation')).toBe(true);
    });
  });
});
