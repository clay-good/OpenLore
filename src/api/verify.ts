/**
 * openlore verify — programmatic API
 *
 * Tests generated spec accuracy against actual source code.
 * Never controls the process and is console-silent by default.
 */

import { join, resolve } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_LOGS_SUBDIR, OPENLORE_OUTPUTS_SUBDIR, OPENLORE_VERIFICATION_SUBDIR, OPENSPEC_SPECS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH, ARTIFACT_GENERATION_REPORT } from '../constants.js';
import { fileExists, readJsonFile } from '../utils/command-helpers.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { isLlmLoggingEnabled } from '../core/services/llm-logging-policy.js';
import type { LLMService } from '../core/services/llm-service.js';
import { SpecVerificationEngine } from '../core/verifier/verification-engine.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import type { GenerationReport } from '../core/generator/openspec-writer.js';
import type { VerifyApiOptions, VerifyResult, ProgressCallback } from './types.js';
import { resolveOpenspecDir } from '../utils/openspec-dir.js';
import { resolveTrustedApiBase, resolveTrustedSslVerify } from '../core/services/repo-config-trust.js';
import { errors, isOpenLoreError } from '../utils/errors.js';
import { withLoggerOptions } from '../utils/logger.js';
import { resolveGenerationProvider } from '../core/runtime/generation-core.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'verify', step, status, detail });
}

/**
 * Verify generated specs against actual source code.
 *
 * Samples files and validates that specs accurately describe behavior
 * using an LLM to predict behavior from specs and compare against code.
 *
 * @throws OpenLoreError with a stable API code when verification cannot complete
 */
async function verify(options: VerifyApiOptions): Promise<VerifyResult> {
  const startTime = Date.now();
  const rootPath = resolve(options.rootPath ?? process.cwd());
  const samples = options.samples ?? 5;
  const threshold = options.threshold ?? 0.5;
  const { onProgress } = options;

  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error('samples must be a positive integer');
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('threshold must be a finite number between 0 and 1');
  }

  // Load config
  const openloreConfig = await readOpenLoreConfig(rootPath, options.configPath);
  if (!openloreConfig) {
    throw errors.noConfig(options.configPath);
  }

  // Check specs exist
  const openspecPath = resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
  const specsPath = join(openspecPath, OPENSPEC_SPECS_SUBDIR);
  if (!(await fileExists(specsPath))) {
    throw new Error('No specs found. Run openloreGenerate() first.');
  }

  // Load dependency graph
  progress(onProgress, 'Loading analysis', 'start');
  const analysisPath = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  let depGraph: DependencyGraphResult | null;
  try {
    depGraph = await readJsonFile<DependencyGraphResult>(
      join(analysisPath, ARTIFACT_DEPENDENCY_GRAPH),
      ARTIFACT_DEPENDENCY_GRAPH,
    );
  } catch (error) {
    throw errors.noAnalysis(analysisPath, error);
  }
  if (!depGraph) {
    throw errors.noAnalysis(analysisPath);
  }

  // Load generation report
  const genReport = await readJsonFile<GenerationReport>(
    join(rootPath, OPENLORE_DIR, OPENLORE_OUTPUTS_SUBDIR, ARTIFACT_GENERATION_REPORT),
    ARTIFACT_GENERATION_REPORT,
  );
  const generationContext: string[] = genReport?.filesWritten ?? [];
  progress(onProgress, 'Loading analysis', 'complete');

  const resolved = resolveGenerationProvider(openloreConfig, {
    provider: options.provider,
    model: options.model,
    openaiCompatBaseUrl: options.openaiCompatBaseUrl,
  });
  if (!resolved) throw errors.apiNoApiKey();
  let llm: LLMService;
  try {
    llm = createLLMService({
      provider: resolved.provider,
      model: resolved.model,
      apiBase: resolveTrustedApiBase(options.apiBase, openloreConfig.llm?.apiBase),
      sslVerify: resolveTrustedSslVerify(
        options.sslVerify === undefined ? undefined : !options.sslVerify,
        openloreConfig.llm?.sslVerify,
      ),
      openaiCompatBaseUrl: resolved.openaiCompatBaseUrl,
      timeout: options.timeout ?? openloreConfig.generation?.timeout,
      disableResponseFormat: openloreConfig.generation?.disableResponseFormat,
      enableLogging: isLlmLoggingEnabled(),
      logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
      logRoot: rootPath,
    });
  } catch (error) {
    throw new Error(`Failed to create LLM service: ${(error as Error).message}`, { cause: error });
  }

  // Run verification
  progress(onProgress, 'Selecting verification files', 'start');
  const verificationDir = join(rootPath, OPENLORE_DIR, OPENLORE_VERIFICATION_SUBDIR);
  const engine = new SpecVerificationEngine(llm, {
    rootPath,
    openspecPath,
    outputDir: verificationDir,
    filesPerDomain: samples,
    passThreshold: threshold,
    generationContext,
  });

  const selectedCandidates = await engine.prepareCandidates(depGraph, samples);
  if (selectedCandidates.length === 0) {
    throw new Error('No suitable verification candidates found.');
  }
  progress(onProgress, 'Selecting verification files', 'complete', `${selectedCandidates.length} candidates`);

  progress(onProgress, 'Verifying specs against codebase', 'start');
  const report = await engine.verify(depGraph, openloreConfig.version, selectedCandidates);
  progress(
    onProgress,
    'Verifying specs against codebase',
    'complete',
    `${(report.overallConfidence * 100).toFixed(0)}% weighted mixed-evidence composite confidence`,
  );

  // Save LLM logs
  await llm.saveLogs().catch(() => {});

  return {
    report,
    duration: Date.now() - startTime,
  };
}

export async function openloreVerify(options: VerifyApiOptions = {}): Promise<VerifyResult> {
  try {
    return await withLoggerOptions({ quiet: options.quiet ?? true }, () => verify(options));
  } catch (error) {
    if (isOpenLoreError(error)) throw error;
    throw errors.pipelineFailed(`Verification failed: ${(error as Error).message}`, error);
  }
}
