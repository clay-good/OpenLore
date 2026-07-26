/**
 * openlore drift — programmatic API
 *
 * Detects spec drift: finds code changes not reflected in specs.
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { DEFAULT_DRIFT_MAX_FILES, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_COMPAT_MODEL, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_LOGS_SUBDIR, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR, ARTIFACT_REPO_STRUCTURE } from '../constants.js';
import { fileExists } from '../utils/command-helpers.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import {
  getChangedFiles,
  isGitRepository,
  buildSpecMap,
  buildADRMap,
  detectDrift,
} from '../core/drift/index.js';
import { createLLMService } from '../core/services/llm-service.js';
import type { LLMService } from '../core/services/llm-service.js';
import type { DriftResult } from '../types/index.js';
import type { DriftApiOptions, ProgressCallback } from './types.js';
import { resolveOpenspecDir } from '../utils/openspec-dir.js';
import { resolveTrustedApiBase, resolveTrustedSslVerify } from '../core/services/repo-config-trust.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'drift', step, status, detail });
}

/**
 * Detect spec drift in a project.
 *
 * Compares code changes against existing OpenSpec specifications
 * and reports gaps, stale specs, uncovered files, and orphaned specs.
 *
 * @throws Error if not a git repository
 * @throws Error if no openlore configuration found
 * @throws Error if no specs found
 * @throws Error if LLM enhanced mode requested but no API key
 */
export async function openloreDrift(options: DriftApiOptions = {}): Promise<DriftResult> {
  const startTime = Date.now();
  const rootPath = options.rootPath ?? process.cwd();
  const baseRef = options.baseRef ?? 'auto';
  const files = options.files ?? [];
  const domains = options.domains ?? [];
  const llmEnhanced = options.llmEnhanced ?? false;
  const failOn = options.failOn ?? 'warning';
  const maxFiles = options.maxFiles ?? DEFAULT_DRIFT_MAX_FILES;
  const { onProgress } = options;

  // Validate git repo
  if (!(await isGitRepository(rootPath))) {
    throw new Error('Not a git repository. Drift detection requires git.');
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

  // Create LLM service if needed — support all four providers
  let llm: LLMService | undefined;
  if (llmEnhanced) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const openaiCompatKey = process.env.OPENAI_COMPAT_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!anthropicKey && !openaiKey && !openaiCompatKey && !geminiKey) {
      throw new Error('No LLM API key found. LLM-enhanced drift requires ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_API_KEY.');
    }
    const envDetectedProvider = anthropicKey ? 'anthropic'
      : geminiKey ? 'gemini'
      : openaiCompatKey ? 'openai-compat'
      : 'openai';
    const provider = options.provider ?? envDetectedProvider;
    const defaultModels: Record<string, string> = {
      anthropic: DEFAULT_ANTHROPIC_MODEL,
      gemini: DEFAULT_GEMINI_MODEL,
      'openai-compat': DEFAULT_OPENAI_COMPAT_MODEL,
      openai: DEFAULT_OPENAI_MODEL,
    };
    llm = createLLMService({
      provider,
      model: options.model ?? defaultModels[provider] ?? DEFAULT_ANTHROPIC_MODEL,
      apiBase: resolveTrustedApiBase(options.apiBase, openloreConfig.llm?.apiBase),
      openaiCompatBaseUrl: options.openaiCompatBaseUrl,
      sslVerify: resolveTrustedSslVerify(
        options.sslVerify === undefined ? undefined : !options.sslVerify,
        openloreConfig.llm?.sslVerify,
      ),
      timeout: options.timeout ?? openloreConfig.generation?.timeout,
      enableLogging: true,
      logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
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
      specRelevantFiles: 0,
      issues: [],
      summary: { gaps: 0, stale: 0, uncovered: 0, orphanedSpecs: 0, adrGaps: 0, adrOrphaned: 0, memoryDrifted: 0, memoryOrphaned: 0, total: 0 },
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
  progress(onProgress, 'Detecting drift', 'complete', `${result.summary.total} issues`);

  // Save LLM logs if applicable
  if (llm) {
    try { await llm.saveLogs(); } catch { /* best-effort */ }
  }

  return result;
}
