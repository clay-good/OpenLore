/**
 * Progress indicators for openlore CLI
 * Uses ora for spinners with meaningful status messages
 */

import ora, { Ora } from 'ora';
import { logger } from './logger.js';
import { sanitizeForTerminal } from './misc.js';

/**
 * Render a tqdm-style progress bar: [=====>    ] 45% (9/20)
 */
export function renderBar(current: number, total: number, width = 30): string {
  const pct = total > 0 ? Math.min(current / total, 1) : 0;
  const filled = Math.floor(pct * width);
  const arrow = filled < width ? '>' : '';
  const dashes = width - filled - arrow.length;
  const bar = '='.repeat(filled) + arrow + ' '.repeat(Math.max(0, dashes));
  return `[${bar}] ${Math.round(pct * 100)}% (${current}/${total})`;
}

export interface ProgressOptions {
  /** Whether to show the spinner (false for non-TTY) */
  enabled?: boolean;
  /** Prefix for log messages */
  prefix?: string;
}

export interface AnalysisProgress {
  phase: 'imports' | 'scoring' | 'graph' | 'clustering';
  current?: string;
  processed?: number;
  total?: number;
}

export interface GenerationProgress {
  stage: number;
  totalStages: number;
  stageName: string;
  tokensUsed?: number;
}

export interface WritingProgress {
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Progress manager for CLI operations
 */
export class ProgressIndicator {
  private spinner: Ora | null = null;
  private enabled: boolean;
  private prefix: string;
  private verbose: boolean;
  private logs: string[] = [];

  constructor(options: ProgressOptions & { verbose?: boolean } = {}) {
    this.enabled = options.enabled ?? process.stdout.isTTY ?? false;
    this.prefix = options.prefix ?? '';
    this.verbose = options.verbose ?? false;
  }

  /**
   * Start a new spinner with a message
   */
  start(message: string): void {
    if (this.enabled) {
      this.spinner = ora({
        text: this.formatMessage(message),
        prefixText: this.prefix,
      }).start();
      logger.setActiveSpinner(this.spinner);
    } else {
      this.log(message);
    }
  }

  /**
   * Update the spinner text
   */
  update(message: string): void {
    if (this.spinner && this.enabled) {
      this.spinner.text = this.formatMessage(message);
    } else if (!this.enabled) {
      this.log(message);
    }
  }

  /**
   * Mark the current task as successful
   */
  succeed(message?: string): void {
    if (this.spinner && this.enabled) {
      this.spinner.succeed(message ? this.formatMessage(message) : undefined);
      this.spinner = null;
      logger.clearSpinner();
    } else if (message) {
      this.log(`✓ ${message}`);
    }
  }

  /**
   * Mark the current task as failed
   */
  fail(message?: string): void {
    if (this.spinner && this.enabled) {
      this.spinner.fail(message ? this.formatMessage(message) : undefined);
      this.spinner = null;
      logger.clearSpinner();
    } else if (message) {
      this.log(`✗ ${message}`);
    }
  }

  /**
   * Show a warning
   */
  warn(message: string): void {
    if (this.spinner && this.enabled) {
      this.spinner.warn(this.formatMessage(message));
      this.spinner = null;
      logger.clearSpinner();
    } else {
      this.log(`⚠ ${message}`);
    }
  }

  /**
   * Show an info message (pauses spinner)
   */
  info(message: string): void {
    if (this.spinner && this.enabled) {
      this.spinner.info(this.formatMessage(message));
      this.spinner = null;
      logger.clearSpinner();
    } else {
      this.log(`ℹ ${message}`);
    }
  }

  /**
   * Stop the spinner without a status
   */
  stop(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
      logger.clearSpinner();
    }
  }

  /**
   * Update analysis progress
   */
  updateAnalysis(progress: AnalysisProgress): void {
    const phases: Record<AnalysisProgress['phase'], string> = {
      imports: 'Analyzing imports',
      scoring: 'Calculating significance scores',
      graph: 'Building dependency graph',
      clustering: 'Detecting domain clusters',
    };

    let message = `${phases[progress.phase]}`;

    if (progress.processed !== undefined && progress.total !== undefined) {
      message += ` ${renderBar(progress.processed, progress.total)}`;
    } else {
      message += '...';
    }

    if (progress.current) {
      message += ` ${progress.current}`;
    }

    this.update(message);
  }

  /**
   * Update generation progress
   */
  updateGeneration(progress: GenerationProgress): void {
    const bar = renderBar(progress.stage, progress.totalStages);
    let message = `Generating ${bar} ${progress.stageName}`;

    if (progress.tokensUsed !== undefined) {
      message += ` [${progress.tokensUsed} tokens]`;
    }

    this.update(message);
  }

  /**
   * Update file writing progress
   */
  updateWriting(progress: WritingProgress): void {
    const bar = renderBar(progress.current, progress.total);
    let message = `Writing specs ${bar}`;

    if (progress.currentFile) {
      message += ` ${progress.currentFile}`;
    }

    this.update(message);
  }

  /**
   * Log a verbose message (only shown in verbose mode)
   */
  verboseLog(message: string): void {
    if (this.verbose) {
      this.logs.push(message);
      if (this.spinner && this.enabled) {
        // Pause spinner, log, resume
        this.spinner.stop();
        console.log(`  [verbose] ${sanitizeForTerminal(message, { keepNewlines: true })}`);
        this.spinner.start();
      } else {
        console.log(`  [verbose] ${sanitizeForTerminal(message, { keepNewlines: true })}`);
      }
    }
  }

  /**
   * Get all logs for saving
   */
  getLogs(): string[] {
    return [...this.logs];
  }

  /**
   * The single funnel for spinner text. Callers pass file paths and error messages
   * read out of the analyzed repository, and ora writes them to the terminal with
   * its own cursor control — so an ESC smuggled through a path would be interpreted
   * mid-spinner. Newlines go too: spinner text is one line by construction.
   */
  private formatMessage(message: string): string {
    return sanitizeForTerminal(message);
  }

  /** The non-TTY twin of formatMessage: same untrusted text, plain-line sink. */
  private log(message: string): void {
    console.log(sanitizeForTerminal(message, { keepNewlines: true }));
  }
}

/**
 * Create a progress indicator for CLI operations
 */
export function createProgress(
  options?: ProgressOptions & { verbose?: boolean }
): ProgressIndicator {
  return new ProgressIndicator(options);
}

/**
 * Show post-run suggestions for next steps
 */
export function showNextSteps(options: {
  generated?: boolean;
  verified?: boolean;
  analyzed?: boolean;
}): void {
  console.log('');
  console.log('Next steps:');

  if (options.analyzed && !options.generated) {
    console.log('1. openlore generate     # Generate specs from analysis');
    console.log('2. openspec list --specs # Review generated specs');
  } else if (options.generated && !options.verified) {
    console.log('1. openspec list --specs   # Review generated specs');
    console.log('2. openspec validate --all # Validate structure');
    console.log('3. openlore verify         # Test accuracy');
    console.log('4. openspec change <name>  # Start spec-driven development');
  } else if (options.verified) {
    console.log('1. openspec list --specs   # Review specs');
    console.log('2. openspec change <name>  # Start spec-driven development');
    console.log('3. openlore generate       # Re-generate if needed');
  } else {
    console.log('1. openlore                # Run full pipeline');
    console.log('2. openlore analyze        # Analyze codebase');
    console.log('3. openlore --help         # See all options');
  }

  console.log('');
}

/**
 * Show success message after generation
 */
export function showGenerationSuccess(options: {
  specsCount: number;
  outputPath: string;
  tokensUsed?: number;
}): void {
  const isTTY = process.stdout.isTTY === true;
  console.log('');
  console.log(isTTY ? '✅ Generation complete!' : '[ok] Generation complete!');
  console.log('');
  console.log(`   ${isTTY ? '📁' : '-'} ${options.specsCount} spec files written to ${sanitizeForTerminal(options.outputPath)}`);

  if (options.tokensUsed) {
    console.log(`   ${isTTY ? '🔤' : '-'} ${options.tokensUsed.toLocaleString()} tokens used`);
  }

  showNextSteps({ generated: true });
}

/**
 * Show success message after analysis
 */
export function showAnalysisSuccess(options: {
  filesAnalyzed: number;
  outputPath: string;
  domains?: number;
}): void {
  const isTTY = process.stdout.isTTY === true;
  console.log('');
  console.log(isTTY ? '✅ Analysis complete!' : '[ok] Analysis complete!');
  console.log('');
  console.log(`   ${isTTY ? '📁' : '-'} ${options.filesAnalyzed} files analyzed`);
  console.log(`   ${isTTY ? '📊' : '-'} Results saved to ${sanitizeForTerminal(options.outputPath)}`);

  if (options.domains) {
    console.log(`   ${isTTY ? '🏷️ ' : '-'} ${options.domains} domain clusters detected`);
  }

  showNextSteps({ analyzed: true });
}

/**
 * Show success message after verification
 */
export function showVerificationSuccess(options: {
  score: number;
  filesVerified: number;
  passed: boolean;
}): void {
  const isTTY = process.stdout.isTTY === true;
  console.log('');

  if (options.passed) {
    console.log(isTTY ? '✅ Verification passed!' : '[ok] Verification passed!');
  } else {
    console.log(isTTY ? '⚠️  Verification completed with warnings' : '[warn] Verification completed with warnings');
  }

  console.log('');
  console.log(`   ${isTTY ? '📊' : '-'} Accuracy score: ${(options.score * 100).toFixed(1)}%`);
  console.log(`   ${isTTY ? '📁' : '-'} ${options.filesVerified} files verified`);

  showNextSteps({ verified: true });
}
