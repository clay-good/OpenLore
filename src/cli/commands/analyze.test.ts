/**
 * Tests for openlore analyze command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCommand, formatIndexedFunctionPopulation, formatSpecIndexFailure, runAnalysis } from './analyze.js';
import { ARTIFACT_FINGERPRINT } from '../../constants.js';

// ============================================================================
// MOCKS
// ============================================================================

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

vi.mock('../../core/analyzer/repository-mapper.js', () => {
  const mockMap = vi.fn().mockResolvedValue({
    allFiles: [],
    highValueFiles: [],
    summary: { totalFiles: 0, analyzedFiles: 0, skippedFiles: 0, languages: [] },
  });
  return { RepositoryMapper: vi.fn().mockImplementation(function(this: unknown, root: string, opts: unknown) {
    Object.assign(this as object, { map: mockMap });
    void root; void opts;
  }) };
});

vi.mock('../../core/analyzer/dependency-graph.js', () => ({
  DependencyGraphBuilder: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, {
      build: vi.fn().mockResolvedValue({
        statistics: { nodeCount: 0, edgeCount: 0, clusterCount: 0, cycleCount: 0, avgDegree: 0 },
      }),
    });
  }),
}));

vi.mock('../../core/analyzer/artifact-generator.js', () => ({
  AnalysisArtifactGenerator: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, {
      generateAndSave: vi.fn().mockResolvedValue({
        repoStructure: {
          architecture: { pattern: 'unknown' },
          domains: [],
          uiComponents: [],
          schemas: [],
          routeInventory: { total: 0, byMethod: {}, byFramework: {}, routes: [] },
          middleware: [],
          envVars: [],
        },
        llmContext: { callGraph: null },
      }),
    });
  }),
  repoStructureToRepoMap: vi.fn().mockReturnValue({}),
}));

vi.mock('../../core/analyzer/ui-component-extractor.js', () => ({
  extractUIComponents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/analyzer/schema-extractor.js', () => ({
  extractSchemas: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/analyzer/http-route-parser.js', () => ({
  buildRouteInventory: vi.fn().mockResolvedValue({ total: 0, byMethod: {}, byFramework: {}, routes: [] }),
  extractAllHttpEdges: vi.fn().mockResolvedValue({ calls: [], routes: [], edges: [] }),
}));

vi.mock('../../core/analyzer/middleware-extractor.js', () => ({
  extractMiddleware: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/analyzer/env-extractor.js', () => ({
  extractEnvVars: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/analyzer/ai-config-generator.js', () => ({
  generateAiConfigs: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/services/config-manager.js', () => ({
  readOpenLoreConfig: vi.fn(),
}));

// Partial-mock utils: keep everything real except isCacheFresh, so the action-handler
// tests can drive the source-unchanged (skip) vs source-changed (re-analyze) decision
// directly — the skip is now fingerprint-gated, not a wall-clock TTL.
vi.mock('../../core/services/mcp-handlers/utils.js', async (orig) => {
  const actual = await orig<typeof import('../../core/services/mcp-handlers/utils.js')>();
  return { ...actual, isCacheFresh: vi.fn().mockResolvedValue(true) };
});
import { isCacheFresh } from '../../core/services/mcp-handlers/utils.js';

describe('analyze command', () => {
  describe('indexed function population disclosure', () => {
    it('uses the call-graph count when there are no additional indexed symbols', () => {
      expect(formatIndexedFunctionPopulation({
        total: 5,
        productionFunctions: 5,
        testFunctions: 0,
        signatureOnlySymbols: 0,
      })).toBe('5 functions');
    });

    it('names every additional indexed population when counts differ', () => {
      expect(formatIndexedFunctionPopulation({
        total: 8,
        productionFunctions: 5,
        testFunctions: 2,
        signatureOnlySymbols: 1,
      })).toBe('5 call-graph functions + 2 test functions + 1 signature-only symbols; 8 indexed repo symbols');
    });
  });
  describe('command configuration', () => {
    it('should have correct name and description', () => {
      expect(analyzeCommand.name()).toBe('analyze');
      expect(analyzeCommand.description()).toContain('static analysis');
    });

    it('should have --output option with default', () => {
      const outputOption = analyzeCommand.options.find(o => o.long === '--output');
      expect(outputOption).toBeDefined();
      expect(outputOption?.defaultValue).toBe('.openlore/analysis/');
    });

    it('should have --max-files option with default', () => {
      const maxFilesOption = analyzeCommand.options.find(o => o.long === '--max-files');
      expect(maxFilesOption).toBeDefined();
      expect(maxFilesOption?.defaultValue).toBe('100000');
    });

    it('should have --include option (repeatable)', () => {
      const includeOption = analyzeCommand.options.find(o => o.long === '--include');
      expect(includeOption).toBeDefined();
      expect(includeOption?.description).toContain('repeatable');
    });

    it('should have --exclude option (repeatable)', () => {
      const excludeOption = analyzeCommand.options.find(o => o.long === '--exclude');
      expect(excludeOption).toBeDefined();
      expect(excludeOption?.description).toContain('repeatable');
    });

    it('should have --force option, described by what it actually does', () => {
      const forceOption = analyzeCommand.options.find(o => o.long === '--force');
      expect(forceOption).toBeDefined();
      // Since the Pass-1 fact memo (change: optimize-hash-keyed-analyze), an ordinary
      // analyze already re-runs; what `--force` uniquely buys is a full re-extraction, so
      // that is what the help must promise.
      expect(forceOption?.description).toMatch(/re-extract/i);
    });

    it('should have --reanalyze: re-run without re-extracting', () => {
      const option = analyzeCommand.options.find(o => o.long === '--reanalyze');
      expect(option).toBeDefined();
      expect(option?.description).toMatch(/reuse cached extraction/i);
    });

    /**
     * The action handler rebuilds its options object from an explicit WHITELIST, so a flag
     * that is declared but not listed there parses fine, shows up in `--help`, and is then
     * silently dropped — the failure has no symptom until someone notices the behavior never
     * changed. Bind every declared flag to that list.
     */
    it('every declared flag survives the handler’s option whitelist', () => {
      const declared = analyzeCommand.options
        .map(o => o.attributeName())
        .filter(name => name !== 'help');
      const handler = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), 'analyze.ts'),
        'utf-8',
      );
      const mapped = handler.slice(handler.indexOf('.action(async (options'));
      for (const name of declared) {
        expect(mapped, `--${name} is declared but never read from \`options\``)
          .toMatch(new RegExp(`options\\.${name}\\b`));
      }
    });
  });

  describe('helper function tests', () => {
    it('presents a freshly created empty spec directory as optional normal state', () => {
      const line = formatSpecIndexFailure(
        'Spec directory /repo/openspec/specs exists but contains no spec.md files',
        true,
      );
      expect(line).toContain('ℹ No specs yet');
      expect(line).toContain('optional');
      expect(line).toContain('requires an LLM provider');
      expect(line).not.toContain('⚠');
    });

    it('preserves the warning for an empty spec directory not created by this run', () => {
      expect(formatSpecIndexFailure('exists but contains no spec.md files', false)).toContain('⚠ Spec index skipped');
    });

    describe('collect function', () => {
      it('should collect multiple values', () => {
        const collect = (value: string, previous: string[]): string[] => {
          return previous.concat([value]);
        };

        let result: string[] = [];
        result = collect('*.graphql', result);
        result = collect('*.prisma', result);

        expect(result).toEqual(['*.graphql', '*.prisma']);
      });
    });

    describe('formatDuration', () => {
      it('should format milliseconds correctly', () => {
        const formatDuration = (ms: number): string => {
          if (ms < 1000) return `${ms}ms`;
          if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
          const minutes = Math.floor(ms / 60000);
          const seconds = Math.floor((ms % 60000) / 1000);
          return `${minutes}m ${seconds}s`;
        };

        expect(formatDuration(500)).toBe('500ms');
        expect(formatDuration(1500)).toBe('1.5s');
        expect(formatDuration(65000)).toBe('1m 5s');
      });
    });

    describe('formatAge', () => {
      it('should format age correctly', () => {
        const formatAge = (ms: number): string => {
          if (ms < 60000) return 'just now';
          if (ms < 3600000) return `${Math.floor(ms / 60000)} minutes ago`;
          if (ms < 86400000) return `${Math.floor(ms / 3600000)} hours ago`;
          return `${Math.floor(ms / 86400000)} days ago`;
        };

        expect(formatAge(30000)).toBe('just now');
        expect(formatAge(1800000)).toBe('30 minutes ago');
        expect(formatAge(7200000)).toBe('2 hours ago');
        expect(formatAge(172800000)).toBe('2 days ago');
      });
    });
  });

  describe('analysis caching (fingerprint-gated, not a wall-clock TTL)', () => {
    // The real skip decision: skip iff an analysis exists, --force is off, AND the
    // source is unchanged since the last run (`cacheFresh` = isCacheFresh). A
    // committed/edited source change re-analyzes even within the freshness window;
    // an unchanged tree skips regardless of age.
    const shouldSkip = (analysisAge: number | null, force: boolean, cacheFresh: boolean): boolean =>
      analysisAge !== null && !force && cacheFresh;

    it('skips when an analysis exists and the source is unchanged (cacheFresh)', () => {
      expect(shouldSkip(30 * 60 * 1000, false, true)).toBe(true);
    });

    it('re-analyzes when source changed even if the analysis is recent (the bug fix)', () => {
      // Previously this skipped on the < 1h TTL, ignoring the source change.
      expect(shouldSkip(30 * 60 * 1000, false, false)).toBe(false);
    });

    it('skips an unchanged tree regardless of age (fingerprint overrides the old TTL)', () => {
      expect(shouldSkip(2 * 60 * 60 * 1000, false, true)).toBe(true);
    });

    it('always runs with --force', () => {
      expect(shouldSkip(30 * 60 * 1000, true, true)).toBe(false);
    });

    it('runs when no analysis exists', () => {
      expect(shouldSkip(null, false, true)).toBe(false);
    });
  });

  describe('output files', () => {
    it('should generate expected output files', () => {
      const expectedFiles = [
        'repo-structure.json',
        'dependency-graph.json',
        'llm-context.json',
        'dependencies.mermaid',
        'SUMMARY.md',
      ];

      for (const file of expectedFiles) {
        expect(file).toBeTruthy();
      }
    });
  });

  describe('runAnalysis function', () => {
    it('should be exported', () => {
      expect(runAnalysis).toBeDefined();
      expect(typeof runAnalysis).toBe('function');
    });
  });

  describe('runAnalysis — excludePatterns from config', () => {
    let MockRepositoryMapper: ReturnType<typeof vi.fn>;
    let readOpenLoreConfig: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      MockRepositoryMapper = vi.mocked(mapperMod.RepositoryMapper);
      MockRepositoryMapper.mockClear();

      const cfgMod = await import('../../core/services/config-manager.js');
      readOpenLoreConfig = vi.mocked(cfgMod.readOpenLoreConfig);
    });

    function makeConfig(excludePatterns: string[], includePatterns: string[] = []) {
      return {
        version: '1.0.0',
        projectType: 'nodejs' as const,
        openspecPath: './openspec',
        analysis: { maxFiles: 100000, includePatterns, excludePatterns },
        generation: { provider: 'openai' as const, model: 'gpt-4', domains: 'auto' as const },
        createdAt: new Date().toISOString(),
        lastRun: null,
      };
    }

    function getMapperOptions(): { excludePatterns?: string[]; includePatterns?: string[] } {
      const calls = MockRepositoryMapper.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      return (calls[calls.length - 1][1] as { excludePatterns?: string[]; includePatterns?: string[] }) ?? {};
    }

    function getMapperExcludePatterns(): string[] {
      return getMapperOptions().excludePatterns ?? [];
    }

    it('passes config excludePatterns to RepositoryMapper when caller passes none', async () => {
      readOpenLoreConfig.mockResolvedValue(makeConfig(['static/**', 'vendor/**']));

      await runAnalysis('/fake/root', '/fake/root/.openlore/analysis', {
        maxFiles: 100000, include: [], exclude: [],
      });

      expect(getMapperExcludePatterns()).toEqual(
        expect.arrayContaining(['static/**', 'vendor/**'])
      );
    });

    it('merges config excludePatterns with caller-supplied exclude patterns', async () => {
      readOpenLoreConfig.mockResolvedValue(makeConfig(['static/**']));

      await runAnalysis('/fake/root', '/fake/root/.openlore/analysis', {
        maxFiles: 100000, include: [], exclude: ['legacy/**'],
      });

      expect(getMapperExcludePatterns()).toEqual(
        expect.arrayContaining(['static/**', 'legacy/**'])
      );
    });

    it('deduplicates patterns that appear in both config and caller exclude', async () => {
      readOpenLoreConfig.mockResolvedValue(makeConfig(['node_modules/**']));

      await runAnalysis('/fake/root', '/fake/root/.openlore/analysis', {
        maxFiles: 100000, include: [], exclude: ['node_modules/**'],
      });

      const patterns = getMapperExcludePatterns();
      expect(patterns.filter(p => p === 'node_modules/**')).toHaveLength(1);
    });

    it('works when no config exists (null) and uses caller-supplied patterns only', async () => {
      readOpenLoreConfig.mockResolvedValue(null);

      await runAnalysis('/fake/root', '/fake/root/.openlore/analysis', {
        maxFiles: 100000, include: [], exclude: ['dist/**'],
      });

      expect(getMapperExcludePatterns()).toEqual(
        expect.arrayContaining(['dist/**'])
      );
    });
  });

  describe('runAnalysis — includePatterns from config', () => {
    let MockRepositoryMapper: ReturnType<typeof vi.fn>;
    let readOpenLoreConfig: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      MockRepositoryMapper = vi.mocked(mapperMod.RepositoryMapper);
      MockRepositoryMapper.mockClear();
      const cfgMod = await import('../../core/services/config-manager.js');
      readOpenLoreConfig = vi.mocked(cfgMod.readOpenLoreConfig);
    });

    function makeConfig(includePatterns: string[], excludePatterns: string[] = []) {
      return {
        version: '1.0.0', projectType: 'nodejs' as const, openspecPath: './openspec',
        analysis: { maxFiles: 100000, includePatterns, excludePatterns },
        generation: { provider: 'openai' as const, model: 'gpt-4', domains: 'auto' as const },
        createdAt: new Date().toISOString(), lastRun: null,
      };
    }

    function getMapperIncludePatterns(): string[] {
      const calls = MockRepositoryMapper.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      return ((calls[calls.length - 1][1] as { includePatterns?: string[] })?.includePatterns) ?? [];
    }

    it('passes config includePatterns to RepositoryMapper when caller passes none', async () => {
      readOpenLoreConfig.mockResolvedValue(makeConfig(['*.graphql', '*.prisma']));

      await runAnalysis('/fake/root', '/fake/root/.openlore/analysis', {
        maxFiles: 100000, include: [], exclude: [],
      });

      expect(getMapperIncludePatterns()).toEqual(
        expect.arrayContaining(['*.graphql', '*.prisma'])
      );
    });

    it('merges config includePatterns with caller-supplied include patterns', async () => {
      readOpenLoreConfig.mockResolvedValue(makeConfig(['*.graphql']));

      await runAnalysis('/fake/root', '/fake/root/.openlore/analysis', {
        maxFiles: 100000, include: ['*.proto'], exclude: [],
      });

      expect(getMapperIncludePatterns()).toEqual(
        expect.arrayContaining(['*.graphql', '*.proto'])
      );
    });

    it('deduplicates include patterns present in both config and caller', async () => {
      readOpenLoreConfig.mockResolvedValue(makeConfig(['*.graphql']));

      await runAnalysis('/fake/root', '/fake/root/.openlore/analysis', {
        maxFiles: 100000, include: ['*.graphql'], exclude: [],
      });

      const patterns = getMapperIncludePatterns();
      expect(patterns.filter(p => p === '*.graphql')).toHaveLength(1);
    });
  });

  // ============================================================================
  // ACTION HANDLER TESTS
  // ============================================================================

  describe('analyzeCommand — action handler', () => {
    // Shared references to mocked fs functions, resolved in beforeEach
    // so they are guaranteed to be the same instances vitest hoisted.
    let mockAccess:   ReturnType<typeof vi.fn>;
    let mockStat:     ReturnType<typeof vi.fn>;
    let mockMkdir:    ReturnType<typeof vi.fn>;
    let mockReadFile: ReturnType<typeof vi.fn>;
    let mockReadOpenLoreConfig: ReturnType<typeof vi.fn>;

    let consoleSpy: ReturnType<typeof vi.spyOn>;
    let cwdSpy:     ReturnType<typeof vi.spyOn>;

    const FAKE_CONFIG = {
      version: '1.0.0',
      projectType: 'nodejs' as const,
      openspecPath: './openspec',
      analysis: { maxFiles: 100000, includePatterns: [], excludePatterns: [] },
      generation: { provider: 'openai' as const, model: 'gpt-4', domains: 'auto' as const },
      createdAt: new Date().toISOString(),
      lastRun: null,
    };

    // Minimal repo-structure.json content returned by readFile in the cache-hit branch
    const CACHED_STRUCTURE = JSON.stringify({
      statistics: { analyzedFiles: 42 },
      domains: [{ name: 'api', files: [] }],
      architecture: { pattern: 'layered' },
    });

    beforeEach(async () => {
      const fsMod  = await import('node:fs/promises');
      const cfgMod = await import('../../core/services/config-manager.js');

       
      mockAccess   = vi.mocked(fsMod.access as any);
       
      mockStat     = vi.mocked(fsMod.stat as any);
       
      mockMkdir    = vi.mocked(fsMod.mkdir as any);
       
      mockReadFile = vi.mocked(fsMod.readFile as any);
      mockReadOpenLoreConfig = vi.mocked(cfgMod.readOpenLoreConfig);

      // Safe defaults: file exists, stale (2 h), mkdir ok, readFile gives empty JSON
      mockAccess.mockReset().mockResolvedValue(undefined);
      mockStat.mockReset().mockResolvedValue({ mtime: new Date(Date.now() - 2 * 3_600_000) });
      mockMkdir.mockReset().mockResolvedValue(undefined);
      mockReadFile.mockReset().mockResolvedValue('{}');
      mockReadOpenLoreConfig.mockReset();
      // Default: source unchanged since the last analysis (the common skip case).
      vi.mocked(isCacheFresh).mockReset().mockResolvedValue(true);

      cwdSpy     = vi.spyOn(process, 'cwd').mockReturnValue('/fake/root');
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      process.exitCode = undefined;
    });

    afterEach(() => {
      cwdSpy.mockRestore();
      consoleSpy.mockRestore();
      process.exitCode = undefined;
    });

    it('exits with code 1 when no config found', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(null);

      await analyzeCommand.parseAsync([], { from: 'user' });

      expect(process.exitCode).toBe(1);
    });

    it('skips analysis when a recent cache exists AND the source is unchanged', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(FAKE_CONFIG);
      // mtime 30 minutes ago → recent
      mockStat.mockResolvedValue({ mtime: new Date(Date.now() - 30 * 60_000) });
      mockReadFile.mockResolvedValue(CACHED_STRUCTURE);
      vi.mocked(isCacheFresh).mockResolvedValue(true); // source unchanged

      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      vi.mocked(mapperMod.RepositoryMapper).mockClear();

      await analyzeCommand.parseAsync([], { from: 'user' });

      // RepositoryMapper must NOT have been instantiated (analysis was skipped)
      expect(vi.mocked(mapperMod.RepositoryMapper)).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('re-analyzes a recent cache when the source CHANGED (the fingerprint-staleness fix)', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(FAKE_CONFIG);
      mockStat.mockResolvedValue({ mtime: new Date(Date.now() - 30 * 60_000) }); // still "recent"
      mockReadFile.mockResolvedValue(CACHED_STRUCTURE);
      vi.mocked(isCacheFresh).mockResolvedValue(false); // source changed since last analysis

      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      vi.mocked(mapperMod.RepositoryMapper).mockClear();

      await analyzeCommand.parseAsync([], { from: 'user' });

      // The change must force a full re-analysis even within the freshness window.
      expect(vi.mocked(mapperMod.RepositoryMapper)).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('runs analysis even with recent cache when --force is passed', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(FAKE_CONFIG);
      mockStat.mockResolvedValue({ mtime: new Date(Date.now() - 30 * 60_000) });

      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      vi.mocked(mapperMod.RepositoryMapper).mockClear();

      await analyzeCommand.parseAsync(['--force'], { from: 'user' });

      expect(vi.mocked(mapperMod.RepositoryMapper)).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('runs fresh analysis when no previous analysis exists', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(FAKE_CONFIG);
      // access rejects → fileExists returns false → getAnalysisAge returns null
      mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      vi.mocked(mapperMod.RepositoryMapper).mockClear();

      await analyzeCommand.parseAsync([], { from: 'user' });

      expect(vi.mocked(mapperMod.RepositoryMapper)).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('re-runs stale analysis automatically (> 1 hour, no --force needed)', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(FAKE_CONFIG);
      // Default beforeEach stat: 2 hours old → stale

      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      vi.mocked(mapperMod.RepositoryMapper).mockClear();

      await analyzeCommand.parseAsync([], { from: 'user' });

      expect(vi.mocked(mapperMod.RepositoryMapper)).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('sets exitCode=1 and logs error message when analysis pipeline throws', async () => {
      mockReadOpenLoreConfig.mockResolvedValue(FAKE_CONFIG);
      mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockMkdir.mockRejectedValue(new Error('Permission denied'));

      const loggerMod = await import('../../utils/logger.js');
      const errorSpy = vi.mocked(loggerMod.logger.error);

      await analyzeCommand.parseAsync([], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
    });
  });

  describe('--max-files input validation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.exitCode = undefined;
    });

    it('rejects --max-files 0', async () => {
      const loggerMod = await import('../../utils/logger.js');
      const errorSpy = vi.mocked(loggerMod.logger.error);

      await analyzeCommand.parseAsync(['--max-files', '0'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith('--max-files must be a positive integer');
      expect(process.exitCode).toBe(1);
    });

    it('rejects --max-files -10', async () => {
      const loggerMod = await import('../../utils/logger.js');
      const errorSpy = vi.mocked(loggerMod.logger.error);

      await analyzeCommand.parseAsync(['--max-files', '-10'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith('--max-files must be a positive integer');
      expect(process.exitCode).toBe(1);
    });

    it('rejects non-numeric --max-files', async () => {
      const loggerMod = await import('../../utils/logger.js');
      const errorSpy = vi.mocked(loggerMod.logger.error);

      await analyzeCommand.parseAsync(['--max-files', 'abc'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith('--max-files must be a positive integer');
      expect(process.exitCode).toBe(1);
    });
  });

  // Producer side of the confidence-boundary staleness marker: analyze must capture
  // the short HEAD commit into fingerprint.json so the marker can name the index's
  // build commit. The consumer (computeStaleness/buildStalenessMarker) is unit-tested
  // separately; this guards that the field is always written and degrades to null off
  // a git repo, never silently dropped. (spec: add-confidence-boundary-disclosure)
  describe('runAnalysis — build commit in fingerprint.json', () => {
    let writeFileMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const fsMod = await import('node:fs/promises');
      writeFileMock = vi.mocked(fsMod.writeFile);
      writeFileMock.mockClear();
      // `--max-files input validation` leaves `mkdir` rejecting with "Permission denied", and these
      // cases run a real analysis. Nothing here reset it, which was harmless only while the
      // artifact writes went through the mocked `writeFile`; the streaming writer calls `mkdir`.
      vi.mocked(fsMod.mkdir).mockReset().mockResolvedValue(undefined);
      const cfgMod = await import('../../core/services/config-manager.js');
      vi.mocked(cfgMod.readOpenLoreConfig).mockResolvedValue(null as never);
    });

    function fingerprint(): { hash: string; commit: string | null } {
      const call = writeFileMock.mock.calls.find(c => String(c[0]).endsWith(ARTIFACT_FINGERPRINT));
      expect(call, 'fingerprint.json was written').toBeDefined();
      return JSON.parse(String((call as unknown[])[1]));
    }

    it('records the short HEAD commit when analyzing a git repo', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ol-analyze-git-'));
      const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir });
      try {
        git('init', '-q');
        writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
        git('add', 'a.ts');
        git('commit', '-q', '-m', 'init');
        const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).toString().trim();

        await runAnalysis(dir, join(dir, '.openlore', 'analysis'), { maxFiles: 100000, include: [], exclude: [] });
        expect(fingerprint().commit).toBe(head);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writes commit: null off a git repo — degrades, never omits the field', async () => {
      await runAnalysis('/fake/root', '/fake/root/.openlore/analysis', { maxFiles: 100000, include: [], exclude: [] });
      const fp = fingerprint();
      expect('commit' in fp).toBe(true);
      expect(fp.commit).toBeNull();
    });
  });
});
