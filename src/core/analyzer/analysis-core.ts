import { join, relative, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_FINGERPRINT,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_REPO_STRUCTURE,
  DEEP_ANALYSIS_FILE_RATIO,
  MAX_DEEP_ANALYSIS_FILES,
  MAX_VALIDATION_FILES,
  SOURCE_SCAN_MAX_FILE_BYTES,
} from '../../constants.js';
import type { OpenLoreConfig } from '../../types/index.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { snapshotOldNodes, carryForwardContinuity } from '../decisions/continuity-carry-forward.js';
import { withAnalysisLock } from '../runtime/advisory-lock.js';
import { publishGeneration, readCurrentGeneration, REQUIRED_ANALYSIS_ARTIFACTS } from '../runtime/analysis-generation.js';
import {
  clearPartialIndex,
  flushPartialIndex,
  refreshPartialIndexStamp,
  type PartialIndexStamp,
  type PartialPhase,
} from '../runtime/partial-index.js';
import { PROGRESS_INTERVAL_MS, type AnalysisOwnership } from '../runtime/analysis-ownership.js';
import { readOpenLoreConfig } from '../services/config-manager.js';
import { computeProjectFingerprint, fingerprintHashOfConfiguration } from '../services/mcp-handlers/utils.js';
import { writeAnalysisContentProvenance } from '../services/served-content.js';
import { AnalysisArtifactGenerator, type AnalysisArtifacts, type EnrichmentData } from './artifact-generator.js';
import { isScannedByEnrichment, type OversizedFileObserver } from './bounded-file-scan.js';
import { DependencyGraphBuilder, type DependencyGraphResult } from './dependency-graph.js';
import { extractEnvVars } from './env-extractor.js';
import { buildRouteInventory } from './http-route-parser.js';
import { extractMiddleware } from './middleware-extractor.js';
import { describeMemoryDegradation } from './memory-strategy.js';
import { describeExclusions } from './parse-health.js';
import { describeScriptContainerBoundaries } from './sfc-script-extractor.js';
import { RepositoryMapper, type RepositoryMap } from './repository-mapper.js';
import { extractSchemas } from './schema-extractor.js';
import { captureSourceState, reconcileSourceStates } from './source-state.js';
import { extractUIComponents } from './ui-component-extractor.js';
import { writeJsonAtomicStreaming } from './json-stream.js';
import { isConfinedPath } from '../../utils/path-confinement.js';
import { EdgeStore } from '../services/edge-store.js';
import { detectWorkspaceShards, resolveWorkspaceShardSelection, type WorkspaceShardReport } from './workspace-shards.js';
import {
  runShardScopedAnalysis,
  writeFullShardReceipt,
  type ShardScopedAnalysisReceipt,
} from './workspace-shard-analysis.js';

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
  workspaceShards?: WorkspaceShardReport;
  shardReceipt?: ShardScopedAnalysisReceipt;
}

export interface AnalysisCoreOptions {
  maxFiles: number;
  include?: string[];
  exclude?: string[];
  reExtract?: boolean;
  ownership?: AnalysisOwnership & { state: 'owned' };
  reporter?: AnalysisReporter;
  config?: OpenLoreConfig | null;
  /** Explicit workspace shard names. Omit for the legacy full-analysis path. */
  shards?: string[];
  /**
   * Flush a partial index at phase boundaries so reads during an index-ABSENT first build
   * are answered from what exists instead of "no index found"
   * (change: refine-first-run-partial-serving).
   *
   * Opt-in, and honoured only when this really is a first build: a repository that already
   * has a published generation has something better to serve, so the lane stays off. CI and
   * embedded hosts leave it off and keep today's single-write behaviour.
   */
  partialServing?: boolean;
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

  // Partial first-run serving (change: refine-first-run-partial-serving). The lane is armed
  // only when the caller asked for it AND this repository has no published generation to
  // serve instead — so an ordinary re-analysis, which always has something better on disk,
  // pays nothing and writes nothing.
  // Both conditions matter. `readCurrentGeneration` returns null for a present-but-MALFORMED
  // manifest as well as an absent one, so on a re-analysis of a repo with a corrupt manifest it
  // alone would arm the lane and write a partial index beside a complete artifact set. The
  // artifact check is the same predicate the read path uses to decide precedence.
  const partialArmed = options.partialServing === true
    && (await readCurrentGeneration(outputPath, [...REQUIRED_ANALYSIS_ARTIFACTS])) === null
    && !existsSync(join(outputPath, ARTIFACT_LLM_CONTEXT));
  const partialStartedAt = new Date().toISOString();
  let partialFlushed = false;

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
  const workspaceShards = await detectWorkspaceShards(
    rootPath,
    repoMap.allFiles.map(file => file.path),
    config?.workspace?.shards,
  );
  emit({
    stage: 'mapping',
    status: 'info',
    detail: `Workspace shards (${workspaceShards.source}): ${workspaceShards.shards.map(shard => `${shard.name} ${shard.files.length}`).join(', ')}`,
  });
  for (const ignored of workspaceShards.ignoredMembers) {
    emit({ stage: 'mapping', status: 'warning', detail: `Ignored workspace member '${ignored.member}' from ${ignored.manifest}: ${ignored.reason}.` });
  }
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

  if (options.shards && options.shards.length > 0) {
    const selected = resolveWorkspaceShardSelection(workspaceShards, options.shards);
    if (EdgeStore.exists(outputPath) && options.reExtract !== true) {
      await stage('artifacts', 50, `Recomputing workspace shard(s): ${selected.map(shard => shard.name).join(', ')}`);
      const shardReceipt = await runShardScopedAnalysis({
        rootPath,
        outputPath,
        report: workspaceShards,
        selectedNames: selected.map(shard => shard.name),
      });
      // Scoped publication deliberately retains repo-wide JSON artifacts. Load them
      // for API compatibility; callers use shardReceipt to avoid presenting them as
      // freshly re-aggregated results.
      const [depGraphRaw, repoStructureRaw, llmContextRaw, summaryMarkdown, dependencyDiagram] = await Promise.all([
        readFile(join(outputPath, ARTIFACT_DEPENDENCY_GRAPH), 'utf8'),
        readFile(join(outputPath, ARTIFACT_REPO_STRUCTURE), 'utf8'),
        readFile(join(outputPath, ARTIFACT_LLM_CONTEXT), 'utf8'),
        readFile(join(outputPath, 'SUMMARY.md'), 'utf8'),
        readFile(join(outputPath, 'dependencies.mermaid'), 'utf8'),
      ]);
      emit({
        stage: 'complete',
        status: shardReceipt.staleFiles.length > 0 ? 'warning' : 'complete',
        percent: 100,
        detail: `Scoped graph update: recomputed ${shardReceipt.recomputed.join(', ')}; retained ${shardReceipt.retained.join(', ') || 'none'}; frontier ${shardReceipt.frontierFiles.length}; stale ${shardReceipt.staleFiles.length}. Repo-wide artifacts retained until a full analyze.`,
      });
      return {
        repoMap,
        depGraph: JSON.parse(depGraphRaw) as DependencyGraphResult,
        artifacts: {
          repoStructure: JSON.parse(repoStructureRaw) as AnalysisArtifacts['repoStructure'],
          llmContext: JSON.parse(llmContextRaw) as AnalysisArtifacts['llmContext'],
          summaryMarkdown,
          dependencyDiagram,
        },
        duration: Date.now() - startedAt,
        workspaceShards,
        shardReceipt,
      };
    }
    emit({
      stage: 'mapping',
      status: 'warning',
      detail: options.reExtract === true
        ? '`--shard` with `--force` performs a disclosed full rebuild; shard scoping is not applied.'
        : '`--shard` requested but no prior graph index exists; performing a disclosed full rebuild.',
    });
  }

  await stage('dependency-graph', 25, 'Building dependency graph');
  const depGraph = await new DependencyGraphBuilder({ rootDir: rootPath }).build(repoMap.allFiles);
  emit({
    stage: 'dependency-graph',
    status: 'complete',
    detail: `${depGraph.statistics.nodeCount} nodes, ${depGraph.statistics.edgeCount} edges`,
  });

  const generator = new AnalysisArtifactGenerator({
    rootDir: rootPath,
    outputDir: outputPath,
    maxDeepAnalysisFiles: Math.min(MAX_DEEP_ANALYSIS_FILES, Math.ceil(repoMap.highValueFiles.length * DEEP_ANALYSIS_FILE_RATIO)),
    maxValidationFiles: MAX_VALIDATION_FILES,
    reExtract: options.reExtract ?? false,
  });

  /**
   * Flush one partial index.
   *
   * Structure and inventories only: the call-graph pass has not run, so `filesExtracted`
   * is zero and `absent` names what is missing rather than letting a reader infer it. The
   * whole call is fail-soft — a partial index that cannot be written must never be able to
   * disturb the analysis it is a side effect of.
   */
  const flushPartial = async (phase: PartialPhase, enrichment?: EnrichmentData): Promise<void> => {
    if (!partialArmed) return;
    try {
      const written = await buildPartialFlush(phase, enrichment);
      partialFlushed = written || partialFlushed;
      if (written) {
        emit({
          stage: 'extractors',
          status: 'info',
          detail: 'Partial index available: tool calls are answered from the repository '
            + 'structure and dependency graph, with a disclosure, while the call graph builds.',
        });
      }
    } catch {
      // The flush is a side effect on the first-run EXPERIENCE. Nothing it does may reach
      // the analysis it is a side effect of, so the whole lane — including composing the
      // structure to flush — is contained here rather than only inside the writer.
    }
  };

  const buildPartialFlush = async (phase: PartialPhase, enrichment?: EnrichmentData): Promise<boolean> => {
    const stamp: PartialIndexStamp = {
      partial: true,
      phase,
      buildPhase: phase,
      filesExtracted: 0,
      filesTotal: repoMap.summary.totalFiles,
      filesMapped: repoMap.allFiles.length,
      startedAt: partialStartedAt,
      updatedAt: new Date().toISOString(),
      pid: process.pid,
      absent: [
        'the call graph (function-to-function edges, fan-in/fan-out, hubs)',
        'function signatures and the searchable symbol corpus',
        ...(enrichment ? [] : ['route, schema, UI, middleware, and environment inventories']),
      ],
    };
    return flushPartialIndex(outputPath, {
      repoStructure: generator.generateStructureOnly(repoMap, depGraph, enrichment),
      llmContext: {
        phase1_survey: { purpose: 'Partial first-run index: repository structure only', files: [] },
        phase2_deep: { purpose: 'Not built yet', files: [] },
        phase3_validation: { purpose: 'Not built yet', files: [] },
        partial: stamp,
      },
      dependencyGraph: depGraph,
      stamp,
    });
  };

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

  const inventories = { uiComponents, schemas, routeInventory, middleware, envVars };
  // The one flush. Taken here because everything before it is fast and everything after it is
  // the call-graph pass, which produces nothing servable until it finishes and then publishes.
  // Flushing earlier as well bought half a second of timeliness for a second full domain
  // reconciliation — the wrong trade on exactly the large repositories this is for.
  await flushPartial('extractors', inventories);

  await stage('artifacts', 75, 'Generating analysis artifacts');
  const oldNodeSnapshot = snapshotOldNodes(outputPath);
  const artifactStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const detail = `Generating analysis artifacts (${Math.round((Date.now() - artifactStartedAt) / 1000)}s elapsed)`;
    void options.ownership?.update('artifacts', { percent: 75, detail }).catch(() => {});
    emit({ stage: 'artifacts', status: 'progress', percent: 75, detail });
    // Keep the partial receipt current. No new facts are flushed here — the call-graph
    // pass produces nothing servable until it finishes — but a reader must be able to tell
    // "this build is alive and in the artifacts phase" from "this build died mid-flush".
    if (partialFlushed) void refreshPartialIndexStamp(outputPath, { buildPhase: 'artifacts' });
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
    await writeFullShardReceipt(outputPath, workspaceShards, rootPath);
    await writeJsonAtomicStreaming(join(outputPath, ARTIFACT_DEPENDENCY_GRAPH), depGraph);
    await atomicWriteFile(join(outputPath, ARTIFACT_FINGERPRINT), JSON.stringify({
      hash: fingerprintHash,
      commit: sourceState.commit,
      sourceTreeState: sourceState.treeState,
      computedAt: new Date().toISOString(),
      fileCount: repoMap.allFiles.length,
      analysisConfigHash: fingerprintHashOfConfiguration(fingerprintConfig),
      // The fingerprint configuration VALUES, not just their hash (change:
      // extend-api-for-supervising-hosts). `--include` / `--exclude` / `--max-files` are
      // per-invocation CLI inputs that are never persisted anywhere else, and they decide which
      // files the hash covers. Without them a later reader cannot RECOMPUTE this hash: it would
      // fingerprint a different corpus and report a mismatch on an unchanged tree. Recording them
      // is what makes `openloreIndexState` able to answer at all.
      fingerprintConfig,
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

  // The published generation supersedes the partial index in every respect, so the partial
  // index stops being merely redundant and becomes wrong. Removed AFTER the publish, never
  // before: a failed publish must leave the partial index in place, because it is then still
  // the best thing this repository has to serve.
  if (partialArmed) await clearPartialIndex(outputPath);

  if (artifacts.extractionLaneNote) emit({ stage: 'artifacts', status: 'warning', detail: artifacts.extractionLaneNote });
  if (artifacts.pass1CacheNote) emit({ stage: 'artifacts', status: 'info', detail: artifacts.pass1CacheNote });
  const excludedNote = describeExclusions(artifacts.parseHealth);
  if (excludedNote) emit({ stage: 'artifacts', status: 'warning', detail: excludedNote });
  const scriptContainerNote = describeScriptContainerBoundaries(artifacts.parseHealth?.scriptContainers);
  if (scriptContainerNote) emit({ stage: 'artifacts', status: 'warning', detail: scriptContainerNote });
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
  return { repoMap, depGraph, artifacts, duration: Date.now() - startedAt, generationId: generationId!, workspaceShards };
}
