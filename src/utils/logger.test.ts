/**
 * Tests for the Logger class
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, withLoggerOptions } from './logger.js';

describe('Logger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('constructor and configure', () => {
    it('should use default options when none provided', () => {
      const logger = new Logger();
      const options = logger.getOptions();

      expect(options.quiet).toBe(false);
      expect(options.verbose).toBe(false);
      expect(options.noColor).toBe(false);
      expect(options.timestamps).toBe(false);
    });

    it('should accept custom options', () => {
      const logger = new Logger({ quiet: true, verbose: true });
      const options = logger.getOptions();

      expect(options.quiet).toBe(true);
      expect(options.verbose).toBe(true);
    });

    it('should update options via configure', () => {
      const logger = new Logger();
      logger.configure({ quiet: true });

      expect(logger.getOptions().quiet).toBe(true);
    });
  });

  // In vitest, process.stdout.isTTY is false (non-interactive), so ASCII prefixes are used.
  describe('log levels', () => {
    it('should output discovery messages with correct prefix', () => {
      const logger = new Logger({ noColor: true });
      logger.discovery('Found 100 files');

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Found 100 files'));
    });

    it('should output analysis messages with correct prefix', () => {
      const logger = new Logger({ noColor: true });
      logger.analysis('Parsing AST');

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Parsing AST'));
    });

    it('should output inference messages with correct prefix', () => {
      const logger = new Logger({ noColor: true });
      logger.inference('Generating specs');

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Generating specs'));
    });

    it('should output success messages with correct prefix', () => {
      const logger = new Logger({ noColor: true });
      logger.success('Done');

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Done'));
    });

    it('should output warning messages with correct prefix', () => {
      const logger = new Logger({ noColor: true });
      logger.warning('Skipped file');

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Skipped file'));
    });

    it('should output error messages with correct prefix to stderr', () => {
      const logger = new Logger({ noColor: true });
      logger.error('Something failed');

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Something failed'));
    });

    it('should output debug messages with correct prefix', () => {
      const logger = new Logger({ noColor: true, verbose: true });
      logger.debug('Debug info');

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Debug info'));
    });
  });

  describe('quiet mode', () => {
    it('should suppress all non-error messages in quiet mode', () => {
      const logger = new Logger({ quiet: true, noColor: true });

      logger.discovery('test');
      logger.analysis('test');
      logger.inference('test');
      logger.success('test');
      logger.warning('test');
      logger.debug('test');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should still show error messages in quiet mode', () => {
      const logger = new Logger({ quiet: true, noColor: true });

      logger.error('Critical error');

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Critical error'));
    });

    it('scopes quiet mode to one async request without mutating logger options', async () => {
      const logger = new Logger({ noColor: true });

      await withLoggerOptions({ quiet: true }, async () => {
        await Promise.resolve();
        logger.success('hidden');
        logger.error('hidden-error');
      });
      logger.success('visible');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('visible'));
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(logger.getOptions().quiet).toBe(false);
    });

    it('keeps overlapping async logger scopes isolated', async () => {
      const logger = new Logger({ noColor: true });
      let releaseQuiet!: () => void;
      const quietGate = new Promise<void>(resolve => { releaseQuiet = resolve; });

      const quietRequest = withLoggerOptions({ quiet: true }, async () => {
        await quietGate;
        logger.success('quiet-request');
      });
      const normalRequest = withLoggerOptions({ quiet: false }, async () => {
        logger.success('normal-request');
        releaseQuiet();
      });
      await Promise.all([quietRequest, normalRequest]);

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('normal-request'));
    });

    it('does not let a nested scope re-enable any output from a muted request', async () => {
      const logger = new Logger({ noColor: true });

      await withLoggerOptions({ quiet: true }, async () => {
        await withLoggerOptions({ quiet: false }, async () => {
          logger.success('hidden-log');
          logger.error('hidden-error');
          logger.blank();
          logger.section('hidden-section');
          logger.info('hidden', 'info');
          logger.listItem('hidden-item');
          logger.spinner('hidden-spinner').stop();
        });
      });

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('verbose mode', () => {
    it('should hide debug messages when verbose is false', () => {
      const logger = new Logger({ noColor: true, verbose: false });

      logger.debug('Debug info');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should show debug messages when verbose is true', () => {
      const logger = new Logger({ noColor: true, verbose: true });

      logger.debug('Debug info');

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Debug info'));
    });
  });

  describe('timestamps', () => {
    it('should add timestamps when enabled', () => {
      const logger = new Logger({ noColor: true, timestamps: true });

      logger.success('Done');

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0] as string;
      // Timestamp is always ISO format; prefix varies by TTY mode
      expect(output).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] .+ Done$/);
    });
  });

  describe('section and info helpers', () => {
    it('should print section headers', () => {
      const logger = new Logger({ noColor: true });

      logger.section('Analysis Results');

      expect(consoleLogSpy).toHaveBeenCalledWith('=== Analysis Results ===');
    });

    it('should print info key-value pairs', () => {
      const logger = new Logger({ noColor: true });

      logger.info('Files', 100);

      expect(consoleLogSpy).toHaveBeenCalledWith('  Files: 100');
    });

    it('should print list items', () => {
      const logger = new Logger({ noColor: true });

      logger.listItem('First item');

      expect(consoleLogSpy).toHaveBeenCalledWith('• First item');
    });

    it('should respect indent level for list items', () => {
      const logger = new Logger({ noColor: true });

      logger.listItem('Nested item', 2);

      expect(consoleLogSpy).toHaveBeenCalledWith('    • Nested item');
    });

    it('should suppress helpers in quiet mode', () => {
      const logger = new Logger({ noColor: true, quiet: true });

      logger.section('Test');
      logger.info('Key', 'value');
      logger.listItem('Item');
      logger.blank();

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('spinner', () => {
    it('should return a SpinnerController', () => {
      const logger = new Logger({ noColor: true });
      const spinner = logger.spinner('Loading...');

      expect(spinner).toBeDefined();
      expect(typeof spinner.succeed).toBe('function');
      expect(typeof spinner.fail).toBe('function');
      expect(typeof spinner.stop).toBe('function');

      spinner.stop();
    });

    it('should return no-op spinner in quiet mode', () => {
      const logger = new Logger({ quiet: true });
      const spinner = logger.spinner('Loading...');

      // Should not throw
      spinner.update('Updated');
      spinner.succeed('Done');
    });

    it('should return no-op spinner in timestamps mode', () => {
      const logger = new Logger({ timestamps: true });
      const spinner = logger.spinner('Loading...');

      // Should not throw
      spinner.update('Updated');
      spinner.succeed('Done');
    });
  });
});
