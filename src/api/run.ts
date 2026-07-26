/**
 * openlore run — programmatic API
 *
 * Runs the full pipeline: init → analyze → generate.
 * Smart defaults skip unnecessary steps.
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_MAX_FILES, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_COMPAT_MODEL, DEFAULT_COPILOT_MODEL, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_LOGS_SUBDIR, OPENLORE_CONFIG_REL_PATH, OPENLORE_GENERATION_SUBDIR, OPENLORE_RUNS_SUBDIR, DEFAULT_OPENSPEC_PATH, ARTIFACT_REPO_STRUCTURE, ARTIFACT_DEPENDENCY_GRAPH, ARTIFACT_LLM_CONTEXT } from '../constants.js';
import { fileExists, readJsonFile } from '../utils/command-helpers.js';
import { isCacheFresh } from '../core/services/mcp-handlers/utils.js';
import {
  detectProjectType,
  getProjectTypeName,
} from '../core/services/project-detector.js';
import {
  getDefaultConfig,
  readOpenLoreConfig,
  writeOpenLoreConfig,
  openloreConfigExists,
  openspecDirExists,
  createOpenSpecStructure,
} from '../core/services/config-manager.js';
import { ensureGitignored } from '../core/services/gitignore-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import type { LLMService } from '../core/services/llm-service.js';
import { RepositoryMapper } from '../core/analyzer/repository-mapper.js';
import { DependencyGraphBuilder, type DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import { AnalysisArtifactGenerator, repoStructureToRepoMap } from '../core/analyzer/artifact-generator.js';
import type { RepoStructure, LLMContext, AnalysisArtifacts } from '../core/analyzer/artifact-generator.js';
import { SpecGenerationPipeline } from '../core/generator/spec-pipeline.js';
import { OpenSpecFormatGenerator } from '../core/generator/openspec-format-generator.js';
import { OpenSpecWriter } from '../core/generator/openspec-writer.js';
import { ADRGenerator } from '../core/generator/adr-generator.js';
import type { RunApiOptions, RunResult, InitResult, AnalyzeResult, ProgressCallback } from './types.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'run', step, status, detail });
}

/**
 * Load cached analysis artifacts from disk.
 */
async function loadCachedArtifacts(
  analysisPath: string,
  repoStructure: RepoStructure,
): Promise<AnalysisArtifacts> {
  const llmContext = await readJsonFile<LLMContext>(
    join(analysisPath, ARTIFACT_LLM_CONTEXT),
    ARTIFACT_LLM_CONTEXT,
  ) ?? { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] } };

  let summaryMarkdown = '';
  let dependencyDiagram = '';
  try { summaryMarkdown = await readFile(join(analysisPath, 'SUMMARY.md'), 'utf-8'); } catch { /* optional */ }
  try { dependencyDiagram = await readFile(join(analysisPath, 'dependencies.mermaid'), 'utf-8'); } catch { /* optional */ }

  return { repoStructure, summaryMarkdown, dependencyDiagram, llmContext };
}

/**
 * Run the full openlore pipeline: init → analyze → generate.
 *
 * Uses smart defaults to skip unnecessary steps (e.g., skips init
 * if config exists, skips analysis if recent).
 *
 * @throws Error if no LLM API key found
 * @throws Error if pipeline fails
 */
export async function openloreRun(options: RunApiOptions = {}): Promise<RunResult> {
  const startTime = Date.now();
  const rootPath = options.rootPath ?? process.cwd();
  const force = options.force ?? false;
  const reanalyze = options.reanalyze ?? false;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const adr = options.adr ?? false;
  const { onProgress } = options;

  // ========================================================================
  // STEP 1: INITIALIZATION
  // ========================================================================
  progress(onProgress, 'Initialization', 'start');

  const detection = await detectProjectType(rootPath);
  const projectType = getProjectTypeName(detection.projectType);

  let initResult: InitResult;
  const configExists = await openloreConfigExists(rootPath);
  let openloreConfig = configExists ? await readOpenLoreConfig(rootPath) : null;

  if (configExists && !force) {
    initResult = {
      configPath: OPENLORE_CONFIG_REL_PATH,
      openspecPath: openloreConfig?.openspecPath ?? DEFAULT_OPENSPEC_PATH,
      projectType,
      created: false,
    };
    progress(onProgress, 'Initialization', 'skip', 'Config exists');
  } else {
    const openspecPath = DEFAULT_OPENSPEC_PATH;
    openloreConfig = getDefaultConfig(detection.projectType, openspecPath);
    await writeOpenLoreConfig(rootPath, openloreConfig);

    const fullOpenspecPath = join(rootPath, openspecPath);
    if (!(await openspecDirExists(fullOpenspecPath))) {
      await createOpenSpecStructure(fullOpenspecPath);
    }

    // Ensure .openlore/ analysis artifacts (multi-MB lance binaries) are ignored,
    // creating .gitignore when absent so a fresh `git init` repo doesn't leak them
    // into git status and diff-based tools.
    await ensureGitignored(rootPath, `${OPENLORE_DIR}/`, 'openlore analysis artifacts');

    initResult = {
      configPath: OPENLORE_CONFIG_REL_PATH,
      openspecPath: openspecPath,
      projectType,
      created: true,
    };
    progress(onProgress, 'Initialization', 'complete');
  }

  // Ensure we have config
  if (!openloreConfig) {
    openloreConfig = await readOpenLoreConfig(rootPath);
    if (!openloreConfig) {
      throw new Error('Failed to load configuration');
    }
  }

  // ========================================================================
  // STEP 2: ANALYSIS
  // ========================================================================
  progress(onProgress, 'Analysis', 'start');

  const analysisPath = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  let analyzeResult: AnalyzeResult;

  // Check for existing fresh analysis (content-hash or TTL)
  const repoStructurePath = join(analysisPath, ARTIFACT_REPO_STRUCTURE);
  let useExisting = false;

  if (!reanalyze && !force && await fileExists(repoStructurePath) && await isCacheFresh(rootPath)) {
    useExisting = true;
  }

  if (useExisting) {
    const repoStructure = await readJsonFile<RepoStructure>(repoStructurePath, ARTIFACT_REPO_STRUCTURE);
    if (!repoStructure) {
      throw new Error(`Failed to load ${ARTIFACT_REPO_STRUCTURE} — run openlore analyze to regenerate`);
    }
    const depGraph = await readJsonFile<DependencyGraphResult>(
      join(analysisPath, ARTIFACT_DEPENDENCY_GRAPH),
      ARTIFACT_DEPENDENCY_GRAPH,
    ) ?? undefined;

    analyzeResult = {
      repoMap: repoStructureToRepoMap(repoStructure),
      depGraph: depGraph ?? {
        nodes: [], edges: [], clusters: [], structuralClusters: [], cycles: [],
        rankings: { byImportance: [], byConnectivity: [], clusterCenters: [], leafNodes: [], bridgeNodes: [], orphanNodes: [] },
        statistics: { nodeCount: 0, edgeCount: 0, importEdgeCount: 0, httpEdgeCount: 0, avgDegree: 0, density: 0, clusterCount: 0, structuralClusterCount: 0, cycleCount: 0 },
      },
      artifacts: await loadCachedArtifacts(analysisPath, repoStructure),
      duration: 0,
    };
    progress(onProgress, 'Analysis', 'skip', 'Recent analysis exists');
  } else {
    await mkdir(analysisPath, { recursive: true });

    const mapper = new RepositoryMapper(rootPath, { maxFiles });
    const repoMap = await mapper.map();

    const graphBuilder = new DependencyGraphBuilder({ rootDir: rootPath });
    const depGraph = await graphBuilder.build(repoMap.allFiles);

    const artifactGenerator = new AnalysisArtifactGenerator({
      rootDir: rootPath,
      outputDir: analysisPath,
      maxDeepAnalysisFiles: Math.min(20, Math.ceil(repoMap.highValueFiles.length * 0.3)),
      maxValidationFiles: 5,
      // NOT keyed off `force` (change: optimize-hash-keyed-analyze) — here `force` means
      // "reinitialize / do not skip", never "re-parse every file". The reused extraction
      // lane is byte-identical, so there is nothing for a forced run to distrust; a caller
      // that genuinely wants a full re-parse asks for it.
      reExtract: options.reExtract ?? false,
    });
    const artifacts = await artifactGenerator.generateAndSave(repoMap, depGraph);

    await writeFile(
      join(analysisPath, ARTIFACT_DEPENDENCY_GRAPH),
      JSON.stringify(depGraph, null, 2)
    );

    analyzeResult = {
      repoMap,
      depGraph,
      artifacts,
      duration: Date.now() - startTime,
    };
    progress(onProgress, 'Analysis', 'complete', `${repoMap.summary.analyzedFiles} files`);
  }

  // ========================================================================
  // STEP 3: GENERATION
  // ========================================================================

  if (options.dryRun) {
    progress(onProgress, 'Generation', 'skip', 'Dry run');
    return {
      init: initResult,
      analysis: analyzeResult,
      generation: {
        report: {
          timestamp: new Date().toISOString(),
          openspecVersion: openloreConfig?.version ?? '1.0.0',
          openloreVersion: '1.0.0',
          filesWritten: [],
          filesSkipped: [],
          filesBackedUp: [],
          filesMerged: [],
          domainsRemoved: [],
          configUpdated: false,
          validationErrors: [],
          warnings: [],
          nextSteps: ['Run without --dry-run to generate specs'],
        },
        pipelineResult: {} as RunResult['generation']['pipelineResult'],
        duration: 0,
      },
      duration: Date.now() - startTime,
    };
  }

  progress(onProgress, 'Generation', 'start');

  // Check for API key — support all four providers
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiCompatKey = process.env.OPENAI_COMPAT_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const noKeyProviders = ['claude-code', 'mistral-vibe', 'copilot', 'gemini-cli', 'cursor-agent'];
  if (!noKeyProviders.includes(options.provider ?? '') && !anthropicKey && !openaiKey && !openaiCompatKey && !geminiKey) {
    throw new Error('No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENAI_COMPAT_API_KEY, or use provider "copilot".');
  }

  // Create LLM service
  const envDetectedProvider = anthropicKey ? 'anthropic'
    : geminiKey ? 'gemini'
    : openaiCompatKey ? 'openai-compat'
    : 'openai';
  const provider = options.provider ?? envDetectedProvider;
  const defaultModels: Record<string, string> = {
    anthropic: DEFAULT_ANTHROPIC_MODEL,
    gemini: DEFAULT_GEMINI_MODEL,
    'openai-compat': DEFAULT_OPENAI_COMPAT_MODEL,
    copilot: DEFAULT_COPILOT_MODEL,
    openai: DEFAULT_OPENAI_MODEL,
    'claude-code': 'claude-code',
    'mistral-vibe': 'mistral-vibe',
    'gemini-cli': 'gemini-cli',
    'cursor-agent': 'cursor-agent',
  };
  const model = options.model ?? defaultModels[provider] ?? DEFAULT_ANTHROPIC_MODEL;
  let llm: LLMService;
  try {
    llm = createLLMService({
      provider,
      model,
      apiBase: options.apiBase ?? openloreConfig.llm?.apiBase,
      sslVerify: options.sslVerify ?? openloreConfig.llm?.sslVerify ?? true,
      openaiCompatBaseUrl: options.openaiCompatBaseUrl,
      timeout: options.timeout ?? openloreConfig.generation?.timeout,
      enableLogging: true,
      logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
    });
  } catch (error) {
    throw new Error(`Failed to create LLM service: ${(error as Error).message}`, { cause: error });
  }

  // Load analysis data for pipeline
  const llmContext = await readJsonFile<LLMContext>(
    join(analysisPath, ARTIFACT_LLM_CONTEXT),
    ARTIFACT_LLM_CONTEXT,
  ) ?? {
    phase1_survey: { purpose: 'Initial survey', files: [], estimatedTokens: 0 },
    phase2_deep: { purpose: 'Deep analysis', files: [], totalTokens: 0 },
    phase3_validation: { purpose: 'Validation', files: [], totalTokens: 0 },
  };

  const repoStructure = await readJsonFile<RepoStructure>(repoStructurePath, ARTIFACT_REPO_STRUCTURE);
  if (!repoStructure) {
    throw new Error(`Failed to load ${ARTIFACT_REPO_STRUCTURE} — run openlore analyze to regenerate`);
  }

  // Run pipeline
  const pipeline = new SpecGenerationPipeline(llm, {
    outputDir: join(rootPath, OPENLORE_DIR, OPENLORE_GENERATION_SUBDIR),
    saveIntermediate: true,
    generateADRs: adr,
  });

  let pipelineResult;
  try {
    pipelineResult = await pipeline.run(repoStructure, llmContext, analyzeResult.depGraph);
  } catch (error) {
    await llm.saveLogs().catch(() => {});
    throw new Error(`Pipeline failed: ${(error as Error).message}`, { cause: error });
  }

  // Format and write specs
  const formatGenerator = new OpenSpecFormatGenerator({
    version: openloreConfig.version ?? '1.0.0',
    includeConfidence: true,
    includeTechnicalNotes: true,
  });

  const generatedSpecs = formatGenerator.generateSpecs(pipelineResult);

  if (adr && pipelineResult.adrs && pipelineResult.adrs.length > 0) {
    const adrGenerator = new ADRGenerator({
      version: openloreConfig.version ?? '1.0.0',
      includeMermaid: true,
    });
    const adrSpecs = adrGenerator.generateADRs(pipelineResult);
    generatedSpecs.push(...adrSpecs);
  }

  const writer = new OpenSpecWriter({
    rootPath,
    writeMode: 'replace',
    version: openloreConfig.version ?? '1.0.0',
    createBackups: true,
    updateConfig: true,
    validateBeforeWrite: true,
  });

  const report = await writer.writeSpecs(generatedSpecs, pipelineResult.survey);

  // Save LLM logs
  await llm.saveLogs().catch(() => {});

  progress(onProgress, 'Generation', 'complete', `${report.filesWritten.length} specs written`);

  // Save run metadata
  const duration = Date.now() - startTime;
  const runsDir = join(rootPath, OPENLORE_DIR, OPENLORE_RUNS_SUBDIR);
  await mkdir(runsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(
    join(runsDir, `${timestamp}.json`),
    JSON.stringify({
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      duration,
      steps: {
        init: { status: initResult.created ? 'completed' : 'skipped' },
        analyze: { status: useExisting ? 'skipped' : 'completed' },
        generate: { status: 'completed', specsGenerated: report.filesWritten.length },
      },
      result: 'success',
    }, null, 2)
  );

  return {
    init: initResult,
    analysis: analyzeResult,
    generation: {
      report,
      pipelineResult,
      duration: Date.now() - startTime,
    },
    duration,
  };
}
