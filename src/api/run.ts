/**
 * openlore run — programmatic API
 *
 * Thin orchestration over the public init, analyze, and generate APIs. Keeping
 * this function compositional prevents the full-pipeline entry point from
 * drifting from the standalone stages.
 */

import type { ProgressCallback, RunApiOptions, RunResult } from './types.js';
import { openloreInit } from './init.js';
import { openloreAnalyze } from './analyze.js';
import { openloreGenerate } from './generate.js';
import { withLoggerOptions } from '../utils/logger.js';
import {
  detectOpenSpecPackageVersion,
  OPENLORE_PACKAGE_VERSION,
  resolveGenerationProvider,
} from '../core/runtime/generation-core.js';
import { errors, isOpenLoreError } from '../utils/errors.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { resolve } from 'node:path';
import { estimateCost } from '../utils/command-helpers.js';

function progress(
  onProgress: ProgressCallback | undefined,
  step: string,
  status: 'start' | 'complete',
): void {
  onProgress?.({ phase: 'run', step, status });
}

/** Run the full OpenLore pipeline: init → analyze → generate. */
async function runCore(options: RunApiOptions): Promise<RunResult> {
  const startTime = Date.now();
  const rootPath = resolve(options.rootPath ?? process.cwd());

  if (options.dryRun) {
    const generationStartTime = Date.now();
    const config = await readOpenLoreConfig(rootPath, options.configPath);
    const generation = {
      dryRun: true as const,
      report: {
        timestamp: new Date().toISOString(),
        openspecVersion: await detectOpenSpecPackageVersion(rootPath),
        openloreVersion: OPENLORE_PACKAGE_VERSION,
        configSchemaVersion: config?.version ?? 'unknown',
        filesWritten: [],
        filesSkipped: [],
        filesBackedUp: [],
        filesMerged: [],
        domainsRemoved: [],
        configUpdated: false,
        validationErrors: [],
        warnings: [],
        nextSteps: ['Run without dryRun to initialize, analyze, and generate specs'],
      },
      duration: Date.now() - generationStartTime,
    };
    return {
      dryRun: true,
      plan: { init: true, analyze: true, generate: true },
      generation,
      duration: Date.now() - startTime,
    };
  }

  const shared = {
    rootPath,
    configPath: options.configPath,
    onProgress: options.onProgress,
    quiet: options.quiet,
    signal: options.signal,
  };

  progress(options.onProgress, 'Initialization', 'start');
  const init = await openloreInit({ ...shared, force: options.force });
  progress(options.onProgress, 'Initialization', 'complete');

  progress(options.onProgress, 'Analysis', 'start');
  let analysis = await openloreAnalyze({
    ...shared,
    maxFiles: options.maxFiles,
    force: options.reanalyze || options.force,
    reExtract: options.reExtract,
  });
  if (!analysis.depGraph) {
    progress(options.onProgress, 'Healing dependency graph', 'start');
    analysis = await openloreAnalyze({
      ...shared,
      maxFiles: options.maxFiles,
      force: true,
      reExtract: options.reExtract,
    });
    progress(options.onProgress, 'Healing dependency graph', 'complete');
  }
  progress(options.onProgress, 'Analysis', 'complete');

  if (options.confirmGeneration) {
    const config = await readOpenLoreConfig(rootPath, options.configPath);
    const resolved = resolveGenerationProvider(config ?? undefined, {
      provider: options.provider,
      model: options.model,
      openaiCompatBaseUrl: options.openaiCompatBaseUrl,
    });
    if (!resolved) throw errors.apiNoApiKey();
    const estimate = estimateCost(analysis.artifacts.llmContext, resolved.provider, resolved.model);
    const confirmed = await options.confirmGeneration({
      ...estimate,
      provider: resolved.provider,
      model: resolved.model,
    });
    if (!confirmed) throw errors.pipelineFailed('Generation cancelled by user');
  }

  progress(options.onProgress, 'Generation', 'start');
  const generation = await openloreGenerate({
    ...shared,
    provider: options.provider,
    model: options.model,
    apiBase: options.apiBase,
    sslVerify: options.sslVerify,
    openaiCompatBaseUrl: options.openaiCompatBaseUrl,
    timeout: options.timeout,
    adr: options.adr,
    dryRun: false,
    force: options.force,
  });
  progress(options.onProgress, 'Generation', 'complete');

  if (generation.dryRun) {
    throw errors.pipelineFailed('Generation unexpectedly returned a dry-run result');
  }

  return { dryRun: false, init, analysis, generation, duration: Date.now() - startTime };
}

export async function openloreRun(options: RunApiOptions = {}): Promise<RunResult> {
  try {
    return await withLoggerOptions(
      { quiet: options.quiet ?? true },
      () => runCore(options),
    );
  } catch (error) {
    if (isOpenLoreError(error)) throw error;
    throw errors.pipelineFailed(`Run failed: ${(error as Error).message}`, error);
  }
}
