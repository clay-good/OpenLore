/**
 * openlore analyze — programmatic API
 *
 * Runs static analysis on the codebase (no LLM required).
 * No side effects (no process.exit, no console.log).
 */

import { join, resolve } from 'node:path';
import { readFile, stat, mkdir, realpath } from 'node:fs/promises';
import { ANALYSIS_STALE_THRESHOLD_MS, DEFAULT_MAX_FILES, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_REPO_STRUCTURE, ARTIFACT_DEPENDENCY_GRAPH, ARTIFACT_LLM_CONTEXT, ARTIFACT_FINGERPRINT, OPENSPEC_DIR } from '../constants.js';
import { fileExists, readJsonFile } from '../utils/command-helpers.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { RepositoryMapper } from '../core/analyzer/repository-mapper.js';
import {
  DependencyGraphBuilder,
  type DependencyGraphResult,
} from '../core/analyzer/dependency-graph.js';
import { AnalysisArtifactGenerator, repoStructureToRepoMap, type RepoStructure, type LLMContext } from '../core/analyzer/artifact-generator.js';
import type { AnalyzeApiOptions, AnalyzeResult, ProgressCallback } from './types.js';
import { SpecSnapshotGenerator } from '../core/analyzer/spec-snapshot-generator.js';
import { atomicWriteFile } from '../core/decisions/atomic-store.js';
import { withAnalysisLock } from '../core/runtime/advisory-lock.js';
import { captureSourceState, reconcileSourceStates } from '../core/analyzer/source-state.js';
import { publishGeneration, readGenerationSnapshot, REQUIRED_ANALYSIS_ARTIFACTS } from '../core/runtime/analysis-generation.js';
import { computeProjectFingerprint } from '../core/services/mcp-handlers/utils.js';
import {
  acquireAnalysisOwnership,
  type AnalysisOwnerPayload,
} from '../core/runtime/analysis-ownership.js';
import { safeJoin } from '../utils/path-confinement.js';

/**
 * Raised when another frontend already owns a full analysis of this repository.
 *
 * The API has always rejected analysis failures, so a typed error preserves its
 * `Promise<AnalyzeResult>` contract while giving embedders the same explicit,
 * machine-readable state that the CLI and MCP surfaces expose.
 */
export class AnalysisInProgressError extends Error {
  readonly code = 'ANALYSIS_IN_PROGRESS' as const;

  constructor(
    readonly owner: AnalysisOwnerPayload | null,
    readonly elapsedMs: number | null,
    readonly heartbeatAgeMs: number,
  ) {
    super('Another process already owns a full analysis of this repository. No duplicate analysis was started.');
    this.name = 'AnalysisInProgressError';
  }
}

function progress(
  onProgress: ProgressCallback | undefined,
  step: string,
  status: 'start' | 'progress' | 'complete' | 'skip',
  detail?: string
): void {
  onProgress?.({ phase: 'analyze', step, status, detail });
}


/**
 * Load cached analysis artifacts from disk.
 * All four artifact files are saved by AnalysisArtifactGenerator.generateAndSave().
 */
async function loadCachedArtifacts(
  outputPath: string,
  repoStructure: RepoStructure,
): Promise<AnalyzeResult['artifacts']> {
  const llmContext = await readJsonFile<LLMContext>(
    join(outputPath, ARTIFACT_LLM_CONTEXT),
    ARTIFACT_LLM_CONTEXT,
  ) ?? { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] } };

  let summaryMarkdown = '';
  let dependencyDiagram = '';
  try { summaryMarkdown = await readFile(join(outputPath, 'SUMMARY.md'), 'utf-8'); } catch { /* optional */ }
  try { dependencyDiagram = await readFile(join(outputPath, 'dependencies.mermaid'), 'utf-8'); } catch { /* optional */ }

  return { repoStructure, summaryMarkdown, dependencyDiagram, llmContext };
}

/**
 * Run static analysis on the codebase.
 *
 * Scans the repository, builds a dependency graph, and generates
 * analysis artifacts. No LLM involvement.
 *
 * @throws Error if no openlore configuration found
 */
export async function openloreAnalyze(options: AnalyzeApiOptions = {}): Promise<AnalyzeResult> {
  const startTime = Date.now();
  // Ownership identity must be canonical across API, CLI, and MCP frontends;
  // otherwise a symlink spelling can leave a crashed owner's lock unreclaimable.
  const rootPath = await realpath(options.rootPath ?? process.cwd());
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const excludePatterns = options.excludePatterns ?? [];
  const includePatterns = options.includePatterns ?? [];
  const force = options.force ?? false;
  const outputRelPath = options.outputPath ?? `${OPENLORE_ANALYSIS_REL_PATH}/`;
  // The default internal store is repository-controlled and must not follow a
  // committed `.openlore` symlink. An explicit outputPath remains an operator-
  // authorized custom destination for API compatibility.
  const outputPath = options.outputPath === undefined
    ? safeJoin(rootPath, outputRelPath)
    : resolve(rootPath, outputRelPath);
  const { onProgress } = options;

  // Validate config exists
  const openloreConfig = await readOpenLoreConfig(rootPath);
  if (!openloreConfig) {
    throw new Error('No openlore configuration found. Run openloreInit() first.');
  }

  // Check for existing recent analysis
  if (!force) {
    const repoStructurePath = join(outputPath, ARTIFACT_REPO_STRUCTURE);
    if (await fileExists(repoStructurePath)) {
      const stats = await stat(repoStructurePath);
      const age = Date.now() - stats.mtime.getTime();
      if (age < ANALYSIS_STALE_THRESHOLD_MS) {
        const snapshot = await readGenerationSnapshot(
          outputPath,
          [...REQUIRED_ANALYSIS_ARTIFACTS],
          async (): Promise<AnalyzeResult | null> => {
            const repoStructure = await readJsonFile<RepoStructure>(
              repoStructurePath,
              ARTIFACT_REPO_STRUCTURE,
            );
            if (!repoStructure) return null;
            const depGraph = await readJsonFile<DependencyGraphResult>(
              join(outputPath, ARTIFACT_DEPENDENCY_GRAPH),
              ARTIFACT_DEPENDENCY_GRAPH,
            ) ?? undefined;
            return {
              repoMap: repoStructureToRepoMap(repoStructure),
              depGraph: depGraph ?? {
            nodes: [],
            edges: [],
            clusters: [],
            cycles: [],
            structuralClusters: [],
            rankings: {
              byImportance: [],
              byConnectivity: [],
              clusterCenters: [],
              leafNodes: [],
              bridgeNodes: [],
              orphanNodes: [],
            },
            statistics: {
              nodeCount: 0,
              edgeCount: 0,
              importEdgeCount: 0,
              httpEdgeCount: 0,
              clusterCount: 0,
              cycleCount: 0,
              avgDegree: 0,
              density: 0,
              structuralClusterCount: 0,
            },
              },
              artifacts: await loadCachedArtifacts(outputPath, repoStructure),
              duration: Date.now() - startTime,
            };
          },
        );
        if (snapshot.state === 'ok' && snapshot.value) {
          progress(
            onProgress,
            'Recent analysis exists',
            'skip',
            `${Math.floor(age / 60000)} minutes old`
          );
          return snapshot.value;
        }
        // TTL-fresh but mixed/uncommitted artifacts are a cache miss. Continue
        // through ownership and rebuild rather than returning unverifiable facts.
      }
    }
  }

  // Ensure output directory exists
  await mkdir(outputPath, { recursive: true });

  // Share the repository-wide single-flight fence used by the CLI and MCP. The
  // ownership spans computation as well as publication: taking only the artifact
  // lock below would still allow an older, slower scan to publish after a newer
  // one and roll the repository's evidence backward.
  const ownership = await acquireAnalysisOwnership(rootPath, outputPath, { stage: 'starting' });
  if (ownership.state === 'in-progress') {
    throw new AnalysisInProgressError(
      ownership.owner,
      ownership.elapsedMs,
      ownership.heartbeatAgeMs,
    );
  }

  try {
    // Phase 1: Repository Mapping
    await ownership.update('scanning', { percent: 0 }).catch(() => {});
    progress(onProgress, 'Scanning directory structure', 'start');
    const mapper = new RepositoryMapper(rootPath, {
      maxFiles,
      excludePatterns: excludePatterns.length > 0 ? excludePatterns : undefined,
      includePatterns: includePatterns.length > 0 ? includePatterns : undefined,
    });
    const sourceStateBefore = await captureSourceState(rootPath);
    const repoMap = await mapper.map();
    progress(
      onProgress,
      'Scanning directory structure',
      'complete',
      `${repoMap.summary.analyzedFiles} files`
    );

    // Phase 2: Dependency Graph
    await ownership.update('dependency-graph', { percent: 35 }).catch(() => {});
    progress(onProgress, 'Building dependency graph', 'start');
    const graphBuilder = new DependencyGraphBuilder({ rootDir: rootPath });
    const depGraph = await graphBuilder.build(repoMap.allFiles);
    progress(
      onProgress,
      'Building dependency graph',
      'complete',
      `${depGraph.statistics.nodeCount} nodes, ${depGraph.statistics.edgeCount} edges`
    );

    // Phase 3: Generate Artifacts
    await ownership.update('artifacts', { percent: 70 }).catch(() => {});
    progress(onProgress, 'Generating analysis artifacts', 'start');
    const artifactGenerator = new AnalysisArtifactGenerator({
      rootDir: rootPath,
      outputDir: outputPath,
      maxDeepAnalysisFiles: Math.min(20, Math.ceil(repoMap.highValueFiles.length * 0.3)),
      maxValidationFiles: 5,
      // NOT keyed off `force` (change: optimize-hash-keyed-analyze). `force` here means "do
      // not skip this run", which is what the serve daemon's post-edit rebuild asks for — and
      // that rebuild is exactly the incremental workload the extraction memo exists to make
      // cheap. Re-extraction is its own opt-in.
      reExtract: options.reExtract ?? false,
    });
    let artifacts: AnalyzeResult['artifacts'];
    await withAnalysisLock(outputPath, async () => {
      artifacts = await artifactGenerator.generateAndSave(repoMap, depGraph, undefined, {
        acquireLock: false,
      });
      const fingerprintHash = await computeProjectFingerprint(rootPath);
      const sourceState = reconcileSourceStates(sourceStateBefore, await captureSourceState(rootPath));
      await atomicWriteFile(
        join(outputPath, ARTIFACT_DEPENDENCY_GRAPH),
        JSON.stringify(depGraph, null, 2)
      );
      await atomicWriteFile(
        join(outputPath, ARTIFACT_FINGERPRINT),
        JSON.stringify({
          hash: fingerprintHash,
          commit: sourceState.commit,
          sourceTreeState: sourceState.treeState,
          computedAt: new Date().toISOString(),
          fileCount: repoMap.allFiles.length,
        })
      );
      if (!(await publishGeneration(outputPath, [...REQUIRED_ANALYSIS_ARTIFACTS]))) {
        throw new Error(
          'Analysis produced an incomplete required artifact set; generation was not published.'
        );
      }
    });
    progress(onProgress, 'Generating analysis artifacts', 'complete');

    // Generate spec snapshot (non-fatal — snapshot is a derived artifact)
    const openspecRelPath = openloreConfig.openspecPath ?? OPENSPEC_DIR;
    const snapshotGenerator = new SpecSnapshotGenerator(rootPath, openspecRelPath);
    await snapshotGenerator.generate().catch(() => {});

    const duration = Date.now() - startTime;
    return { repoMap, depGraph, artifacts: artifacts!, duration };
  } finally {
    await ownership.release();
  }
}
