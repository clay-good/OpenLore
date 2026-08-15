/**
 * Tests for openloreGenerate programmatic API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openloreGenerate } from './generate.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access:    vi.fn(),
    readFile:  vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir:     vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../core/services/config-manager.js', () => ({
  readOpenLoreConfig:  vi.fn(),
  readOpenSpecConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock('../core/services/llm-service.js', () => ({
  createLLMService: vi.fn(),
}));

vi.mock('../core/runtime/analysis-generation.js', () => ({
  REQUIRED_ANALYSIS_ARTIFACTS: ['repo-structure.json', 'llm-context.json', 'dependency-graph.json', 'fingerprint.json'],
  readGenerationSnapshot: vi.fn(async (_dir: string, _required: string[], read: () => Promise<unknown>) => ({
    state: 'ok', value: await read(), generationId: 'legacy-test', compatibility: 'legacy', coherence: 'full',
  })),
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

vi.mock('../core/generator/openspec-writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/generator/openspec-writer.js')>();
  return {
    ...actual,
    OpenSpecWriter: vi.fn().mockImplementation(function(this: unknown) {
      Object.assign(this as object, { writeSpecs: vi.fn() });
    }),
  };
});

vi.mock('../core/generator/adr-generator.js', () => ({
  ADRGenerator: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateADRs: vi.fn() });
  }),
}));

// Anchor verification and link-index derivation are exercised by their own unit
// fixtures; here they are stubbed so the generate flow can be tested without a
// real analysis directory on disk.
vi.mock('../core/generator/spec-link-service.js', () => ({
  requirementAnchorProposals: vi.fn().mockReturnValue([]),
  verifyRequirementAnchors: vi.fn().mockReturnValue(new Map()),
  resolveSpecLinkIndex: vi.fn().mockResolvedValue({
    state: 'unavailable', reason: 'analysis-unavailable',
    message: 'stubbed', remediation: 'stubbed', artifactPath: '/tmp/mapping.json',
  }),
}));

import { readFile, access } from 'node:fs/promises';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { SpecGenerationPipeline } from '../core/generator/spec-pipeline.js';
import { OpenSpecFormatGenerator } from '../core/generator/openspec-format-generator.js';
import { OpenSpecWriter } from '../core/generator/openspec-writer.js';
import { ADRGenerator } from '../core/generator/adr-generator.js';

const mockReadFile = vi.mocked(readFile);
const mockAccess = vi.mocked(access);
const mockReadOpenLoreConfig = vi.mocked(readOpenLoreConfig);
const mockCreateLLMService = vi.mocked(createLLMService);

// ============================================================================
// FIXTURES
// ============================================================================

const ROOT = '/test/project';
const MOCK_CONFIG = {
  version: '1.0.0',
  projectType: 'nodejs' as const,
  openspecPath: './openspec',
  analysis: {
    maxFiles: 1000,
    includePatterns: ['**/*.ts', '**/*.js', '**/*.py'],
    excludePatterns: ['node_modules', '**/*.test.*', '**/*.spec.*'],
  },
  generation: {
    provider: undefined,
    model: undefined,
    openaiCompatBaseUrl: undefined,
    skipSslVerify: false,
    domains: [],
  },
  llm: {},
  createdAt: new Date().toISOString(),
  lastRun: null,
};
const MOCK_REPO_STRUCTURE = { projectType: 'nodejs', architecture: { pattern: 'layered' }, domains: [], frameworks: [], statistics: { analyzedFiles: 5, totalFiles: 5 } };
const MOCK_LLM_CONTEXT = {
  phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
  phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
  phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
};
const MOCK_PIPELINE_RESULT = {
  survey: { projectCategory: 'web-backend', frameworks: [], suggestedDomains: ['auth'] },
  entities: [], services: [], endpoints: [],
  architecture: { systemPurpose: 'test', architectureStyle: 'layered', layerMap: [], dataFlow: '', integrations: [], securityModel: '', keyDecisions: [] },
  metadata: { totalTokens: 100, estimatedCost: 0.01, duration: 1000, completedStages: [], skippedStages: [] },
};
const MOCK_WRITE_REPORT = {
  timestamp: new Date().toISOString(), openspecVersion: '1.0.0', openloreVersion: '1.0.0',
  filesWritten: ['openspec/auth/spec.md'], filesSkipped: [], filesBackedUp: [], filesMerged: [],
  configUpdated: true, validationErrors: [], warnings: [], nextSteps: [],
};
const MOCK_LLM_SERVICE = {
  completeJSON: vi.fn(),
  complete: vi.fn(),
  getTokenUsage: vi.fn().mockReturnValue({ totalTokens: 100 }),
  getCostTracking: vi.fn().mockReturnValue({ estimatedCost: 0.01 }),
  saveLogs: vi.fn().mockResolvedValue(undefined),
};

function setupMocks() {
  mockReadOpenLoreConfig.mockResolvedValue(MOCK_CONFIG as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);
  mockAccess.mockResolvedValue(undefined);
  mockReadFile.mockImplementation((path) => {
    const p = String(path);
    if (p.includes('repo-structure')) return Promise.resolve(JSON.stringify(MOCK_REPO_STRUCTURE));
    if (p.includes('llm-context')) return Promise.resolve(JSON.stringify(MOCK_LLM_CONTEXT));
    if (p.includes('dependency-graph')) return Promise.resolve(JSON.stringify({ statistics: { nodeCount: 0, edgeCount: 0, clusterCount: 0, cycleCount: 0, avgDegree: 0 } }));
    return Promise.resolve('{}');
  });
  mockCreateLLMService.mockReturnValue(MOCK_LLM_SERVICE as unknown as ReturnType<typeof createLLMService>);

  vi.mocked(SpecGenerationPipeline).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { run: vi.fn().mockResolvedValue(MOCK_PIPELINE_RESULT) });
  });
  vi.mocked(OpenSpecFormatGenerator).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateSpecs: vi.fn().mockReturnValue([{ domain: 'auth', content: '# Auth' }]) });
  });
  vi.mocked(OpenSpecWriter).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { writeSpecs: vi.fn().mockResolvedValue(MOCK_WRITE_REPORT) });
  });
  vi.mocked(ADRGenerator).mockImplementation(function(this: unknown) {
    Object.assign(this as object, { generateADRs: vi.fn().mockReturnValue([]) });
  });

  process.env.ANTHROPIC_API_KEY = 'test-key';
}

// ============================================================================
// TESTS
// ============================================================================

describe('openloreGenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  describe('config validation', () => {
    it('throws if no openlore config', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(null as unknown as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);
      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toThrow();
    });

    it('throws if no analysis found', async () => {
      // Simulate repo-structure.json not existing by rejecting readFile with ENOENT
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockReadFile.mockRejectedValue(enoent);
      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toThrow();
    });

    it('throws if no LLM API key', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toThrow(/API key/i);
    });

    it('the no-key error points users to the claude-code provider (no API key needed)', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      // A user with the Claude Code CLI but no API key must learn the path that works for them.
      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toThrow(/claude-code/);
    });

    it('an embedding TLS opt-out never disables TLS for the host process', async () => {
      mockReadOpenLoreConfig.mockResolvedValue({
        ...MOCK_CONFIG,
        embedding: { skipSslVerify: true },
      } as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);

      await openloreGenerate({ rootPath: ROOT });
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    });
  });

  describe('dry run', () => {
    it('returns an empty report without an API key, provider construction, or pipeline', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      const result = await openloreGenerate({ rootPath: ROOT, dryRun: true });

      expect(result.report.filesWritten).toHaveLength(0);
      expect(mockCreateLLMService).not.toHaveBeenCalled();
      expect(SpecGenerationPipeline).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('runs pipeline and writes specs', async () => {
      const result = await openloreGenerate({ rootPath: ROOT });

      expect(SpecGenerationPipeline).toHaveBeenCalled();
      expect(OpenSpecWriter).toHaveBeenCalled();
      expect(result.report.filesWritten).toContain('openspec/auth/spec.md');
    });

    it('returns pipeline result and duration', async () => {
      const result = await openloreGenerate({ rootPath: ROOT });

      expect(result.pipelineResult).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('does not authorize stale-domain deletion for filtered force generation', async () => {
      await openloreGenerate({ rootPath: ROOT, force: true, domains: ['auth'] });

      expect(OpenSpecWriter).toHaveBeenCalledWith(expect.objectContaining({
        cleanBeforeWrite: false,
      }));
    });

    it('authorizes stale-domain deletion for unfiltered full force generation', async () => {
      await openloreGenerate({ rootPath: ROOT, force: true });

      expect(OpenSpecWriter).toHaveBeenCalledWith(expect.objectContaining({
        cleanBeforeWrite: true,
      }));
    });

    it('writes only selected domains while retaining the complete metadata view', async () => {
      const allSpecs = [
        { path: 'openspec/specs/auth/spec.md', domain: 'auth', type: 'domain' as const, content: '# Auth' },
        { path: 'openspec/specs/billing/spec.md', domain: 'billing', type: 'domain' as const, content: '# Billing' },
      ];
      vi.mocked(OpenSpecFormatGenerator).mockImplementation(function(this: unknown) {
        Object.assign(this as object, { generateSpecs: vi.fn().mockReturnValue(allSpecs) });
      });

      await openloreGenerate({ rootPath: ROOT, force: true, domains: ['auth'] });

      const writer = vi.mocked(OpenSpecWriter).mock.results[0].value as unknown as {
        writeSpecs: ReturnType<typeof vi.fn>;
      };
      expect(writer.writeSpecs).toHaveBeenCalledWith(
        [allSpecs[0]],
        MOCK_PIPELINE_RESULT.survey,
        allSpecs,
      );
    });
  });

  describe('ADR generation', () => {
    it('generates ADRs when adr=true and pipeline has adrs', async () => {
      const pipelineResultWithADRs = {
        ...MOCK_PIPELINE_RESULT,
        adrs: [{ id: 'ADR-001', title: 'Use TypeScript', status: 'accepted' }],
      };
      vi.mocked(SpecGenerationPipeline).mockImplementation(function(this: unknown) {
        Object.assign(this as object, { run: vi.fn().mockResolvedValue(pipelineResultWithADRs) });
      });
      vi.mocked(ADRGenerator).mockImplementation(function(this: unknown) {
        Object.assign(this as object, { generateADRs: vi.fn().mockReturnValue([{ domain: 'adr', content: '# ADR' }]) });
      });

      await openloreGenerate({ rootPath: ROOT, adr: true });

      expect(ADRGenerator).toHaveBeenCalled();
    });

    it('skips ADR generation when adr=false', async () => {
      await openloreGenerate({ rootPath: ROOT, adr: false });
      expect(ADRGenerator).not.toHaveBeenCalled();
    });

    it('keeps the complete domain metadata view during ADR-only generation', async () => {
      const allSpecs = [
        { path: 'openspec/specs/auth/spec.md', domain: 'auth', type: 'domain' as const, content: '# Auth' },
        { path: 'openspec/specs/billing/spec.md', domain: 'billing', type: 'domain' as const, content: '# Billing' },
      ];
      const adrSpec = {
        path: 'openspec/decisions/adr-0001.md',
        domain: 'adr',
        type: 'adr' as const,
        content: '# ADR',
      };
      vi.mocked(OpenSpecFormatGenerator).mockImplementation(function(this: unknown) {
        Object.assign(this as object, { generateSpecs: vi.fn().mockReturnValue(allSpecs) });
      });
      vi.mocked(ADRGenerator).mockImplementation(function(this: unknown) {
        Object.assign(this as object, { generateADRs: vi.fn().mockReturnValue([adrSpec]) });
      });

      await openloreGenerate({ rootPath: ROOT, adrOnly: true });

      const writer = vi.mocked(OpenSpecWriter).mock.results[0].value as unknown as {
        writeSpecs: ReturnType<typeof vi.fn>;
      };
      expect(writer.writeSpecs).toHaveBeenCalledWith(
        [adrSpec],
        MOCK_PIPELINE_RESULT.survey,
        [...allSpecs, adrSpec],
      );
    });
  });

  describe('pipeline failure', () => {
    it('throws on pipeline error', async () => {
      vi.mocked(SpecGenerationPipeline).mockImplementation(function(this: unknown) {
        Object.assign(this as object, { run: vi.fn().mockRejectedValue(new Error('LLM timeout')) });
      });

      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toThrow(/LLM timeout|Pipeline/i);
    });
  });

  describe('missing llm-context.json', () => {
    it('uses empty context when llm-context.json missing', async () => {
      // readFile rejects with ENOENT for llm-context.json → loadAnalysisData uses empty context
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockReadFile.mockImplementation((path) => {
        const p = String(path);
        if (p.includes('llm-context')) return Promise.reject(enoent);
        if (p.includes('repo-structure')) return Promise.resolve(JSON.stringify(MOCK_REPO_STRUCTURE));
        if (p.includes('dependency-graph')) return Promise.resolve(JSON.stringify({ statistics: { nodeCount: 0, edgeCount: 0, clusterCount: 0, cycleCount: 0, avgDegree: 0 } }));
        return Promise.resolve('{}');
      });

      const result = await openloreGenerate({ rootPath: ROOT });
      expect(result.report).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Provider auto-detection
  // --------------------------------------------------------------------------

  describe('provider auto-detection', () => {
    it('uses anthropic when only ANTHROPIC_API_KEY is set', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;

      await openloreGenerate({ rootPath: ROOT });

      expect(mockCreateLLMService).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic' })
      );
    });

    it('uses gemini when only GEMINI_API_KEY is set', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.GEMINI_API_KEY = 'gemini-key';
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;

      await openloreGenerate({ rootPath: ROOT });

      expect(mockCreateLLMService).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'gemini' })
      );
    });

    it('uses openai-compat when only OPENAI_COMPAT_API_KEY is set', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GEMINI_API_KEY;
      process.env.OPENAI_COMPAT_API_KEY = 'compat-key';
      delete process.env.OPENAI_API_KEY;

      await openloreGenerate({ rootPath: ROOT });

      expect(mockCreateLLMService).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai-compat' })
      );
    });

    it('uses openai when only OPENAI_API_KEY is set', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-openai-test';

      await openloreGenerate({ rootPath: ROOT });

      expect(mockCreateLLMService).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai' })
      );
    });

    it('anthropic takes priority over gemini when both keys are set', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.GEMINI_API_KEY = 'gemini-test';

      await openloreGenerate({ rootPath: ROOT });

      expect(mockCreateLLMService).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic' })
      );
    });

    it('explicit provider option overrides env auto-detection', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      await openloreGenerate({ rootPath: ROOT, provider: 'gemini' });

      expect(mockCreateLLMService).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'gemini' })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Model fallback map
  // --------------------------------------------------------------------------

  describe('model fallback map', () => {
    it('uses a claude model as default for anthropic provider', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      delete process.env.OPENAI_API_KEY;

      await openloreGenerate({ rootPath: ROOT });

      const call = mockCreateLLMService.mock.calls[0]?.[0];
      expect(call?.model).toMatch(/claude/i);
    });

    it('uses a gemini model as default for gemini provider', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.GEMINI_API_KEY = 'gemini-key';

      await openloreGenerate({ rootPath: ROOT });

      const call = mockCreateLLMService.mock.calls[0]?.[0];
      expect(call?.model).toMatch(/gemini/i);
    });

    it('explicit model option overrides the default model', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      await openloreGenerate({ rootPath: ROOT, model: 'custom-model-v99' });

      expect(mockCreateLLMService).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'custom-model-v99' })
      );
    });
  });
});
