/**
 * Standardized logging interface for openlore
 *
 * Provides semantic log levels with specific visual treatments:
 * - DISCOVERY: Finding files, detecting patterns, scanning directories
 * - ANALYSIS: Parsing AST, building graphs, scoring significance
 * - INFERENCE: LLM generating content, making decisions
 * - SUCCESS: Tasks complete successfully
 * - WARNING: Non-fatal issues, skipped files, fallback behavior
 * - ERROR: Fatal errors, missing requirements
 */

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sanitizeForTerminal } from './misc.js';

export type LogLevel = 'discovery' | 'analysis' | 'inference' | 'success' | 'warning' | 'error' | 'debug';

export interface LoggerOptions {
  quiet: boolean;
  verbose: boolean;
  noColor: boolean;
  timestamps: boolean;
}

const defaultOptions: LoggerOptions = {
  quiet: false,
  verbose: false,
  noColor: false,
  timestamps: false,
};

interface LoggerRequestContext {
  options: Partial<LoggerOptions>;
  /** API quiet means no console writes at all; configured CLI quiet still shows errors. */
  muteAll: boolean;
}

const loggerOptionsStorage = new AsyncLocalStorage<LoggerRequestContext>();

/**
 * Run a host request with logger options that are local to its async call chain.
 * Concurrent API calls therefore cannot mute or reconfigure each other's output.
 */
export function withLoggerOptions<T>(options: Partial<LoggerOptions>, callback: () => T): T {
  const inherited = loggerOptionsStorage.getStore();
  return loggerOptionsStorage.run({
    options: { ...inherited?.options, ...options },
    muteAll: inherited?.muteAll === true || options.quiet === true,
  }, callback);
}

/**
 * Semantic prefixes for each log level.
 * Emoji variants are used in interactive TTY sessions; plain ASCII in CI/pipes.
 */
const PREFIXES_EMOJI = {
  discovery: '🔍',
  analysis: '🔬',
  inference: '🧠',
  success: '✓',
  warning: '⚠',
  error: '✗',
  debug: '→',
} as const;

const PREFIXES_ASCII = {
  discovery: '[scan]',
  analysis: '[analyze]',
  inference: '[infer]',
  success: '[ok]',
  warning: '[warn]',
  error: '[error]',
  debug: '[debug]',
} as const;

const isTTY = process.stdout.isTTY === true;

/**
 * Color functions for each log level
 */
const COLORS = {
  discovery: chalk.cyan,
  analysis: chalk.yellow,
  inference: chalk.magenta,
  success: chalk.green,
  warning: chalk.hex('#FFA500'), // Orange
  error: chalk.red,
  debug: chalk.gray,
} as const;

/**
 * Logger class providing semantic log levels and spinner support
 */
export class Logger {
  private options: LoggerOptions;
  private activeSpinner: Ora | null = null;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = { ...defaultOptions, ...options };
  }

  /**
   * Update logger options
   */
  configure(options: Partial<LoggerOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Get current options
   */
  getOptions(): LoggerOptions {
    const context = loggerOptionsStorage.getStore();
    return {
      ...this.options,
      ...context?.options,
      ...(context?.muteAll ? { quiet: true } : {}),
    };
  }

  /**
   * Format a message with optional timestamp
   */
  private formatMessage(level: LogLevel, message: string): string {
    const options = this.getOptions();
    const prefix = isTTY && !options.noColor ? PREFIXES_EMOJI[level] : PREFIXES_ASCII[level];
    const colorFn = options.noColor ? (s: string) => s : COLORS[level];

    // Messages routinely carry repository-derived text (paths, symbol names). Strip
    // control sequences here, once, rather than at every call site — the prefix and
    // the color wrapper below are added afterwards, so OpenLore's own color survives.
    let formattedMessage = `${prefix} ${sanitizeForTerminal(message, { keepNewlines: true })}`;

    if (options.timestamps) {
      const timestamp = new Date().toISOString();
      formattedMessage = `[${timestamp}] ${formattedMessage}`;
    }

    return colorFn(formattedMessage);
  }

  /**
   * Core log method
   */
  private log(level: LogLevel, message: string): void {
    if (loggerOptionsStorage.getStore()?.muteAll) return;
    const options = this.getOptions();
    // In quiet mode, only show errors
    if (options.quiet && level !== 'error') {
      return;
    }

    // Debug messages only show in verbose mode
    if (level === 'debug' && !options.verbose) {
      return;
    }

    // Pause spinner if active to prevent overlap
    if (this.activeSpinner) {
      this.activeSpinner.stop();
    }

    const formattedMessage = this.formatMessage(level, message);

    if (level === 'error') {
      console.error(formattedMessage);
    } else {
      console.log(formattedMessage);
    }

    // Resume spinner if it was active
    if (this.activeSpinner) {
      this.activeSpinner.start();
    }
  }

  /**
   * DISCOVERY - Finding files, detecting patterns, scanning directories
   * @example logger.discovery("Discovered 847 files across 23 directories")
   */
  discovery(message: string): void {
    this.log('discovery', message);
  }

  /**
   * ANALYSIS - Parsing AST, building graphs, scoring significance
   * @example logger.analysis("Analyzing dependency graph...")
   */
  analysis(message: string): void {
    this.log('analysis', message);
  }

  /**
   * INFERENCE - LLM is generating content, making decisions
   * @example logger.inference("Inferring system intent from core modules...")
   */
  inference(message: string): void {
    this.log('inference', message);
  }

  /**
   * SUCCESS - Tasks complete successfully
   * @example logger.success("Generated openspec/specs/auth/spec.md")
   */
  success(message: string): void {
    this.log('success', message);
  }

  /**
   * WARNING - Non-fatal issues, skipped files, fallback behavior
   * @example logger.warning("Skipped 12 binary files")
   */
  warning(message: string): void {
    this.log('warning', message);
  }

  /**
   * ERROR - Fatal errors, missing requirements
   * @example logger.error("No .git directory found. Is this a repository?")
   */
  error(message: string): void {
    this.log('error', message);
  }

  /**
   * DEBUG - Verbose debug information (only shown with --verbose)
   * @example logger.debug("Processing file: src/utils/helper.ts")
   */
  debug(message: string): void {
    this.log('debug', message);
  }

  /**
   * Start a spinner for long-running operations
   * @returns Spinner control object with succeed/fail/stop methods
   */
  spinner(message: string): SpinnerController {
    const options = this.getOptions();
    // Don't show spinners in quiet mode or CI (timestamps mode)
    if (options.quiet || options.timestamps) {
      // Return a no-op controller
      return new SpinnerController(null, this);
    }

    // Stop any existing spinner
    if (this.activeSpinner) {
      this.activeSpinner.stop();
    }

    const spinner = ora({
      text: message,
      color: 'cyan',
      spinner: 'dots',
    });

    if (!options.noColor) {
      spinner.start();
    } else {
      // In no-color mode, just print the message
      console.log(`... ${message}`);
    }

    this.activeSpinner = spinner;
    return new SpinnerController(spinner, this);
  }

  /**
   * Register an external spinner so log calls pause/resume it correctly
   */
  setActiveSpinner(spinner: Ora | null): void {
    this.activeSpinner = spinner;
  }

  /**
   * Clear the active spinner reference
   */
  clearSpinner(): void {
    this.activeSpinner = null;
  }

  /**
   * Print a blank line (respects quiet mode)
   */
  blank(): void {
    if (!this.getOptions().quiet) {
      console.log();
    }
  }

  /**
   * Print a section header
   */
  section(title: string): void {
    title = sanitizeForTerminal(title);
    const options = this.getOptions();
    if (options.quiet) return;

    this.blank();
    if (options.noColor) {
      console.log(`=== ${title} ===`);
    } else {
      console.log(chalk.bold.underline(title));
    }
    this.blank();
  }

  /**
   * Print a key-value pair for summaries
   */
  info(key: string, value: string | number): void {
    key = sanitizeForTerminal(key);
    if (typeof value === 'string') value = sanitizeForTerminal(value);
    const options = this.getOptions();
    if (options.quiet) return;

    if (options.noColor) {
      console.log(`  ${key}: ${value}`);
    } else {
      console.log(`  ${chalk.dim(key + ':')} ${value}`);
    }
  }

  /**
   * Print a list item
   */
  listItem(item: string, indent: number = 0): void {
    item = sanitizeForTerminal(item);
    const options = this.getOptions();
    if (options.quiet) return;

    const prefix = '  '.repeat(indent) + '•';
    if (options.noColor) {
      console.log(`${prefix} ${item}`);
    } else {
      console.log(`${chalk.dim(prefix)} ${item}`);
    }
  }
}

/**
 * Controller for spinner operations
 */
export class SpinnerController {
  private spinner: Ora | null;
  private logger: Logger;

  constructor(spinner: Ora | null, logger: Logger) {
    this.spinner = spinner;
    this.logger = logger;
  }

  /**
   * Update spinner text
   */
  update(message: string): void {
    if (this.spinner) {
      this.spinner.text = message;
    }
  }

  /**
   * Mark spinner as succeeded
   */
  succeed(message?: string): void {
    if (this.spinner) {
      this.spinner.succeed(message);
    } else if (message) {
      this.logger.success(message);
    }
    this.logger.clearSpinner();
  }

  /**
   * Mark spinner as failed
   */
  fail(message?: string): void {
    if (this.spinner) {
      this.spinner.fail(message);
    } else if (message) {
      this.logger.error(message);
    }
    this.logger.clearSpinner();
  }

  /**
   * Mark spinner as warning
   */
  warn(message?: string): void {
    if (this.spinner) {
      this.spinner.warn(message);
    } else if (message) {
      this.logger.warning(message);
    }
    this.logger.clearSpinner();
  }

  /**
   * Stop spinner without status
   */
  stop(): void {
    if (this.spinner) {
      this.spinner.stop();
    }
    this.logger.clearSpinner();
  }

  /**
   * Stop spinner and show info
   */
  info(message?: string): void {
    if (this.spinner) {
      this.spinner.info(message);
    }
    this.logger.clearSpinner();
  }
}

/**
 * Singleton logger instance for use across the application
 */
export const logger = new Logger();

/**
 * Configure the global logger instance
 */
export function configureLogger(options: Partial<LoggerOptions>): void {
  logger.configure(options);
}

export default logger;
