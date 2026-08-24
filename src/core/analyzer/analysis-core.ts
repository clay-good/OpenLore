import { join, relative, resolve } from 'node:path';
import {
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_FINGERPRINT,
  DEEP_ANALYSIS_FILE_RATIO,
  MAX_DEEP_ANALYSIS_FILES,
  MAX_VALIDATION_FILES,
  SOURCE_SCAN_MAX_FILE_BYTES,
} from '../../constants.js';
import type { OpenLoreConfig } from '../../types/index.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { snapshotOldNodes, carryForwardContinuity } from '../decisions/continuity-carry-forward.js';
import { withAnalysisLock } from '../runtime/advisory-lock.js';
import { publishGeneration, REQUIRED_ANALYSIS_ARTIFACTS } from '../runtime/analysis-generation.js';
import { PROGRESS_INTERVAL_MS, type AnalysisOwnership } from '../runtime/analysis-ownership.js';
import { readOpenLoreConfig } from '../services/config-manager.js';
import { computeProjectFingerprint, fingerprintHashOfConfiguration } from '../services/mcp-handlers/utils.js';
import { writeAnalysisContentProvenance } from '../services/served-content.js';
import { AnalysisArtifactGenerator, type AnalysisArtifacts } from './artifact-generator.js';
import { isScannedByEnrichment, type OversizedFileObserver } from './bounded-file-scan.js';
import { DependencyGraphBuilder, type DependencyGraphResult } from './dependency-graph.js';
import { extractEnvVars } from './env-extractor.js';
import { buildRouteInventory } from './http-route-parser.js';
import { extractMiddleware } from './middleware-extractor.js';
import { describeMemoryDegradation } from './memory-strategy.js';
import { describeExclusions } from './parse-health.js';
import { RepositoryMapper, type RepositoryMap } from './repository-mapper.js';
import { extractSchemas } from './schema-extractor.js';
import { captureSourceState, reconcileSourceStates } from './source-state.js';
import { extractUIComponents } from './ui-component-extractor.js';
import { writeJsonAtomicStreaming } from './json-stream.js';
import { isConfinedPath } from '../../utils/path-confinement.js';

export { isAnalysisCacheFresh } from '../services/mcp-handlers/utils.js';

export type AnalysisStage = 'mapping' | 'dependency-graph' | 'extractors' | 'artifacts' | 'complete';

export interface AnalysisReport {
  stage: AnalysisStage;
  status: 'start' | 'progress' | 'complete' | 'warning' | 'info';
  detail?: string;
  percent?: number;
}

/** An injected boundary: the shared core never writes to stdout/stderr. */
export interface AnalysisReporter {
  report(event: AnalysisReport): void;
}

export interface AnalysisCoreResult {
  repoMap: RepositoryMap;
  depGraph: DependencyGraphResult;
  artifacts: AnalysisArtifacts;
  duration: number;
  generationId?: string;
}

export interface AnalysisCoreOptions {
  maxFiles: number;
  include?: string[];
  exclude?: string[];
  reExtract?: boolean;
  ownership?: AnalysisOwnership & { state: 'owned' };
  reporter?: AnalysisReporter;
  config?: OpenLoreConfig | null;
}

export function mergeAnalysisPatterns(
  configured: { includePatterns?: string[]; excludePatterns?: string[] } | undefined,
  include: string[],
  exclude: string[],
): { includePatterns: string[]; excludePatterns: string[] } {
  return {
    // Operator includes retain their force-include semantics. Repository-configured
    // includes are passed separately to the walker below so they can widen built-in
    // corpus defaults without resurrecting files protected by ignore files.
    includePatterns: [...new Set(include)],
    excludePatterns: [...new Set([...(configured?.excludePatterns ?? []), ...exclude])],
  };
}

export function analysisConfigFingerprintInput(
  configured: { includePatterns?: string[]; excludePatterns?: string[] } | undefined,
  include: string[],
  exclude: string[],
  maxFiles: number,
  protectedExcludePatterns: string[] = [],
): { includePatterns: string[]; excludePatterns: string[]; maxFiles: number; protectedExcludePatterns: string[] } {
  return { ...mergeAnalysisPatterns(configured, include, exclude), maxFiles, protectedExcludePatterns };
}

export function analysisGeneratedExcludes(rootPath: string, outputPath: string, openspecPath?: string): string[] {
  const root = resolve(rootPath);
  const candidates = [resolve(outputPath), resolve(root, openspecPath ?? 'openspec')];
  return [...new Set(candidates.flatMap(candidate => {
    if (!isConfinedPath(root, candidate) || candidate === root) return [];
    const rel = relative(root, candidate).replace(/\\/g, '/');
    return [`${rel}/**`];
  }))];
}

/**
 * Run and atomically publish the analysis artifact set shared by CLI and API.
 * UI, logging, and progress rendering are deliberately delegated to `reporter`.
 */
export async function runAnalysisCore(
  rootPath: string,
  outputPath: string,
  options: AnalysisCoreOptions,
): Promise<AnalysisCoreResult> {
  const startedAt = Date.now();
  const emit = (event: AnalysisReport): void => options.reporter?.report(event);
  const stage = async (name: AnalysisStage, percent: number, detail?: string): Promise<void> => {
    await options.ownership?.update(name, { percent, ...(detail ? { detail } : {}) }).catch(() => {});
    emit({ stage: name, status: 'start', percent, detail });
  };

  const config = options.config ?? await readOpenLoreConfig(rootPath);
  if (config?.analysis.includePatterns?.length) {
    emit({
      stage: 'mapping',
      status: 'warning',
      detail: 'Repository-configured analysis.includePatterns cannot override .gitignore or .openlore-ignore; use the explicit --include option for an operator-approved override.',
    });
  }
  const patterns = mergeAnalysisPatterns(
    config?.analysis,
    options.include ?? [],
    options.exclude ?? [],
  );
  const protectedExcludePatterns = analysisGeneratedExcludes(rootPath, outputPath, config?.openspecPath);
  const fingerprintConfig = analysisConfigFingerprintInput(config?.analysis, options.include ?? [], options.exclude ?? [], options.maxFiles, protectedExcludePatterns);

  await stage('mapping', 0, 'Scanning directory structure');
  const mapper = new RepositoryMapper(rootPath, {
    maxFiles: options.maxFiles,
    includePatterns: patterns.includePatterns.length > 0 ? patterns.includePatterns : undefined,
    restrictedIncludePatterns: config?.analysis.includePatterns?.filter(
      pattern => !patterns.includePatterns.includes(pattern),
    ),
    excludePatterns: patterns.excludePatterns.length > 0 ? patterns.excludePatterns : undefined,
    protectedExcludePatterns,
  });
  const fingerprintHash = await computeProjectFingerprint(rootPath, { configuration: fingerprintConfig, protectedExcludePatterns });
  const sourceStateBefore = await captureSourceState(rootPath);
  const repoMap = await mapper.map();
  emit({ stage: 'mapping', status: 'complete', detail: `${repoMap.summary.analyzedFiles} files` });
  const skipReasons = Object.entries(repoMap.summary.skippedReasons ?? {})
    .filter(([, count]) => count > 0)
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName))
    .map(([reason, count]) => `${reason} ${count}`);
  emit({
    stage: 'mapping',
    status: 'info',
    detail: `Files skipped: ${repoMap.summary.skippedFiles}${skipReasons.length > 0 ? ` (${skipReasons.join(', ')})` : ''}`,
  });
  if (repoMap.summary.includePatternsUnmatched?.length) {
    emit({ stage: 'mapping', status: 'warning', detail: `Include pattern(s) matched no files: ${repoMap.summary.includePatternsUnmatched.join(', ')}` });
  }
  if (repoMap.summary.truncated) {
    emit({ stage: 'mapping', status: 'warning', detail: `Partial corpus: walk stopped at the ${repoMap.summary.truncated.limit}-file cap (at ${repoMap.summary.truncated.atPath}).` });
  }

  await stage('dependency-graph', 25, 'Building dependency graph');
  const depGraph = await new DependencyGraphBuilder({ rootDir: rootPath }).build(repoMap.allFiles);
  emit({
    stage: 'dependency-graph',
    status: 'complete',
    detail: `${depGraph.statistics.nodeCount} nodes, ${depGraph.statistics.edgeCount} edges`,
  });

  await stage('extractors', 50, 'Extracting UI components, schemas, routes, middleware, and env vars');
  // Inventory extractors read their path argument directly. Absolute mapper paths keep the
  // shared core independent of process.cwd(), which differs between CLI and API consumers.
  const allFilePaths = repoMap.allFiles.map(file => file.absolutePath);
  const oversizedByPath = new Map<string, number>();
  const observeOversized: OversizedFileObserver = (path, bytes) => {
    if (isScannedByEnrichment(path)) {
      oversizedByPath.set(path, Math.max(bytes, oversizedByPath.get(path) ?? 0));
    }
  };
  // Serialized by design: bounded scans in parallel still multiply peak memory.
  const uiComponents = await extractUIComponents(allFilePaths, rootPath, observeOversized);
  const schemas = await extractSchemas(allFilePaths, rootPath, observeOversized);
  const routeInventory = await buildRouteInventory(allFilePaths, rootPath, observeOversized);
  const middleware = await extractMiddleware(allFilePaths, rootPath, observeOversized);
  const envVars = await extractEnvVars(allFilePaths, rootPath, observeOversized);
  if (oversizedByPath.size > 0) {
    emit({
      stage: 'extractors',
      status: 'warning',
      detail: `${oversizedByPath.size} file(s) exceeded the ${Math.round(SOURCE_SCAN_MAX_FILE_BYTES / 1024 / 1024)} MB enrichment scan cap; inventory counts are a lower bound.`,
    });
  }
  emit({ stage: 'extractors', status: 'complete' });

  await stage('artifacts', 75, 'Generating analysis artifacts');
  const generator = new AnalysisArtifactGenerator({
    rootDir: rootPath,
    outputDir: outputPath,
    maxDeepAnalysisFiles: Math.min(MAX_DEEP_ANALYSIS_FILES, Math.ceil(repoMap.highValueFiles.length * DEEP_ANALYSIS_FILE_RATIO)),
    maxValidationFiles: MAX_VALIDATION_FILES,
    reExtract: options.reExtract ?? false,
  });
  const oldNodeSnapshot = snapshotOldNodes(outputPath);
  const inventories = { uiComponents, schemas, routeInventory, middleware, envVars };
  const artifactStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const detail = `Generating analysis artifacts (${Math.round((Date.now() - artifactStartedAt) / 1000)}s elapsed)`;
    void options.ownership?.update('artifacts', { percent: 75, detail }).catch(() => {});
    emit({ stage: 'artifacts', status: 'progress', percent: 75, detail });
  }, PROGRESS_INTERVAL_MS);
  heartbeat.unref?.();
  let artifacts: AnalysisArtifacts;
  try {
    artifacts = await generator.generate(repoMap, depGraph, inventories);
  } finally {
    clearInterval(heartbeat);
  }
  const sourceState = reconcileSourceStates(sourceStateBefore, await captureSourceState(rootPath));

  let generationId: string | undefined;
  await withAnalysisLock(outputPath, async () => {
    await generator.generateAndSave(repoMap, depGraph, inventories, {
      precomputed: artifacts,
      acquireLock: false,
    });
    await writeJsonAtomicStreaming(join(outputPath, ARTIFACT_DEPENDENCY_GRAPH), depGraph);
    await atomicWriteFile(join(outputPath, ARTIFACT_FINGERPRINT), JSON.stringify({
      hash: fingerprintHash,
      commit: sourceState.commit,
      sourceTreeState: sourceState.treeState,
      computedAt: new Date().toISOString(),
      fileCount: repoMap.allFiles.length,
      analysisConfigHash: fingerprintHashOfConfiguration(fingerprintConfig),
    }));
    await writeAnalysisContentProvenance(outputPath, 'source-derived');
    if (await computeProjectFingerprint(rootPath, { configuration: fingerprintConfig, protectedExcludePatterns }) !== fingerprintHash) {
      throw new Error('Source files changed during analysis publication; refusing to publish a stale artifact generation. Retry analysis.');
    }
    const generation = await publishGeneration(outputPath, [...REQUIRED_ANALYSIS_ARTIFACTS]);
    if (!generation) {
      throw new Error('Analysis produced an incomplete required artifact set; generation was not published.');
    }
    generationId = generation.generationId;
  });

  if (artifacts.extractionLaneNote) emit({ stage: 'artifacts', status: 'warning', detail: artifacts.extractionLaneNote });
  if (artifacts.pass1CacheNote) emit({ stage: 'artifacts', status: 'info', detail: artifacts.pass1CacheNote });
  const excludedNote = describeExclusions(artifacts.parseHealth);
  if (excludedNote) emit({ stage: 'artifacts', status: 'warning', detail: excludedNote });
  const memoryNote = describeMemoryDegradation(artifacts.memoryDegradation);
  if (memoryNote) emit({ stage: 'artifacts', status: 'warning', detail: memoryNote });

  try {
    const continuity = await carryForwardContinuity(rootPath, oldNodeSnapshot, outputPath);
    if (continuity.carried.length > 0) {
      emit({ stage: 'artifacts', status: 'info', detail: `Carried ${continuity.carried.length} anchored symbol(s) across rename/move.` });
    } else if (continuity.ambiguous.length > 0) {
      emit({ stage: 'artifacts', status: 'warning', detail: `${continuity.ambiguous.length} anchored symbol(s) moved ambiguously; no guess was made.` });
    }
  } catch (error) {
    emit({ stage: 'artifacts', status: 'warning', detail: `Continuity carry-forward skipped: ${(error as Error).message}` });
  }

  emit({ stage: 'artifacts', status: 'complete' });
  await options.ownership?.update('complete', { percent: 100 }).catch(() => {});
  emit({ stage: 'complete', status: 'complete', percent: 100 });
  return { repoMap, depGraph, artifacts, duration: Date.now() - startedAt, generationId: generationId! };
}
