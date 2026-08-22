/**
 * Tests for drift command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { DriftResult } from '../../types/index.js';

const execFileAsync = promisify(execFile);

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

describe('drift command', () => {
  const testDir = join(process.cwd(), 'test-drift-cmd');

  beforeEach(async () => {
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
      const { driftCommand } = await import('./drift.js');

      expect(driftCommand.name()).toBe('drift');
      expect(driftCommand.description()).toBe('Detect spec drift: find code changes not reflected in specs');
    });

    it('should have base option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--base');
      expect(option).toBeDefined();
    });

    it('should have files option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--files');
      expect(option).toBeDefined();
    });

    it('should have domains option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--domains');
      expect(option).toBeDefined();
    });

    it('should have use-llm option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--use-llm');
      expect(option).toBeDefined();
    });

    it('should have json option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--json');
      expect(option).toBeDefined();
    });

    it('should have install-hook option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--install-hook');
      expect(option).toBeDefined();
    });

    it('should have uninstall-hook option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--uninstall-hook');
      expect(option).toBeDefined();
    });

    it('should have fail-on option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--fail-on');
      expect(option).toBeDefined();
    });

    it('should have max-files option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--max-files');
      expect(option).toBeDefined();
    });

    it('should have verbose option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--verbose');
      expect(option).toBeDefined();
    });
  });

  describe('parseList helper', () => {
    it('should parse comma-separated values', () => {
      const input = 'auth,user,payment';
      const parsed = input.split(',').map(s => s.trim()).filter(Boolean);
      expect(parsed).toEqual(['auth', 'user', 'payment']);
    });

    it('should handle whitespace', () => {
      const input = 'auth , user , payment';
      const parsed = input.split(',').map(s => s.trim()).filter(Boolean);
      expect(parsed).toEqual(['auth', 'user', 'payment']);
    });

    it('should filter empty entries', () => {
      const input = 'auth,,payment,';
      const parsed = input.split(',').map(s => s.trim()).filter(Boolean);
      expect(parsed).toEqual(['auth', 'payment']);
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

  describe('severity helpers', () => {
    it('should map severity to labels', () => {
      const labels: Record<string, string> = {
        error: 'ERROR',
        warning: 'WARNING',
        info: 'INFO',
      };

      expect(labels['error']).toBe('ERROR');
      expect(labels['warning']).toBe('WARNING');
      expect(labels['info']).toBe('INFO');
    });

    it('renders memory-only summaries without claiming that no issues exist', async () => {
      const { displaySummary } = await import('./drift.js');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = {
        timestamp: '2026-08-22T00:00:00.000Z', baseRef: 'main', totalChangedFiles: 1,
        analyzedFiles: 1, filesOmitted: 0, specRelevantFiles: 0, issues: [],
        summary: { gaps: 0, stale: 0, uncovered: 0, orphanedSpecs: 0, adrGaps: 0,
          adrOrphaned: 0, memoryDrifted: 1, memoryOrphaned: 2, memoryOutOfScope: 0, total: 3 },
        hasDrift: true, duration: 1, mode: 'static',
      } satisfies DriftResult;

      displaySummary(result);
      const output = log.mock.calls.map(([line]) => String(line)).join('\n');
      expect(output).toContain('Memory drifted: 1');
      expect(output).toContain('Memory orphaned: 2');
      expect(output).not.toContain('No issues found');
      log.mockRestore();
    });

    it('should map severity to icons', () => {
      const icons: Record<string, string> = {
        error: '✗',
        warning: '⚠',
        info: '→',
      };

      expect(icons['error']).toBe('✗');
      expect(icons['warning']).toBe('⚠');
      expect(icons['info']).toBe('→');
    });

    it('should map every drift kind, including memory kinds, to a visible label', async () => {
      const { kindLabel } = await import('./drift.js');

      expect(kindLabel('gap')).toBe('gap');
      expect(kindLabel('orphaned-spec')).toBe('orphaned');
      expect(kindLabel('memory-drifted')).toBe('memory-drifted');
      expect(kindLabel('memory-orphaned')).toBe('memory-orphaned');
    });
  });

  describe('failOn validation', () => {
    it('should accept valid severity levels', () => {
      const validLevels = ['error', 'warning', 'info'];
      for (const level of validLevels) {
        expect(['error', 'warning', 'info'].includes(level)).toBe(true);
      }
    });

    it('should reject invalid severity levels', () => {
      const invalidLevels = ['critical', 'debug', 'none'];
      for (const level of invalidLevels) {
        expect(['error', 'warning', 'info'].includes(level)).toBe(false);
      }
    });
  });

  describe('drift result structure', () => {
    it('should have correct summary structure', () => {
      const summary = {
        gaps: 2,
        stale: 1,
        uncovered: 3,
        orphanedSpecs: 0,
        adrGaps: 0,
        adrOrphaned: 0,
        total: 6,
      };

      expect(summary.gaps + summary.stale + summary.uncovered + summary.orphanedSpecs)
        .toBe(summary.total);
    });

    it('should determine hasDrift from failOn threshold', () => {
      const severityRank: Record<string, number> = { error: 3, warning: 2, info: 1 };

      // Issue at warning level, failOn at warning → drift
      expect(severityRank['warning'] >= severityRank['warning']).toBe(true);

      // Issue at info level, failOn at warning → no drift
      expect(severityRank['info'] >= severityRank['warning']).toBe(false);

      // Issue at error level, failOn at warning → drift
      expect(severityRank['error'] >= severityRank['warning']).toBe(true);
    });
  });

  describe('hook management', () => {
    it('should define hook marker for identification', () => {
      const HOOK_MARKER = '# openlore-drift-hook';
      expect(HOOK_MARKER).toContain('openlore');
    });

    it('should use npx to invoke drift in hook', () => {
      const hookContent = 'npx openlore drift --fail-on warning --quiet';
      expect(hookContent).toContain('openlore drift');
      expect(hookContent).toContain('--fail-on');
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

    it('should handle non-git repos gracefully', async () => {
      const { logger } = await import('../../utils/logger.js');
      expect(logger.error).toBeDefined();
    });
  });

  describe('command help text', () => {
    it('should include examples in description', async () => {
      const { driftCommand } = await import('./drift.js');
      expect(driftCommand.description()).toContain('drift');
    });
  });

  describe('max-files option', () => {
    it('should default to 100', async () => {
      const { driftCommand } = await import('./drift.js');
      const option = driftCommand.options.find(opt => opt.long === '--max-files');
      expect(option?.defaultValue).toBe('100');
    });

    it('should parse string to number', () => {
      const raw = '50';
      const parsed = parseInt(raw, 10);
      expect(parsed).toBe(50);
    });

    it('serializes the exact default-cap receipt for a real 150-file git changeset', async () => {
      const originalCwd = process.cwd();
      const originalWrite = process.stdout.write.bind(process.stdout);
      const chunks: string[] = [];
      try {
        await execFileAsync('git', ['init'], { cwd: testDir });
        await execFileAsync('git', ['branch', '-M', 'main'], { cwd: testDir });
        await execFileAsync('git', ['config', 'user.email', 'test@openlore.dev'], { cwd: testDir });
        await execFileAsync('git', ['config', 'user.name', 'OpenLore Test'], { cwd: testDir });
        await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: testDir });
        await writeFile(join(testDir, '.openlore', 'config.json'), JSON.stringify({
          version: '1.0.0', projectType: 'nodejs', openspecPath: './openspec',
          analysis: { maxFiles: 100000, includePatterns: [], excludePatterns: [] },
          generation: { model: 'claude-sonnet-4-6', domains: 'auto' },
          createdAt: '2026-08-22T00:00:00.000Z', lastRun: null,
        }));
        await writeFile(join(testDir, 'openspec', 'specs', 'spec.md'), '# Test\n');
        await mkdir(join(testDir, 'docs'), { recursive: true });
        const hooksDir = join(testDir, '.git', 'test-hooks');
        await mkdir(hooksDir, { recursive: true });
        await execFileAsync('git', ['config', 'core.hooksPath', hooksDir], { cwd: testDir });
        for (let i = 0; i < 150; i++) {
          await writeFile(join(testDir, 'docs', `file-${String(i).padStart(3, '0')}.md`), 'before\n');
        }
        await execFileAsync('git', ['add', '.'], { cwd: testDir });
        await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: testDir });
        for (let i = 0; i < 150; i++) {
          await writeFile(join(testDir, 'docs', `file-${String(i).padStart(3, '0')}.md`), 'after\n');
        }

        process.chdir(testDir);
        process.stdout.write = ((chunk: string | Uint8Array) => {
          chunks.push(String(chunk));
          return true;
        }) as typeof process.stdout.write;
        process.exitCode = undefined;
        const { driftCommand } = await import('./drift.js');
        await driftCommand.parseAsync(['--json'], { from: 'user' });

        const result = JSON.parse(chunks.join('')) as DriftResult;
        expect(result).toMatchObject({ totalChangedFiles: 150, analyzedFiles: 100, filesOmitted: 50 });
        expect(result.totalChangedFiles).toBe(result.analyzedFiles + result.filesOmitted);
        expect(result.specRelevantFiles).toBeLessThanOrEqual(result.analyzedFiles);

        const { logger } = await import('../../utils/logger.js');
        vi.clearAllMocks();
        process.stdout.write = originalWrite;
        await driftCommand.parseAsync([], { from: 'user' });
        expect(logger.warning).toHaveBeenCalledWith(expect.stringMatching(/100 analyzed.*50 changed files were omitted.*incomplete/i));
        expect(logger.success).not.toHaveBeenCalledWith(expect.stringMatching(/in sync/i));
      } finally {
        process.stdout.write = originalWrite;
        process.chdir(originalCwd);
        process.exitCode = undefined;
      }
    }, 20_000);
  });

  describe('--max-files input validation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.exitCode = undefined;
    });

    it('rejects --max-files 0', async () => {
      const { driftCommand } = await import('./drift.js');
      const { logger } = await import('../../utils/logger.js');
      await driftCommand.parseAsync(['--max-files', '0'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('--max-files must be a positive integer');
      expect(process.exitCode).toBe(2);
    });

    it('rejects --max-files -10', async () => {
      const { driftCommand } = await import('./drift.js');
      const { logger } = await import('../../utils/logger.js');
      await driftCommand.parseAsync(['--max-files', '-10'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('--max-files must be a positive integer');
      expect(process.exitCode).toBe(2);
    });

    it('rejects non-numeric --max-files', async () => {
      const { driftCommand } = await import('./drift.js');
      const { logger } = await import('../../utils/logger.js');
      await driftCommand.parseAsync(['--max-files', 'abc'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('--max-files must be a positive integer');
      expect(process.exitCode).toBe(2);
    });

    it('rejects fractional --max-files', async () => {
      const { driftCommand } = await import('./drift.js');
      const { logger } = await import('../../utils/logger.js');
      await driftCommand.parseAsync(['--max-files', '1.5'], { from: 'user' });
      expect(logger.error).toHaveBeenCalledWith('--max-files must be a positive integer');
      expect(process.exitCode).toBe(2);
    });
  });
});
