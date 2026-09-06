/**
 * openlore analyze command
 *
 * Runs static analysis on the codebase without LLM involvement.
 * Outputs repository map, dependency graph, and file significance scores.
 */

import { Command, Option } from 'commander';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../../utils/logger.js';
import { formatDuration, formatAge, getAnalysisAge } from '../../utils/command-helpers.js';
import { safeJoin } from '../../utils/path-confinement.js';
import {
  ARTIFACT_REFACTOR_PRIORITIES,
  ARTIFACT_REPO_STRUCTURE,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DEPENDENCY_GRAPH,
  DEFAULT_MAX_FILES,
  OPENLORE_ANALYSIS_REL_PATH,
  OPENLORE_CONFIG_REL_PATH,
} from '../../constants.js';
import type { AnalyzeOptions, OpenLoreConfig } from '../../types/index.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import type { RepositoryMap } from '../../core/analyzer/repository-mapper.js';
import type { CloneGroup, CloneInstance } from '../../core/analyzer/duplicate-detector.js';
import type { DependencyGraphResult } from '../../core/analyzer/dependency-graph.js';
import type { AnalysisArtifacts } from '../../core/analyzer/artifact-generator.js';
import { ARTIFACT_WORKSPACE_SHARDS } from '../../core/analyzer/workspace-shard-analysis.js';
import {
  buildArchitectureOverview,
  writeArchitectureMd,
} from '../../core/analyzer/architecture-writer.js';
import { generateCodebaseDigest } from '../../core/analyzer/codebase-digest.js';
import { generateAiConfigs, AI_TOOL_TARGETS, type AiTool, type AiConfigResult } from '../../core/analyzer/ai-config-generator.js';
import {
  acquireAnalysisOwnership,
  isProcessAlive,
  readAnalysisProgress,
  type AnalysisOwnership,
} from '../../core/runtime/analysis-ownership.js';
import {
  analysisConfigFingerprintInput,
  analysisGeneratedExcludes,
  isAnalysisCacheFresh,
  runAnalysisCore,
  type AnalysisReport,
} from '../../core/analyzer/analysis-core.js';
import {
  buildAnalysisIndexes,
  buildSpecIndex,
  type IndexReport,
} from '../../core/analyzer/analysis-indexes.js';
import { readGenerationSnapshot, REQUIRED_ANALYSIS_ARTIFACTS } from '../../core/runtime/analysis-generation.js';

// ============================================================================
// TYPES
// ============================================================================

interface ExtendedAnalyzeOptions extends AnalyzeOptions {
  /** Re-analyze AND re-extract every file — the human "trust nothing" lever. */
  force?: boolean;
  /**
   * Re-analyze without re-extracting: defeat the source-unchanged skip while still reusing
   * cached extraction for files that did not change (change: optimize-hash-keyed-analyze).
   * What the watcher's self-heal rebuild wants — the index is stale, the extractor is not.
   */
  reanalyze?: boolean;
  embed?: boolean;
  reindexSpecs?: boolean;
  aiConfigs?: boolean;
  /** Internal: set when `openlore install` invokes analyze. Suppresses the
   * agent-onboarding tips (the "add @CODEBASE.md to CLAUDE.md" block, the
   * "Agent config files: not generated" tip, and the "run openlore generate"
   * next-step) — install does the agent wiring itself, so those would be
   * redundant and contradictory on the install path. */
  embedded?: boolean;
  /** Internal: the current install created the empty OpenSpec directory. */
  freshSpecDirectory?: boolean;
  /** Follow an analysis another process already owns instead of exiting. */
  wait?: boolean;
  /** Repeatable workspace package names to recompute against the retained graph. */
  shard?: string[];
  /**
   * Internal: flush a partial index during an index-absent first build so tool calls made
   * while it runs are answered from what exists (change: refine-first-run-partial-serving).
   *
   * Set explicitly by the background auto-init build, which also passes `--embedded` and so
   * cannot be recognised as interactive any other way. An interactive `openlore analyze`
   * turns the lane on by default; CI and embedded hosts leave it off and keep the
   * single-write build.
   */
  partialServing?: boolean;
}

interface AnalysisResult {
  repoMap: RepositoryMap;
  depGraph: DependencyGraphResult;
  artifacts: AnalysisArtifacts;
  duration: number;
  generationId?: string;
  workspaceShards?: import('../../core/analyzer/workspace-shards.js').WorkspaceShardReport;
  shardReceipt?: import('../../core/analyzer/workspace-shard-analysis.js').ShardScopedAnalysisReceipt;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Collect multiple values for repeatable options
 */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function formatIndexedFunctionPopulation(result: {
  total: number;
  productionFunctions: number;
  testFunctions: number;
  signatureOnlySymbols: number;
}): string {
  return result.testFunctions + result.signatureOnlySymbols === 0
    ? `${result.productionFunctions} functions`
    : `${result.productionFunctions} call-graph functions + ${result.testFunctions} test functions + ${result.signatureOnlySymbols} signature-only symbols; ${result.total} indexed repo symbols`;
}

/**
 * Check if analysis exists and return its age
 */

// ============================================================================
// CORE ANALYSIS FUNCTION
// ============================================================================

/**
 * Report the live owner of an in-progress analysis, with its current stage.
 *
 * Exits without doing any work: the point of single flight is that the second
 * invocation performs no analysis. `--wait` is the opt-in path for attaching.
 */
async function reportActiveAnalysis(
  ownership: AnalysisOwnership & { state: 'in-progress' },
  outputPath: string,
): Promise<void> {
  const owner = ownership.owner;
  logger.warning('ANALYSIS_IN_PROGRESS — another process already owns a full analysis of this repository.');
  if (owner) {
    logger.info('Owner PID', String(owner.pid));
    logger.info('Stage', owner.stage);
    logger.info('Started', owner.startedAt);
  }
  if (ownership.elapsedMs !== null) logger.info('Elapsed', formatDuration(ownership.elapsedMs));
  // A heartbeat age is not a health verdict. Liveness is the PID; the heartbeat
  // says when the owner last wrote. Printing the age alone made a healthy owner in
  // a long synchronous stage read as abandoned, so the two facts are stated
  // separately and the reader is told which one settles it.
  const alive = owner ? isProcessAlive(owner.pid) : null;
  logger.info(
    'Heartbeat',
    `last beat ${formatDuration(ownership.heartbeatAgeMs)} ago`
    + (alive === null ? '' : alive ? ' — owner process is alive' : ' — owner process is GONE'),
  );
  if (alive === false) {
    logger.info('Reclaim', 'The owner is dead; the next analyze reclaims this lock automatically.');
  }

  const progress = await readAnalysisProgress(outputPath);
  if (progress) {
    logger.info('Progress', progress.percent === null ? progress.stage : `${progress.stage} (${progress.percent}%)`);
  }
  logger.blank();
  logger.info('Attach', 'Re-run with `openlore analyze --wait` to follow it instead of exiting.');
}

/**
 * Print the summary of an analysis THIS process did not run — the result an
 * attaching `--wait` invocation was waiting for. Best-effort: an unreadable
 * artifact is reported as such rather than silently implying no analysis exists.
 */
async function reportCompletedAnalysis(outputPath: string): Promise<void> {
  try {
    const raw = await readFile(join(outputPath, ARTIFACT_REPO_STRUCTURE), 'utf-8');
    const repoStructure = JSON.parse(raw) as {
      statistics: { analyzedFiles: number };
      domains: Array<{ name: string }>;
      architecture: { pattern: string };
    };
    logger.blank();
    logger.success('Analysis Summary');
    logger.info('Files analyzed', String(repoStructure.statistics.analyzedFiles));
    logger.info('Domains detected', repoStructure.domains.map(d => d.name).join(', ') || 'None');
    logger.info('Architecture', repoStructure.architecture.pattern);
  } catch (err) {
    logger.warning(`Analysis completed but its summary could not be read: ${(err as Error).message}`);
  }
}

/**
 * Run the complete analysis pipeline
 */
export async function runAnalysis(
  rootPath: string,
  outputPath: string,
  options: {
    maxFiles: number;
    include: string[];
    exclude: string[];
    reExtract?: boolean;
    ownership?: AnalysisOwnership & { state: 'owned' };
    shards?: string[];
    partialServing?: boolean;
  },
): Promise<AnalysisResult> {
  const reporter = {
    report(event: AnalysisReport): void {
      if (!event.detail) return;
      if (event.status === 'warning') logger.warning(event.detail);
      else if (event.status === 'info') logger.info('Analysis', event.detail);
      else if (event.status === 'start') logger.analysis(`${event.detail}...`);
    },
  };
  return runAnalysisCore(rootPath, outputPath, { ...options, reporter });
}

// ============================================================================
// COMMAND
// ============================================================================

export const analyzeCommand = new Command('analyze')
  .description('Run static analysis on the codebase (no LLM required)')
  .option(
    '--output <path>',
    'Directory to write analysis results',
    `${OPENLORE_ANALYSIS_REL_PATH}/`
  )
  .option(
    '--max-files <n>',
    'Maximum number of files to analyze (default: 100000)',
    '100000'
  )
  .option(
    '--include <glob>',
    'Additional glob patterns to include (repeatable)',
    collect,
    []
  )
  .option(
    '--exclude <glob>',
    'Additional glob patterns to exclude (repeatable)',
    collect,
    []
  )
  .option(
    '--shard <name>',
    'Recompute one workspace shard against the retained whole-repository graph (repeatable)',
    collect,
    []
  )
  .option(
    '--force',
    'Re-analyze from scratch: analyze even if the source is unchanged, and re-extract every file instead of reusing cached extraction',
    false
  )
  .option(
    '--reanalyze',
    'Analyze even if the source is unchanged, but still reuse cached extraction for files that did not change (the cheap half of --force)',
    false
  )
  .option(
    '--embed',
    'Build a semantic vector index after analysis using the configured embedding provider (local on-device, or remote EMBED_*). Falls back to the first-class keyword (BM25) index when none is configured.',
    true
  )
  .option(
    '--no-embed',
    'Build a keyword-only (BM25) index instead of semantic embeddings — orient still works, just without semantic search'
  )
  .option(
    '--reindex-specs',
    'Re-index OpenSpec specs into the vector index without re-running full analysis (requires EMBED_BASE_URL + EMBED_MODEL)',
    false
  )
  .option(
    '--ai-configs',
    'Generate AI tool config files (.cursorrules, .clinerules/openlore.md, CLAUDE.md) if they do not already exist',
    false
  )
  .option(
    '--wait',
    'If another process already owns a full analysis of this repository, follow its progress and return its result instead of exiting',
    false
  )
  // Internal flag set by `openlore install` (hidden from help): install does the
  // agent wiring itself, so analyze must not also print its agent-onboarding tips.
  .addOption(new Option('--embedded').hideHelp())
  .addOption(new Option('--partial-serving').hideHelp())
  .addOption(new Option('--fresh-spec-directory').hideHelp())
  .addHelpText(
    'after',
    `
Examples:
  $ openlore analyze                 Analyze with defaults
  $ openlore analyze --max-files 1000
                                     Analyze more files
  $ openlore analyze --include "*.graphql" --include "*.prisma"
                                     Include additional file types
  $ openlore analyze --exclude "legacy/**"
                                     Exclude specific directories
  $ openlore analyze --shard payments
                                     Recompute one workspace package while retaining the whole graph
  $ openlore analyze --output ./my-analysis
                                     Custom output location
  $ openlore analyze --force         Re-extract every file (ignore the extraction cache)
  $ openlore analyze --no-embed      Build keyword-only (BM25) index, no embeddings
  $ openlore analyze --reindex-specs Re-index specs only (no full re-analysis)

Output files:
  .openlore/analysis/
  ├── repo-structure.json    Repository structure and metadata
  ├── dependency-graph.json  Import/export relationships
  ├── llm-context.json       Optimized context for LLM
  ├── dependencies.mermaid   Visual dependency diagram
  └── SUMMARY.md             Human-readable analysis summary

After analysis, run 'openlore generate' to create OpenSpec files.
`
  )
  .action(async (options: Partial<ExtendedAnalyzeOptions>) => {
    const startTime = Date.now();
    const rootPath = process.cwd();

    const opts: ExtendedAnalyzeOptions = {
      output: options.output ?? `${OPENLORE_ANALYSIS_REL_PATH}/`,
      maxFiles: typeof options.maxFiles === 'string'
        ? parseInt(options.maxFiles, 10)
        : options.maxFiles ?? DEFAULT_MAX_FILES,
      include: options.include ?? [],
      exclude: options.exclude ?? [],
      shard: options.shard ?? [],
      force: options.force ?? false,
      reanalyze: options.reanalyze ?? false,
      embed: options.embed ?? false,
      reindexSpecs: options.reindexSpecs ?? false,
      aiConfigs: options.aiConfigs ?? false,
      // A human waiting at a terminal for a first build is exactly who partial serving is
      // for, so an interactive run opts in by default. An embedded/CI build keeps the
      // single-write behaviour unless it asks for the lane by name — which the background
      // auto-init build does, because it passes `--embedded` too.
      partialServing: options.partialServing === true
        || (options.embedded !== true && !process.env.CI),
      quiet: false,
      verbose: false,
      noColor: false,
      config: OPENLORE_CONFIG_REL_PATH,
    };

    if (isNaN(opts.maxFiles) || opts.maxFiles < 1) {
      logger.error('--max-files must be a positive integer');
      process.exitCode = 1;
      return;
    }

    try {
      // ========================================================================
      // PHASE 1: VALIDATION
      // ========================================================================
      logger.section('Analyzing Codebase');

      // Check for openlore config
      const openloreConfig = await readOpenLoreConfig(rootPath);
      if (!openloreConfig) {
        logger.error('No openlore configuration found. Run "openlore init" first.');
        process.exitCode = 1;
        return;
      }

      // The index is ALWAYS built (so orient works); opts.embed only controls
      // whether we attempt semantic embeddings. --no-embed → keyword-only BM25.
      const keywordOnly = options.embed === false;

      logger.info('Project', openloreConfig.projectType);
      logger.info('Output', opts.output);
      logger.info('Max files', opts.maxFiles);
      if (opts.include.length > 0) {
        logger.info('Include patterns', opts.include.join(', '));
      }
      if (opts.exclude.length > 0) {
        logger.info('Exclude patterns', opts.exclude.join(', '));
      }
      if ((opts.shard?.length ?? 0) > 0) logger.info('Workspace shards', opts.shard!.join(', '));
      logger.blank();

      // ========================================================================
      // PHASE 1b: --reindex-specs fast path (no full analysis)
      // ========================================================================
      if (opts.reindexSpecs) {
        const outputPath = opts.output === `${OPENLORE_ANALYSIS_REL_PATH}/`
          ? safeJoin(rootPath, opts.output)
          : resolve(rootPath, opts.output);
        await mkdir(outputPath, { recursive: true });
        await buildSpecIndex({
          rootPath,
          outputPath,
          config: openloreConfig,
          reporter: {
            report(event): void { console.log(event.status === 'warning' ? formatSpecIndexFailure(event.detail ?? 'unknown error', options.freshSpecDirectory === true) : `    ${event.detail ?? 'Spec index updated'}`); },
          },
        });
        return;
      }

      // ========================================================================
      // PHASE 2: CHECK EXISTING ANALYSIS
      // ========================================================================
      const outputPath = opts.output === `${OPENLORE_ANALYSIS_REL_PATH}/`
        ? safeJoin(rootPath, opts.output)
        : resolve(rootPath, opts.output);
      const analysisAge = await getAnalysisAge(outputPath);
      const fingerprintConfig = analysisConfigFingerprintInput(
        openloreConfig.analysis,
        opts.include,
        opts.exclude,
        opts.maxFiles,
        analysisGeneratedExcludes(rootPath, outputPath, openloreConfig.openspecPath),
      );

      // Skip re-analysis only when the SOURCE is unchanged since the last run — a
      // content fingerprint (path+mtime+size of every source file), not a wall-clock
      // TTL. A committed/edited source change therefore re-analyzes even within the
      // freshness window; an unchanged tree skips regardless of age. (isCacheFresh
      // falls back to the TTL only for a legacy analysis written without a fingerprint.)
      const cacheFresh = analysisAge !== null && (await isAnalysisCacheFresh(rootPath, outputPath, fingerprintConfig));
      // `--reanalyze` and `--force` both defeat the skip; they differ only in whether the
      // per-file extraction cache is also thrown away (change: optimize-hash-keyed-analyze).
      const skipSuppressed = (opts.force ?? false) || (opts.reanalyze ?? false) || (opts.shard?.length ?? 0) > 0;
      if (analysisAge !== null && !skipSuppressed) {
        if (cacheFresh) {
          logger.discovery(`Analysis is up to date — source unchanged (${formatAge(analysisAge)})`);
          logger.info('Tip', 'Use --reanalyze to run anyway, or --force to also re-extract every file');
          logger.blank();

          // Show existing analysis stats
          try {
            const cached = await readGenerationSnapshot(
              outputPath,
              [...REQUIRED_ANALYSIS_ARTIFACTS],
              async () => {
                const repoStructure = JSON.parse(await readFile(join(outputPath, ARTIFACT_REPO_STRUCTURE), 'utf-8'));
                const llmContext = JSON.parse(await readFile(join(outputPath, ARTIFACT_LLM_CONTEXT), 'utf-8'));
                let dependencyGraphDegraded = false;
                try { JSON.parse(await readFile(join(outputPath, ARTIFACT_DEPENDENCY_GRAPH), 'utf-8')); }
                catch { dependencyGraphDegraded = true; }
                return { repoStructure, llmContext, dependencyGraphDegraded };
              },
              value => value.dependencyGraphDegraded ? [ARTIFACT_DEPENDENCY_GRAPH] : [],
            );
            if (cached.state !== 'ok') throw new Error('Cached analysis generation is incomplete or changed');
            const { repoStructure, llmContext, dependencyGraphDegraded } = cached.value;
            if (dependencyGraphDegraded) logger.warning('Dependency graph is unavailable; cached analysis is degraded.');

            logger.success('Analysis Summary');
            logger.info('Files analyzed', repoStructure.statistics.analyzedFiles);
            logger.info('Domains detected', repoStructure.domains.map((d: { name: string }) => d.name).join(', ') || 'None');
            logger.info('Architecture', repoStructure.architecture.pattern);
            logger.blank();

            // Always (re)build the search index — incremental, so it only
            // re-embeds changed functions. keywordOnly forces a BM25 index.
            await runEmbedStep(
              rootPath,
              outputPath,
              openloreConfig,
              opts.force ?? false,
              llmContext,
              keywordOnly,
              options.freshSpecDirectory === true,
              opts.include,
              opts.exclude,
              cached.generationId,
            );

            // If --ai-configs is requested, generate them even from cached analysis
            if (opts.aiConfigs) {
              let selectedTools: AiTool[] | undefined;
              if (process.stdin.isTTY) {
                const { checkbox } = await import('@inquirer/prompts');
                const chosen = await checkbox<AiTool>({
                  message: 'Generate config files for which AI assistants?',
                  choices: AI_TOOL_TARGETS.map(t => ({
                    name: t.label,
                    value: t.tool,
                    checked: true,
                  })),
                });
                selectedTools = chosen.length > 0 ? chosen : undefined;
              }
              if (selectedTools === undefined || selectedTools.length > 0) {
                const aiResults = await generateAiConfigs({
                  rootDir: rootPath,
                  analysisDir: opts.output.replace(/\/$/, ''),
                  projectName: repoStructure.projectName ?? 'project',
                  tools: selectedTools,
                });
                logger.blank();
                console.log('  Agent config files:');
                for (const { rel, created } of aiResults) {
                  const tag = created ? '(created)' : '(already exists)';
                  console.log(`    ├─ ${rel}  ${tag}`);
                }
                logger.blank();
              }
            }

            if (!options.embedded) logger.info('Next step', "Run 'openlore generate' to create OpenSpec files");
            return;
          } catch (readErr) {
            logger.debug(`Could not read existing analysis summary: ${(readErr as Error).message}`);
          }
        } else {
          logger.discovery('Source files changed since the last analysis — re-analyzing...');
          logger.blank();
        }
      }

      // ========================================================================
      // PHASE 3: RUN ANALYSIS
      // ========================================================================
      // Ensure output directory exists
      await mkdir(outputPath, { recursive: true });

      // Repository-scoped single flight. A second analysis — from any frontend —
      // must not duplicate the work already under way; it either reports the live
      // owner and exits, or (with --wait) follows it to completion.
      const ownership = await acquireAnalysisOwnership(rootPath, outputPath, {
        wait: options.wait === true,
        stage: 'starting',
      });
      if (ownership.state === 'in-progress') {
        await reportActiveAnalysis(ownership, outputPath);
        process.exitCode = 1;
        return;
      }

      // Attached: a previous owner held the repository and has now released it, so
      // the analysis this invocation was waiting for already exists. Running the
      // pipeline again would be exactly the duplicate full analysis `--wait` exists
      // to avoid. An explicit re-analysis request still runs, and a dead owner that
      // never finished leaves the tree unchanged-but-not-fresh, which also runs.
      if (ownership.waitedMs > 0 && !skipSuppressed && (await isAnalysisCacheFresh(rootPath, outputPath, fingerprintConfig))) {
        try {
          logger.success('Attached to the analysis owned by another process — it completed');
          logger.info('Waited', formatDuration(ownership.waitedMs));
          await reportCompletedAnalysis(outputPath);
        } finally {
          await ownership.release();
        }
        return;
      }

      let result;
      try {
        result = await runAnalysis(rootPath, outputPath, {
          maxFiles: opts.maxFiles,
          include: opts.include,
          exclude: opts.exclude,
          reExtract: opts.force ?? false,
          ownership,
          shards: opts.shard,
          partialServing: opts.partialServing,
        });
      } finally {
        await ownership.release();
      }

      // ========================================================================
      // PHASE 4: DISPLAY RESULTS
      // ========================================================================
      logger.blank();
      logger.section('Analysis Complete');

      if (result.shardReceipt?.mode === 'scoped') {
        logger.info('Mode', 'Scoped graph update; repo-wide artifacts retained');
        logger.info('Recomputed shards', result.shardReceipt.recomputed.join(', '));
        const retainedStates = result.shardReceipt.shards
          .filter(shard => result.shardReceipt!.retained.includes(shard.name))
          .map(shard => `${shard.name} (${shard.freshness}${shard.lastRecomputedAt ? `; last ${shard.lastRecomputedAt}` : ''})`);
        logger.info('Retained shards', retainedStates.join(', ') || 'None');
        logger.info('Resolution frontier', `${result.shardReceipt.frontierFiles.length} files`);
        logger.info('Explicitly stale', result.shardReceipt.staleFiles.length > 0 ? result.shardReceipt.staleFiles.join(', ') : 'None');
        logger.info('Recomputed artifacts', result.shardReceipt.artifacts.recomputed.join(', '));
        logger.info('Retained artifacts', result.shardReceipt.artifacts.retained.join(', '));
        logger.info('Receipt', join(opts.output, ARTIFACT_WORKSPACE_SHARDS));
        return;
      }

      const { repoMap, depGraph, artifacts } = result;

      // Summary
      console.log('');
      console.log('  Repository Structure:');
      console.log(`    ├─ Files analyzed: ${repoMap.summary.analyzedFiles}`);
      console.log(`    ├─ High-value files: ${repoMap.highValueFiles.length}`);
      console.log(`    ├─ Languages: ${repoMap.summary.languages.slice(0, 3).map(l => l.language).join(', ')}`);
      if (artifacts.repoStructure.undomained?.length) {
        const roleCounts = new Map<string, number>();
        for (const item of artifacts.repoStructure.undomainedEvidence ?? []) {
          roleCounts.set(item.role, (roleCounts.get(item.role) ?? 0) + 1);
        }
        const detail = [...roleCounts.entries()].map(([role, count]) => `${count} ${role}`).join(', ');
        console.log(`    ├─ Undomained analyzed evidence: ${artifacts.repoStructure.undomained.length} (${safe(detail)})`);
      }
      console.log(`    └─ Architecture: ${artifacts.repoStructure.architecture.pattern}`);
      console.log('');

      console.log('  Dependency Graph:');
      console.log(`    ├─ Nodes: ${depGraph.statistics.nodeCount}`);
      console.log(`    ├─ Edges: ${depGraph.statistics.edgeCount}`);
      console.log(`    ├─ Clusters: ${depGraph.statistics.clusterCount}`);
      if (depGraph.statistics.cycleCount > 0) {
        console.log(`    ├─ ⚠ Circular dependencies: ${depGraph.statistics.cycleCount}`);
      }
      console.log(`    └─ Average degree: ${depGraph.statistics.avgDegree.toFixed(1)}`);
      console.log('');

      // Call Graph
      const cg = artifacts.llmContext.callGraph;
      if (cg && cg.stats?.totalNodes > 0) {
        console.log('  Call Graph (static analysis):');
        console.log(`    ├─ Functions: ${cg.stats.totalNodes}`);
        console.log(`    ├─ Internal calls: ${cg.stats.totalEdges}`);
        if (cg.hubFunctions?.length > 0) {
          const hubs = cg.hubFunctions.slice(0, 3).map(f => `${f.name}(fanIn=${f.fanIn})`).join(', ');
          console.log(`    ├─ Hub functions: ${hubs}`);
        }
        if (cg.layerViolations?.length > 0) {
          console.log(`    ├─ ⚠ Layer violations: ${cg.layerViolations.length}`);
        }
        console.log(`    └─ Entry points: ${cg.entryPoints?.length ?? 0}`);
        console.log('');
      }

      // Refactor priorities (read from disk if available)
      try {
        const { readFile: rf } = await import('node:fs/promises');
        const rp = JSON.parse(await rf(join(opts.output, ARTIFACT_REFACTOR_PRIORITIES), 'utf-8'));
        if (rp?.stats?.withIssues > 0) {
          const s = rp.stats;
          const badges = [
            s.unreachable   > 0 ? `${s.unreachable} unreachable`  : null,
            s.highFanIn     > 0 ? `${s.highFanIn} hub overload`   : null,
            s.highFanOut    > 0 ? `${s.highFanOut} god function`   : null,
            s.srpViolations > 0 ? `${s.srpViolations} SRP`        : null,
            s.cyclesDetected> 0 ? `${s.cyclesDetected} cycle`     : null,
            s.inCloneGroup  > 0 ? `${s.inCloneGroup} duplicate`   : null,
          ].filter(Boolean).join('  ·  ');

          const issueLabel: Record<string, string> = {
            unreachable:       'dead code',
            high_fan_in:       `hub   fanIn`,
            high_fan_out:      `god   fanOut`,
            multi_requirement: 'SRP',
            in_cycle:          'cycle',
            in_clone_group:    'clone',
          };

          console.log(`  Refactoring Candidates  (${s.withIssues}/${s.totalFunctions} functions):`);
          console.log(`    ${badges}`);
          console.log('');

          const top = (rp.priorities as Array<{ function: string; file: string; fanIn: number; fanOut: number; issues: string[]; requirements: string[] }>).slice(0, 7);
          if (top.length === 0) {
            console.log('    (no refactoring candidates)');
          } else {
            const maxNameLen = Math.max(...top.map(p => (p.function ?? '').length), 8);
            const maxFileLen = Math.max(...top.map(p => (p.file?.split('/').pop() ?? '').length), 8);

            for (const p of top) {
              const name  = (p.function ?? '').padEnd(maxNameLen);
              const file  = (p.file?.split('/').pop() ?? '').padEnd(maxFileLen);
              const main  = p.issues?.[0];
              const val   = main === 'high_fan_in'  ? `fanIn=${p.fanIn}`
                          : main === 'high_fan_out' ? `fanOut=${p.fanOut}`
                          : main === 'in_cycle'     ? `cycle`
                          : main === 'unreachable'  ? `unreachable`
                          : `${p.requirements?.length ?? 0} req`;
              const extra = (p.issues ?? []).slice(1).map(i => issueLabel[i] ?? i).join(', ');
              const reqs  = (p.requirements?.length ?? 0) > 0 ? `  [${p.requirements.slice(0,2).join(', ')}${p.requirements.length > 2 ? '…' : ''}]` : '';
              console.log(`    ${name}  ${file}  ${val.padEnd(12)}${extra ? '  +' + extra : ''}${reqs}`);
            }
          }

          if (rp.cycles?.length > 0) {
            console.log('');
            for (const c of rp.cycles as Array<{ size: number; participants: Array<{ function: string; file: string }> }>) {
              const names = c.participants.map(p => p.function).join(' ↔ ');
              console.log(`    ⚠ Cycle: ${names}`);
            }
          }

          console.log('');
          console.log(`    → ${opts.output}refactor-priorities.json`);
          console.log('');
        }
      } catch (rpErr) {
        logger.debug(`Refactor priorities not available: ${(rpErr as Error).message}`);
      }

      // Duplicate code detection
      try {
        const { readFile: rf } = await import('node:fs/promises');
        const dup = JSON.parse(await rf(join(opts.output, 'duplicates.json'), 'utf-8'));
        if (dup?.stats?.cloneGroupCount > 0) {
          const s = dup.stats;
          const severity = s.duplicationRatio >= 0.2 ? '⚠'
                           : s.duplicationRatio >= 0.1 ? 'ℹ'
                           : ' ';
          console.log(`  ${severity} Code Duplication  (${s.duplicatedFunctions}/${s.totalFunctions} functions):`);
          console.log(`    ├─ Ratio: ${(s.duplicationRatio * 100).toFixed(1)}%`);
          console.log(`    ├─ Clone groups: ${s.cloneGroupCount}`);

          // Show top clone types
          const typeCounts: Record<string, number> = { exact: 0, structural: 0, near: 0 };
          for (const group of dup.cloneGroups) {
            typeCounts[group.type]++;
          }
          const typeLabels = Object.entries(typeCounts)
            .filter(([_, count]) => count > 0)
            .map(([type, count]) => `${count} ${type}`)
            .join('  ·  ');

          console.log(`    └─ Types: ${typeLabels}`);

          // Show top 5 clone groups
          if (dup.cloneGroups.length > 0) {
            console.log('');
            console.log('  Top 5 Clone Groups:');
            const topGroups = dup.cloneGroups
              .sort((a: CloneGroup, b: CloneGroup) => b.instances.length - a.instances.length)
              .slice(0, 5);

            for (const group of topGroups) {
              const files = group.instances.map((i: CloneInstance) => {
                const fileParts = i.file.split('/');
                return `${fileParts[fileParts.length - 2]}/${fileParts[fileParts.length - 1]}:${i.functionName}`;
              }).join('  ');

              console.log(`    ${group.type.padEnd(10)} (${group.instances.length}x, ${group.lineCount} lines): ${files}`);
            }
          }

          console.log('');
          console.log(`    → ${opts.output}duplicates.json`);
          console.log('');
        }
      } catch (dupErr) {
        logger.debug(`Duplicates report not available: ${(dupErr as Error).message}`);
      }

      // Detected domains
      if (artifacts.repoStructure.domains.length > 0) {
        const rawCandidates = artifacts.repoStructure.statistics.rawDomainCandidateCount
          ?? artifacts.repoStructure.domains.length;
        console.log(`  Detected Domains (${rawCandidates} raw candidates → ${artifacts.repoStructure.domains.length} final):`);
        for (let i = 0; i < Math.min(artifacts.repoStructure.domains.length, 6); i++) {
          const domain = artifacts.repoStructure.domains[i];
          const isLast = i === Math.min(artifacts.repoStructure.domains.length, 6) - 1;
          const prefix = isLast ? '└─' : '├─';
          console.log(`    ${prefix} ${safe(domain.name)} (${domain.files.length} files)`);
        }
        if (artifacts.repoStructure.domains.length > 6) {
          console.log(`       ... and ${artifacts.repoStructure.domains.length - 6} more`);
        }
        console.log('');
      }

      // Generate ARCHITECTURE.md from cached analysis (no LLM)
      let architectureMdWritten = false;
      try {
        const ctx = artifacts.llmContext ?? null;
        const overview = buildArchitectureOverview(depGraph, ctx, rootPath);
        await writeArchitectureMd(outputPath, overview);
        architectureMdWritten = true;
      } catch (archErr) {
        logger.debug(`ARCHITECTURE.md generation skipped: ${(archErr as Error).message}`);
      }

      // Generate .openlore/analysis/CODEBASE.md — agent-readable architecture digest
      const digestWritten = await generateCodebaseDigest(
        artifacts.llmContext,
        depGraph,
        { rootPath, outputDir: outputPath, repoStructure: artifacts.repoStructure },
      );

      // Generate AI tool config files — prompt user to select which assistants
      let aiConfigsCreated: AiConfigResult[] = [];
      if (opts.aiConfigs) {
        let selectedTools: AiTool[] | undefined;

        if (process.stdin.isTTY) {
          const { checkbox } = await import('@inquirer/prompts');
          const chosen = await checkbox<AiTool>({
            message: 'Generate config files for which AI assistants?',
            choices: AI_TOOL_TARGETS.map(t => ({
              name: t.label,
              value: t.tool,
              checked: true,
            })),
          });
          selectedTools = chosen.length > 0 ? chosen : undefined;
        }
        // Non-TTY: generate for all tools (CI / pipe usage)

        if (selectedTools === undefined || selectedTools.length > 0) {
          aiConfigsCreated = await generateAiConfigs({
            rootDir: rootPath,
            analysisDir: opts.output.replace(/\/$/, ''),
            projectName: result.repoMap.metadata.projectName,
            tools: selectedTools,
          });
        }
      }

      // Files generated
      console.log('  Output Files:');
      console.log(`    ├─ ${opts.output}repo-structure.json`);
      console.log(`    ├─ ${opts.output}dependency-graph.json`);
      console.log(`    ├─ ${opts.output}llm-context.json`);
      console.log(`    ├─ ${opts.output}dependencies.mermaid`);
      if (artifacts.repoStructure.schemas.length > 0) {
        console.log(`    ├─ ${opts.output}schema-inventory.json  (${artifacts.repoStructure.schemas.length} table(s))`);
      }
      if (artifacts.repoStructure.routeInventory.total > 0) {
        console.log(`    ├─ ${opts.output}route-inventory.json  (${artifacts.repoStructure.routeInventory.total} route(s))`);
      }
      if (artifacts.repoStructure.middleware.length > 0) {
        console.log(`    ├─ ${opts.output}middleware-inventory.json  (${artifacts.repoStructure.middleware.length} middleware entry(ies))`);
      }
      if (artifacts.repoStructure.uiComponents.length > 0) {
        console.log(`    ├─ ${opts.output}ui-inventory.json  (${artifacts.repoStructure.uiComponents.length} UI component(s))`);
      }
      if (artifacts.repoStructure.envVars.length > 0) {
        console.log(`    ├─ ${opts.output}env-inventory.json  (${artifacts.repoStructure.envVars.length} env var(s))`);
      }
      // Listed like the peer inventories, and only when something was recorded — the artifact is
      // absent on a repository with no site (change: disclose-dynamic-boundary-regions).
      if (artifacts.dynamicBoundary) {
        console.log(
          `    ├─ ${opts.output}dynamic-boundary.json  (${artifacts.dynamicBoundary.totalSites} `
          + `dispatch site(s) the call graph cannot follow, in ${artifacts.dynamicBoundary.totalFiles} file(s))`,
        );
      }
      // CODEBASE.md (digestWritten) is the last branch when present, so it owns the
      // └─ corner; otherwise the corner falls to ARCHITECTURE.md / SUMMARY.md.
      if (architectureMdWritten) {
        console.log(`    ├─ ${opts.output}SUMMARY.md`);
        console.log(`    ${digestWritten ? '├─' : '└─'} ${opts.output}ARCHITECTURE.md`);
      } else {
        console.log(`    ${digestWritten ? '├─' : '└─'} ${opts.output}SUMMARY.md`);
      }
      if (digestWritten) {
        console.log(`    └─ ${opts.output}CODEBASE.md`);
        // Agent-onboarding tip — skipped when `openlore install` runs analyze
        // (install wires CLAUDE.md/.mcp.json/hooks itself, so this would contradict it).
        if (!options.embedded) {
          console.log('');
          console.log('  Agent setup (one-time):');
          console.log(`    Add to your CLAUDE.md or .clinerules:`);
          console.log('');
          console.log(`    @.openlore/analysis/CODEBASE.md`);
          console.log('');
          console.log('    ## openlore MCP tools — when to use them');
          console.log('    | Situation                                       | Tool                              |');
          console.log('    |-------------------------------------------------|-----------------------------------|');
          console.log("    | Don't know which file/function handles a concept | search_code                      |");
          console.log('    | Need call topology across many files            | get_subgraph / analyze_impact     |');
          console.log('    | Starting a new task on an unfamiliar codebase   | orient                            |');
          console.log('    | Planning where to add a feature                 | suggest_insertion_points          |');
          console.log('    | Checking if code still matches spec             | check_spec_drift                  |');
          console.log('    | Finding spec requirements by meaning            | search_specs                      |');
        }
      }
      // "Agent config files" is install's concern; skip it on the embedded path so a
      // user running `openlore install` never sees the contradictory "not generated" tip.
      if (!options.embedded) {
        console.log('');
        if (aiConfigsCreated.length > 0) {
          console.log('  Agent config files:');
          for (const { rel, created } of aiConfigsCreated) {
            const tag = created ? '(created)' : '(already exists)';
            console.log(`    ├─ ${rel}  ${tag}`);
          }
        } else {
          console.log('  Agent config files: not generated');
          console.log('    Tip: Re-run with --ai-configs to generate CLAUDE.md, .cursorrules, AGENTS.md, etc.');
        }
        console.log('');
      }

      // ========================================================================
      // PHASE 5: BUILD SEARCH INDEX
      // ========================================================================
      // Always build an index so orient() works. With embeddings when available,
      // otherwise (or with --no-embed) a keyword-only BM25 index.
      await runEmbedStep(
        rootPath,
        outputPath,
        openloreConfig,
        opts.force ?? false,
        result.artifacts.llmContext,
        keywordOnly,
        options.freshSpecDirectory === true,
        opts.include,
        opts.exclude,
        result.generationId,
      );

      // Duration
      const totalDuration = Date.now() - startTime;
      console.log(`  Total time: ${formatDuration(totalDuration)}`);
      console.log('');

      logger.success('Ready for generation!');
      logger.blank();
      if (!options.embedded) logger.info('Next step', "Run 'openlore generate' to create OpenSpec files");

    } catch (error) {
      logger.error(`Analysis failed: ${(error as Error).message}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exitCode = 1;
    }
  });

// ============================================================================
// EMBED STEP HELPER
// ============================================================================

/**
 * Build (or incrementally update) the vector index from a LLMContext.
 * When llmContext is null, reads llm-context.json from outputDir (cache path).
 * Non-fatal: prints a warning on failure without throwing.
 */
async function runEmbedStep(
  rootPath: string,
  outputPath: string,
  openloreConfig: OpenLoreConfig | null,
  force: boolean,
  llmContext: import('../../core/analyzer/artifact-generator.js').LLMContext | null,
  keywordOnly = false,
  freshSpecDirectory = false,
  include: string[] = [],
  exclude: string[] = [],
  generationId?: string,
): Promise<void> {
  const reporter = {
    report(event: IndexReport): void {
      const label = event.index === 'function' ? 'Function index' : event.index === 'text' ? 'Text line index' : 'Spec index';
      if (event.index === 'spec' && (event.status === 'warning' || event.status === 'skip')) {
        console.log(formatSpecIndexFailure(event.detail ?? 'unknown error', freshSpecDirectory));
      } else if (event.status === 'warning') console.log(`    ⚠ ${label} skipped: ${event.detail ?? 'unknown error'}`);
      else if (event.status === 'skip') console.log(`    ℹ ${label} skipped${event.detail ? `: ${event.detail}` : ''}`);
      else if (event.status === 'complete') console.log(`    ✓ ${label} built${event.detail ? ` ${event.detail}` : ''}`);
    },
  };
  await buildAnalysisIndexes({
    rootPath,
    outputPath,
    config: openloreConfig,
    force,
    llmContext,
    keywordOnly,
    freshSpecDirectory,
    include,
    exclude,
    generationId,
    reporter,
  });
}

export function formatSpecIndexFailure(message: string, freshSpecDirectory: boolean): string {
  if (message.includes('No OpenSpec specs directory')) {
    return '    ℹ No OpenSpec specs directory — spec index skipped';
  }
  if (freshSpecDirectory && message.includes('exists but contains no spec.md files')) {
    // change: align-first-run-ctas-with-repo-shape — install created this
    // empty directory, so it is expected first-run state rather than a warning.
    return '    ℹ No specs yet — optional: run "openlore generate" (requires an LLM provider; see "openlore features")';
  }
  return `    ⚠ Spec index skipped: ${message}`;
}
