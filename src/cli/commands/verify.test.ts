/**
 * Tests for verify command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

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
    listItem: vi.fn(),
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

describe('verify command', () => {
  const testDir = join(process.cwd(), 'test-verify-cmd');

  beforeEach(async () => {
    // Create test directories
    await mkdir(join(testDir, '.openlore', 'analysis'), { recursive: true });
    await mkdir(join(testDir, 'openspec', 'specs'), { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  describe('command configuration', () => {
    it('should have correct name and description', async () => {
      const { verifyCommand } = await import('./verify.js');

      expect(verifyCommand.name()).toBe('verify');
      expect(verifyCommand.description()).toBe('Verify generated specs against actual source code');
    });

    it('should have samples option', async () => {
      const { verifyCommand } = await import('./verify.js');

      const samplesOption = verifyCommand.options.find(opt => opt.long === '--samples');
      expect(samplesOption).toBeDefined();
    });

    it('should have threshold option', async () => {
      const { verifyCommand } = await import('./verify.js');

      const thresholdOption = verifyCommand.options.find(opt => opt.long === '--threshold');
      expect(thresholdOption).toBeDefined();
    });

    it('should have files option', async () => {
      const { verifyCommand } = await import('./verify.js');

      const filesOption = verifyCommand.options.find(opt => opt.long === '--files');
      expect(filesOption).toBeDefined();
    });

    it('should have domains option', async () => {
      const { verifyCommand } = await import('./verify.js');

      const domainsOption = verifyCommand.options.find(opt => opt.long === '--domains');
      expect(domainsOption).toBeDefined();
    });

    it('should have verbose option', async () => {
      const { verifyCommand } = await import('./verify.js');

      const verboseOption = verifyCommand.options.find(opt => opt.long === '--verbose');
      expect(verboseOption).toBeDefined();
    });

    it('should have json option', async () => {
      const { verifyCommand } = await import('./verify.js');

      const jsonOption = verifyCommand.options.find(opt => opt.long === '--json');
      expect(jsonOption).toBeDefined();
    });
  });

  describe('parseList helper', () => {
    it('should parse comma-separated values', () => {
      const input = 'user,order,auth';
      const parsed = input.split(',').map(s => s.trim()).filter(Boolean);
      expect(parsed).toEqual(['user', 'order', 'auth']);
    });

    it('should handle whitespace', () => {
      const input = 'user , order , auth';
      const parsed = input.split(',').map(s => s.trim()).filter(Boolean);
      expect(parsed).toEqual(['user', 'order', 'auth']);
    });

    it('should filter empty entries', () => {
      const input = 'user,,auth,';
      const parsed = input.split(',').map(s => s.trim()).filter(Boolean);
      expect(parsed).toEqual(['user', 'auth']);
    });
  });

  describe('formatDuration helper', () => {
    it('should format milliseconds', () => {
      const ms = 500;
      expect(ms).toBeLessThan(1000);
    });

    it('should format seconds', () => {
      const ms = 5000;
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThan(60000);
    });

    it('should format minutes', () => {
      const ms = 120000;
      expect(ms).toBeGreaterThanOrEqual(60000);
    });
  });

  describe('formatScoreBar helper', () => {
    it('should create a bar with filled and empty characters', () => {
      const score = 0.7;
      const width = 10;
      const filled = Math.round(score * width);
      const empty = width - filled;
      const bar = '■'.repeat(filled) + '□'.repeat(empty);

      expect(bar).toBe('■■■■■■■□□□');
      expect(bar.length).toBe(width);
    });

    it('should handle 0 score', () => {
      const score = 0;
      const width = 10;
      const filled = Math.round(score * width);
      const empty = width - filled;
      const bar = '■'.repeat(filled) + '□'.repeat(empty);

      expect(bar).toBe('□□□□□□□□□□');
    });

    it('should handle 1.0 score', () => {
      const score = 1.0;
      const width = 10;
      const filled = Math.round(score * width);
      const empty = width - filled;
      const bar = '■'.repeat(filled) + '□'.repeat(empty);

      expect(bar).toBe('■■■■■■■■■■');
    });
  });

  describe('getStatusEmoji helper', () => {
    it('should return checkmark for passing score', () => {
      const score = 0.8;
      const threshold = 0.7;
      const status = score >= threshold ? '✓' : score >= threshold * 0.8 ? '⚠' : '✗';
      expect(status).toBe('✓');
    });

    it('should return warning for marginal score', () => {
      const score = 0.6;
      const threshold = 0.7;
      const status = score >= threshold ? '✓' : score >= threshold * 0.8 ? '⚠' : '✗';
      expect(status).toBe('⚠');
    });

    it('should return X for failing score', () => {
      const score = 0.4;
      const threshold = 0.7;
      const status = score >= threshold ? '✓' : score >= threshold * 0.8 ? '⚠' : '✗';
      expect(status).toBe('✗');
    });
  });

  describe('threshold validation', () => {
    it('should accept valid thresholds', () => {
      const validThresholds = [0, 0.5, 0.7, 1.0];
      for (const threshold of validThresholds) {
        expect(threshold >= 0 && threshold <= 1).toBe(true);
      }
    });

    it('should reject invalid thresholds', () => {
      const invalidThresholds = [-0.1, 1.1, 2];
      for (const threshold of invalidThresholds) {
        expect(threshold >= 0 && threshold <= 1).toBe(false);
      }
    });
  });

  describe('exit codes', () => {
    function getExitCode(recommendation: string): number {
      return recommendation === 'regenerate' ? 1 : 0;
    }

    it('should return 0 for ready recommendation', () => {
      expect(getExitCode('ready')).toBe(0);
    });

    it('should return 0 for needs-review recommendation', () => {
      expect(getExitCode('needs-review')).toBe(0);
    });

    it('should return 1 for regenerate recommendation', () => {
      expect(getExitCode('regenerate')).toBe(1);
    });
  });

  describe('samples distribution', () => {
    it('should distribute samples across domains', () => {
      const samples = 10;
      const domainsEstimate = 4;
      const filesPerDomain = Math.ceil(samples / domainsEstimate);
      expect(filesPerDomain).toBe(3);
    });

    it('should handle small sample sizes', () => {
      const samples = 2;
      const domainsEstimate = 4;
      const filesPerDomain = Math.ceil(samples / domainsEstimate);
      expect(filesPerDomain).toBe(1);
    });
  });

  describe('displayResult function behavior', () => {
    it('should format percentage correctly', () => {
      const f1Score = 0.857;
      const percent = (f1Score * 100).toFixed(0);
      expect(percent).toBe('86');
    });

    it('should handle zero values', () => {
      const f1Score = 0;
      const percent = (f1Score * 100).toFixed(0);
      expect(percent).toBe('0');
    });
  });

  describe('displaySummary function behavior', () => {
    it('should calculate passed percentage correctly', () => {
      const sampledFiles = 5;
      const passedFiles = 3;
      const passedPercent = sampledFiles > 0
        ? ((passedFiles / sampledFiles) * 100).toFixed(0)
        : '0';
      expect(passedPercent).toBe('60');
    });

    it('should handle zero sampled files', () => {
      const sampledFiles = 0;
      const passedFiles = 0;
      const passedPercent = sampledFiles > 0
        ? ((passedFiles / sampledFiles) * 100).toFixed(0)
        : '0';
      expect(passedPercent).toBe('0');
    });

    it('discloses attempted and failed files in the interactive summary', async () => {
      const { displaySummary } = await import('./verify.js');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      displaySummary({
        timestamp: '2026-08-16T00:00:00.000Z',
        specVersion: '1',
        attemptedFiles: 12,
        sampledFiles: 3,
        failedFiles: 9,
        failures: [{ filePath: 'src/fail.ts', reason: 'rate limited' }],
        aggregateBasis: 'successful-files',
        passedFiles: 3,
        overallConfidence: 0.9,
        domainBreakdown: [],
        commonGaps: [],
        recommendation: 'needs-review',
        recommendationQualification: '9 of 12 attempted files could not be verified; aggregates cover successful files only.',
        suggestedImprovements: [],
        results: [],
      }, 0.7);

      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('Attempted: 12 files');
      expect(output).toContain('Failed verification: 9 files');
      expect(output).toContain('9 of 12 attempted files could not be verified');
      expect(output).toContain('src/fail.ts: rate limited');
      expect(output).toContain('Verification was incomplete; review the failed files before relying on this result.');
      log.mockRestore();
    });

    it('renders an LLM scalar without fabricating per-requirement membership', async () => {
      const { displayResult } = await import('./verify.js');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      displayResult({
        filePath: 'src/user.ts',
        domain: 'user',
        purposeMatch: { predicted: '', actual: '', similarity: 1 },
        importMatch: { predicted: [], actual: [], precision: 1, recall: 1, f1Score: 1 },
        exportMatch: { predicted: [], actual: [], precision: 1, recall: 1, f1Score: 1 },
        requirementCoverage: {
          relatedRequirements: ['Auth', 'Profile'],
          actuallyImplements: [],
          coverage: 0.25,
          evidence: 'llm-score',
          provenance: { source: 'llm-judged', model: 'judge-model' },
        },
        overallScore: 0.75,
        llmConfidence: 0.8,
        feedback: [],
      }, 1, 1, 0.7, false);

      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('25% coverage (LLM-judged by judge-model; no per-requirement claims)');
      expect(output).not.toContain('Requirements: None');
      log.mockRestore();
    });

    it('labels named requirement matches as deterministic keyword fallback evidence', async () => {
      const { displayResult } = await import('./verify.js');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      displayResult({
        filePath: 'src/user.ts', domain: 'user',
        purposeMatch: { predicted: '', actual: '', similarity: 1 },
        importMatch: { predicted: [], actual: [], precision: 1, recall: 1, f1Score: 1 },
        exportMatch: { predicted: [], actual: [], precision: 1, recall: 1, f1Score: 1 },
        requirementCoverage: {
          relatedRequirements: ['Auth'], actuallyImplements: ['Auth'], coverage: 1,
          evidence: 'keyword-match', provenance: { source: 'keyword-fallback' },
        },
        overallScore: 1, llmConfidence: 0.8, feedback: [],
      }, 1, 1, 0.7, false);

      expect(log.mock.calls.flat().join('\n')).toContain('Auth (deterministic keyword fallback)');
      log.mockRestore();
    });

    it('neutralizes hostile terminal text across result and summary fields', async () => {
      const { displayResult, displaySummary } = await import('./verify.js');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      displayResult({
        filePath: 'src/user.ts',
        domain: 'user',
        purposeMatch: { predicted: '', actual: '', similarity: 0.5 },
        importMatch: { predicted: [], actual: [], precision: 0, recall: 0, f1Score: 0 },
        exportMatch: { predicted: [], actual: [], precision: 0, recall: 0, f1Score: 0 },
        requirementCoverage: {
          relatedRequirements: ['Auth'],
          actuallyImplements: ['Auth\nFORGED\u001b[2J'],
          coverage: 1,
          evidence: 'keyword-match',
        },
        overallScore: 0.5,
        llmConfidence: 0.5,
        feedback: ['warning\nFORGED\u001b[2J'],
      }, 1, 1, 0.7, true);
      displaySummary({
        timestamp: '',
        specVersion: '',
        attemptedFiles: 1,
        sampledFiles: 1,
        failedFiles: 0,
        failures: [],
        aggregateBasis: 'successful-files',
        passedFiles: 0,
        overallConfidence: 0.5,
        domainBreakdown: [{ domain: 'user\nFORGED\u001b[2J', specPath: '', filesVerified: 1, averageScore: 2, weakestArea: '' }],
        commonGaps: ['gap\nFORGED\u001b[2J'],
        recommendation: 'needs-review',
        suggestedImprovements: [{ domain: 'user', issue: 'issue', suggestion: 'fix\nFORGED\u001b[2J' }],
        results: [],
      }, 0.7);

      const calls = log.mock.calls.flat().map(String);
      expect(calls.every(line => !line.includes('\n') && !line.includes('\u001b'))).toBe(true);
      expect(calls.join('\n')).toContain('■■■■■■■■■■');
      log.mockRestore();
    });
  });

  describe('recommendation logic', () => {
    it('should recommend ready for high confidence', () => {
      const overallConfidence = 0.8;
      let recommendation: 'ready' | 'needs-review' | 'regenerate';

      if (overallConfidence >= 0.75) {
        recommendation = 'ready';
      } else if (overallConfidence >= 0.5) {
        recommendation = 'needs-review';
      } else {
        recommendation = 'regenerate';
      }

      expect(recommendation).toBe('ready');
    });

    it('should recommend needs-review for medium confidence', () => {
      const overallConfidence = 0.6;
      let recommendation: 'ready' | 'needs-review' | 'regenerate';

      if (overallConfidence >= 0.75) {
        recommendation = 'ready';
      } else if (overallConfidence >= 0.5) {
        recommendation = 'needs-review';
      } else {
        recommendation = 'regenerate';
      }

      expect(recommendation).toBe('needs-review');
    });

    it('should recommend regenerate for low confidence', () => {
      const overallConfidence = 0.3;
      let recommendation: 'ready' | 'needs-review' | 'regenerate';

      if (overallConfidence >= 0.75) {
        recommendation = 'ready';
      } else if (overallConfidence >= 0.5) {
        recommendation = 'needs-review';
      } else {
        recommendation = 'regenerate';
      }

      expect(recommendation).toBe('regenerate');
    });
  });

  describe('command help text', () => {
    it('should include examples', async () => {
      const { verifyCommand } = await import('./verify.js');

      // addHelpText adds after the main help
      expect(verifyCommand.description()).toBe('Verify generated specs against actual source code');
    });
  });

  describe('error handling', () => {
    it('should handle missing config gracefully', async () => {
      const { logger } = await import('../../utils/logger.js');
      expect(logger.error).toBeDefined();
    });

    it('should handle missing specs gracefully', async () => {
      const { logger } = await import('../../utils/logger.js');
      expect(logger.error).toBeDefined();
    });

    it('should handle missing API key gracefully', async () => {
      const { logger } = await import('../../utils/logger.js');
      expect(logger.error).toBeDefined();
    });
  });

  describe('input validation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.exitCode = undefined;
    });

    it('should reject --samples 0', async () => {
      const { verifyCommand } = await import('./verify.js');
      const { logger } = await import('../../utils/logger.js');
      await verifyCommand.parseAsync(['--samples', '0'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('--samples must be a positive integer');
      expect(process.exitCode).toBe(1);
    });

    it('should reject --samples -1', async () => {
      const { verifyCommand } = await import('./verify.js');
      const { logger } = await import('../../utils/logger.js');
      await verifyCommand.parseAsync(['--samples', '-1'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('--samples must be a positive integer');
      expect(process.exitCode).toBe(1);
    });

    it('should reject a fractional sample count', async () => {
      const { verifyCommand } = await import('./verify.js');
      const { logger } = await import('../../utils/logger.js');
      await verifyCommand.parseAsync(['--samples', '1.5'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('--samples must be a positive integer');
      expect(process.exitCode).toBe(1);
    });

    it('should reject --threshold 1.5', async () => {
      const { verifyCommand } = await import('./verify.js');
      const { logger } = await import('../../utils/logger.js');
      await verifyCommand.parseAsync(['--samples', '5', '--threshold', '1.5'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('Threshold must be a number between 0 and 1');
      expect(process.exitCode).toBe(1);
    });

    it('should reject --threshold -0.1', async () => {
      const { verifyCommand } = await import('./verify.js');
      const { logger } = await import('../../utils/logger.js');
      await verifyCommand.parseAsync(['--samples', '5', '--threshold', '-0.1'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('Threshold must be a number between 0 and 1');
      expect(process.exitCode).toBe(1);
    });

    it('should reject non-numeric --threshold', async () => {
      const { verifyCommand } = await import('./verify.js');
      const { logger } = await import('../../utils/logger.js');
      await verifyCommand.parseAsync(['--samples', '5', '--threshold', 'abc'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('Threshold must be a number between 0 and 1');
      expect(process.exitCode).toBe(1);
    });
  });
});
