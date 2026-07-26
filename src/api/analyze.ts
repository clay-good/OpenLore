/**
 * openlore analyze — programmatic API
 *
 * Runs static analysis on the codebase (no LLM required).
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { ANALYSIS_STALE_THRESHOLD_MS, DEFAULT_MAX_FILES, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_REPO_STRUCTURE, ARTIFACT_DEPENDENCY_GRAPH, ARTIFACT_LLM_CONTEXT, OPENSPEC_DIR } from '../constants.js';
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
  const rootPath = options.rootPath ?? process.cwd();
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const excludePatterns = options.excludePatterns ?? [];
  const includePatterns = options.includePatterns ?? [];
  const force = options.force ?? false;
  const outputRelPath = options.outputPath ?? `${OPENLORE_ANALYSIS_REL_PATH}/`;
  const outputPath = join(rootPath, outputRelPath);
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
        progress(
          onProgress,
          'Recent analysis exists',
          'skip',
          `${Math.floor(age / 60000)} minutes old`
        );
        // Load and return existing analysis
        const repoStructure = await readJsonFile<RepoStructure>(
          repoStructurePath,
          ARTIFACT_REPO_STRUCTURE,
        );
        if (!repoStructure) {
          throw new Error(`Failed to load ${ARTIFACT_REPO_STRUCTURE} — run openlore analyze --force to regenerate`);
        }

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
      }
    }
  }

  // Ensure output directory exists
  await mkdir(outputPath, { recursive: true });

  // Phase 1: Repository Mapping
  progress(onProgress, 'Scanning directory structure', 'start');
  const mapper = new RepositoryMapper(rootPath, {
    maxFiles,
    excludePatterns: excludePatterns.length > 0 ? excludePatterns : undefined,
    includePatterns: includePatterns.length > 0 ? includePatterns : undefined,
  });
  const repoMap = await mapper.map();
  progress(
    onProgress,
    'Scanning directory structure',
    'complete',
    `${repoMap.summary.analyzedFiles} files`
  );

  // Phase 2: Dependency Graph
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
  const artifacts = await artifactGenerator.generateAndSave(repoMap, depGraph);

  // Save dependency graph
  await writeFile(join(outputPath, ARTIFACT_DEPENDENCY_GRAPH), JSON.stringify(depGraph, null, 2));
  progress(onProgress, 'Generating analysis artifacts', 'complete');

  // Generate spec snapshot (non-fatal — snapshot is a derived artifact)
  const openspecRelPath = openloreConfig.openspecPath ?? OPENSPEC_DIR;
  const snapshotGenerator = new SpecSnapshotGenerator(rootPath, openspecRelPath);
  await snapshotGenerator.generate().catch(() => {});

  const duration = Date.now() - startTime;
  return { repoMap, depGraph, artifacts, duration };
}
