/**
 * openlore generate — programmatic API
 *
 * Generates OpenSpec specification files from analysis results using LLM.
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { allowInsecureTls } from '../core/services/tls-scope.js';
import { readJsonFile } from '../utils/command-helpers.js';
import {
  readOpenLoreConfig,
  readOpenSpecConfig,
} from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import type { LLMService } from '../core/services/llm-service.js';
import { SpecGenerationPipeline } from '../core/generator/spec-pipeline.js';
import { OpenSpecFormatGenerator } from '../core/generator/openspec-format-generator.js';
import {
  OpenSpecWriter,
  shouldCleanStaleDomains,
  type WriteMode,
} from '../core/generator/openspec-writer.js';
import { ADRGenerator } from '../core/generator/adr-generator.js';
import { MappingGenerator } from '../core/generator/mapping-generator.js';
import type { MappingArtifact } from '../core/generator/mapping-generator.js';
import { RagManifestGenerator } from '../core/generator/rag-manifest-generator.js';
import type { RepoStructure, LLMContext } from '../core/analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import type { RefactorReport } from '../core/analyzer/refactor-analyzer.js';
import type { GenerateApiOptions, GenerateResult, ProgressCallback } from './types.js';
import { SpecSnapshotGenerator } from '../core/analyzer/spec-snapshot-generator.js';
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_COMPAT_MODEL,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_GEMINI_MODEL,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_LOGS_SUBDIR,
  OPENLORE_ANALYSIS_REL_PATH,
  OPENLORE_GENERATION_SUBDIR,
  OPENSPEC_DIR,
  ARTIFACT_REPO_STRUCTURE,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_REFACTOR_PRIORITIES,
  ARTIFACT_RAG_MANIFEST,
} from '../constants.js';
import { resolveTrustedApiBase, resolveTrustedSslVerify, rejectRepoConfiguredTlsOptOut, discloseRepoConfiguredEndpoint } from '../core/services/repo-config-trust.js';
import { resolveOpenspecDir } from '../utils/openspec-dir.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'generate', step, status, detail });
}


interface AnalysisData {
  repoStructure: RepoStructure;
  llmContext: LLMContext;
  depGraph?: DependencyGraphResult;
  refactorReport?: RefactorReport;
}

async function loadAnalysisData(analysisPath: string): Promise<AnalysisData | null> {
  const repoStructure = await readJsonFile<RepoStructure>(
    join(analysisPath, ARTIFACT_REPO_STRUCTURE),
    ARTIFACT_REPO_STRUCTURE,
  );
  if (!repoStructure) return null;

  const llmContext = await readJsonFile<LLMContext>(
    join(analysisPath, ARTIFACT_LLM_CONTEXT),
    ARTIFACT_LLM_CONTEXT,
  ) ?? {
    phase1_survey: { purpose: 'Initial survey', files: [], estimatedTokens: 0 },
    phase2_deep: { purpose: 'Deep analysis', files: [], totalTokens: 0 },
    phase3_validation: { purpose: 'Validation', files: [], totalTokens: 0 },
  };

  const depGraph = await readJsonFile<DependencyGraphResult>(
    join(analysisPath, ARTIFACT_DEPENDENCY_GRAPH),
    ARTIFACT_DEPENDENCY_GRAPH,
  ) ?? undefined;

  const refactorReport = await readJsonFile<RefactorReport>(
    join(analysisPath, ARTIFACT_REFACTOR_PRIORITIES),
    ARTIFACT_REFACTOR_PRIORITIES,
  ) ?? undefined;

  return { repoStructure, llmContext, depGraph, refactorReport };
}

/**
 * Generate OpenSpec specification files from analysis results using LLM.
 *
 * @throws Error if no openlore configuration found
 * @throws Error if no analysis found
 * @throws Error if no LLM API key found
 * @throws Error if LLM API connectivity fails
 * @throws Error if pipeline fails
 */
export async function openloreGenerate(options: GenerateApiOptions = {}): Promise<GenerateResult> {
  const startTime = Date.now();
  const rootPath = options.rootPath ?? process.cwd();
  const analysisRelPath = options.analysisPath ?? `${OPENLORE_ANALYSIS_REL_PATH}/`;
  const analysisPath = join(rootPath, analysisRelPath);
  const { onProgress } = options;

  // Load config
  progress(onProgress, 'Loading configuration', 'start');
  const openloreConfig = await readOpenLoreConfig(rootPath);
  if (!openloreConfig) {
    throw new Error('No openlore configuration found. Run openloreInit() first.');
  }

  const openspecRelPath = openloreConfig.openspecPath ?? OPENSPEC_DIR;
  // Confined: this becomes a WRITE target (the RAG manifest, the generated specs), and
  // `openspecPath` comes from the analyzed repo's own config. The CLI twin does the
  // same; leaving the API twin unguarded would just move the escape one layer down.
  const fullOpenspecPath = resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
  await readOpenSpecConfig(fullOpenspecPath); // Ensure it's readable
  progress(onProgress, 'Loading configuration', 'complete');

  // Load analysis
  progress(onProgress, 'Loading analysis', 'start');
  const analysisData = await loadAnalysisData(analysisPath);
  if (!analysisData) {
    throw new Error('No analysis found. Run openloreAnalyze() first.');
  }
  const { repoStructure, llmContext, depGraph, refactorReport } = analysisData;
  progress(onProgress, 'Loading analysis', 'complete', `${repoStructure.statistics.analyzedFiles} files`);

  // Resolve provider
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiCompatKey = process.env.OPENAI_COMPAT_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  const configuredProvider = options.provider ?? openloreConfig.generation.provider;
  const noKeyProviders = ['claude-code', 'mistral-vibe', 'copilot', 'gemini-cli', 'cursor-agent'];

  if (!noKeyProviders.includes(configuredProvider ?? '') && !anthropicKey && !openaiKey && !openaiCompatKey && !geminiKey) {
    throw new Error(
      'No LLM API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_API_KEY — ' +
        'or, with the Claude Code CLI installed, set generation.provider to "claude-code" in .openlore/config.json (no API key needed). ' +
        'Other no-key providers: copilot, gemini-cli, mistral-vibe, cursor-agent.'
    );
  }

  const envDetectedProvider = anthropicKey ? 'anthropic'
    : geminiKey ? 'gemini'
    : openaiCompatKey ? 'openai-compat'
    : 'openai';

  const effectiveProvider = configuredProvider ?? envDetectedProvider;

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
  const effectiveModel = options.model || openloreConfig.generation.model || defaultModels[effectiveProvider];

  const rootConfig = openloreConfig as unknown as Record<string, string>;
  const effectiveBaseUrl = options.openaiCompatBaseUrl
    ?? process.env.OPENAI_COMPAT_BASE_URL
    ?? openloreConfig.generation.openaiCompatBaseUrl
    ?? rootConfig['openaiCompatBaseUrl'];
  // Disclose when the endpoint came from the analyzed repo's config rather than the
  // host process or the environment. Both spellings are covered — the undeclared
  // top-level `openaiCompatBaseUrl` key is read here and nowhere else, so it had no
  // disclosure at all.
  if (!options.openaiCompatBaseUrl && !process.env.OPENAI_COMPAT_BASE_URL) {
    discloseRepoConfiguredEndpoint(
      'generation.openaiCompatBaseUrl',
      openloreConfig.generation.openaiCompatBaseUrl ?? rootConfig['openaiCompatBaseUrl'],
    );
  }

  // `options.*` is supplied by the HOST PROCESS embedding OpenLore, so it is trusted
  // like a CLI flag; the config file is the analyzed repo's and is not.
  const sslVerify = resolveTrustedSslVerify(
    options.sslVerify === undefined ? undefined : !options.sslVerify,
    openloreConfig.llm?.sslVerify,
  );
  rejectRepoConfiguredTlsOptOut('generation.skipSslVerify', openloreConfig.generation.skipSslVerify);
  rejectRepoConfiguredTlsOptOut('embedding.skipSslVerify', openloreConfig.embedding?.skipSslVerify);
  if (!sslVerify) {
    allowInsecureTls('sslVerify=false');
  }

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
      enableLogging: true,
      logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
    });
  } catch (error) {
    throw new Error(`Failed to create LLM service: ${(error as Error).message}`, { cause: error });
  }
  progress(onProgress, 'Creating LLM service', 'complete', `${effectiveProvider}/${effectiveModel}`);

  // Dry run — return empty result
  if (options.dryRun) {
    progress(onProgress, 'Dry run complete', 'complete');
    return {
      report: {
        timestamp: new Date().toISOString(),
        openspecVersion: openloreConfig.version ?? '1.0.0',
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
      pipelineResult: {} as GenerateResult['pipelineResult'],
      duration: Date.now() - startTime,
    };
  }

  // Run pipeline
  progress(onProgress, 'Running LLM generation pipeline', 'start');
  const adr = options.adr ?? false;
  const adrOnly = options.adrOnly ?? false;
  const pipeline = new SpecGenerationPipeline(llm, {
    outputDir: join(rootPath, OPENLORE_DIR, OPENLORE_GENERATION_SUBDIR),
    saveIntermediate: true,
    generateADRs: adr || adrOnly,
    force: options.force,
    chunkMaxChars: openloreConfig.generation?.chunkMaxChars,
  });

  let pipelineResult;
  try {
    pipelineResult = await pipeline.run(repoStructure, llmContext, depGraph, refactorReport);
  } catch (error) {
    await llm.saveLogs().catch(() => {});
    throw new Error(`Pipeline failed: ${(error as Error).message}`, { cause: error });
  }
  progress(onProgress, 'Running LLM generation pipeline', 'complete');

  // Generate mapping artifact early so formatGenerator can annotate file:line per requirement
  let mappingArtifact: MappingArtifact | undefined;
  if ((options.mapping ?? true) && depGraph) {
    try {
      let semanticSearch: import('../core/generator/mapping-generator.js').SemanticSearchFn | undefined;
      const analysisDir = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
      const { VectorIndex } = await import('../core/analyzer/vector-index.js');
      if (VectorIndex.exists(analysisDir)) {
        const { resolveEmbedder } = await import('../core/analyzer/embedder.js');
        const embedSvc = await resolveEmbedder(openloreConfig) ?? undefined;
        if (embedSvc) {
          const svc = embedSvc;
          semanticSearch = (query, limit) => VectorIndex.search(analysisDir, query, svc, { limit });
        }
      }
      const mapper = new MappingGenerator(rootPath, openspecRelPath, semanticSearch);
      mappingArtifact = await mapper.generate(pipelineResult, depGraph);
      progress(onProgress, 'Generating mapping artifact', 'complete');
    } catch {
      // Non-fatal
    }
  }

  // Format specs
  progress(onProgress, 'Formatting specifications', 'start');
  const formatGenerator = new OpenSpecFormatGenerator({
    version: openloreConfig.version,
    includeConfidence: true,
    includeTechnicalNotes: true,
    depGraph,
  });

  let generatedSpecs = adrOnly ? [] : formatGenerator.generateSpecs(pipelineResult, mappingArtifact);

  // Filter by domains
  if (!adrOnly && options.domains && options.domains.length > 0) {
    const domainSet = new Set(options.domains.map(d => d.toLowerCase()));
    generatedSpecs = generatedSpecs.filter(spec =>
      spec.type === 'overview' || spec.type === 'architecture' || domainSet.has(spec.domain.toLowerCase())
    );
  }

  // Generate ADRs
  if (adr || adrOnly) {
    const adrGenerator = new ADRGenerator({
      version: openloreConfig.version,
      includeMermaid: true,
    });
    const adrSpecs = adrGenerator.generateADRs(pipelineResult);
    generatedSpecs.push(...adrSpecs);
  }
  progress(onProgress, 'Formatting specifications', 'complete', `${generatedSpecs.length} files`);

  // Write specs
  progress(onProgress, 'Writing OpenSpec files', 'start');
  const writeMode: WriteMode = options.writeMode ?? 'replace';

  const writer = new OpenSpecWriter({
    rootPath,
    writeMode,
    version: openloreConfig.version,
    createBackups: true,
    updateConfig: true,
    validateBeforeWrite: true,
    cleanBeforeWrite: shouldCleanStaleDomains(options.force, options.domains, adrOnly),
  });

  const report = await writer.writeSpecs(generatedSpecs, pipelineResult.survey);
  progress(onProgress, 'Writing OpenSpec files', 'complete', `${report.filesWritten.length} written`);

  // Generate RAG manifest
  try {
    const manifestGen = new RagManifestGenerator();
    const manifest = manifestGen.generate(generatedSpecs, depGraph);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(fullOpenspecPath, ARTIFACT_RAG_MANIFEST),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
    progress(onProgress, 'Generating RAG manifest', 'complete', `${manifest.domains.length} domains`);
  } catch {
    // Non-fatal
  }

  // Update spec snapshot with richer post-generate coverage (non-fatal)
  const snapshotGenerator = new SpecSnapshotGenerator(rootPath, openspecRelPath);
  await snapshotGenerator.generate().catch(() => {});

  // Save LLM logs
  await llm.saveLogs().catch(() => {});

  return {
    report,
    pipelineResult,
    duration: Date.now() - startTime,
  };
}
