import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OpenLoreError,
  errors,
  isOpenLoreError,
  formatError,
  handleError,
} from './errors.js';

describe('OpenLoreError', () => {
  describe('constructor', () => {
    it('preserves an internal cause for typed API errors', () => {
      const cause = new SyntaxError('bad json');
      const error = new OpenLoreError('Pipeline failed', 'pipeline-failed', undefined, { cause });

      expect(error.code).toBe('pipeline-failed');
      expect(error.cause).toBe(cause);
    });

    it('should create error with code and message', () => {
      const error = new OpenLoreError('Test message', 'NO_API_KEY');

      expect(error.message).toBe('Test message');
      expect(error.code).toBe('NO_API_KEY');
      expect(error.suggestion).toBeUndefined();
      expect(error.name).toBe('OpenLoreError');
    });

    it('should create error with suggestion', () => {
      const error = new OpenLoreError(
        'Test message',
        'NO_API_KEY',
        'Try this fix'
      );

      expect(error.message).toBe('Test message');
      expect(error.suggestion).toBe('Try this fix');
    });

    it('should be an instance of Error', () => {
      const error = new OpenLoreError('Test', 'UNKNOWN_ERROR');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(OpenLoreError);
    });
  });

  describe('format', () => {
    it('should format error with color', () => {
      const error = new OpenLoreError(
        'Something went wrong',
        'ANALYSIS_FAILED',
        'Try this instead'
      );

      const output = error.format(true);

      expect(output).toContain('Error [ANALYSIS_FAILED]:');
      expect(output).toContain('Something went wrong');
      expect(output).toContain('Suggestion:');
      expect(output).toContain('Try this instead');
      expect(output).toContain('\x1b['); // Contains color codes
    });

    it('should format error without color', () => {
      const error = new OpenLoreError(
        'Something went wrong',
        'ANALYSIS_FAILED',
        'Try this instead'
      );

      const output = error.format(false);

      expect(output).toContain('Error [ANALYSIS_FAILED]:');
      expect(output).toContain('Something went wrong');
      expect(output).toContain('Suggestion:');
      expect(output).toContain('Try this instead');
      expect(output).not.toContain('\x1b['); // No color codes
    });

    it('should include help link', () => {
      const error = new OpenLoreError('Test', 'UNKNOWN_ERROR');
      const output = error.format(false);

      expect(output).toContain('https://github.com/clay-good/openlore#readme');
    });
  });
});

describe('error factory functions', () => {
  describe('stable API errors', () => {
    it.each([
      [errors.noConfig(), 'no-config'],
      [errors.noAnalysis(), 'no-analysis'],
      [errors.apiNoApiKey(), 'no-api-key'],
    ] as const)('creates a lowercase typed error', (error, code) => {
      expect(error).toBeInstanceOf(OpenLoreError);
      expect(error.code).toBe(code);
    });

    it('carries the pipeline failure cause', () => {
      const cause = new Error('provider exploded');
      const error = errors.pipelineFailed('Generation failed', cause);
      expect(error.code).toBe('pipeline-failed');
      expect(error.cause).toBe(cause);
    });
  });

  describe('noApiKey', () => {
    it('should create NO_API_KEY error', () => {
      const error = errors.noApiKey();

      expect(error.code).toBe('NO_API_KEY');
      expect(error.message).toContain('No API key');
      expect(error.suggestion).toContain('ANTHROPIC_API_KEY');
      expect(error.suggestion).toContain('OPENAI_API_KEY');
    });
  });

  describe('notARepository', () => {
    it('should create NOT_A_REPOSITORY error', () => {
      const error = errors.notARepository();

      expect(error.code).toBe('NOT_A_REPOSITORY');
      expect(error.message).toContain('.git');
      expect(error.suggestion).toContain('git init');
      expect(error.suggestion).toContain('--force');
    });
  });

  describe('openspecExists', () => {
    it('should create OPENSPEC_EXISTS error with path', () => {
      const error = errors.openspecExists('/path/to/project');

      expect(error.code).toBe('OPENSPEC_EXISTS');
      expect(error.message).toContain('/path/to/project');
      expect(error.suggestion).toContain('--merge');
      expect(error.suggestion).toContain('--force');
    });
  });

  describe('analysisTooOld', () => {
    it('should create ANALYSIS_TOO_OLD error with age', () => {
      const error = errors.analysisTooOld(25.5);

      expect(error.code).toBe('ANALYSIS_TOO_OLD');
      expect(error.message).toContain('25.5 hours');
      expect(error.suggestion).toContain('--reanalyze');
    });
  });

  describe('noHighValueFiles', () => {
    it('should create NO_HIGH_VALUE_FILES error', () => {
      const error = errors.noHighValueFiles();

      expect(error.code).toBe('NO_HIGH_VALUE_FILES');
      expect(error.message).toContain('high-value files');
      expect(error.suggestion).toContain('config.json');
    });
  });

  describe('llmRateLimit', () => {
    it('should create LLM_RATE_LIMIT error with attempt info', () => {
      const error = errors.llmRateLimit(2, 3);

      expect(error.code).toBe('LLM_RATE_LIMIT');
      expect(error.message).toContain('rate limit');
      expect(error.suggestion).toContain('attempt 2 of 3');
    });
  });

  describe('openspecValidationFailed', () => {
    it('should create OPENSPEC_VALIDATION_FAILED error', () => {
      const error = errors.openspecValidationFailed();

      expect(error.code).toBe('OPENSPEC_VALIDATION_FAILED');
      expect(error.message).toContain('validation');
      expect(error.suggestion).toContain('.openlore/logs/');
    });

    it('should include details when provided', () => {
      const error = errors.openspecValidationFailed('missing required field');

      expect(error.message).toContain('missing required field');
    });
  });

  describe('analysisFailed', () => {
    it('should create ANALYSIS_FAILED error', () => {
      const error = errors.analysisFailed('No files found');

      expect(error.code).toBe('ANALYSIS_FAILED');
      expect(error.message).toContain('No files found');
      expect(error.suggestion).toContain('--verbose');
    });
  });

  describe('generationFailed', () => {
    it('should create GENERATION_FAILED error', () => {
      const error = errors.generationFailed('API timeout');

      expect(error.code).toBe('GENERATION_FAILED');
      expect(error.message).toContain('API timeout');
      expect(error.suggestion).toContain('openlore analyze');
    });
  });

  describe('verificationFailed', () => {
    it('should create VERIFICATION_FAILED error', () => {
      const error = errors.verificationFailed('No specs to verify');

      expect(error.code).toBe('VERIFICATION_FAILED');
      expect(error.message).toContain('No specs to verify');
      expect(error.suggestion).toContain('openlore generate');
    });
  });

  describe('configNotFound', () => {
    it('should create CONFIG_NOT_FOUND error', () => {
      const error = errors.configNotFound('/path/config.json');

      expect(error.code).toBe('CONFIG_NOT_FOUND');
      expect(error.message).toContain('/path/config.json');
      expect(error.suggestion).toContain('openlore init');
    });
  });

  describe('invalidConfig', () => {
    it('should create INVALID_CONFIG error', () => {
      const error = errors.invalidConfig('/path/config.json');

      expect(error.code).toBe('INVALID_CONFIG');
      expect(error.message).toContain('/path/config.json');
    });

    it('should include details when provided', () => {
      const error = errors.invalidConfig('/path/config.json', 'invalid JSON');

      expect(error.message).toContain('invalid JSON');
    });
  });

  describe('fileWriteError', () => {
    it('should create FILE_WRITE_ERROR error', () => {
      const error = errors.fileWriteError('/path/file.md');

      expect(error.code).toBe('FILE_WRITE_ERROR');
      expect(error.message).toContain('/path/file.md');
    });

    it('should include reason when provided', () => {
      const error = errors.fileWriteError('/path/file.md', 'permission denied');

      expect(error.message).toContain('permission denied');
    });
  });

  describe('fileReadError', () => {
    it('should create FILE_READ_ERROR error', () => {
      const error = errors.fileReadError('/path/file.md');

      expect(error.code).toBe('FILE_READ_ERROR');
      expect(error.message).toContain('/path/file.md');
    });
  });

  describe('unknown', () => {
    it('should create UNKNOWN_ERROR from Error', () => {
      const error = errors.unknown(new Error('Something broke'));

      expect(error.code).toBe('UNKNOWN_ERROR');
      expect(error.message).toContain('Something broke');
      expect(error.suggestion).toContain('report');
    });

    it('should create UNKNOWN_ERROR from string', () => {
      const error = errors.unknown('Something broke');

      expect(error.code).toBe('UNKNOWN_ERROR');
      expect(error.message).toContain('Something broke');
    });
  });
});

describe('isOpenLoreError', () => {
  it('should return true for OpenLoreError', () => {
    const error = new OpenLoreError('Test', 'UNKNOWN_ERROR');
    expect(isOpenLoreError(error)).toBe(true);
  });

  it('should return false for regular Error', () => {
    const error = new Error('Test');
    expect(isOpenLoreError(error)).toBe(false);
  });

  it('should return false for non-errors', () => {
    expect(isOpenLoreError('test')).toBe(false);
    expect(isOpenLoreError(null)).toBe(false);
    expect(isOpenLoreError(undefined)).toBe(false);
    expect(isOpenLoreError({})).toBe(false);
  });
});

describe('formatError', () => {
  it('should format OpenLoreError', () => {
    const error = new OpenLoreError('Test', 'ANALYSIS_FAILED', 'Fix it');
    const output = formatError(error, false);

    expect(output).toContain('Error [ANALYSIS_FAILED]:');
    expect(output).toContain('Test');
  });

  it('should wrap regular Error as unknown', () => {
    const error = new Error('Something broke');
    const output = formatError(error, false);

    expect(output).toContain('Error [UNKNOWN_ERROR]:');
    expect(output).toContain('Something broke');
  });

  it('should handle non-error values', () => {
    const output = formatError('string error', false);

    expect(output).toContain('Error [UNKNOWN_ERROR]:');
    expect(output).toContain('string error');
  });
});

describe('handleError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should log error and exit by default', () => {
    const error = new OpenLoreError('Test', 'ANALYSIS_FAILED');

    expect(() => handleError(error)).toThrow('process.exit called');
    expect(console.error).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('should not exit when exit=false', () => {
    const error = new OpenLoreError('Test', 'ANALYSIS_FAILED');

    handleError(error, false);

    expect(console.error).toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });
});
