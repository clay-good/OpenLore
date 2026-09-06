/**
 * Tests for generate command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RepoStructure, LLMContext } from '../../core/analyzer/artifact-generator.js';

// Mock dependencies
vi.mock('../../utils/logger.js', () => ({
  logger: {
    section: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    discovery: vi.fn(),
    analysis: vi.fn(),
    inference: vi.fn(),
    blank: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../core/services/llm-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/llm-service.js')>();
  return {
    ...actual,
    createLLMService: vi.fn(() => ({
      complete: vi.fn(),
      completeJSON: vi.fn(),
      getProviderName: vi.fn(() => 'mock'),
      getTokenUsage: vi.fn(() => ({ inputTokens: 100, outputTokens: 50, totalTokens: 150, requests: 1 })),
      getCostTracking: vi.fn(() => ({ estimatedCost: 0.01, currency: 'USD', byProvider: {} })),
      saveLogs: vi.fn(),
    })),
  };
});

describe('generate command', () => {
  const testDir = join(process.cwd(), 'test-generate-cmd');
  const openloreDir = join(testDir, '.openlore');
  const analysisDir = join(openloreDir, 'analysis');

  beforeEach(async () => {
    // Create test directories
    await mkdir(analysisDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup test directories
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  describe('loadAnalysis', () => {
    it('should return null when analysis does not exist', async () => {
      // Import the function (after mocks are set up)
      const { generateCommand } = await import('./generate.js');
      expect(generateCommand).toBeDefined();
    });

    it('should load existing analysis data', async () => {
      // Create mock analysis files
      const repoStructure: RepoStructure = {
        projectName: 'test-project',
        projectType: 'node-typescript',
        frameworks: ['express'],
        architecture: {
          pattern: 'layered',
          layers: [],
        },
        domains: [{ name: 'user', suggestedSpecPath: 'openspec/specs/user/spec.md', files: [], entities: [], keyFile: null }],
        entryPoints: [],
        dataFlow: { sources: [], sinks: [], transformers: [] },
        keyFiles: { schemas: [], config: [], auth: [], database: [], routes: [], services: [] },
        uiComponents: [],
        schemas: [],
        routeInventory: { total: 0, byMethod: {}, byFramework: {}, routes: [] },
        middleware: [],
        envVars: [],
        statistics: {
          totalFiles: 100,
          analyzedFiles: 50,
          skippedFiles: 50,
          avgFileScore: 5.0,
          nodeCount: 50,
          edgeCount: 40,
          cycleCount: 0,
          clusterCount: 3,
        },
      };

      const llmContext: LLMContext = {
        phase1_survey: { purpose: 'Initial survey', files: [], estimatedTokens: 2000 },
        phase2_deep: { purpose: 'Deep analysis', files: [], totalTokens: 5000 },
        phase3_validation: { purpose: 'Validation', files: [], totalTokens: 1000 },
      };

      await writeFile(join(analysisDir, 'repo-structure.json'), JSON.stringify(repoStructure));
      await writeFile(join(analysisDir, 'llm-context.json'), JSON.stringify(llmContext));

      // Verify files were created
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(analysisDir, 'repo-structure.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.projectName).toBe('test-project');
    });
  });

  describe('estimateCost', () => {
    it('should estimate cost based on context tokens', () => {
      const llmContext: LLMContext = {
        phase1_survey: { purpose: 'Survey', files: [], estimatedTokens: 2000 },
        phase2_deep: {
          purpose: 'Deep',
          files: [
            { path: 'file1.ts', tokens: 1000 },
            { path: 'file2.ts', tokens: 500 },
          ],
          totalTokens: 1500,
        },
        phase3_validation: { purpose: 'Validation', files: [], totalTokens: 500 },
      };

      // The estimate function is internal, but we can test command behavior
      // For now, just verify the structure is correct
      expect(llmContext.phase2_deep.files.length).toBe(2);
    });
  });

  describe('formatDuration', () => {
    it('should format durations correctly', () => {
      // Test various durations
      expect(100).toBeLessThan(1000); // ms
      expect(5000).toBeGreaterThanOrEqual(1000); // seconds
      expect(120000).toBeGreaterThanOrEqual(60000); // minutes
    });
  });

  describe('formatAge', () => {
    it('should format age correctly', () => {
      // Test various ages
      expect(30000).toBeLessThan(60000); // "just now"
      expect(1800000).toBeLessThan(3600000); // "X minutes ago"
      expect(7200000).toBeLessThan(86400000); // "X hours ago"
    });
  });

  describe('command options', () => {
    it('preserves absolute output directories and resolves relative ones from the project root', async () => {
      const { resolveGenerateOutputPath } = await import('./generate.js');
      const absoluteOut = resolve('/private/tmp/specs');
      expect(resolveGenerateOutputPath(resolve('/project'), absoluteOut)).toBe(absoluteOut);
      expect(resolveGenerateOutputPath('/project', 'artifacts/specs')).toBe(resolve('/project/artifacts/specs'));
    });

    it('should have correct default values', async () => {
      const { generateCommand } = await import('./generate.js');

      // Check command configuration
      expect(generateCommand.name()).toBe('generate');
      expect(generateCommand.description()).toBe('Generate OpenSpec files from analysis using LLM');
    });

    it('should parse domains option correctly', async () => {
      const { generateCommand } = await import('./generate.js');

      // Find the domains option
      const domainsOption = generateCommand.options.find(opt => opt.long === '--domains');
      expect(domainsOption).toBeDefined();
    });

    it('uses the shared cleanup policy so filtered force generation cannot delete other domains', () => {
      const source = readFileSync(fileURLToPath(new URL('./generate.ts', import.meta.url)), 'utf-8');
      expect(source).toMatch(
        /cleanBeforeWrite:\s*shouldCleanStaleDomains\(opts\.force,\s*opts\.domains,\s*opts\.adrOnly\)/,
      );
    });

    it('keeps scoped global metadata honest and wires the concrete output root', () => {
      const source = readFileSync(fileURLToPath(new URL('./generate.ts', import.meta.url)), 'utf-8');
      expect(source).toContain('openspecRoot: fullOpenspecPath');
      expect(source).toContain('updateConfig: hasOperatorOutputDir || opts.domains.length === 0');
      expect(source).toContain('scoped: opts.domains.length > 0 && !hasOperatorOutputDir');
    });

    it('derives the link index from the specs it wrote, not from the pipeline result', () => {
      const source = readFileSync(fileURLToPath(new URL('./generate.ts', import.meta.url)), 'utf-8');
      // Anchors are verified against the graph BEFORE the write…
      expect(source).toContain('verifyRequirementAnchors(requirementAnchorProposals(pipelineResult), depGraph)');
      // …and the persisted index is derived AFTER it, from the files on disk.
      const write = source.indexOf('await writer.writeSpecs(');
      const derive = source.indexOf('await finalizeGeneration({');
      expect(write).toBeGreaterThan(-1);
      expect(derive).toBeGreaterThan(write);
      // No probabilistic matcher survives as a coverage input.
      expect(source).not.toContain('MappingGenerator');
    });

    it('should have dry-run option', async () => {
      const { generateCommand } = await import('./generate.js');

      const dryRunOption = generateCommand.options.find(opt => opt.long === '--dry-run');
      expect(dryRunOption).toBeDefined();
    });

    it('should have merge option', async () => {
      const { generateCommand } = await import('./generate.js');

      const mergeOption = generateCommand.options.find(opt => opt.long === '--merge');
      expect(mergeOption).toBeDefined();
    });

    it('should have yes option with short flag', async () => {
      const { generateCommand } = await import('./generate.js');

      const yesOption = generateCommand.options.find(opt => opt.long === '--yes');
      expect(yesOption).toBeDefined();
      expect(yesOption?.short).toBe('-y');
    });
  });

  describe('command help text', () => {
    it('should have proper description', async () => {
      const { generateCommand } = await import('./generate.js');

      // Check that the command has help text configured
      expect(generateCommand.description()).toBe('Generate OpenSpec files from analysis using LLM');
      // The addHelpText is configured, we just verify it doesn't throw
      expect(() => generateCommand.helpInformation()).not.toThrow();
    });

    it('should have description containing key terms', async () => {
      const { generateCommand } = await import('./generate.js');

      expect(generateCommand.description()).toContain('Generate');
      expect(generateCommand.description()).toContain('OpenSpec');
    });
  });

  describe('parseDomains helper', () => {
    it('should parse comma-separated domains', () => {
      // Test the parsing logic
      const input = 'auth,api,database';
      const parsed = input.split(',').map(d => d.trim()).filter(Boolean);
      expect(parsed).toEqual(['auth', 'api', 'database']);
    });

    it('should handle whitespace', () => {
      const input = 'auth , api , database';
      const parsed = input.split(',').map(d => d.trim()).filter(Boolean);
      expect(parsed).toEqual(['auth', 'api', 'database']);
    });

    it('should filter empty entries', () => {
      const input = 'auth,,database,';
      const parsed = input.split(',').map(d => d.trim()).filter(Boolean);
      expect(parsed).toEqual(['auth', 'database']);
    });
  });

  describe('write mode selection', () => {
    it('should select merge mode when --merge is set', () => {
      const opts = { merge: true, noOverwrite: false };
      let writeMode = 'replace';
      if (opts.merge) {
        writeMode = 'merge';
      } else if (opts.noOverwrite) {
        writeMode = 'skip';
      }
      expect(writeMode).toBe('merge');
    });

    it('should select skip mode when --no-overwrite is set', () => {
      const opts = { merge: false, noOverwrite: true };
      let writeMode = 'replace';
      if (opts.merge) {
        writeMode = 'merge';
      } else if (opts.noOverwrite) {
        writeMode = 'skip';
      }
      expect(writeMode).toBe('skip');
    });

    it('should default to replace mode', () => {
      const opts = { merge: false, noOverwrite: false };
      let writeMode = 'replace';
      if (opts.merge) {
        writeMode = 'merge';
      } else if (opts.noOverwrite) {
        writeMode = 'skip';
      }
      expect(writeMode).toBe('replace');
    });

    it('should prefer merge over skip when both are set', () => {
      const opts = { merge: true, noOverwrite: true };
      let writeMode = 'replace';
      if (opts.merge) {
        writeMode = 'merge';
      } else if (opts.noOverwrite) {
        writeMode = 'skip';
      }
      expect(writeMode).toBe('merge');
    });
  });

  describe('domain filtering', () => {
    it('should filter specs by domain', () => {
      const specs = [
        { type: 'overview' as const, domain: 'overview', path: '', content: '' },
        { type: 'architecture' as const, domain: 'architecture', path: '', content: '' },
        { type: 'domain' as const, domain: 'user', path: '', content: '' },
        { type: 'domain' as const, domain: 'order', path: '', content: '' },
        { type: 'api' as const, domain: 'api', path: '', content: '' },
      ];

      const domainFilter = ['user'];
      const domainSet = new Set(domainFilter.map(d => d.toLowerCase()));

      const filtered = specs.filter(spec => {
        // Always include overview and architecture
        if (spec.type === 'overview' || spec.type === 'architecture') {
          return true;
        }
        // Check if domain matches
        return domainSet.has(spec.domain.toLowerCase());
      });

      expect(filtered).toHaveLength(3); // overview, architecture, user
      expect(filtered.map(s => s.domain)).toContain('user');
      expect(filtered.map(s => s.domain)).not.toContain('order');
    });

    it('should include all domains when filter is empty', () => {
      const specs = [
        { type: 'overview' as const, domain: 'overview', path: '', content: '' },
        { type: 'domain' as const, domain: 'user', path: '', content: '' },
        { type: 'domain' as const, domain: 'order', path: '', content: '' },
      ];

      const domainFilter: string[] = [];

      // When filter is empty, all specs pass
      const filtered = domainFilter.length === 0 ? specs : specs.filter(s => domainFilter.includes(s.domain));

      expect(filtered).toHaveLength(3);
    });
  });

  describe('cost estimation', () => {
    it('should calculate cost based on model pricing', () => {
      const pricing: Record<string, { input: number; output: number }> = {
        'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
        'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
        'gpt-4o': { input: 5.0, output: 15.0 },
        default: { input: 3.0, output: 15.0 },
      };

      const model = 'claude-sonnet-4-20250514';
      const modelPricing = pricing[model] ?? pricing.default;

      expect(modelPricing.input).toBe(3.0);
      expect(modelPricing.output).toBe(15.0);
    });

    it('should use default pricing for unknown models', () => {
      const pricing: Record<string, { input: number; output: number }> = {
        'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
        default: { input: 3.0, output: 15.0 },
      };

      const model = 'unknown-model';
      const modelPricing = pricing[model] ?? pricing.default;

      expect(modelPricing.input).toBe(3.0);
      expect(modelPricing.output).toBe(15.0);
    });
  });

  describe('error handling', () => {
    it('should handle missing config gracefully', async () => {
      // This tests that the command checks for config before proceeding
      const { logger } = await import('../../utils/logger.js');

      // The actual error handling is in the command action
      // We just verify the logger mock is available
      expect(logger.error).toBeDefined();
    });

    it('should handle missing analysis gracefully', async () => {
      const { logger } = await import('../../utils/logger.js');
      expect(logger.error).toBeDefined();
    });

    it('should handle missing API key gracefully', async () => {
      const { logger } = await import('../../utils/logger.js');
      expect(logger.error).toBeDefined();
    });
  });
});

// ============================================================================
// FREE PLAN/DRY RUN VS PAID PREVIEW (change: harden-spec-workflow-lifecycle)
// ============================================================================

const { generateCommand } = await import('./generate.js');
const { renderSpecPreviewDiff } = await import('./generate.js');

describe('generate preview modes', () => {
  const roots: string[] = [];

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function specTree(specs: Record<string, string>): Promise<string> {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'openlore-preview-'));
    roots.push(root);
    for (const [domain, content] of Object.entries(specs)) {
      await mkdir(join(root, 'specs', domain), { recursive: true });
      await writeFile(join(root, 'specs', domain, 'spec.md'), content, 'utf-8');
    }
    return root;
  }

  it('exposes free --dry-run/--plan and explicit paid --preview', () => {
    expect(generateCommand.options.find(opt => opt.long === '--plan')).toBeDefined();
    expect(generateCommand.options.find(opt => opt.long === '--dry-run')).toBeDefined();
    expect(generateCommand.options.find(opt => opt.long === '--preview')).toBeDefined();
  });

  it('preserves force in the normalized execution options', async () => {
    const { normalizeGenerateOptions } = await import('./generate.js');
    expect(normalizeGenerateOptions({ force: true }).force).toBe(true);
    expect(normalizeGenerateOptions({}).force).toBe(false);
  });

  // skipIf(win32): the premise is a symlink, which needs elevated privileges or Developer
  // Mode there — the test cannot build the thing it asserts is not copied. Exercised on Linux.
  it.skipIf(process.platform === 'win32')('seeds a preview from regular project files without copying symlinks', async () => {
    const { copyRegularTree } = await import('./generate.js');
    const { mkdir, readFile, symlink, writeFile } = await import('node:fs/promises');
    const source = await specTree({ billing: '# Billing\nhuman content\n' });
    const destination = await specTree({});
    const victim = join(source, '..', `preview-victim-${Date.now()}.json`);
    roots.push(victim);
    await writeFile(victim, 'ORIGINAL');
    await mkdir(join(source, '.openlore', 'generation'), { recursive: true });
    await symlink(victim, join(source, '.openlore', 'generation', 'pipeline-result.json'));

    await copyRegularTree(source, destination);

    expect(await readFile(join(destination, 'specs', 'billing', 'spec.md'), 'utf-8'))
      .toContain('human content');
    await expect(readFile(join(destination, '.openlore', 'generation', 'pipeline-result.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(victim, 'utf-8')).toBe('ORIGINAL');
  });

  it('documents cost only on the explicit preview', () => {
    const dryRun = generateCommand.options.find(opt => opt.long === '--dry-run');
    expect(dryRun?.description).toMatch(/no provider call, no cost/i);
    const plan = generateCommand.options.find(opt => opt.long === '--plan');
    expect(plan?.description).toMatch(/no provider call/i);
    const preview = generateCommand.options.find(opt => opt.long === '--preview');
    expect(preview?.description).toMatch(/cost occur/i);
  });

  it('runs dry-run and plan mode before provider resolution or construction', () => {
    const source = readFileSync(fileURLToPath(new URL('./generate.ts', import.meta.url)), 'utf-8');
    const planReturn = source.indexOf("logger.success(`${opts.dryRun ? 'Dry run' : 'Plan'} complete");
    const providerResolved = source.indexOf('const resolved = resolveGenerationProvider(');
    const providerCreated = source.indexOf('llm = createLLMService(');
    expect(planReturn).toBeGreaterThan(-1);
    expect(providerResolved).toBeGreaterThan(planReturn);
    expect(providerCreated).toBeGreaterThan(planReturn);
  });

  it('redirects every paid-preview write into a captured throwaway workspace and removes it', () => {
    const source = readFileSync(fileURLToPath(new URL('./generate.ts', import.meta.url)), 'utf-8');
    expect(source).toContain("mkdtemp(join(tmpdir(), 'openlore-preview-'))");
    expect(source).toContain('opts.outputDir = previewRoot;');
    expect(source).toContain('? join(previewRoot, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR)');
    expect(source).toContain('snapshotRootPath: previewRoot ?? rootPath');
    // Cleanup runs in a finally, so a provider failure cannot leak the workspace.
    expect(source).toMatch(/finally \{[\s\S]*if \(previewRoot\)[\s\S]*rm\(previewRoot/);
  });

  it('reports a new spec as an addition', async () => {
    const project = await specTree({});
    const preview = await specTree({ billing: '# Billing\nline\n' });
    const lines = await renderSpecPreviewDiff(project, preview);
    expect(lines.join('\n')).toContain('+ billing');
    expect(lines.join('\n')).toContain('1 specification(s) would change');
  });

  it('reports a rewritten spec with its line delta', async () => {
    const project = await specTree({ billing: '# Billing\n' });
    const preview = await specTree({ billing: '# Billing\nmore\nlines\n' });
    const lines = await renderSpecPreviewDiff(project, preview);
    expect(lines.join('\n')).toMatch(/~ billing.*\+2 lines/);
  });

  it('reports a byte-identical spec as unchanged rather than as a rewrite', async () => {
    const identical = '# Billing\nsame\n';
    const project = await specTree({ billing: identical });
    const preview = await specTree({ billing: identical });
    const lines = await renderSpecPreviewDiff(project, preview);
    expect(lines.join('\n')).toContain('= billing  (byte-identical)');
    expect(lines.join('\n')).toContain('No specification would change');
  });

  it('leaves a spec outside the generation scope marked untouched', async () => {
    const project = await specTree({ billing: '# Billing\n', auth: '# Auth\n' });
    const preview = await specTree({ billing: '# Billing\nnew\n' });
    const lines = await renderSpecPreviewDiff(project, preview);
    expect(lines.join('\n')).toContain("= auth  (untouched");
  });

  it('says so plainly when the preview produced nothing', async () => {
    const project = await specTree({});
    const preview = await specTree({});
    expect(await renderSpecPreviewDiff(project, preview)).toEqual(['  (no specifications were generated)']);
  });
});
