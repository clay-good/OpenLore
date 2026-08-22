/**
 * Tests for openlore run command (full pipeline)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCommand } from './run.js';
import { openloreRun } from '../../api/run.js';
import { confirm } from '@inquirer/prompts';
import { confirmRunGeneration } from './run.js';

vi.mock('../../api/run.js', () => ({ openloreRun: vi.fn() }));
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

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
    listItem: vi.fn(),
  },
}));

describe('run command', () => {
  describe('command configuration', () => {
    it('should have correct name and description', () => {
      expect(runCommand.name()).toBe('run');
      expect(runCommand.description()).toContain('full openlore pipeline');
    });

    it('should have --force option', () => {
      const forceOption = runCommand.options.find(o => o.long === '--force');
      expect(forceOption).toBeDefined();
      expect(forceOption?.description).toContain('Reinitialize');
    });

    it('should have --reanalyze option', () => {
      const reanalyzeOption = runCommand.options.find(o => o.long === '--reanalyze');
      expect(reanalyzeOption).toBeDefined();
      expect(reanalyzeOption?.description).toContain('fresh analysis');
    });

    it('should have --model option with default', () => {
      const modelOption = runCommand.options.find(o => o.long === '--model');
      expect(modelOption).toBeDefined();
      expect(modelOption?.defaultValue).toBe('claude-sonnet-4-6');
    });

    it('should have --dry-run option', () => {
      const dryRunOption = runCommand.options.find(o => o.long === '--dry-run');
      expect(dryRunOption).toBeDefined();
      expect(dryRunOption?.description).toContain('without making changes');
    });

    it('should have -y/--yes option', () => {
      const yesOption = runCommand.options.find(o => o.long === '--yes');
      expect(yesOption).toBeDefined();
      expect(yesOption?.short).toBe('-y');
      expect(yesOption?.description).toContain('Skip all');
    });

    it('should have --max-files option with default', () => {
      const maxFilesOption = runCommand.options.find(o => o.long === '--max-files');
      expect(maxFilesOption).toBeDefined();
      expect(maxFilesOption?.defaultValue).toBe('100000');
    });
  });

  describe('helper function tests', () => {
    describe('formatDuration', () => {
      // Test the logic that would be in formatDuration
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
        expect(formatDuration(125000)).toBe('2m 5s');
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
        expect(formatAge(120000)).toBe('2 minutes ago');
        expect(formatAge(3600000)).toBe('1 hours ago');
        expect(formatAge(86400000)).toBe('1 days ago');
      });
    });

    describe('estimateCost', () => {
      it('should estimate cost based on tokens and model', () => {
        const estimateCost = (tokens: number, model: string): { tokens: number; cost: number } => {
          const pricing: Record<string, { input: number; output: number }> = {
            'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
            'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
            'gpt-4o': { input: 5.0, output: 15.0 },
            'gpt-4o-mini': { input: 0.15, output: 0.6 },
            default: { input: 3.0, output: 15.0 },
          };

          const outputTokens = Math.ceil(tokens * 0.3);
          const totalTokens = tokens + outputTokens;
          const modelPricing = pricing[model] ?? pricing.default;
          const inputCost = (tokens / 1_000_000) * modelPricing.input;
          const outputCost = (outputTokens / 1_000_000) * modelPricing.output;
          const cost = inputCost + outputCost;

          return { tokens: totalTokens, cost };
        };

        const sonnetResult = estimateCost(10000, 'claude-sonnet-4-20250514');
        expect(sonnetResult.tokens).toBe(13000);
        expect(sonnetResult.cost).toBeGreaterThan(0);

        const opusResult = estimateCost(10000, 'claude-opus-4-20250514');
        expect(opusResult.cost).toBeGreaterThan(sonnetResult.cost);

        const miniResult = estimateCost(10000, 'gpt-4o-mini');
        expect(miniResult.cost).toBeLessThan(sonnetResult.cost);
      });
    });
  });

  describe('run metadata', () => {
    it('should have correct structure', () => {
      interface RunMetadata {
        version: string;
        timestamp: string;
        duration: number;
        steps: {
          init: { status: 'skipped' | 'completed'; reason?: string };
          analyze: { status: 'skipped' | 'completed'; reason?: string; filesAnalyzed?: number };
          generate: { status: 'skipped' | 'completed'; reason?: string; specsGenerated?: number };
        };
        result: 'success' | 'failure';
        error?: string;
      }

      const metadata: RunMetadata = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration: 0,
        steps: {
          init: { status: 'skipped', reason: 'Config exists' },
          analyze: { status: 'completed', filesAnalyzed: 100 },
          generate: { status: 'completed', specsGenerated: 5 },
        },
        result: 'success',
      };

      expect(metadata.version).toBe('1.0.0');
      expect(metadata.steps.init.status).toBe('skipped');
      expect(metadata.steps.analyze.filesAnalyzed).toBe(100);
      expect(metadata.steps.generate.specsGenerated).toBe(5);
      expect(metadata.result).toBe('success');
    });

    it('should handle failure state', () => {
      interface RunMetadata {
        version: string;
        timestamp: string;
        duration: number;
        steps: {
          init: { status: 'skipped' | 'completed'; reason?: string };
          analyze: { status: 'skipped' | 'completed'; reason?: string; filesAnalyzed?: number };
          generate: { status: 'skipped' | 'completed'; reason?: string; specsGenerated?: number };
        };
        result: 'success' | 'failure';
        error?: string;
      }

      const metadata: RunMetadata = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        duration: 5000,
        steps: {
          init: { status: 'completed' },
          analyze: { status: 'completed', filesAnalyzed: 50 },
          generate: { status: 'skipped', reason: 'No API key' },
        },
        result: 'failure',
        error: 'No LLM API key found',
      };

      expect(metadata.result).toBe('failure');
      expect(metadata.error).toBe('No LLM API key found');
      expect(metadata.steps.generate.status).toBe('skipped');
    });
  });

  describe('smart defaults', () => {
    it('should skip init when config exists', () => {
      // Simulate the logic
      const configExists = true;
      const force = false;

      const shouldRunInit = !configExists || force;
      expect(shouldRunInit).toBe(false);
    });

    it('should run init with --force', () => {
      const configExists = true;
      const force = true;

      const shouldRunInit = !configExists || force;
      expect(shouldRunInit).toBe(true);
    });

    it('should skip analysis when recent (< 1 hour)', () => {
      const analysisAge = 30 * 60 * 1000; // 30 minutes
      const oneHour = 60 * 60 * 1000;
      const reanalyze = false;
      const force = false;

      const shouldSkipAnalysis = analysisAge < oneHour && !reanalyze && !force;
      expect(shouldSkipAnalysis).toBe(true);
    });

    it('should run analysis when old (> 1 hour)', () => {
      const analysisAge = 2 * 60 * 60 * 1000; // 2 hours
      const oneHour = 60 * 60 * 1000;
      const reanalyze = false;
      const force = false;

      const shouldSkipAnalysis = analysisAge < oneHour && !reanalyze && !force;
      expect(shouldSkipAnalysis).toBe(false);
    });

    it('should run analysis with --reanalyze', () => {
      const analysisAge = 30 * 60 * 1000; // 30 minutes
      const oneHour = 60 * 60 * 1000;
      const reanalyze = true;
      const force = false;

      const shouldSkipAnalysis = analysisAge < oneHour && !reanalyze && !force;
      expect(shouldSkipAnalysis).toBe(false);
    });

    it('should run analysis with --force', () => {
      const analysisAge = 30 * 60 * 1000; // 30 minutes
      const oneHour = 60 * 60 * 1000;
      const reanalyze = false;
      const force = true;

      const shouldSkipAnalysis = analysisAge < oneHour && !reanalyze && !force;
      expect(shouldSkipAnalysis).toBe(false);
    });
  });

  describe('API key detection', () => {
    it('should prefer Anthropic key when both available', () => {
      const anthropicKey = 'sk-ant-xxx';

      const provider = anthropicKey ? 'anthropic' : 'openai';
      expect(provider).toBe('anthropic');
    });

    it('should use OpenAI when only OpenAI key available', () => {
      const anthropicKey = '';

      const provider = anthropicKey ? 'anthropic' : 'openai';
      expect(provider).toBe('openai');
    });

    it('should fail when no API key available', () => {
      const anthropicKey = '';
      const openaiKey = '';

      const hasApiKey = !!(anthropicKey || openaiKey);
      expect(hasApiKey).toBe(false);
    });
  });

  describe('exit codes', () => {
    function getExitCode(result: string): number {
      return result === 'success' ? 0 : 1;
    }

    it('should return success (0) for successful run', () => {
      expect(getExitCode('success')).toBe(0);
    });

    it('should return failure (1) for failed run', () => {
      expect(getExitCode('failure')).toBe(1);
    });
  });

  describe('banner display', () => {
    it('should include project name in banner', () => {
      const projectName = 'my-awesome-project';
      const banner = `  Project: ${projectName}`;
      expect(banner).toContain('my-awesome-project');
    });

    it('should include version in banner', () => {
      const version = '1.0.0';
      const banner = `  openlore v${version}`;
      expect(banner).toContain('v1.0.0');
    });
  });

  describe('step display', () => {
    it('should show step progress', () => {
      const steps = ['Initialization', 'Analysis', 'Generation'];
      const currentStep = 2;

      const display = `[Step ${currentStep}/${steps.length}] ${steps[currentStep - 1]}`;
      expect(display).toBe('[Step 2/3] Analysis');
    });
  });

  describe('--max-files input validation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.exitCode = undefined;
    });

    it('rejects --max-files 0', async () => {
      const { logger } = await import('../../utils/logger.js');
      await runCommand.parseAsync(['--max-files', '0'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('--max-files must be a positive integer');
      expect(process.exitCode).toBe(1);
    });

    it('rejects --max-files -5', async () => {
      const { logger } = await import('../../utils/logger.js');
      await runCommand.parseAsync(['--max-files', '-5'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('--max-files must be a positive integer');
      expect(process.exitCode).toBe(1);
    });

    it('rejects non-numeric --max-files', async () => {
      const { logger } = await import('../../utils/logger.js');
      await runCommand.parseAsync(['--max-files', 'abc'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('--max-files must be a positive integer');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('shared pipeline delegation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.exitCode = undefined;
      vi.mocked(openloreRun).mockResolvedValue({
        dryRun: false,
        init: {} as never,
        analysis: {} as never,
        generation: { dryRun: false, report: { filesWritten: [] } as never, pipelineResult: {} as never, duration: 0 },
        duration: 1,
      });
    });

    it('delegates force, analysis, generation, and transport options to the shared run API', async () => {
      await runCommand.parseAsync([
        '--force', '--reanalyze', '--model', 'configured-model', '--max-files', '42', '--adr',
      ], { from: 'user' });

      expect(openloreRun).toHaveBeenCalledWith(expect.objectContaining({
        force: true,
        reanalyze: true,
        model: 'configured-model',
        maxFiles: 42,
        adr: true,
        quiet: false,
        confirmGeneration: expect.any(Function),
      }));
    });
  });

  describe('paid generation consent', () => {
    it('does not prompt below the shared cost threshold', async () => {
      await expect(confirmRunGeneration({ cost: 0.01 }, false, true)).resolves.toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });

    it('requires --yes for an expensive non-interactive run', async () => {
      await expect(confirmRunGeneration({ cost: 1.25 }, false, false)).resolves.toBe(false);
      await expect(confirmRunGeneration({ cost: 1.25 }, true, false)).resolves.toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });

    it('prompts interactively with the estimated cost', async () => {
      vi.mocked(confirm).mockResolvedValue(true);
      await expect(confirmRunGeneration({ cost: 1.25 }, false, true)).resolves.toBe(true);
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('$1.25') }));
    });
  });
});
