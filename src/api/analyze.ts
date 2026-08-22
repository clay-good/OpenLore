/** Programmatic facade over OpenLore's shared analysis core. */
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { ARTIFACT_DEPENDENCY_GRAPH, ARTIFACT_LLM_CONTEXT, ARTIFACT_REPO_STRUCTURE, DEFAULT_MAX_FILES, OPENLORE_ANALYSIS_REL_PATH } from '../constants.js';
import { analysisConfigFingerprintInput, analysisGeneratedExcludes, isAnalysisCacheFresh, runAnalysisCore, type AnalysisReport } from '../core/analyzer/analysis-core.js';
import { buildAnalysisIndexes, type IndexReport } from '../core/analyzer/analysis-indexes.js';
import { repoStructureToRepoMap, type LLMContext, type RepoStructure } from '../core/analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import { acquireAnalysisOwnership, type AnalysisOwnerPayload } from '../core/runtime/analysis-ownership.js';
import { readGenerationSnapshot, REQUIRED_ANALYSIS_ARTIFACTS } from '../core/runtime/analysis-generation.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { fileExists, readJsonFile } from '../utils/command-helpers.js';
import { errors, OpenLoreError } from '../utils/errors.js';
import { withLoggerOptions } from '../utils/logger.js';
import { safeJoin } from '../utils/path-confinement.js';
import type { AnalyzeApiOptions, AnalyzeResult, ProgressCallback } from './types.js';
import type { ScoredFile } from '../types/index.js';

export class AnalysisInProgressError extends Error {
  readonly code = 'ANALYSIS_IN_PROGRESS' as const;
  constructor(readonly owner: AnalysisOwnerPayload | null, readonly elapsedMs: number | null, readonly heartbeatAgeMs: number) {
    super('Another process already owns a full analysis of this repository. No duplicate analysis was started.');
    this.name = 'AnalysisInProgressError';
  }
}

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'analyze', step, status, detail });
}

function analysisReporter(onProgress: ProgressCallback | undefined): { report(event: AnalysisReport): void } {
  return { report(event): void {
    const status = event.status === 'warning' || event.status === 'info' ? 'progress' : event.status;
    progress(onProgress, event.detail ?? event.stage, status, event.detail);
  } };
}

function indexReporter(onProgress: ProgressCallback | undefined): { report(event: IndexReport): void } {
  return { report(event): void {
    progress(onProgress, `${event.index} index`, event.status === 'warning' ? 'progress' : event.status, event.detail);
  } };
}

async function loadCachedArtifacts(outputPath: string, repoStructure: RepoStructure): Promise<AnalyzeResult['artifacts']> {
  const llmContext = await readJsonFile<LLMContext>(join(outputPath, ARTIFACT_LLM_CONTEXT), ARTIFACT_LLM_CONTEXT)
    ?? { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] } };
  let summaryMarkdown = '';
  let dependencyDiagram = '';
  try { summaryMarkdown = await readFile(join(outputPath, 'SUMMARY.md'), 'utf-8'); } catch { /* optional */ }
  try { dependencyDiagram = await readFile(join(outputPath, 'dependencies.mermaid'), 'utf-8'); } catch { /* optional */ }
  return { repoStructure, summaryMarkdown, dependencyDiagram, llmContext };
}

function cachedRepoMap(rootPath: string, repoStructure: RepoStructure, llmContext: LLMContext): AnalyzeResult['repoMap'] {
  const map = repoStructureToRepoMap(repoStructure);
  map.metadata.rootPath = rootPath;
  const domains = repoStructure.domains ?? [];
  const entryPoints = repoStructure.entryPoints ?? [];
  const keyFiles = repoStructure.keyFiles ?? { schemas: [], config: [], auth: [], database: [], routes: [], services: [] };
  const paths = new Set<string>([
    ...(llmContext.signatures ?? []).map(signature => signature.path),
    ...domains.flatMap(domain => domain.files),
    ...(repoStructure.undomained ?? []),
    ...entryPoints.map(entry => entry.file),
    ...Object.values(keyFiles).flat(),
  ].filter(path => path && path !== 'external'));
  const scored = (path: string): ScoredFile => ({
    path,
    absolutePath: resolve(rootPath, path),
    name: basename(path),
    extension: extname(path),
    size: 0,
    lines: 0,
    depth: path.split('/').length - 1,
    directory: dirname(path) === '.' ? '' : dirname(path),
    isEntryPoint: entryPoints.some(entry => entry.file === path),
    isConfig: keyFiles.config.includes(path),
    isTest: /(^|\/)(__tests__|test|tests)\//.test(path) || /\.(test|spec)\.[^.]+$/.test(path),
    isGenerated: false,
    score: 0,
    scoreBreakdown: { name: 0, path: 0, structure: 0, connectivity: 0 },
    tags: [],
  });
  const byPath = new Map([...paths].map(path => [path, scored(path)]));
  map.allFiles = [...byPath.values()];
  map.highValueFiles = (llmContext.phase2_deep?.files ?? []).map(file => byPath.get(file.path)).filter((file): file is ScoredFile => file !== undefined);
  map.entryPoints = entryPoints.map(entry => byPath.get(entry.file)).filter((file): file is ScoredFile => file !== undefined);
  map.schemaFiles = keyFiles.schemas.map(path => byPath.get(path)).filter((file): file is ScoredFile => file !== undefined);
  map.configFiles = keyFiles.config.map(path => byPath.get(path)).filter((file): file is ScoredFile => file !== undefined);
  map.clusters.byDomain = Object.fromEntries(domains.map(domain => [domain.name, domain.files.map(path => byPath.get(path)).filter((file): file is ScoredFile => file !== undefined)]));
  for (const file of map.allFiles) (map.clusters.byDirectory[file.directory] ??= []).push(file);
  return map;
}

async function readDependencyGraph(outputPath: string): Promise<{ depGraph?: DependencyGraphResult; degraded?: { artifact: string; reason: 'missing' | 'corrupt' } }> {
  const path = join(outputPath, ARTIFACT_DEPENDENCY_GRAPH);
  if (!(await fileExists(path))) return { degraded: { artifact: ARTIFACT_DEPENDENCY_GRAPH, reason: 'missing' } };
  try { return { depGraph: JSON.parse(await readFile(path, 'utf-8')) as DependencyGraphResult }; }
  catch { return { degraded: { artifact: ARTIFACT_DEPENDENCY_GRAPH, reason: 'corrupt' } }; }
}

/** Run static analysis with the same corpus, artifacts, and indexes as the CLI. */
async function openloreAnalyzeImpl(options: AnalyzeApiOptions): Promise<AnalyzeResult> {
  const startedAt = Date.now();
  const rootPath = await realpath(options.rootPath ?? process.cwd());
  const outputRelPath = options.outputPath ?? `${OPENLORE_ANALYSIS_REL_PATH}/`;
  const outputPath = options.outputPath === undefined ? safeJoin(rootPath, outputRelPath) : resolve(rootPath, outputRelPath);
  const config = await readOpenLoreConfig(rootPath, options.configPath);
  if (!config) throw errors.noConfig(options.configPath);
  const fingerprintConfig = analysisConfigFingerprintInput(
    config.analysis,
    options.includePatterns ?? [],
    options.excludePatterns ?? [],
    options.maxFiles ?? DEFAULT_MAX_FILES,
    analysisGeneratedExcludes(rootPath, outputPath, config.openspecPath),
  );

  if (!(options.force ?? false) && await isAnalysisCacheFresh(rootPath, outputPath, fingerprintConfig)) {
    const snapshot = await readGenerationSnapshot(outputPath, [...REQUIRED_ANALYSIS_ARTIFACTS], async (): Promise<AnalyzeResult | null> => {
      const repoStructure = await readJsonFile<RepoStructure>(join(outputPath, ARTIFACT_REPO_STRUCTURE), ARTIFACT_REPO_STRUCTURE);
      if (!repoStructure) return null;
      const artifacts = await loadCachedArtifacts(outputPath, repoStructure);
      return {
        repoMap: cachedRepoMap(rootPath, repoStructure, artifacts.llmContext),
        ...await readDependencyGraph(outputPath),
        artifacts,
        duration: Date.now() - startedAt,
        fromCache: true,
      };
    }, value => value?.degraded ? [value.degraded.artifact] : []);
    if (snapshot.state === 'ok' && snapshot.value) {
      progress(options.onProgress, 'Analysis cache', 'skip', 'Source content unchanged');
      const indexes = await buildAnalysisIndexes({ rootPath, outputPath, config, include: options.includePatterns, exclude: options.excludePatterns, llmContext: snapshot.value!.artifacts.llmContext, generationId: snapshot.generationId, reporter: indexReporter(options.onProgress) });
      if (indexes.degraded.length > 0) snapshot.value.indexDegradations = indexes.degraded;
      return snapshot.value;
    }
  }

  await mkdir(outputPath, { recursive: true });
  const ownership = await acquireAnalysisOwnership(rootPath, outputPath, { stage: 'starting' });
  if (ownership.state === 'in-progress') throw new AnalysisInProgressError(ownership.owner, ownership.elapsedMs, ownership.heartbeatAgeMs);
  try {
    progress(options.onProgress, 'Scanning directory structure', 'start');
    const result = await runAnalysisCore(rootPath, outputPath, {
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
      include: options.includePatterns ?? [],
      exclude: options.excludePatterns ?? [],
      reExtract: options.reExtract ?? false,
      ownership,
      config,
      reporter: analysisReporter(options.onProgress),
    });
    const indexes = await buildAnalysisIndexes({ rootPath, outputPath, config, include: options.includePatterns, exclude: options.excludePatterns, llmContext: result.artifacts.llmContext, generationId: result.generationId, force: options.force, reporter: indexReporter(options.onProgress) });
    return { ...result, fromCache: false, ...(indexes.degraded.length > 0 ? { indexDegradations: indexes.degraded } : {}) };
  } finally {
    await ownership.release();
  }
}

export function openloreAnalyze(options: AnalyzeApiOptions = {}): Promise<AnalyzeResult> {
  return withLoggerOptions({ quiet: options.quiet ?? true }, async () => {
    try {
      return await openloreAnalyzeImpl(options);
    } catch (error) {
      if (error instanceof OpenLoreError) throw error;
      throw errors.pipelineFailed(`Analysis failed: ${(error as Error).message}`, error);
    }
  });
}
