/**
 * openlore drift — programmatic API
 *
 * Detects spec drift: finds code changes not reflected in specs.
 * Never controls the process and is console-silent by default.
 */

import { join, resolve } from 'node:path';
import { DEFAULT_DRIFT_MAX_FILES, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_LOGS_SUBDIR, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR, ARTIFACT_REPO_STRUCTURE } from '../constants.js';
import { fileExists } from '../utils/command-helpers.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import {
  getChangedFiles,
  isGitRepositoryRoot,
  buildSpecMap,
  buildADRMap,
  detectDrift,
} from '../core/drift/index.js';
import { createLLMService } from '../core/services/llm-service.js';
import { isLlmLoggingEnabled } from '../core/services/llm-logging-policy.js';
import type { LLMService } from '../core/services/llm-service.js';
import type { DriftResult } from '../types/index.js';
import type { DriftApiOptions, ProgressCallback } from './types.js';
import { resolveOpenspecDir } from '../utils/openspec-dir.js';
import { resolveTrustedApiBase, resolveTrustedSslVerify } from '../core/services/repo-config-trust.js';
import { errors, isOpenLoreError } from '../utils/errors.js';
import { withLoggerOptions } from '../utils/logger.js';
import { resolveGenerationProvider } from '../core/runtime/generation-core.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'drift', step, status, detail });
}

/**
 * Detect spec drift in a project.
 *
 * Compares code changes against existing OpenSpec specifications
 * and reports gaps, stale specs, uncovered files, and orphaned specs.
 *
 * @throws OpenLoreError with a stable API code when drift detection cannot complete
 */
async function drift(options: DriftApiOptions): Promise<DriftResult> {
  const startTime = Date.now();
  const rootPath = resolve(options.rootPath ?? process.cwd());
  const baseRef = options.baseRef ?? 'auto';
  const files = options.files ?? [];
  const domains = options.domains ?? [];
  const llmEnhanced = options.llmEnhanced ?? false;
  const failOn = options.failOn ?? 'warning';
  const maxFiles = options.maxFiles ?? DEFAULT_DRIFT_MAX_FILES;
  const { onProgress } = options;

  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error('maxFiles must be a positive integer');
  }

  // Validate git repo. Root-only: drift joins git's repo-root-relative changed-file
  // paths against the analyzed-root-relative spec map, so it is correct only when the
  // analyzed root IS the repository root. Below-root support is out of scope here;
  // gating on the root preserves the exact prior refusal instead of silently joining
  // mismatched path frames (which would miss real drift / invent phantom gaps).
  if (!(await isGitRepositoryRoot(rootPath))) {
    throw new Error('Not a git repository (or not at its root). Drift detection requires git and must run at the repository root.');
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

  // Create LLM service if needed — support all four providers
  let llm: LLMService | undefined;
  if (llmEnhanced) {
    const resolved = resolveGenerationProvider(openloreConfig, {
      provider: options.provider,
      model: options.model,
      openaiCompatBaseUrl: options.openaiCompatBaseUrl,
    });
    if (!resolved) throw errors.apiNoApiKey();
    llm = createLLMService({
      provider: resolved.provider,
      model: resolved.model,
      apiBase: resolveTrustedApiBase(options.apiBase, openloreConfig.llm?.apiBase),
      openaiCompatBaseUrl: resolved.openaiCompatBaseUrl,
      sslVerify: resolveTrustedSslVerify(
        options.sslVerify === undefined ? undefined : !options.sslVerify,
        openloreConfig.llm?.sslVerify,
      ),
      timeout: options.timeout ?? openloreConfig.generation?.timeout,
      disableResponseFormat: openloreConfig.generation?.disableResponseFormat,
      enableLogging: isLlmLoggingEnabled(),
      logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
      logRoot: rootPath,
    });
  }

  // Get changed files
  progress(onProgress, 'Analyzing git changes', 'start');
  const gitResult = await getChangedFiles({
    rootPath,
    baseRef,
    pathFilter: files.length > 0 ? files : undefined,
    includeUnstaged: true,
  });
  progress(onProgress, 'Analyzing git changes', 'complete', `${gitResult.files.length} changed files`);

  if (gitResult.files.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      baseRef: gitResult.resolvedBase,
      totalChangedFiles: 0,
      analyzedFiles: 0,
      filesOmitted: 0,
      specRelevantFiles: 0,
      issues: [],
      summary: { gaps: 0, stale: 0, uncovered: 0, orphanedSpecs: 0, adrGaps: 0, adrOrphaned: 0, memoryDrifted: 0, memoryOrphaned: 0, memoryOutOfScope: 0, total: 0 },
      hasDrift: false,
      duration: Date.now() - startTime,
      mode: 'static',
    };
  }

  // Apply max-files limit
  const actualChangedFiles = gitResult.files.length;
  if (gitResult.files.length > maxFiles) {
    gitResult.files = gitResult.files.slice(0, maxFiles);
  }

  // Build spec map
  progress(onProgress, 'Loading spec mappings', 'start');
  const repoStructurePath = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_REPO_STRUCTURE);
  const hasRepoStructure = await fileExists(repoStructurePath);

  const specMap = await buildSpecMap({
    rootPath,
    openspecPath,
    repoStructurePath: hasRepoStructure ? repoStructurePath : undefined,
  });

  // Build ADR map
  const adrMap = await buildADRMap({
    rootPath,
    openspecPath,
    repoStructurePath: hasRepoStructure ? repoStructurePath : undefined,
  });
  progress(onProgress, 'Loading spec mappings', 'complete', `${specMap.domainCount} domains`);

  // Detect drift
  progress(onProgress, 'Detecting drift', 'start');
  const result = await detectDrift({
    rootPath,
    specMap,
    changedFiles: gitResult.files,
    failOn,
    domainFilter: domains.length > 0 ? domains : undefined,
    openspecRelPath: openloreConfig.openspecPath ?? OPENSPEC_DIR,
    llm,
    baseRef: gitResult.resolvedBase,
    adrMap: adrMap ?? undefined,
  });

  result.baseRef = gitResult.resolvedBase;
  result.totalChangedFiles = actualChangedFiles;
  result.analyzedFiles = gitResult.files.length;
  result.filesOmitted = actualChangedFiles - gitResult.files.length;
  progress(onProgress, 'Detecting drift', 'complete', `${result.summary.total} issues`);

  // Save LLM logs if applicable
  if (llm) {
    try { await llm.saveLogs(); } catch { /* best-effort */ }
  }

  return result;
}

export async function openloreDrift(options: DriftApiOptions = {}): Promise<DriftResult> {
  try {
    return await withLoggerOptions({ quiet: options.quiet ?? true }, () => drift(options));
  } catch (error) {
    if (isOpenLoreError(error)) throw error;
    throw errors.pipelineFailed(`Drift detection failed: ${(error as Error).message}`, error);
  }
}
