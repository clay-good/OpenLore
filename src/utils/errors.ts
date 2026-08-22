/**
 * Custom error classes for openlore with helpful user-facing messages
 */

import {
  OPENLORE_DIR,
  OPENLORE_BACKUPS_SUBDIR,
  OPENLORE_LOGS_SUBDIR,
  OPENLORE_CONFIG_REL_PATH,
} from '../constants.js';

export type ApiErrorCode = 'no-config' | 'no-analysis' | 'no-api-key' | 'pipeline-failed';

export type ErrorCode = ApiErrorCode
  | 'NO_API_KEY'
  | 'NOT_A_REPOSITORY'
  | 'OPENSPEC_EXISTS'
  | 'ANALYSIS_TOO_OLD'
  | 'NO_HIGH_VALUE_FILES'
  | 'LLM_RATE_LIMIT'
  | 'OPENSPEC_VALIDATION_FAILED'
  | 'ANALYSIS_FAILED'
  | 'GENERATION_FAILED'
  | 'VERIFICATION_FAILED'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_CONFIG'
  | 'FILE_WRITE_ERROR'
  | 'FILE_READ_ERROR'
  | 'DRIFT_DETECTED'
  | 'NO_SPECS_FOUND'
  | 'UNKNOWN_ERROR';

/**
 * Base error class for openlore with code and suggestion
 */
export class OpenLoreError extends Error {
  constructor(
    message: string,
    public code: ErrorCode,
    public suggestion?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OpenLoreError';
    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace?.(this, this.constructor);
  }

  /**
   * Format error for CLI display with color support
   */
  format(useColor = true): string {
    const red = useColor ? '\x1b[31m' : '';
    const yellow = useColor ? '\x1b[33m' : '';
    const reset = useColor ? '\x1b[0m' : '';
    const dim = useColor ? '\x1b[2m' : '';

    let output = `${red}Error [${this.code}]:${reset} ${this.message}`;

    if (this.suggestion) {
      output += `\n\n${yellow}Suggestion:${reset} ${this.suggestion}`;
    }

    output += `\n\n${dim}For more help, see: https://github.com/clay-good/openlore#readme${reset}`;

    return output;
  }
}

/**
 * Error factory functions with predefined messages and suggestions
 */
export const errors = {
  noConfig(path?: string, cause?: unknown): OpenLoreError {
    return new OpenLoreError(
      `No openlore configuration found${path ? ` at ${path}` : ''}`,
      'no-config',
      `Run 'openlore init' to create a configuration file.`,
      { cause },
    );
  },

  noAnalysis(path?: string, cause?: unknown): OpenLoreError {
    return new OpenLoreError(
      `No openlore analysis found${path ? ` at ${path}` : ''}`,
      'no-analysis',
      `Run 'openlore analyze' before generating specifications.`,
      { cause },
    );
  },

  apiNoApiKey(cause?: unknown): OpenLoreError {
    return new OpenLoreError(
      'No API key found for LLM provider',
      'no-api-key',
      `Configure an API key or select a supported keyless provider.`,
      { cause },
    );
  },

  pipelineFailed(reason: string, cause?: unknown): OpenLoreError {
    return new OpenLoreError(
      reason,
      'pipeline-failed',
      `Inspect the underlying cause and retry the pipeline.`,
      { cause },
    );
  },

  noApiKey(): OpenLoreError {
    return new OpenLoreError(
      'No API key found for LLM provider',
      'NO_API_KEY',
      `Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.
Get an API key at https://console.anthropic.com/ or https://platform.openai.com/`
    );
  },

  notARepository(): OpenLoreError {
    return new OpenLoreError(
      'No .git directory found',
      'NOT_A_REPOSITORY',
      `openlore works best in git repositories.
Run 'git init' or use --force to continue anyway.`
    );
  },

  openspecExists(path: string): OpenLoreError {
    return new OpenLoreError(
      `openspec/specs/ already contains specifications at ${path}`,
      'OPENSPEC_EXISTS',
      `Use --merge to add to existing specs, or --force to overwrite.
Existing specs will be backed up to ${OPENLORE_DIR}/${OPENLORE_BACKUPS_SUBDIR}/`
    );
  },

  analysisTooOld(ageHours: number): OpenLoreError {
    return new OpenLoreError(
      `Existing analysis is ${ageHours.toFixed(1)} hours old`,
      'ANALYSIS_TOO_OLD',
      `Run 'openlore analyze' to refresh, or use --reanalyze flag.`
    );
  },

  noHighValueFiles(): OpenLoreError {
    return new OpenLoreError(
      'Could not identify any high-value files to analyze',
      'NO_HIGH_VALUE_FILES',
      `This might happen with unusual project structures.
Try adjusting scoring in ${OPENLORE_CONFIG_REL_PATH} or use --include patterns.`
    );
  },

  llmRateLimit(attempt: number, maxAttempts: number): OpenLoreError {
    return new OpenLoreError(
      'API rate limit exceeded',
      'LLM_RATE_LIMIT',
      `Waiting and retrying... (attempt ${attempt} of ${maxAttempts})
If this persists, try a different model or wait a few minutes.`
    );
  },

  openspecValidationFailed(details?: string): OpenLoreError {
    return new OpenLoreError(
      `Generated specs failed OpenSpec validation${details ? `: ${details}` : ''}`,
      'OPENSPEC_VALIDATION_FAILED',
      `Check ${OPENLORE_DIR}/${OPENLORE_LOGS_SUBDIR}/ for details.
This may indicate a generation bug - please report it at https://github.com/clay-good/openlore/issues`
    );
  },

  analysisFailed(reason: string): OpenLoreError {
    return new OpenLoreError(
      `Static analysis failed: ${reason}`,
      'ANALYSIS_FAILED',
      `Check that the project directory is accessible and contains source files.
Try running with --verbose for more details.`
    );
  },

  generationFailed(reason: string): OpenLoreError {
    return new OpenLoreError(
      `Spec generation failed: ${reason}`,
      'GENERATION_FAILED',
      `This could be due to API issues or invalid analysis data.
Try running 'openlore analyze' first, then 'openlore generate'.`
    );
  },

  verificationFailed(reason: string): OpenLoreError {
    return new OpenLoreError(
      `Verification failed: ${reason}`,
      'VERIFICATION_FAILED',
      `Ensure specs exist in openspec/specs/ directory.
Run 'openlore generate' first if you haven't already.`
    );
  },

  configNotFound(path: string): OpenLoreError {
    return new OpenLoreError(
      `Configuration file not found at ${path}`,
      'CONFIG_NOT_FOUND',
      `Run 'openlore init' to create a configuration file.`
    );
  },

  invalidConfig(path: string, details?: string): OpenLoreError {
    return new OpenLoreError(
      `Invalid configuration file at ${path}${details ? `: ${details}` : ''}`,
      'INVALID_CONFIG',
      `Check the configuration file format. You may need to delete it and run 'openlore init' again.`
    );
  },

  fileWriteError(path: string, reason?: string): OpenLoreError {
    return new OpenLoreError(
      `Failed to write file ${path}${reason ? `: ${reason}` : ''}`,
      'FILE_WRITE_ERROR',
      `Check that you have write permissions for the directory.`
    );
  },

  fileReadError(path: string, reason?: string): OpenLoreError {
    return new OpenLoreError(
      `Failed to read file ${path}${reason ? `: ${reason}` : ''}`,
      'FILE_READ_ERROR',
      `Check that the file exists and you have read permissions.`
    );
  },

  driftDetected(issueCount: number): OpenLoreError {
    return new OpenLoreError(
      `Spec drift detected: ${issueCount} issue${issueCount === 1 ? '' : 's'} found`,
      'DRIFT_DETECTED',
      `Run 'openlore drift' to see details, then update specs to match code changes.
Use 'openlore drift --verbose' for detailed issue descriptions.`
    );
  },

  noSpecsFound(): OpenLoreError {
    return new OpenLoreError(
      'No OpenSpec specifications found',
      'NO_SPECS_FOUND',
      `Run 'openlore generate' to create specifications from your codebase.`
    );
  },

  unknown(error: unknown): OpenLoreError {
    const message = error instanceof Error ? error.message : String(error);
    return new OpenLoreError(
      `An unexpected error occurred: ${message}`,
      'UNKNOWN_ERROR',
      `Please report this issue at https://github.com/clay-good/openlore/issues`
    );
  },
};

/**
 * Type guard to check if an error is a OpenLoreError
 */
export function isOpenLoreError(error: unknown): error is OpenLoreError {
  return error instanceof OpenLoreError;
}

/**
 * Format any error for CLI display
 */
export function formatError(error: unknown, useColor = true): string {
  if (isOpenLoreError(error)) {
    return error.format(useColor);
  }

  if (error instanceof Error) {
    return errors.unknown(error).format(useColor);
  }

  return errors.unknown(String(error)).format(useColor);
}

/**
 * Handle errors in CLI commands by formatting and logging them
 */
export function handleError(error: unknown, exit = true): never | void {
  console.error(formatError(error, process.stdout.isTTY));

  if (exit) {
    process.exit(1);
  }
}
