/**
 * Tests for openloreVerify programmatic API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openloreVerify } from './verify.js';

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

vi.mock('../core/verifier/verification-engine.js', () => ({
  SpecVerificationEngine: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, {
      selectCandidates: vi.fn(),
      verify: vi.fn(),
    });
  }),
}));

import { access, readFile } from 'node:fs/promises';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { SpecVerificationEngine } from '../core/verifier/verification-engine.js';

const mockAccess = vi.mocked(access);
const mockReadFile = vi.mocked(readFile);
const mockReadOpenLoreConfig = vi.mocked(readOpenLoreConfig);
const mockCreateLLMService = vi.mocked(createLLMService);

// ============================================================================
// FIXTURES
// ============================================================================

const ROOT = '/test/project';
const MOCK_CONFIG = { version: '1.0.0', openspecPath: './openspec' };
const MOCK_DEP_GRAPH = { statistics: { nodeCount: 5, edgeCount: 3, clusterCount: 1, cycleCount: 0, avgDegree: 0.6 } };
const MOCK_VERIFY_REPORT = {
  timestamp: new Date().toISOString(),
  specVersion: '1.0.0',
  sampledFiles: 3,
  passedFiles: 3,
  overallConfidence: 0.85,
  domainBreakdown: [],
  commonGaps: [],
  recommendation: 'ready' as const,
  suggestedImprovements: [],
  results: [],
};
const MOCK_LLM_SERVICE = {
  completeJSON: vi.fn(),
  complete: vi.fn(),
  getTokenUsage: vi.fn().mockReturnValue({ totalTokens: 50 }),
  saveLogs: vi.fn().mockResolvedValue(undefined),
};
const MOCK_CANDIDATES = [
  { path: 'openspec/auth/spec.md', domain: 'auth' },
  { path: 'openspec/users/spec.md', domain: 'users' },
];

function setupMocks() {
  mockReadOpenLoreConfig.mockResolvedValue(MOCK_CONFIG as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);
  mockAccess.mockResolvedValue(undefined);
  mockReadFile.mockImplementation((path) => {
    const p = String(path);
    if (p.includes('dependency-graph')) return Promise.resolve(JSON.stringify(MOCK_DEP_GRAPH));
    if (p.includes('generation-report')) return Promise.resolve(JSON.stringify({ filesWritten: [] }));
    return Promise.resolve('{}');
  });
  mockCreateLLMService.mockReturnValue(MOCK_LLM_SERVICE as unknown as ReturnType<typeof createLLMService>);

  vi.mocked(SpecVerificationEngine).mockImplementation(function(this: unknown) {
    Object.assign(this as object, {
      selectCandidates: vi.fn().mockResolvedValue(MOCK_CANDIDATES),
      verify: vi.fn().mockResolvedValue(MOCK_VERIFY_REPORT),
    });
  });

  process.env.ANTHROPIC_API_KEY = 'test-key';
}

// ============================================================================
// TESTS
// ============================================================================

describe('openloreVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  describe('config and resource validation', () => {
    it('throws if no openlore config', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(null as unknown as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);
      await expect(openloreVerify({ rootPath: ROOT })).rejects.toThrow();
    });

    it('throws if no specs exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      await expect(openloreVerify({ rootPath: ROOT })).rejects.toThrow();
    });

    it('throws if no analysis (dep graph missing)', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      await expect(openloreVerify({ rootPath: ROOT })).rejects.toThrow();
    });

    it('throws if no LLM API key', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      await expect(openloreVerify({ rootPath: ROOT })).rejects.toThrow(/API key/i);
    });
  });

  describe('no verification candidates', () => {
    it('throws if no candidates found', async () => {
      vi.mocked(SpecVerificationEngine).mockImplementation(function(this: unknown) {
        Object.assign(this as object, {
          selectCandidates: vi.fn().mockResolvedValue([]),
          verify: vi.fn(),
        });
      });

      await expect(openloreVerify({ rootPath: ROOT })).rejects.toThrow();
    });
  });

  describe('happy path', () => {
    it('returns verification report', async () => {
      const result = await openloreVerify({ rootPath: ROOT });

      expect(result.report).toBeDefined();
      expect(result.report.overallConfidence).toBe(0.85);
      expect(result.report.sampledFiles).toBe(3);
    });

    it('returns non-zero duration', async () => {
      const result = await openloreVerify({ rootPath: ROOT });
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('creates LLM service with provided options', async () => {
      await openloreVerify({ rootPath: ROOT, model: 'claude-opus-4-6' });
      expect(mockCreateLLMService).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-4-6' }));
    });
  });

  describe('provider detection', () => {
    it('uses anthropic when ANTHROPIC_API_KEY is set', async () => {
      await openloreVerify({ rootPath: ROOT });
      expect(mockCreateLLMService).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }));
    });

    it('uses openai when only OPENAI_API_KEY is set', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      process.env.OPENAI_API_KEY = 'openai-key';
      await openloreVerify({ rootPath: ROOT });
      expect(mockCreateLLMService).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai' }));
    });

    it.each(['codex-cli', 'antigravity-cli'] as const)('uses no-key provider %s', async (provider) => {
      delete process.env.ANTHROPIC_API_KEY;
      await openloreVerify({ rootPath: ROOT, provider });
      expect(mockCreateLLMService).toHaveBeenCalledWith(expect.objectContaining({ provider, model: provider }));
    });
  });
});
