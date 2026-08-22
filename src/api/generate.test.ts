/**
 * Tests for openloreGenerate programmatic API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openloreGenerate } from './generate.js';
import { resolve } from 'node:path';

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
    rm:        vi.fn().mockResolvedValue(undefined),
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

vi.mock('../core/runtime/generation-lock.js', () => ({
  withGenerationLock: vi.fn(async (_root: string, callback: () => Promise<unknown>) => callback()),
}));

vi.mock('../core/runtime/generation-semantic-search.js', () => ({
  resolveGenerationSemanticSearch: vi.fn(),
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

import { readFile, access, rm } from 'node:fs/promises';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { SpecGenerationPipeline } from '../core/generator/spec-pipeline.js';
import { OpenSpecFormatGenerator } from '../core/generator/openspec-format-generator.js';
import { OpenSpecWriter } from '../core/generator/openspec-writer.js';
import { ADRGenerator } from '../core/generator/adr-generator.js';
import { OpenLoreError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { readGenerationSnapshot } from '../core/runtime/analysis-generation.js';
import { withGenerationLock } from '../core/runtime/generation-lock.js';
import { resolveGenerationSemanticSearch } from '../core/runtime/generation-semantic-search.js';

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
  vi.mocked(resolveGenerationSemanticSearch).mockResolvedValue(undefined);

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
    delete process.env.OPENLORE_LLM_LOGS;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  describe('config validation', () => {
    it('normalizes a relative root path before any repository access', async () => {
      await openloreGenerate({ rootPath: 'relative/project', dryRun: true });

      expect(mockReadOpenLoreConfig).toHaveBeenCalledWith(resolve('relative/project'), undefined);
    });

    it('honors an absolute analysis path without rebasing it under root', async () => {
      await openloreGenerate({ rootPath: ROOT, analysisPath: '/external/analysis', dryRun: true });

      expect(readGenerationSnapshot).toHaveBeenCalledWith(
        '/external/analysis',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('honors an explicit config path', async () => {
      await openloreGenerate({ rootPath: ROOT, configPath: 'config/custom.json', dryRun: true });

      expect(mockReadOpenLoreConfig).toHaveBeenCalledWith(ROOT, 'config/custom.json');
    });

    it('throws if no openlore config', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(null as unknown as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);
      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toMatchObject({
        code: 'no-config',
      });
    });

    it('throws if no analysis found', async () => {
      // Simulate repo-structure.json not existing by rejecting readFile with ENOENT
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockReadFile.mockRejectedValue(enoent);
      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toMatchObject({
        code: 'no-analysis',
      });
    });

    it('throws if no LLM API key', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toMatchObject({
        code: 'no-api-key',
      });
    });

    it('returns a typed error when no key or keyless provider is configured', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toBeInstanceOf(OpenLoreError);
    });

    it.each([
      ['anthropic', 'OPENAI_API_KEY'],
      ['openai', 'ANTHROPIC_API_KEY'],
      ['openai-compat', 'ANTHROPIC_API_KEY'],
      ['gemini', 'ANTHROPIC_API_KEY'],
    ] as const)('returns no-api-key when %s lacks its own credential', async (provider, wrongKey) => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_COMPAT_API_KEY;
      process.env[wrongKey] = 'wrong-provider-key';
      mockReadOpenLoreConfig.mockResolvedValue({
        ...MOCK_CONFIG,
        generation: { ...MOCK_CONFIG.generation, provider },
      } as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);

      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toMatchObject({
        code: 'no-api-key',
      });
      expect(mockCreateLLMService).not.toHaveBeenCalled();
      expect(withGenerationLock).not.toHaveBeenCalled();
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

      expect(result.dryRun).toBe(true);
      expect(result.report.filesWritten).toHaveLength(0);
      expect(result.report.openloreVersion).toBe('2.2.0');
      expect(result.report.openspecVersion).toBe('1.9.0');
      expect(result.report.configSchemaVersion).toBe(MOCK_CONFIG.version);
      expect('pipelineResult' in result).toBe(false);
      expect(mockCreateLLMService).not.toHaveBeenCalled();
      expect(SpecGenerationPipeline).not.toHaveBeenCalled();
      expect(withGenerationLock).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('suppresses logger output by default for embedders', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.mocked(OpenSpecWriter).mockImplementation(function(this: unknown) {
        Object.assign(this as object, {
          writeSpecs: vi.fn().mockImplementation(async () => {
            logger.success('must stay out of host stdout');
            logger.error('must stay out of host stderr');
            return MOCK_WRITE_REPORT;
          }),
        });
      });

      await openloreGenerate({ rootPath: ROOT });

      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(consoleInfo).not.toHaveBeenCalled();
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();
      consoleLog.mockRestore();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      consoleInfo.mockRestore();
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    });

    it('uses a keyless provider configured in the repository', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      mockReadOpenLoreConfig.mockResolvedValue({
        ...MOCK_CONFIG,
        generation: { ...MOCK_CONFIG.generation, provider: 'codex-cli', model: 'gpt-5-codex' },
      } as ReturnType<typeof readOpenLoreConfig> extends Promise<infer T> ? T : never);

      await openloreGenerate({ rootPath: ROOT });

      expect(mockCreateLLMService).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex-cli',
        model: 'gpt-5-codex',
      }));
    });

    it('runs pipeline and writes specs', async () => {
      const result = await openloreGenerate({ rootPath: ROOT });

      expect(SpecGenerationPipeline).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ rootPath: ROOT }),
      );
      expect(OpenSpecWriter).toHaveBeenCalled();
      expect(result.report.filesWritten).toContain('openspec/auth/spec.md');
      expect(result.report.openloreVersion).toBe('2.2.0');
      expect(result.report.openspecVersion).toBe('1.9.0');
      expect(result.report.configSchemaVersion).toBe(MOCK_CONFIG.version);
      expect(withGenerationLock).toHaveBeenCalledWith(ROOT, expect.any(Function), { signal: undefined });
    });

    it('passes the shared semantic retrieval seam into the pipeline', async () => {
      const semanticSearch = vi.fn();
      vi.mocked(resolveGenerationSemanticSearch).mockResolvedValue(semanticSearch);

      await openloreGenerate({ rootPath: ROOT, analysisPath: '/custom/analysis' });

      expect(resolveGenerationSemanticSearch).toHaveBeenCalledWith('/custom/analysis', MOCK_CONFIG);
      expect(SpecGenerationPipeline).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ semanticSearch }),
      );
    });

    it('clears the generation cache inside ownership before a forced pipeline run', async () => {
      await openloreGenerate({ rootPath: ROOT, force: true });

      expect(rm).toHaveBeenCalledWith('/test/project/.openlore/generation', {
        recursive: true,
        force: true,
      });
      expect(vi.mocked(rm).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(SpecGenerationPipeline).mock.invocationCallOrder[0],
      );
    });

    it('returns pipeline result and duration', async () => {
      const result = await openloreGenerate({ rootPath: ROOT });

      expect(result.dryRun).toBe(false);
      if (result.dryRun) throw new Error('expected completed generation');
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

      await expect(openloreGenerate({ rootPath: ROOT })).rejects.toMatchObject({
        code: 'pipeline-failed',
        cause: expect.objectContaining({ message: 'LLM timeout' }),
      });
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
    it.each([
      [undefined, false],
      ['0', false],
      ['false', false],
      ['true', false],
      ['1', true],
    ])('passes exact LLM-log opt-in options to the API service constructor (value: %s)', async (value, expected) => {
      if (value === undefined) delete process.env.OPENLORE_LLM_LOGS;
      else process.env.OPENLORE_LLM_LOGS = value;

      await openloreGenerate({ rootPath: ROOT });

      expect(mockCreateLLMService).toHaveBeenCalledWith(expect.objectContaining({
        enableLogging: expected,
        logDir: '/test/project/.openlore/logs',
        logRoot: ROOT,
      }));
    });

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
      process.env.GEMINI_API_KEY = 'gemini-test';

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
