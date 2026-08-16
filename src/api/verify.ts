/**
 * openlore verify — programmatic API
 *
 * Tests generated spec accuracy against actual source code.
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_LOGS_SUBDIR, OPENLORE_OUTPUTS_SUBDIR, OPENLORE_VERIFICATION_SUBDIR, OPENSPEC_SPECS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH, ARTIFACT_GENERATION_REPORT, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_COMPAT_MODEL } from '../constants.js';
import { fileExists, readJsonFile } from '../utils/command-helpers.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import type { LLMService } from '../core/services/llm-service.js';
import { SpecVerificationEngine } from '../core/verifier/verification-engine.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import type { GenerationReport } from '../core/generator/openspec-writer.js';
import type { VerifyApiOptions, VerifyResult, ProgressCallback } from './types.js';
import { resolveOpenspecDir } from '../utils/openspec-dir.js';
import { resolveTrustedApiBase, resolveTrustedSslVerify } from '../core/services/repo-config-trust.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'verify', step, status, detail });
}

/**
 * Verify generated specs against actual source code.
 *
 * Samples files and validates that specs accurately describe behavior
 * using an LLM to predict behavior from specs and compare against code.
 *
 * @throws Error if no openlore configuration found
 * @throws Error if no specs or analysis found
 * @throws Error if no LLM API key found
 * @throws Error if no verification candidates found
 */
export async function openloreVerify(options: VerifyApiOptions = {}): Promise<VerifyResult> {
  const startTime = Date.now();
  const rootPath = options.rootPath ?? process.cwd();
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
  const openloreConfig = await readOpenLoreConfig(rootPath);
  if (!openloreConfig) {
    throw new Error('No openlore configuration found. Run openloreInit() first.');
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
  const depGraph = await readJsonFile<DependencyGraphResult>(
    join(analysisPath, ARTIFACT_DEPENDENCY_GRAPH),
    ARTIFACT_DEPENDENCY_GRAPH,
  );
  if (!depGraph) {
    throw new Error('No analysis found. Run openloreAnalyze() first.');
  }

  // Load generation report
  const genReport = await readJsonFile<GenerationReport>(
    join(rootPath, OPENLORE_DIR, OPENLORE_OUTPUTS_SUBDIR, ARTIFACT_GENERATION_REPORT),
    ARTIFACT_GENERATION_REPORT,
  );
  const generationContext: string[] = genReport?.filesWritten ?? [];
  progress(onProgress, 'Loading analysis', 'complete');

  // Create LLM service — support all four providers
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiCompatKey = process.env.OPENAI_COMPAT_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const noKeyProviders = ['claude-code', 'codex-cli', 'mistral-vibe', 'copilot', 'gemini-cli', 'antigravity-cli', 'cursor-agent'];
  const configuredProvider = options.provider ?? openloreConfig.generation?.provider;
  if (!noKeyProviders.includes(configuredProvider ?? '') && !anthropicKey && !openaiKey && !openaiCompatKey && !geminiKey) {
    throw new Error('No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_API_KEY.');
  }

  const envDetectedProvider = anthropicKey ? 'anthropic'
    : geminiKey ? 'gemini'
    : openaiCompatKey ? 'openai-compat'
    : 'openai';
  const provider = configuredProvider ?? envDetectedProvider;
  const defaultModels: Record<string, string> = {
    anthropic: DEFAULT_ANTHROPIC_MODEL,
    gemini: DEFAULT_GEMINI_MODEL,
    'openai-compat': DEFAULT_OPENAI_COMPAT_MODEL,
    openai: DEFAULT_OPENAI_MODEL,
    'claude-code': 'claude-code',
    'codex-cli': 'codex-cli',
    'mistral-vibe': 'mistral-vibe',
    'gemini-cli': 'gemini-cli',
    'antigravity-cli': 'antigravity-cli',
    'cursor-agent': 'cursor-agent',
  };
  const effectiveModel = options.model ?? defaultModels[provider] ?? DEFAULT_ANTHROPIC_MODEL;
  let llm: LLMService;
  try {
    llm = createLLMService({
      provider,
      model: effectiveModel,
      apiBase: resolveTrustedApiBase(options.apiBase, openloreConfig.llm?.apiBase),
      sslVerify: resolveTrustedSslVerify(
        options.sslVerify === undefined ? undefined : !options.sslVerify,
        openloreConfig.llm?.sslVerify,
      ),
      openaiCompatBaseUrl: options.openaiCompatBaseUrl,
      timeout: options.timeout ?? openloreConfig.generation?.timeout,
      enableLogging: true,
      logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
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
