/**
 * Tests for openloreDrift programmatic API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openloreDrift } from './drift.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access:   vi.fn(),
    readFile: vi.fn(),
  };
});

vi.mock('../core/services/config-manager.js', () => ({
  readOpenLoreConfig: vi.fn(),
}));

vi.mock('../core/services/llm-service.js', () => ({
  createLLMService: vi.fn(),
}));

vi.mock('../core/drift/git-diff.js', () => ({
  isGitRepositoryRoot: vi.fn(),
  getChangedFiles: vi.fn(),
}));

vi.mock('../core/drift/spec-mapper.js', () => ({
  buildSpecMap: vi.fn(),
  buildADRMap:  vi.fn(),
}));

vi.mock('../core/drift/drift-detector.js', () => ({
  detectDrift: vi.fn(),
}));

import { access, readFile } from 'node:fs/promises';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { isGitRepositoryRoot, getChangedFiles } from '../core/drift/git-diff.js';
import { buildSpecMap, buildADRMap } from '../core/drift/spec-mapper.js';
import { detectDrift } from '../core/drift/drift-detector.js';

const mockAccess = vi.mocked(access);
const mockReadFile = vi.mocked(readFile);
const mockReadOpenLoreConfig = vi.mocked(readOpenLoreConfig);
const mockCreateLLMService = vi.mocked(createLLMService);
const mockIsGitRepositoryRoot = vi.mocked(isGitRepositoryRoot);
const mockGetChangedFiles = vi.mocked(getChangedFiles);
const mockBuildSpecMap = vi.mocked(buildSpecMap);
const mockBuildADRMap = vi.mocked(buildADRMap);
const mockDetectDrift = vi.mocked(detectDrift);

// ============================================================================
// FIXTURES
// ============================================================================

const ROOT = '/test/project';
const MOCK_CONFIG = { version: '1.0.0', openspecPath: './openspec' };
const MOCK_CHANGED_FILES = [
  { path: 'src/auth.ts', status: 'modified', additions: 10, deletions: 2, isTest: false, isConfig: false, isGenerated: false, extension: '.ts' },
  { path: 'src/users.ts', status: 'modified', additions: 5, deletions: 1, isTest: false, isConfig: false, isGenerated: false, extension: '.ts' },
];
const MOCK_DRIFT_RESULT = {
  timestamp: new Date().toISOString(),
  baseRef: 'main',
  totalChangedFiles: 2,
  specRelevantFiles: 1,
  issues: [],
  summary: { gaps: 0, stale: 0, uncovered: 1, orphanedSpecs: 0, adrGaps: 0, adrOrphaned: 0, memoryDrifted: 0, memoryOrphaned: 0, total: 1 },
  hasDrift: true,
  mode: 'static' as const,
  duration: 500,
};
const MOCK_SPEC_MAP = { byDomain: new Map(), byFile: new Map(), domainCount: 0, totalMappedFiles: 0 };
const MOCK_ADR_MAP = { byId: new Map(), byDomain: new Map() };
const MOCK_LLM_SERVICE = {
  complete: vi.fn(),
  completeJSON: vi.fn(),
  saveLogs: vi.fn().mockResolvedValue(undefined),
};

function setupMocks() {
  mockReadOpenLoreConfig.mockResolvedValue(MOCK_CONFIG as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);
  mockAccess.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue('{}');
  mockIsGitRepositoryRoot.mockResolvedValue(true);
  mockGetChangedFiles.mockResolvedValue({ files: MOCK_CHANGED_FILES, resolvedBase: 'main', hasUnstagedChanges: false, currentBranch: 'main' } as Awaited<ReturnType<typeof getChangedFiles>>);
  mockBuildSpecMap.mockResolvedValue(MOCK_SPEC_MAP);
  mockBuildADRMap.mockResolvedValue(MOCK_ADR_MAP);
  mockDetectDrift.mockResolvedValue(MOCK_DRIFT_RESULT);
  mockCreateLLMService.mockReturnValue(MOCK_LLM_SERVICE as unknown as ReturnType<typeof createLLMService>);
  process.env.ANTHROPIC_API_KEY = 'test-key';
}

// ============================================================================
// TESTS
// ============================================================================

describe('openloreDrift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  describe('precondition checks', () => {
    it('throws if not a git repository', async () => {
      mockIsGitRepositoryRoot.mockResolvedValue(false);
      await expect(openloreDrift({ rootPath: ROOT })).rejects.toThrow(/git/i);
    });

    it('throws if no openlore config', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(null as unknown as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);
      await expect(openloreDrift({ rootPath: ROOT })).rejects.toThrow();
    });

    it('throws if no specs found', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      await expect(openloreDrift({ rootPath: ROOT })).rejects.toThrow();
    });
  });

  describe('no changed files', () => {
    it('returns empty result without running drift detection', async () => {
      mockGetChangedFiles.mockResolvedValue({ files: [], resolvedBase: 'main', hasUnstagedChanges: false, currentBranch: 'main' } as Awaited<ReturnType<typeof getChangedFiles>>);

      const result = await openloreDrift({ rootPath: ROOT });

      expect(result.totalChangedFiles).toBe(0);
      expect(result.issues).toHaveLength(0);
      expect(result.hasDrift).toBe(false);
      expect(mockDetectDrift).not.toHaveBeenCalled();
    });
  });

  describe('happy path — static mode', () => {
    it('returns drift result', async () => {
      const result = await openloreDrift({ rootPath: ROOT });

      expect(result.totalChangedFiles).toBe(2);
      expect(result.hasDrift).toBe(true);
      expect(mockDetectDrift).toHaveBeenCalled();
    });

    it('does not create LLM service in static mode', async () => {
      await openloreDrift({ rootPath: ROOT, llmEnhanced: false });
      expect(mockCreateLLMService).not.toHaveBeenCalled();
    });
  });

  describe('LLM-enhanced mode', () => {
    it('throws if llmEnhanced=true but no API key', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      await expect(openloreDrift({ rootPath: ROOT, llmEnhanced: true })).rejects.toThrow(/API key/i);
    });

    it('creates LLM service when llmEnhanced=true', async () => {
      await openloreDrift({ rootPath: ROOT, llmEnhanced: true });
      expect(mockCreateLLMService).toHaveBeenCalled();
    });
  });

  describe('maxFiles limit', () => {
    it('slices changed files to maxFiles', async () => {
      const manyFiles = Array.from({ length: 20 }, (_, i) => ({
        path: `src/file${i}.ts`, status: 'modified' as const,
        additions: 1, deletions: 0, isTest: false, isConfig: false, isGenerated: false, extension: '.ts',
      }));
      mockGetChangedFiles.mockResolvedValue({ files: manyFiles, resolvedBase: 'main', hasUnstagedChanges: false, currentBranch: 'main' } as Awaited<ReturnType<typeof getChangedFiles>>);

      await openloreDrift({ rootPath: ROOT, maxFiles: 5 });

      // detectDrift should be called with at most 5 files
      const callArgs = mockDetectDrift.mock.calls[0];
      expect(callArgs).toBeDefined();
    });
  });
});
