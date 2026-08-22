/**
 * openlore generate — programmatic API
 *
 * Generates OpenSpec specification files from analysis results using LLM.
 * Writes generated artifacts, but never controls the process and is console-silent by default.
 */

import { join, relative, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { readJsonFile } from '../utils/command-helpers.js';
import {
  readOpenLoreConfig,
  readOpenSpecConfig,
} from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { isLlmLoggingEnabled } from '../core/services/llm-logging-policy.js';
import type { LLMService } from '../core/services/llm-service.js';
import { SpecGenerationPipeline } from '../core/generator/spec-pipeline.js';
import {
  OpenSpecFormatGenerator,
  type GeneratedSpec,
} from '../core/generator/openspec-format-generator.js';
import {
  OpenSpecWriter,
  shouldCleanStaleDomains,
  type WriteMode,
} from '../core/generator/openspec-writer.js';
import { ADRGenerator } from '../core/generator/adr-generator.js';
import {
  requirementAnchorProposals,
  verifyRequirementAnchors,
} from '../core/generator/spec-link-service.js';
import type { SpecSymbolRef } from '../core/generator/spec-link-index.js';
import type { RepoStructure, LLMContext } from '../core/analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import type { RefactorReport } from '../core/analyzer/refactor-analyzer.js';
import type { GenerateApiOptions, GenerateResult, ProgressCallback } from './types.js';
import {
  OPENLORE_DIR,
  OPENLORE_LOGS_SUBDIR,
  OPENLORE_ANALYSIS_REL_PATH,
  OPENLORE_GENERATION_SUBDIR,
  ARTIFACT_REPO_STRUCTURE,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_FINGERPRINT,
  ARTIFACT_REFACTOR_PRIORITIES,
} from '../constants.js';
import { resolveTrustedApiBase, resolveTrustedCompatBase, resolveTrustedSslVerify, rejectRepoConfiguredTlsOptOut } from '../core/services/repo-config-trust.js';
import { resolveOpenspecDir } from '../utils/openspec-dir.js';
import { safeJoin } from '../utils/path-confinement.js';
import { normalizeDomainName } from '../core/generator/openspec-compat.js';
import { withLoggerOptions } from '../utils/logger.js';
import { errors, isOpenLoreError } from '../utils/errors.js';
import {
  readGenerationSnapshot,
  REQUIRED_ANALYSIS_ARTIFACTS,
  type GenerationManifest,
} from '../core/runtime/analysis-generation.js';
import {
  finalizeGeneration,
  detectOpenSpecPackageVersion,
  OPENLORE_PACKAGE_VERSION,
  resolveGenerationProvider,
} from '../core/runtime/generation-core.js';
import { withGenerationLock } from '../core/runtime/generation-lock.js';
import { resolveGenerationSemanticSearch } from '../core/runtime/generation-semantic-search.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'generate', step, status, detail });
}


interface AnalysisData {
  repoStructure: RepoStructure;
  llmContext: LLMContext;
  depGraph?: DependencyGraphResult;
  refactorReport?: RefactorReport;
  generationCompatibility: GenerationManifest['compatibility'];
}

export class GenerateAnalysisError extends Error {
  constructor(public readonly code: 'analysis-unavailable' | 'analysis-changed', message: string) {
    super(message);
    this.name = 'GenerateAnalysisError';
  }
}

type JsonArtifactReader = <T>(path: string, label: string) => Promise<T | null>;

export async function loadAnalysisData(
  analysisPath: string,
  readArtifact: JsonArtifactReader = readJsonFile,
): Promise<AnalysisData> {
  const snapshot = await readGenerationSnapshot(
    analysisPath,
    [...REQUIRED_ANALYSIS_ARTIFACTS],
    async () => Promise.all([
      readArtifact<RepoStructure>(join(analysisPath, ARTIFACT_REPO_STRUCTURE), ARTIFACT_REPO_STRUCTURE),
      readArtifact<LLMContext>(join(analysisPath, ARTIFACT_LLM_CONTEXT), ARTIFACT_LLM_CONTEXT),
      readArtifact<DependencyGraphResult>(join(analysisPath, ARTIFACT_DEPENDENCY_GRAPH), ARTIFACT_DEPENDENCY_GRAPH)
        .catch(error => {
          if ((error as Error).message.startsWith(`Failed to parse ${ARTIFACT_DEPENDENCY_GRAPH}`)) return null;
          throw error;
        }),
      readArtifact<Record<string, unknown>>(join(analysisPath, ARTIFACT_FINGERPRINT), ARTIFACT_FINGERPRINT),
      readArtifact<RefactorReport>(join(analysisPath, ARTIFACT_REFACTOR_PRIORITIES), ARTIFACT_REFACTOR_PRIORITIES),
    ]),
    value => value[2] ? [] : [ARTIFACT_DEPENDENCY_GRAPH],
  );

  if (snapshot.state === 'analysis-changed') {
    throw new GenerateAnalysisError('analysis-changed', snapshot.message);
  }
  if (snapshot.state === 'analysis-unavailable') {
    throw new GenerateAnalysisError('analysis-unavailable', 'No compatible analysis generation found. Run openloreAnalyze() first.');
  }

  const [repoStructure, llmContext, depGraph, fingerprint, refactorReport] = snapshot.value;
  if (!repoStructure || (snapshot.compatibility === 'manifest' && (!llmContext || !fingerprint))) {
    throw new GenerateAnalysisError('analysis-unavailable', 'The current analysis generation is incomplete or invalid. Run openloreAnalyze() again.');
  }

  return {
    repoStructure,
    llmContext: llmContext ?? {
      phase1_survey: { purpose: 'Initial survey', files: [], estimatedTokens: 0 },
      phase2_deep: { purpose: 'Deep analysis', files: [], totalTokens: 0 },
      phase3_validation: { purpose: 'Validation', files: [], totalTokens: 0 },
    },
    depGraph: depGraph ?? undefined,
    refactorReport: refactorReport ?? undefined,
    generationCompatibility: snapshot.compatibility,
  };
}

/**
 * Generate OpenSpec specification files from analysis results using LLM.
 *
 * @throws Error if no openlore configuration found
 * @throws Error if no analysis found
 * @throws Error if no LLM API key found (except in dry-run mode)
 * @throws Error if LLM API connectivity fails
 * @throws Error if pipeline fails
 */
async function generateCore(options: GenerateApiOptions): Promise<GenerateResult> {
  const startTime = Date.now();
  const rootPath = resolve(options.rootPath ?? process.cwd());
  const analysisRelPath = options.analysisPath ?? `${OPENLORE_ANALYSIS_REL_PATH}/`;
  const analysisPath = resolve(rootPath, analysisRelPath);
  const { onProgress } = options;

  // Load config
  progress(onProgress, 'Loading configuration', 'start');
  const openloreConfig = await readOpenLoreConfig(rootPath, options.configPath);
  if (!openloreConfig) {
    throw errors.noConfig(options.configPath);
  }

  // Confined: this becomes a WRITE target (the RAG manifest, the generated specs), and
  // `openspecPath` comes from the analyzed repo's own config. The CLI twin does the
  // same; leaving the API twin unguarded would just move the escape one layer down.
  const fullOpenspecPath = resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
  const openspecRelPath = relative(rootPath, fullOpenspecPath) || '.';
  await readOpenSpecConfig(fullOpenspecPath); // Ensure it's readable
  progress(onProgress, 'Loading configuration', 'complete');

  // Load analysis
  progress(onProgress, 'Loading analysis', 'start');
  let analysisData: AnalysisData;
  try {
    analysisData = await loadAnalysisData(analysisPath);
  } catch (error) {
    throw errors.noAnalysis(analysisPath, error);
  }
  const { repoStructure, llmContext, depGraph, refactorReport, generationCompatibility } = analysisData;
  progress(
    onProgress,
    'Loading analysis',
    'complete',
    `${repoStructure.statistics.analyzedFiles} files (${generationCompatibility} generation)`,
  );

  // Validate the generation prerequisites only. A dry run does not resolve a
  // provider, acquire the generation lock, predict output files, or write state.
  if (options.dryRun) {
    progress(onProgress, 'Dry run complete', 'complete');
    return {
      report: {
        timestamp: new Date().toISOString(),
        openspecVersion: await detectOpenSpecPackageVersion(rootPath),
        openloreVersion: OPENLORE_PACKAGE_VERSION,
        configSchemaVersion: openloreConfig.version,
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
      dryRun: true,
      duration: Date.now() - startTime,
    };
  }

  const resolved = resolveGenerationProvider(openloreConfig, {
    provider: options.provider,
    model: options.model,
    openaiCompatBaseUrl: options.openaiCompatBaseUrl,
  });
  if (!resolved) {
    throw errors.apiNoApiKey();
  }

  const effectiveProvider = resolved.provider;
  const effectiveModel = resolved.model;

  const rootConfig = openloreConfig as unknown as Record<string, string>;
  const effectiveBaseUrl = resolved.openaiCompatBaseUrl ?? resolveTrustedCompatBase(
    options.openaiCompatBaseUrl ?? process.env.OPENAI_COMPAT_BASE_URL,
    rootConfig['openaiCompatBaseUrl'],
  );

  return withGenerationLock(rootPath, async () => {

  // `options.*` is supplied by the HOST PROCESS embedding OpenLore, so it is trusted
  // like a CLI flag; the config file is the analyzed repo's and is not.
  const sslVerify = resolveTrustedSslVerify(
    options.sslVerify === undefined ? undefined : !options.sslVerify,
    openloreConfig.llm?.sslVerify,
  );
  rejectRepoConfiguredTlsOptOut('generation.skipSslVerify', openloreConfig.generation.skipSslVerify);
  rejectRepoConfiguredTlsOptOut('embedding.skipSslVerify', openloreConfig.embedding?.skipSslVerify);
  // Create LLM service
  progress(onProgress, 'Creating LLM service', 'start');
  let llm: LLMService;
  try {
    llm = createLLMService({
      provider: effectiveProvider,
      model: effectiveModel,
      openaiCompatBaseUrl: effectiveBaseUrl,
      apiBase: resolveTrustedApiBase(options.apiBase, openloreConfig.llm?.apiBase),
      sslVerify,
      timeout: options.timeout ?? openloreConfig.generation?.timeout,
      disableResponseFormat: openloreConfig.generation?.disableResponseFormat,
      enableLogging: isLlmLoggingEnabled(),
      logDir: safeJoin(rootPath, join(OPENLORE_DIR, OPENLORE_LOGS_SUBDIR)),
      logRoot: rootPath,
    });
  } catch (error) {
    throw errors.pipelineFailed(`Failed to create LLM service: ${(error as Error).message}`, error);
  }
  progress(onProgress, 'Creating LLM service', 'complete', `${effectiveProvider}/${effectiveModel}`);

  if (options.force) {
    await rm(safeJoin(rootPath, join(OPENLORE_DIR, OPENLORE_GENERATION_SUBDIR)), {
      recursive: true,
      force: true,
    });
  }

  // Run pipeline
  progress(onProgress, 'Running LLM generation pipeline', 'start');
  const adr = options.adr ?? false;
  const adrOnly = options.adrOnly ?? false;
  const semanticSearch = await resolveGenerationSemanticSearch(analysisPath, openloreConfig);
  const pipeline = new SpecGenerationPipeline(llm, {
    outputDir: safeJoin(rootPath, join(OPENLORE_DIR, OPENLORE_GENERATION_SUBDIR)),
    rootPath,
    domains: options.domains,
    saveIntermediate: true,
    generateADRs: adr || adrOnly,
    force: options.force,
    semanticSearch,
    chunkMaxChars: openloreConfig.generation?.chunkMaxChars,
  });

  let pipelineResult;
  try {
    pipelineResult = await pipeline.run(repoStructure, llmContext, depGraph, refactorReport);
  } catch (error) {
    await llm.saveLogs().catch(() => {});
    throw errors.pipelineFailed(`Pipeline failed: ${(error as Error).message}`, error);
  }
  progress(onProgress, 'Running LLM generation pipeline', 'complete');

  // Verify each requirement's proposed implementation symbol against the graph
  // BEFORE the spec is written, so the spec carries exact anchors the link index
  // can read back. An unverifiable proposal yields no anchor, never a guess.
  let verifiedAnchors: Map<string, SpecSymbolRef> | undefined;
  if ((options.mapping ?? true) && depGraph) {
    const anchors = verifyRequirementAnchors(requirementAnchorProposals(pipelineResult), depGraph);
    verifiedAnchors = anchors;
    progress(onProgress, 'Verifying requirement anchors', 'complete', `${anchors.size} exact`);
  }

  // Format specs
  progress(onProgress, 'Formatting specifications', 'start');
  const formatGenerator = new OpenSpecFormatGenerator({
    version: openloreConfig.version,
    includeConfidence: true,
    includeTechnicalNotes: true,
    depGraph,
  });

  const allGeneratedSpecs = formatGenerator.generateSpecs(pipelineResult, verifiedAnchors);
  let generatedSpecs = adrOnly ? [] : [...allGeneratedSpecs];

  // Filter by domains
  if (!adrOnly && options.domains && options.domains.length > 0) {
    const domainSet = new Set(options.domains.map(normalizeDomainName));
    generatedSpecs = generatedSpecs.filter(spec =>
      spec.type === 'overview' || spec.type === 'architecture' || domainSet.has(normalizeDomainName(spec.domain))
    );
  }

  // Generate ADRs
  let adrSpecs: GeneratedSpec[] = [];
  if (adr || adrOnly) {
    const adrGenerator = new ADRGenerator({
      version: openloreConfig.version,
      includeMermaid: true,
    });
    adrSpecs = adrGenerator.generateADRs(pipelineResult);
    generatedSpecs.push(...adrSpecs);
  }
  const metadataSpecs = [...allGeneratedSpecs, ...adrSpecs];
  progress(onProgress, 'Formatting specifications', 'complete', `${generatedSpecs.length} files`);

  // Write specs
  progress(onProgress, 'Writing OpenSpec files', 'start');
  const writeMode: WriteMode = options.writeMode ?? 'replace';

  const writer = new OpenSpecWriter({
    rootPath,
    openspecRoot: fullOpenspecPath,
    writeMode,
    version: openloreConfig.version,
    createBackups: true,
    updateConfig: (options.domains?.length ?? 0) === 0,
    validateBeforeWrite: true,
    cleanBeforeWrite: shouldCleanStaleDomains(options.force, options.domains, adrOnly),
  });

  const report = await writer.writeSpecs(generatedSpecs, pipelineResult.survey, metadataSpecs);
  // The writer's `version` option is the OpenSpec/config schema version. Package
  // identity is a separate concern and must never be fabricated from that field.
  report.openloreVersion = OPENLORE_PACKAGE_VERSION;
  report.openspecVersion = await detectOpenSpecPackageVersion(rootPath);
  report.configSchemaVersion = openloreConfig.version;
  progress(onProgress, 'Writing OpenSpec files', 'complete', `${report.filesWritten.length} written`);

  await finalizeGeneration({
    rootPath,
    openspecRoot: fullOpenspecPath,
    openspecPath: openspecRelPath,
    metadataSpecs,
    depGraph,
    mapping: options.mapping,
    scoped: (options.domains?.length ?? 0) > 0,
    onProgress: (step, status, detail) => {
      const label = step === 'mapping' ? 'Deriving spec link index'
        : step === 'rag-manifest' ? 'Generating RAG manifest'
        : 'Generating spec snapshot';
      progress(onProgress, label, status, detail);
    },
  });

  // Save LLM logs
  await llm.saveLogs().catch(() => {});

  return {
    dryRun: false,
    report,
    pipelineResult,
    duration: Date.now() - startTime,
  };
  }, { signal: options.signal });
}

export async function openloreGenerate(options: GenerateApiOptions = {}): Promise<GenerateResult> {
  try {
    return await withLoggerOptions(
      { quiet: options.quiet ?? true },
      () => generateCore(options),
    );
  } catch (error) {
    if (isOpenLoreError(error)) throw error;
    throw errors.pipelineFailed(`Generation failed: ${(error as Error).message}`, error);
  }
}
