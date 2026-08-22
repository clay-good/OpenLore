/** openlore run command — CLI presentation over the shared public pipeline. */

import { Command } from 'commander';
import { openloreRun } from '../../api/run.js';
import {
  COST_CONFIRMATION_THRESHOLD,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_FILES,
} from '../../constants.js';
import { formatDuration } from '../../utils/command-helpers.js';
import { logger } from '../../utils/logger.js';
import { confirm } from '@inquirer/prompts';

interface RunOptions {
  force: boolean;
  reanalyze: boolean;
  model: string;
  dryRun: boolean;
  yes: boolean;
  maxFiles: number | string;
  adr: boolean;
}

export async function confirmRunGeneration(
  estimate: { cost: number },
  autoYes: boolean,
  interactive = process.stdin.isTTY === true,
): Promise<boolean> {
  if (estimate.cost <= COST_CONFIRMATION_THRESHOLD || autoYes) return true;
  const message = `Estimated cost: ~$${estimate.cost.toFixed(2)}. Continue?`;
  if (!interactive) {
    logger.warning(`${message} — use --yes to confirm in non-interactive mode`);
    return false;
  }
  return confirm({ message, default: true });
}

export const runCommand = new Command('run')
  .description('Run the full openlore pipeline (init → analyze → generate)')
  .option('--force', 'Reinitialize even if config exists', false)
  .option('--reanalyze', 'Force fresh analysis even if recent exists', false)
  .option('--model <name>', 'LLM model to use for generation', DEFAULT_ANTHROPIC_MODEL)
  .option('--dry-run', 'Show what would be done without making changes', false)
  .option('-y, --yes', 'Skip all confirmation prompts', false)
  .option('--max-files <n>', 'Maximum files to analyze (default: 100000)', '100000')
  .option('--adr', 'Also generate Architecture Decision Records', false)
  .addHelpText('after', `
Examples:
  $ openlore run                     Run the full pipeline with smart defaults
  $ openlore run --force             Reinitialize and re-analyze
  $ openlore run --reanalyze         Force fresh analysis
  $ openlore run --model claude-opus-4-20250514
  $ openlore run --dry-run           Preview without modifying the project
  $ openlore run -y                  Skip confirmation prompts
`)
  .action(async function (this: Command, options: Partial<RunOptions>) {
    const maxFiles = typeof options.maxFiles === 'string'
      ? Number.parseInt(options.maxFiles, 10)
      : options.maxFiles ?? DEFAULT_MAX_FILES;
    if (!Number.isInteger(maxFiles) || maxFiles < 1) {
      logger.error('--max-files must be a positive integer');
      process.exitCode = 1;
      return;
    }

    const globalOpts = this.optsWithGlobals?.() ?? {};
    const modelWasExplicit = this.getOptionValueSource?.('model') !== 'default';
    try {
      logger.section('Running openlore pipeline');
      const result = await openloreRun({
        rootPath: process.cwd(),
        force: options.force ?? false,
        reanalyze: options.reanalyze ?? false,
        model: modelWasExplicit ? options.model : undefined,
        dryRun: options.dryRun ?? false,
        maxFiles,
        adr: options.adr ?? false,
        apiBase: globalOpts.apiBase,
        sslVerify: globalOpts.insecure ? false : undefined,
        timeout: globalOpts.timeout,
        quiet: false,
        confirmGeneration: estimate => confirmRunGeneration(estimate, options.yes ?? false),
        onProgress: event => {
          if (event.phase === 'run' && event.status === 'start') logger.discovery(event.step);
        },
      });

      if (result.dryRun) {
        logger.success('Dry run complete. No files were modified.');
        return;
      }
      logger.success(`Pipeline completed in ${formatDuration(result.duration)}`);
      logger.info('Specifications written', result.generation.report.filesWritten.length);
    } catch (error) {
      logger.error(`Pipeline failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });
