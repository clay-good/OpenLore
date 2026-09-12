import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProgressIndicator,
  createProgress,
  renderBar,
  showNextSteps,
  showGenerationSuccess,
  showAnalysisSuccess,
  showVerificationSuccess,
} from './progress.js';

// Mock ora
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

describe('ProgressIndicator', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('constructor', () => {
    it('should create with default options', () => {
      const progress = new ProgressIndicator();
      expect(progress).toBeInstanceOf(ProgressIndicator);
    });

    it('should respect enabled option', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.start('Test');
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('start', () => {
    it('should log message when disabled', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.start('Starting task');
      expect(consoleSpy).toHaveBeenCalledWith('Starting task');
    });
  });

  describe('succeed', () => {
    it('should log success message when disabled', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.succeed('Task completed');
      expect(consoleSpy).toHaveBeenCalledWith('✓ Task completed');
    });
  });

  describe('fail', () => {
    it('should log failure message when disabled', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.fail('Task failed');
      expect(consoleSpy).toHaveBeenCalledWith('✗ Task failed');
    });
  });

  describe('warn', () => {
    it('should log warning message when disabled', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.warn('Warning message');
      expect(consoleSpy).toHaveBeenCalledWith('⚠ Warning message');
    });
  });

  describe('info', () => {
    it('should log info message when disabled', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.info('Info message');
      expect(consoleSpy).toHaveBeenCalledWith('ℹ Info message');
    });
  });

  describe('updateAnalysis', () => {
    it('should format imports phase', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.updateAnalysis({
        phase: 'imports',
        current: 'src/index.ts',
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        'Analyzing imports... src/index.ts'
      );
    });

    it('should format scoring phase with counts', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.updateAnalysis({
        phase: 'scoring',
        processed: 10,
        total: 50,
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^Calculating significance scores \[.*\] 20% \(10\/50\)/)
      );
    });

    it('should format graph phase', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.updateAnalysis({ phase: 'graph' });
      expect(consoleSpy).toHaveBeenCalledWith(
        'Building dependency graph...'
      );
    });

    it('should format clustering phase', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.updateAnalysis({ phase: 'clustering' });
      expect(consoleSpy).toHaveBeenCalledWith(
        'Detecting domain clusters...'
      );
    });
  });

  describe('updateGeneration', () => {
    it('should format generation progress', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.updateGeneration({
        stage: 2,
        totalStages: 5,
        stageName: 'Entity Extraction',
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^Generating \[.*\] 40% \(2\/5\) Entity Extraction$/)
      );
    });

    it('should include token count when provided', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.updateGeneration({
        stage: 3,
        totalStages: 5,
        stageName: 'Service Analysis',
        tokensUsed: 1500,
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^Generating \[.*\] 60% \(3\/5\) Service Analysis \[1500 tokens\]$/)
      );
    });
  });

  describe('updateWriting', () => {
    it('should format writing progress', () => {
      const progress = new ProgressIndicator({ enabled: false });
      progress.updateWriting({
        current: 3,
        total: 6,
        currentFile: 'user/spec.md',
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^Writing specs \[.*\] 50% \(3\/6\) user\/spec\.md$/)
      );
    });
  });

  describe('verboseLog', () => {
    it('should not log when verbose is false', () => {
      const progress = new ProgressIndicator({ enabled: false, verbose: false });
      progress.verboseLog('Debug message');
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should log when verbose is true', () => {
      const progress = new ProgressIndicator({ enabled: false, verbose: true });
      progress.verboseLog('Debug message');
      expect(consoleSpy).toHaveBeenCalledWith('  [verbose] Debug message');
    });

    it('should collect logs', () => {
      const progress = new ProgressIndicator({ verbose: true, enabled: false });
      progress.verboseLog('Log 1');
      progress.verboseLog('Log 2');
      expect(progress.getLogs()).toEqual(['Log 1', 'Log 2']);
    });
  });

  // ── enabled=true paths (uses ora mock) ─────────────────────────────────────

  describe('enabled=true — spinner paths', () => {
    it('start creates a spinner when enabled', () => {
      const progress = new ProgressIndicator({ enabled: true });
      // Should not throw; ora mock returns a fake spinner
      expect(() => progress.start('Starting')).not.toThrow();
    });

    it('succeed without message calls spinner.succeed(undefined)', () => {
      const progress = new ProgressIndicator({ enabled: true });
      progress.start('Running');
      expect(() => progress.succeed()).not.toThrow();
    });

    it('succeed with message calls spinner.succeed with formatted text', () => {
      const progress = new ProgressIndicator({ enabled: true });
      progress.start('Running');
      expect(() => progress.succeed('Done')).not.toThrow();
    });

    it('fail without message calls spinner.fail(undefined)', () => {
      const progress = new ProgressIndicator({ enabled: true });
      progress.start('Running');
      expect(() => progress.fail()).not.toThrow();
    });

    it('fail with message when spinner active', () => {
      const progress = new ProgressIndicator({ enabled: true });
      progress.start('Running');
      expect(() => progress.fail('Failed')).not.toThrow();
    });

    it('warn when spinner active', () => {
      const progress = new ProgressIndicator({ enabled: true });
      progress.start('Running');
      expect(() => progress.warn('Be careful')).not.toThrow();
    });

    it('info when spinner active', () => {
      const progress = new ProgressIndicator({ enabled: true });
      progress.start('Running');
      expect(() => progress.info('FYI')).not.toThrow();
    });

    it('stop clears the spinner', () => {
      const progress = new ProgressIndicator({ enabled: true });
      progress.start('Running');
      expect(() => progress.stop()).not.toThrow();
    });

    it('update when spinner active sets text', () => {
      const progress = new ProgressIndicator({ enabled: true });
      progress.start('Running');
      expect(() => progress.update('Updated')).not.toThrow();
    });
  });
});

describe('createProgress', () => {
  it('should create a ProgressIndicator', () => {
    const progress = createProgress();
    expect(progress).toBeInstanceOf(ProgressIndicator);
  });

  it('should pass options', () => {
    const progress = createProgress({ enabled: false, verbose: true });
    expect(progress).toBeInstanceOf(ProgressIndicator);
  });
});

describe('renderBar', () => {
  it('returns a formatted bar for normal progress', () => {
    const bar = renderBar(5, 10);
    expect(bar).toContain('50%');
    expect(bar).toContain('(5/10)');
  });

  it('returns 0% bar when total is 0', () => {
    const bar = renderBar(0, 0);
    expect(bar).toContain('0%');
    expect(bar).toContain('(0/0)');
  });

  it('returns 100% bar when current equals total (no arrow)', () => {
    const bar = renderBar(10, 10, 10);
    expect(bar).toContain('100%');
    // When filled === width, there's no '>' arrow
    expect(bar).not.toContain('>');
  });

  it('uses custom width', () => {
    const bar = renderBar(1, 2, 20);
    expect(bar.length).toBeGreaterThan(0);
    expect(bar).toContain('50%');
  });
});

describe('showNextSteps', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should show steps after analysis', () => {
    showNextSteps({ analyzed: true });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openlore generate');
  });

  it('should show steps after generation', () => {
    showNextSteps({ generated: true });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openlore verify');
    expect(output).toContain('openspec validate');
  });

  it('should show steps after verification', () => {
    showNextSteps({ verified: true });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openspec change');
  });

  it('should show default steps', () => {
    showNextSteps({});
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('openlore');
    expect(output).toContain('--help');
  });
});

describe('showGenerationSuccess', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should show success message', () => {
    showGenerationSuccess({
      specsCount: 5,
      outputPath: 'openspec/specs/',
    });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Generation complete');
    expect(output).toContain('5 spec files');
    expect(output).toContain('openspec/specs/');
  });

  it('should show token count when provided', () => {
    showGenerationSuccess({
      specsCount: 3,
      outputPath: 'openspec/specs/',
      tokensUsed: 5000,
    });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('5,000 tokens');
  });
});

describe('showAnalysisSuccess', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should show success message', () => {
    showAnalysisSuccess({
      filesAnalyzed: 100,
      outputPath: '.openlore/analysis/',
    });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Analysis complete');
    expect(output).toContain('100 files analyzed');
  });

  it('should show domains when provided', () => {
    showAnalysisSuccess({
      filesAnalyzed: 50,
      outputPath: '.openlore/analysis/',
      domains: 5,
    });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('5 domain clusters');
  });
});

describe('showVerificationSuccess', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should show passed message', () => {
    showVerificationSuccess({
      score: 0.85,
      filesVerified: 5,
      passed: true,
    });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Verification passed');
    expect(output).toContain('85.0%');
    expect(output).toContain('5 files verified');
  });

  it('should show warning message when not passed', () => {
    showVerificationSuccess({
      score: 0.65,
      filesVerified: 5,
      passed: false,
    });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('warnings');
    expect(output).toContain('65.0%');
  });
});

// ── TTY-path coverage ─────────────────────────────────────────────────────────
// When process.stdout.isTTY is true the functions emit emoji-decorated output.

describe('showGenerationSuccess — TTY path', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('emits emoji-decorated output when isTTY=true', () => {
    showGenerationSuccess({ specsCount: 2, outputPath: 'out/', tokensUsed: 1000 });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Generation complete');
  });
});

describe('showAnalysisSuccess — TTY path', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('emits emoji-decorated output when isTTY=true (with domains)', () => {
    showAnalysisSuccess({ filesAnalyzed: 20, outputPath: 'out/', domains: 3 });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Analysis complete');
    expect(output).toContain('3 domain');
  });
});

describe('showVerificationSuccess — TTY path', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('emits passed message with emoji when isTTY=true', () => {
    showVerificationSuccess({ score: 0.9, filesVerified: 3, passed: true });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Verification passed');
  });

  it('emits warning message with emoji when isTTY=true and not passed', () => {
    showVerificationSuccess({ score: 0.5, filesVerified: 3, passed: false });
    const output = consoleSpy.mock.calls.flat().join('\n');
    expect(output).toContain('warnings');
  });
});
