/**
 * MCP tool handlers for codebase analysis:
 * analyze_codebase, get_architecture_overview, get_refactor_report,
 * get_duplicate_report, get_signatures, get_mapping, check_spec_drift,
 * get_function_skeleton, get_god_functions, get_route_inventory,
 * get_middleware_inventory, get_schema_inventory, get_ui_components.
 */

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

/**
 * A repo-relative path served to an agent, always POSIX-separated. Every other
 * structural path OpenLore emits (call-graph node ids, spec anchors, orient
 * results) uses `/` regardless of host OS; `relative()` alone would hand a
 * Windows agent `src\a.ts` next to an `id` of `src/a.ts::fn` it cannot match.
 */
function servedRelPath(fromDir: string, target: string): string {
  return relative(fromDir, target).split(sep).join('/');
}
import { spawnGitSync } from '../../../utils/git-exec.js';
import { mkdtempSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { escapeRegExp } from '../../../utils/misc.js';
import { readFileConfined, readFileConfinedWithStat } from '../../../utils/path-confinement.js';
import { readAnalysisArtifactOrPartial, readDependencyGraphOrPartial } from './artifact-cache.js';
import {
  DEFAULT_MAX_FILES,
  DEFAULT_DRIFT_MAX_FILES,
  TOP_REFACTOR_ISSUES_LIMIT,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_ANALYSIS_REL_PATH,
  OPENSPEC_DIR,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_REPO_STRUCTURE,
  ARTIFACT_ROUTE_INVENTORY,
  ARTIFACT_MIDDLEWARE_INVENTORY,
  ARTIFACT_SCHEMA_INVENTORY,
  ARTIFACT_UI_INVENTORY,
  ARTIFACT_ENV_INVENTORY,
  ARTIFACT_EXTERNAL_PACKAGES,
  TRANSITIVE_SCORE_MAX,
  REPO_CONTENT_PROVENANCE,
} from '../../../constants.js';
import { runAnalysis } from '../../../cli/commands/analyze.js';
import { acquireAnalysisOwnership } from '../../runtime/analysis-ownership.js';
import { analyzeForRefactoring } from '../../analyzer/refactor-analyzer.js';
import { formatSignatureMaps } from '../../analyzer/signature-extractor.js';
import { getSkeletonContent, isSkeletonWorthIncluding } from '../../analyzer/code-shaper.js';
import { detectLanguage } from '../../analyzer/language-detection.js';
import { cfgSupportsLanguage, variableSliceLines, type FunctionCfg } from '../../analyzer/cfg.js';
import type { EdgeConfidence } from '../../analyzer/call-graph-types.js';
import { buildArchitectureOverview } from '../../analyzer/architecture-writer.js';
import { buildDomainEvidence } from '../../generator/domain-evidence.js';
import type { LLMContext, RepoStructure } from '../../analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../../analyzer/dependency-graph.js';
import {
  isGitRepository,
  getChangedFiles,
  buildSpecMap,
  buildADRMap,
  detectDrift,
  validateGitRef,
} from '../../drift/index.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { validateDirectory, readCachedContext, diagnoseIndexUnservable, isCacheFresh, safeJoin, safeOpenspecDir } from './utils.js';
import { buildWeightedAdjacency, weightedBfs } from './graph.js';
import { personalizedPageRank } from '../../analyzer/personalized-pagerank.js';
import { applyTokenBudget, normalizeResponseFormat, truncationReceipt, summarizeListInventory, type ResponseFormat } from './progressive.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import { mappingViewOf, resolveSpecLinkIndex } from '../../generator/spec-link-service.js';
import { openloreAudit } from '../../../api/audit.js';
import type { DriftResult } from '../../../types/index.js';
import { resolveFileFreshness } from './freshness.js';

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Run a full static analysis pass on `directory` and return a compact summary.
 */
export async function handleAnalyzeCodebase(
  directory: string,
  force: boolean
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const outputPath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  if (!force && await isCacheFresh(absDir)) {
    const ctx = await readCachedContext(absDir);
    if (ctx) {
      const cg = ctx.callGraph;
      const topRefactorIssues = cg
        ? analyzeForRefactoring(cg as SerializedCallGraph).priorities.slice(0, TOP_REFACTOR_ISSUES_LIMIT).map(e => ({
            function: e.function, file: e.file, issues: e.issues, priorityScore: e.priorityScore,
          }))
        : [];
      return {
        cached: true,
        callGraph: cg
          ? { totalNodes: cg.stats.totalNodes, totalEdges: cg.stats.totalEdges,
              hubs: cg.hubFunctions.length, entryPoints: cg.entryPoints.length,
              layerViolations: cg.layerViolations.length }
          : null,
        topRefactorIssues,
        analysisPath: OPENLORE_ANALYSIS_REL_PATH,
      };
    }
  }

  // Repository-scoped single flight, shared with the CLI, the daemon, and Pi: an
  // MCP-triggered analyze must not duplicate one a user already started (change
  // `harden-spec-workflow-lifecycle`). A tool call cannot block on someone else's
  // run, so it reports the owner instead of waiting.
  const ownership = await acquireAnalysisOwnership(absDir, outputPath);
  if (ownership.state === 'in-progress') {
    return {
      status: 'ANALYSIS_IN_PROGRESS',
      message: 'Another process already owns a full analysis of this repository. No duplicate analysis was started.',
      owner: ownership.owner,
      elapsedMs: ownership.elapsedMs,
      heartbeatAgeMs: ownership.heartbeatAgeMs,
      remediation: 'Wait for the owner to publish, or run `openlore analyze --wait` to follow it.',
      analysisPath: OPENLORE_ANALYSIS_REL_PATH,
    };
  }

  let result;
  try {
    result = await runAnalysis(absDir, outputPath, {
      maxFiles: DEFAULT_MAX_FILES,
      include: [],
      exclude: [],
      ownership,
    });
  } finally {
    await ownership.release();
  }

  const { artifacts, repoMap, depGraph } = result;
  const rs = artifacts.repoStructure;
  const cg = artifacts.llmContext.callGraph;

  let topRefactorIssues: unknown[] = [];
  if (cg) {
    const report = analyzeForRefactoring(cg as SerializedCallGraph);
    topRefactorIssues = report.priorities.slice(0, TOP_REFACTOR_ISSUES_LIMIT).map(e => ({
      function: e.function,
      file: e.file,
      issues: e.issues,
      priorityScore: e.priorityScore,
    }));
  }

  return {
    projectName: rs.projectName,
    projectType: rs.projectType,
    frameworks: rs.frameworks,
    architecture: rs.architecture.pattern,
    stats: {
      files: repoMap.summary.totalFiles,
      analyzedFiles: repoMap.summary.analyzedFiles,
      depNodes: depGraph.statistics.nodeCount,
      depEdges: depGraph.statistics.edgeCount,
      importEdges: depGraph.statistics.importEdgeCount,
      httpCrossEdges: depGraph.statistics.httpEdgeCount,
      cycles: depGraph.statistics.cycleCount,
    },
    callGraph: cg
      ? {
          totalNodes: cg.stats.totalNodes,
          totalEdges: cg.stats.totalEdges,
          hubs: cg.hubFunctions.length,
          entryPoints: cg.entryPoints.length,
          layerViolations: cg.layerViolations.length,
        }
      : null,
    domains: rs.domains.map((d: { name: string }) => d.name),
    topRefactorIssues,
    analysisPath: OPENLORE_ANALYSIS_REL_PATH,
  };
}

/**
 * High-level architecture map: clusters, cross-cluster deps, entry points, hubs.
 */
export async function handleGetArchitectureOverview(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);

  const analysisDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  // Answered from the partial first-run index when no published dependency graph exists yet
  // (change: refine-first-run-partial-serving). Without this the guard below saw a non-null
  // partial CONTEXT and a null graph, fell through, and built an overview of zeroes — a
  // fabricated negative that read as a complete answer, with the real graph sitting unread in
  // the partial index. Reading it is both the fix and the feature.
  const depGraph = await readDependencyGraphOrPartial<
    import('../../analyzer/dependency-graph.js').DependencyGraphResult
  >(analysisDir, ARTIFACT_DEPENDENCY_GRAPH);

  const ctx = await readCachedContext(absDir);

  if (!depGraph && !ctx) {
    // Name WHY rather than always reporting absence: an index that failed its integrity
    // check is a different situation from one that was never built, and only one of them
    // is fixed by "run analyze first" without anything else being wrong.
    const { reason, message } = await diagnoseIndexUnservable(absDir);
    return { error: message, indexUnservable: reason };
  }

  const overview = buildArchitectureOverview(depGraph, ctx, absDir);
  let domainEvidence: unknown[] = [];
  if (ctx) {
    try {
      const raw = await readAnalysisArtifactOrPartial(analysisDir, ARTIFACT_REPO_STRUCTURE);
      if (raw !== null) domainEvidence = buildDomainEvidence(JSON.parse(raw) as RepoStructure, ctx);
    } catch { /* the architectural summary remains usable when this artifact is absent */ }
  }
  if (ctx?.partial) {
    // Hubs, entry points and every cluster's role are derived from the call graph, which a
    // partial index does not have. Reported as `[]`, `0` and "internal" they read as positive
    // architectural claims — "this repo has no hubs", "every cluster is an implementation
    // detail". Omitted, they read as what they are: not known yet. The dependency-graph half
    // above is real and is served.
    return {
      summary: {
        totalFiles: overview.summary.totalFiles,
        totalClusters: overview.summary.totalClusters,
        totalEdges: overview.summary.totalEdges,
        cycles: overview.summary.cycles,
      },
      clusters: overview.clusters.map(cluster => ({
        id: cluster.id,
        name: cluster.name,
        fileCount: cluster.fileCount,
        dependsOn: cluster.dependsOn,
      })),
      omitted: ['globalEntryPoints', 'criticalHubs', 'layerViolations', 'cluster roles',
        'per-cluster hub and entry-point counts'],
      omittedBecause: 'they are derived from the call graph, which this first build has not '
        + 'produced yet; reporting them as empty would state something the index cannot know',
    };
  }

  return {
    summary: overview.summary,
    clusters: overview.clusters,
    globalEntryPoints: overview.globalEntryPoints,
    criticalHubs: overview.criticalHubs,
    domainEvidence,
  };
}

/**
 * Return a prioritized refactor report from cached analysis.
 */
export async function handleGetRefactorReport(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) {
    const { reason, message } = await diagnoseIndexUnservable(absDir);
    return { error: message, indexUnservable: reason };
  }
  if (!ctx.callGraph) return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };

  return analyzeForRefactoring(ctx.callGraph as SerializedCallGraph);
}

/** How many clone groups the concise duplicate report keeps before truncating. */
const DUPLICATE_REPORT_CONCISE_GROUPS = 10;

/**
 * Read the cached duplicate detection result.
 *
 * `responseFormat` (default `concise`) controls verbosity
 * (ConciseByDefaultDetailedOnRequest): a whole-repo clone report can be large, so
 * the default returns the stats plus the top clone groups (ranked by line count)
 * with a truncation receipt; `detailed` returns the full report unchanged.
 */
export async function handleGetDuplicateReport(
  directory: string,
  responseFormat: ResponseFormat = 'concise',
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const cachePath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, 'duplicates.json');

  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf-8');
  } catch {
    return {
      error:
        'No duplicate report found. Run analyze_codebase first ' +
        '(duplicates.json is generated during analysis).',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'Duplicate report cache is corrupted. Re-run analyze_codebase.' };
  }

  const format = normalizeResponseFormat(responseFormat);
  if (format === 'detailed') return parsed;

  // Concise (default): summarize the clone groups. Fail-soft — if the cache is not
  // the expected { cloneGroups, stats } shape, return it unchanged rather than drop data.
  const obj = parsed as { cloneGroups?: unknown; stats?: unknown };
  if (!Array.isArray(obj.cloneGroups)) return parsed;

  const groups = obj.cloneGroups as Array<{
    type?: string;
    similarity?: number;
    lineCount?: number;
    instances?: Array<{ file?: string; name?: string }>;
  }>;
  const topGroups = groups.slice(0, DUPLICATE_REPORT_CONCISE_GROUPS).map((g) => ({
    type: g.type,
    similarity: g.similarity,
    lineCount: g.lineCount,
    instanceCount: Array.isArray(g.instances) ? g.instances.length : 0,
    files: Array.isArray(g.instances) ? g.instances.map((i) => i.file).filter(Boolean) : [],
  }));
  const receipt = truncationReceipt(
    groups.length - topGroups.length,
    'call get_duplicate_report with responseFormat:"detailed" for the full report',
  );
  return {
    responseFormat: 'concise',
    stats: obj.stats,
    totalCloneGroups: groups.length,
    topGroups,
    ...(receipt ? { truncation: receipt } : {}),
  };
}

/**
 * Return compact function and class signatures for files in the project.
 */
export async function handleGetSignatures(directory: string, filePattern?: string): Promise<string> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) return 'No analysis found. Run analyze_codebase first.';
  if (!ctx.signatures || ctx.signatures.length === 0) {
    return 'No signatures available in cached analysis. Re-run analyze_codebase.';
  }

  const filtered = filePattern
    ? ctx.signatures.filter((s: { path: string }) => s.path.includes(filePattern))
    : ctx.signatures;

  if (filtered.length === 0) {
    return `No files matching pattern "${filePattern}" found in analysis.`;
  }

  const chunks = formatSignatureMaps(filtered);
  return chunks.join('\n\n---\n\n');
}

/**
 * Return the requirement→code links of the deterministic spec link index.
 *
 * Read-only: the index is served from the persisted cache when it is current and
 * derived in memory otherwise, and this path never writes the cache back. An
 * unusable INPUT (no analysis, no specs) is the only error — an absent or legacy
 * `mapping.json` is not, because the links can always be re-derived.
 */
export async function handleGetMapping(
  directory: string,
  domain?: string,
  orphansOnly?: boolean
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const config = await readOpenLoreConfig(absDir).catch(() => null);
  const resolution = await resolveSpecLinkIndex({
    rootPath: absDir,
    openspecPath: config?.openspecPath ?? OPENSPEC_DIR,
    persist: false,
  });
  return mappingViewOf(resolution, domain, orphansOnly);
}

/**
 * Run spec-drift detection in static mode (no LLM).
 */
export async function handleCheckSpecDrift(
  directory: string,
  base = 'auto',
  files: string[] = [],
  domains: string[] = [],
  failOn: 'error' | 'warning' | 'info' = 'warning',
  maxFiles = DEFAULT_DRIFT_MAX_FILES
): Promise<DriftResult | { error: string }> {
  const absDir = await validateDirectory(directory);

  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    return { error: 'maxFiles must be a positive integer.' };
  }

  if (!(await isGitRepository(absDir))) {
    return { error: 'Not a git repository. Drift detection requires git.' };
  }

  const openloreConfig = await readOpenLoreConfig(absDir);
  if (!openloreConfig) {
    return { error: 'No openlore configuration found. Run "openlore init" first.' };
  }

  // Confine the configured openspec dir to the root (config is untrusted input).
  const openspecPath = safeOpenspecDir(absDir, openloreConfig.openspecPath);
  const specsPath = join(openspecPath, 'specs');
  try {
    await stat(specsPath);
  } catch {
    return { error: 'No specs found. Run "openlore generate" first.' };
  }

  const startTime = Date.now();

  const gitResult = await getChangedFiles({
    rootPath: absDir,
    baseRef: base,
    pathFilter: files.length > 0 ? files : undefined,
    includeUnstaged: true,
  });

  if (gitResult.files.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      baseRef: gitResult.resolvedBase,
      totalChangedFiles: 0,
      analyzedFiles: 0,
      filesOmitted: 0,
      specRelevantFiles: 0,
      issues: [],
      summary: { gaps: 0, stale: 0, uncovered: 0, orphanedSpecs: 0, adrGaps: 0, adrOrphaned: 0, memoryDrifted: 0, memoryOrphaned: 0, memoryOutOfScope: 0, total: 0 },
      hasDrift: false,
      duration: Date.now() - startTime,
      mode: 'static',
    };
  }

  const actualChangedFiles = gitResult.files.length;
  if (gitResult.files.length > maxFiles) {
    gitResult.files = gitResult.files.slice(0, maxFiles);
  }

  const repoStructurePath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_REPO_STRUCTURE);
  let hasRepoStructure = false;
  try {
    await stat(repoStructurePath);
    hasRepoStructure = true;
  } catch { /* no prior analysis */ }

  const specMap = await buildSpecMap({
    rootPath: absDir,
    openspecPath,
    repoStructurePath: hasRepoStructure ? repoStructurePath : undefined,
  });

  const adrMap = await buildADRMap({
    rootPath: absDir,
    openspecPath,
    repoStructurePath: hasRepoStructure ? repoStructurePath : undefined,
  });

  const result = await detectDrift({
    rootPath: absDir,
    specMap,
    changedFiles: gitResult.files,
    failOn,
    domainFilter: domains.length > 0 ? domains : undefined,
    openspecRelPath: openloreConfig.openspecPath ?? OPENSPEC_DIR,
    baseRef: gitResult.resolvedBase,
    adrMap: adrMap ?? undefined,
  });

  result.baseRef = gitResult.resolvedBase;
  result.totalChangedFiles = actualChangedFiles;
  result.analyzedFiles = gitResult.files.length;
  result.filesOmitted = actualChangedFiles - gitResult.files.length;

  return result;
}

/**
 * Return a noise-stripped skeleton of a source file.
 */
export async function handleGetFunctionSkeleton(
  directory: string,
  filePath: string
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const absFile = safeJoin(absDir, filePath);

  let source: string;
  try {
    source = await readFile(absFile, 'utf-8');
  } catch {
    return { error: `File not found: ${filePath}` };
  }

  const language = detectLanguage(filePath);
  const skeleton = getSkeletonContent(source, language);
  const worthIncluding = isSkeletonWorthIncluding(source, skeleton);

  return {
    filePath,
    language,
    originalLines: source.split('\n').length,
    skeletonLines: skeleton.split('\n').length,
    reductionPct: Math.round((1 - skeleton.length / source.length) * 100),
    worthIncluding,
    skeleton,
    provenance: REPO_CONTENT_PROVENANCE,
  };
}

// Note: handleGetGodFunctions lives in graph.ts (alongside other call-graph tools)

/**
 * Extract the exact source text of a named function using the cached call graph.
 *
 * Uses the startIndex/endIndex byte offsets recorded in llm-context.json to
 * slice the source file — no extra tree-sitter parsing needed at query time.
 * Falls back to a line-number scan when the call graph is unavailable.
 */
export async function handleGetFunctionBody(
  directory: string,
  filePath: string,
  functionName: string,
  focus?: string,
  focusKind?: 'variable' | 'callee',
): Promise<unknown> {
  if (focus === undefined) {
    if (focusKind !== undefined) return { error: 'focusKind requires focus.' };
    return handleGetFunctionBodyUnfocused(directory, filePath, functionName);
  }
  if (typeof focus !== 'string' || focus.trim().length === 0) {
    return { error: 'focus must be a non-empty variable or callee name when provided.' };
  }
  if (focus.length > 200) return { error: 'focus must be at most 200 characters.' };
  if (focusKind === undefined) return { error: 'focus requires an explicit focusKind of "variable" or "callee".' };
  if (focusKind !== undefined && focusKind !== 'variable' && focusKind !== 'callee') {
    return { error: 'focusKind must be "variable" or "callee" when provided.' };
  }
  return handleGetFunctionBodyFocused(directory, filePath, functionName, focus.trim(), focusKind);
}

async function handleGetFunctionBodyUnfocused(
  directory: string,
  filePath: string,
  functionName: string,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const absFile = safeJoin(absDir, filePath);

  let source: string;
  try {
    source = await readFile(absFile, 'utf-8');
  } catch {
    return { error: `File not found: ${filePath}` };
  }

  // Try call graph first: exact byte-range slice, no ambiguity.
  //
  // Read through the shared context cache, not a bare readFile+JSON.parse: this is a
  // single-symbol tool, and parsing the whole multi-megabyte artifact per call — outside
  // the cache, so without its size ceiling or generation check — made it as expensive as
  // get_call_graph. (change: optimize-serving-hot-path-caches)
  try {
    const ctx = await readCachedContext(absDir);
    if (ctx?.callGraph?.nodes) {
      const node = ctx.callGraph.nodes.find(
        n => n.name === functionName && (n.filePath === filePath || n.filePath.endsWith('/' + filePath.replace(/^\//, '')))
      );
      if (node && node.startIndex < node.endIndex) {
        const body = source.slice(node.startIndex, node.endIndex);
        return {
          functionName,
          filePath,
          language: node.language,
          className: node.className ?? null,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          body,
          lineCount: body.split('\n').length,
          provenance: REPO_CONTENT_PROVENANCE,
        };
      }
    }
  } catch { /* no call graph — fall through to line-scan */ }

  // Fallback: find the function by scanning for its declaration line
  const lines = source.split('\n');
  // `functionName` is a caller-supplied MCP argument: escape it so a value containing
  // regex metacharacters cannot change what this matches or backtrack pathologically.
  const declPattern = new RegExp(`\\b${escapeRegExp(functionName)}\\s*[(<]`);
  const startLine = lines.findIndex(l => declPattern.test(l));
  if (startLine === -1) {
    return { error: `Function "${functionName}" not found in ${filePath}. Run analyze_codebase first for exact byte-range extraction.` };
  }

  // Collect lines until matching brace depth returns to 0 (works for C-style languages)
  let depth = 0;
  let endLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth > 0 || i === startLine) { endLine = i; continue; }
    endLine = i;
    break;
  }

  const body = lines.slice(startLine, endLine + 1).join('\n');
  return {
    functionName,
    filePath,
    language: detectLanguage(filePath),
    className: null,
    startLine: startLine + 1,
    endLine: endLine + 1,
    body,
    lineCount: endLine - startLine + 1,
    note: 'Extracted via line scan (no call graph available). Run analyze_codebase for exact extraction.',
    provenance: REPO_CONTENT_PROVENANCE,
  };
}

interface FocusNode {
  id: string;
  name: string;
  filePath: string;
  language: string;
  className?: string;
  startIndex: number;
  endIndex: number;
  startLine?: number;
  endLine?: number;
}

interface FocusSliceAccumulator {
  dataFlowPrecision?: 'exact' | 'may';
  kinds: Set<'definition' | 'use'>;
  callConfidence: Set<EdgeConfidence>;
  synthesizedBy: Set<string>;
  metadataTruncated: boolean;
}

const FOCUS_EVIDENCE_LIMIT = 50;
const FOCUS_OVERLAY_EDGE_LIMIT = 20_000;
const EDGE_CONFIDENCES = new Set<EdgeConfidence>([
  'self_cls', 'type_inference', 'import', 're_export', 'http_endpoint',
  'same_file', 'name_only', 'type_name', 'synthesized', 'external',
]);

function isFocusNode(value: unknown): value is FocusNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  return typeof node.id === 'string' && node.id.length > 0 && node.id.length <= 4_096
    && typeof node.name === 'string' && node.name.length <= 200
    && typeof node.filePath === 'string' && node.filePath.length <= 4_096
    && typeof node.language === 'string' && node.language.length <= 100
    && (node.className === undefined || (typeof node.className === 'string' && node.className.length <= 200))
    && Number.isSafeInteger(node.startIndex) && Number.isSafeInteger(node.endIndex);
}

function isUsableFocusCfg(value: unknown): value is FunctionCfg {
  if (!value || typeof value !== 'object') return false;
  const cfg = value as Partial<FunctionCfg>;
  if (!Array.isArray(cfg.blocks) || cfg.blocks.length > FOCUS_OVERLAY_EDGE_LIMIT
    || !Array.isArray(cfg.edges) || cfg.edges.length > FOCUS_OVERLAY_EDGE_LIMIT
    || !Array.isArray(cfg.params) || !Array.isArray(cfg.defUse)
    || cfg.params.length > FOCUS_OVERLAY_EDGE_LIMIT
    || cfg.defUse.length > FOCUS_OVERLAY_EDGE_LIMIT
    || !Number.isInteger(cfg.paramLine) || (cfg.paramLine ?? 0) < 1) return false;
  return cfg.params.every(param => typeof param === 'string' && param.length <= 200)
    && cfg.defUse.every(edge => !!edge && typeof edge.variable === 'string' && edge.variable.length <= 200
      && Number.isInteger(edge.defLine) && edge.defLine > 0
      && Number.isInteger(edge.useLine) && edge.useLine > 0
      && (edge.precision === 'exact' || edge.precision === 'may'));
}

function currentSourceFallback(source: string, filePath: string, functionName: string): Record<string, unknown> {
  const lines = source.split('\n');
  const declaration = new RegExp(`\\b${escapeRegExp(functionName)}\\s*[(<]`);
  const start = lines.findIndex(line => declaration.test(line));
  if (start < 0) return { functionName, filePath };
  let depth = 0;
  let end = start;
  for (let index = start; index < lines.length; index++) {
    for (const character of lines[index]) {
      if (character === '{') depth++;
      else if (character === '}') depth--;
    }
    end = index;
    if (index > start && depth <= 0) break;
  }
  const body = lines.slice(start, end + 1).join('\n');
  return {
    functionName,
    filePath,
    language: detectLanguage(filePath),
    className: null,
    startLine: start + 1,
    endLine: end + 1,
    body,
    lineCount: end - start + 1,
    note: 'Extracted from the current confined source because indexed focus evidence was unavailable.',
    provenance: REPO_CONTENT_PROVENANCE,
  };
}

async function handleGetFunctionBodyFocused(
  directory: string,
  filePath: string,
  functionName: string,
  focus: string,
  focusKind?: 'variable' | 'callee',
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const normalizedFile = relative(absDir, safeJoin(absDir, filePath)).replaceAll('\\', '/');
  let confined: Awaited<ReturnType<typeof readFileConfinedWithStat>>;
  try {
    confined = await readFileConfinedWithStat(absDir, normalizedFile);
  } catch {
    return { error: `File not found or changed during safe access: ${filePath}` };
  }
  const source = confined.content;
  const fallback = currentSourceFallback(source, normalizedFile, functionName);
  const refuse = (reason: string, message: string): Record<string, unknown> => ({
    functionName,
    filePath: normalizedFile,
    focus,
    sliceUnavailable: { reason, message },
    provenance: REPO_CONTENT_PROVENANCE,
  });
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph || !ctx.edgeStore) {
    return {
      ...fallback,
      focus,
      sliceUnavailable: {
        reason: 'index-unavailable',
        message: 'Focused slicing requires the current call graph and CFG edge store. Re-run analyze_codebase.',
      },
    };
  }
  if (ctx.integrity && ctx.integrity.verdict !== 'healthy') {
    return refuse('index-integrity-degraded', 'Focused evidence requires a healthy, generation-matched analysis store. Re-run analyze_codebase.');
  }

  const nodes = Array.isArray(ctx.callGraph.nodes) ? ctx.callGraph.nodes.filter(isFocusNode) : [];
  const requestedSuffix = normalizedFile.replace(/^\/+/, '');
  const candidates = nodes.filter(node => {
    const indexedFile = node.filePath.replaceAll('\\', '/');
    return node.name === functionName && indexedFile === requestedSuffix;
  });
  if (candidates.length !== 1) {
    return {
      verdict: candidates.length === 0 ? 'not-found' : 'ambiguous',
      functionName,
      filePath: normalizedFile,
      focus,
      sliceUnavailable: {
        reason: candidates.length === 0 ? 'symbol-not-indexed' : 'ambiguous-symbol',
        candidates: candidates.slice(0, 10).map(node => ({
          id: node.id,
          startLine: Number.isInteger(node.startLine) ? node.startLine : undefined,
        })),
      },
    };
  }

  const node = candidates[0];

  const currentFileHash = createHash('sha256').update(source).digest('hex');
  let baselineFileHash: string | null;
  try {
    baselineFileHash = ctx.edgeStore.getFileHash(node.filePath);
  } catch {
    return refuse('artifact-invalid', 'The persisted file freshness record could not be read safely.');
  }
  const artifactMtimeMs = ctx.artifactMtimeMs ?? 0;
  if (resolveFileFreshness({ baselineFileHash, currentFileHash, sourceMtimeMs: confined.stat.mtimeMs, artifactMtimeMs }) === 'stale') {
    return {
      ...refuse('stale-index', 'The source changed after analysis, so indexed line evidence is not safe to serve. Re-run analyze_codebase.'),
    };
  }

  if (node.startIndex < 0 || node.endIndex <= node.startIndex || node.endIndex > source.length) {
    return refuse('artifact-invalid', 'The indexed function span is invalid.');
  }
  const exactBody = source.slice(node.startIndex, node.endIndex);
  const functionStartLine = source.slice(0, node.startIndex).split('\n').length;
  const functionEndLine = functionStartLine + exactBody.split('\n').length - 1;
  const identity = {
    functionName,
    filePath: normalizedFile,
    language: node.language,
    className: node.className ?? null,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startLine: functionStartLine,
    endLine: functionEndLine,
  };
  const indexedFallback = {
    ...identity,
    body: exactBody,
    lineCount: exactBody.split('\n').length,
    provenance: REPO_CONTENT_PROVENANCE,
  };

  let rawCfg: unknown;
  let rawCallEdges: unknown;
  try {
    rawCfg = ctx.edgeStore.getCfg(node.id);
    rawCallEdges = ctx.edgeStore.getCallees(node.id);
  } catch {
    return { ...indexedFallback, focus, sliceUnavailable: { reason: 'overlay-unavailable' } };
  }
  if (Array.isArray(rawCallEdges) && rawCallEdges.length > FOCUS_OVERLAY_EDGE_LIMIT) {
    return refuse('artifact-invalid', 'The call overlay exceeds the focused evidence bound.');
  }
  if (!Array.isArray(rawCallEdges)) {
    return refuse('artifact-invalid', 'The persisted call overlay has an invalid shape.');
  }
  const cfg = isUsableFocusCfg(rawCfg) ? rawCfg : null;
  const malformedMatch = rawCallEdges.some(edge => {
    if (!edge || typeof edge !== 'object') return false;
    const candidate = edge as Record<string, unknown>;
    if (candidate.calleeName !== focus) return false;
    return candidate.callerId !== node.id
      || typeof candidate.calleeName !== 'string' || candidate.calleeName.length > 200
      || !EDGE_CONFIDENCES.has(candidate.confidence as EdgeConfidence)
      || (candidate.synthesizedBy !== undefined
        && (typeof candidate.synthesizedBy !== 'string' || candidate.synthesizedBy.length > 200));
  });
  if (malformedMatch) return refuse('artifact-invalid', 'A matching persisted call edge has invalid provenance.');
  const matchingCallEdges = rawCallEdges.filter(edge => {
    if (!edge || typeof edge !== 'object') return false;
    const candidate = edge as Record<string, unknown>;
    return candidate.callerId === node.id && candidate.calleeName === focus
      && EDGE_CONFIDENCES.has(candidate.confidence as EdgeConfidence)
      && (candidate.synthesizedBy === undefined
        || (typeof candidate.synthesizedBy === 'string' && candidate.synthesizedBy.length <= 200));
  }) as Array<{ line?: number; confidence: EdgeConfidence; synthesizedBy?: string }>;
  const callEdges = matchingCallEdges.filter((edge): edge is { line: number; confidence: EdgeConfidence; synthesizedBy?: string } =>
    Number.isInteger(edge.line) && (edge.line ?? 0) > 0);
  const hasVariable = !!cfg && (cfg.params.includes(focus) || cfg.defUse.some(edge => edge.variable === focus));
  const hasCallee = matchingCallEdges.length > 0;
  const selectedKind = focusKind;

  if (selectedKind === 'variable' && !cfgSupportsLanguage(node.language)) {
    return {
      ...indexedFallback,
      focus,
      focusKind: selectedKind,
      sliceUnavailable: {
        reason: 'unsupported-language',
        language: node.language,
        message: `Variable focus requires CFG-overlay support; ${node.language} is outside that boundary.`,
      },
    };
  }
  if (selectedKind === 'variable' && !cfg) {
    if (rawCfg != null) return refuse('artifact-invalid', 'The persisted CFG overlay is malformed or exceeds the focused evidence bound.');
    return { ...indexedFallback, focus, focusKind: selectedKind, sliceUnavailable: { reason: 'overlay-unavailable' } };
  }

  const variableLines = selectedKind === 'variable' && cfg ? variableSliceLines(cfg, focus) : [];
  const byLine = new Map<number, FocusSliceAccumulator>();
  const addVariable = (line: number, precision: 'exact' | 'may', kind: 'definition' | 'use'): void => {
    const current = byLine.get(line) ?? { kinds: new Set(), callConfidence: new Set(), synthesizedBy: new Set(), metadataTruncated: false };
    if (!current.dataFlowPrecision || precision === 'may') current.dataFlowPrecision = precision;
    current.kinds.add(kind);
    byLine.set(line, current);
  };
  for (const evidence of variableLines) {
    for (const role of evidence.roles) addVariable(evidence.line, evidence.precision, role);
  }
  if (selectedKind === 'callee') {
    for (const edge of callEdges) {
      const current = byLine.get(edge.line) ?? { kinds: new Set(), callConfidence: new Set(), synthesizedBy: new Set(), metadataTruncated: false };
      current.callConfidence.add(edge.confidence);
      if (edge.synthesizedBy) {
        if (current.synthesizedBy.size < 8) current.synthesizedBy.add(edge.synthesizedBy);
        else if (!current.synthesizedBy.has(edge.synthesizedBy)) current.metadataTruncated = true;
      }
      byLine.set(edge.line, current);
    }
  }

  if (byLine.size === 0) {
    const tracked = [...new Set([
      ...(cfg?.params ?? []),
      ...(cfg?.defUse.map(edge => edge.variable) ?? []),
      ...(Array.isArray(rawCallEdges) ? rawCallEdges.flatMap(edge =>
        edge && typeof edge === 'object'
          && typeof (edge as Record<string, unknown>).calleeName === 'string'
          && ((edge as Record<string, unknown>).calleeName as string).length <= 200
          ? [(edge as Record<string, unknown>).calleeName as string] : []) : []),
    ])].sort().slice(0, 20);
    return {
      verdict: 'not-found',
      functionName,
      filePath: normalizedFile,
      focus,
      sliceUnavailable: {
        reason: selectedKind === 'callee' && hasCallee
          ? 'call-site-line-unavailable'
          : hasVariable ? 'focus-has-no-evidence' : 'focus-not-tracked',
        candidates: tracked,
      },
    };
  }

  const lines = source.split('\n');
  const evidenceLines = [...byLine.keys()].sort((a, b) => a - b);
  if (evidenceLines.some(line => line < functionStartLine || line > functionEndLine || line > lines.length)) {
    return {
      ...refuse('artifact-invalid', 'Stored line evidence falls outside the selected current function span. Re-run analyze_codebase.'),
    };
  }

  const selectedLines = evidenceLines.slice(0, FOCUS_EVIDENCE_LIMIT);
  return {
    ...identity,
    focus,
    focusKind: selectedKind,
    sliceScope: selectedKind === 'variable' ? 'stored-direct-def-use' : 'stored-call-sites',
    variableScope: variableLines.length > 0 ? 'same-spelling variables within this function' : undefined,
    completeFor: selectedKind === 'variable'
      ? 'persisted direct same-spelling def/use evidence'
      : 'persisted call-site evidence with usable lines',
    evidenceReceipt: {
      total: evidenceLines.length,
      returned: selectedLines.length,
      omitted: evidenceLines.length - selectedLines.length,
      limit: FOCUS_EVIDENCE_LIMIT,
      truncated: evidenceLines.length > selectedLines.length,
    },
    slice: selectedLines.map(line => {
      const evidence = byLine.get(line)!;
      const confidence = [...evidence.callConfidence].sort();
      const synthesizedBy = [...evidence.synthesizedBy].sort();
      return {
        line,
        text: lines[line - 1],
        ...(evidence.dataFlowPrecision ? { dataFlowPrecision: evidence.dataFlowPrecision } : {}),
        ...(evidence.kinds.size > 0 ? { roles: [...evidence.kinds].sort() } : {}),
        ...(confidence.length > 0 ? { callConfidence: confidence } : {}),
        ...(synthesizedBy.length > 0 ? { synthesizedBy } : {}),
        ...(evidence.metadataTruncated ? { metadataTruncated: true } : {}),
      };
    }),
    lineCount: selectedLines.length,
    provenance: REPO_CONTENT_PROVENANCE,
  };
}

// ============================================================================
// ROUTE INVENTORY HANDLER
// ============================================================================

/**
 * Return the pre-computed route inventory from the last analysis run.
 * Falls back to re-computing from source files if the artifact is missing.
 */
export async function handleGetRouteInventory(
  directory: string
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ROUTE_INVENTORY);

  // Try reading cached artifact first
  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const inventory = JSON.parse(raw);
    // Untrusted artifact: only serve it if the top-level shape is a plain object;
    // a malformed/poisoned artifact falls through to live re-extraction instead of
    // being spread into the result (mcp-security: fail closed, no attacker shape).
    if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory)) {
      throw new Error('malformed cached route inventory');
    }
    return { cached: true, ...(inventory as Record<string, unknown>) };
  } catch {
    // Artifact not present or malformed — run live extraction
  }

  const { buildRouteInventory } = await import('../../analyzer/http-route-parser.js');
  const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
  const { readOpenLoreConfig } = await import('../config-manager.js');

  const openloreConfig = await readOpenLoreConfig(absDir);
  const configExclude = openloreConfig?.analysis.excludePatterns ?? [];

  const mapper = new RepositoryMapper(absDir, {
    maxFiles: DEFAULT_MAX_FILES,
    excludePatterns: configExclude.length > 0 ? configExclude : undefined,
  });
  const repoMap = await mapper.map();
  const filePaths = repoMap.allFiles.map(f => f.path);

  const inventory = await buildRouteInventory(filePaths, absDir);
  return { cached: false, ...inventory };
}

// ============================================================================
// MIDDLEWARE INVENTORY HANDLER
// ============================================================================

/**
 * Return the pre-computed middleware inventory from the last analysis run.
 * Falls back to re-computing from source files if the artifact is missing.
 */
export async function handleGetMiddlewareInventory(
  directory: string,
  responseFormat: ResponseFormat = 'concise',
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_MIDDLEWARE_INVENTORY);
  const hint = 'call get_middleware_inventory with responseFormat:"detailed" for the full inventory';

  // Try reading cached artifact first
  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const inventory = JSON.parse(raw);
    if (!Array.isArray(inventory)) throw new Error('malformed cached middleware inventory');
    return summarizeListInventory({ cached: true, total: inventory.length, entries: inventory }, 'entries', responseFormat, hint);
  } catch {
    // Artifact not present or malformed — run live extraction
  }

  const { extractMiddleware } = await import('../../analyzer/middleware-extractor.js');
  const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
  const { readOpenLoreConfig } = await import('../config-manager.js');

  const openloreConfig = await readOpenLoreConfig(absDir);
  const configExclude = openloreConfig?.analysis.excludePatterns ?? [];

  const mapper = new RepositoryMapper(absDir, {
    maxFiles: DEFAULT_MAX_FILES,
    excludePatterns: configExclude.length > 0 ? configExclude : undefined,
  });
  const repoMap = await mapper.map();
  const filePaths = repoMap.allFiles.map(f => f.path);

  const entries = await extractMiddleware(filePaths, absDir);
  return summarizeListInventory({ cached: false, total: entries.length, entries }, 'entries', responseFormat, hint);
}

// ============================================================================
// SCHEMA INVENTORY HANDLER
// ============================================================================

/**
 * Return the pre-computed database schema inventory from the last analysis run.
 * Falls back to re-computing from source files if the artifact is missing.
 */
export async function handleGetSchemaInventory(
  directory: string,
  responseFormat: ResponseFormat = 'concise',
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_SCHEMA_INVENTORY);
  const hint = 'call get_schema_inventory with responseFormat:"detailed" for the full inventory';

  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const schemas = JSON.parse(raw);
    if (!Array.isArray(schemas)) throw new Error('malformed cached schema inventory');
    return summarizeListInventory({ cached: true, total: schemas.length, schemas }, 'schemas', responseFormat, hint);
  } catch {
    // Artifact not present or malformed — run live extraction
  }

  const { extractSchemas } = await import('../../analyzer/schema-extractor.js');
  const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
  const { readOpenLoreConfig } = await import('../config-manager.js');

  const openloreConfig = await readOpenLoreConfig(absDir);
  const configExclude = openloreConfig?.analysis.excludePatterns ?? [];

  const mapper = new RepositoryMapper(absDir, {
    maxFiles: DEFAULT_MAX_FILES,
    excludePatterns: configExclude.length > 0 ? configExclude : undefined,
  });
  const repoMap = await mapper.map();
  const filePaths = repoMap.allFiles.map(f => f.path);

  const schemas = await extractSchemas(filePaths, absDir);
  return summarizeListInventory({ cached: false, total: schemas.length, schemas }, 'schemas', responseFormat, hint);
}

// ============================================================================
// UI COMPONENTS HANDLER
// ============================================================================

/**
 * Return the pre-computed UI component inventory from the last analysis run.
 * Falls back to re-computing from source files if the artifact is missing.
 */
export async function handleGetUIComponents(
  directory: string,
  responseFormat: ResponseFormat = 'concise',
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_UI_INVENTORY);
  const hint = 'call get_ui_component_inventory with responseFormat:"detailed" for the full inventory';

  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const components = JSON.parse(raw);
    if (!Array.isArray(components)) throw new Error('malformed cached UI inventory');
    return summarizeListInventory({ cached: true, total: components.length, components }, 'components', responseFormat, hint);
  } catch {
    // Artifact not present or malformed — run live extraction
  }

  const { extractUIComponents } = await import('../../analyzer/ui-component-extractor.js');
  const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
  const { readOpenLoreConfig } = await import('../config-manager.js');

  const openloreConfig = await readOpenLoreConfig(absDir);
  const configExclude = openloreConfig?.analysis.excludePatterns ?? [];

  const mapper = new RepositoryMapper(absDir, {
    maxFiles: DEFAULT_MAX_FILES,
    excludePatterns: configExclude.length > 0 ? configExclude : undefined,
  });
  const repoMap = await mapper.map();
  const filePaths = repoMap.allFiles.map(f => f.path);

  const components = await extractUIComponents(filePaths, absDir);
  return summarizeListInventory({ cached: false, total: components.length, components }, 'components', responseFormat, hint);
}

// ============================================================================
// ENV VARS HANDLER
// ============================================================================

/**
 * Return the pre-computed environment variable inventory from the last analysis run.
 * Falls back to re-computing from source files if the artifact is missing.
 */
export async function handleGetEnvVars(
  directory: string,
  responseFormat: ResponseFormat = 'concise',
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ENV_INVENTORY);
  const hint = 'call get_env_vars with responseFormat:"detailed" for the full inventory';

  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const envVars = JSON.parse(raw);
    if (!Array.isArray(envVars)) throw new Error('malformed cached env inventory');
    return summarizeListInventory({ cached: true, total: envVars.length, envVars }, 'envVars', responseFormat, hint);
  } catch {
    // Artifact not present or malformed — run live extraction
  }

  const { extractEnvVars } = await import('../../analyzer/env-extractor.js');
  const { RepositoryMapper } = await import('../../analyzer/repository-mapper.js');
  const { readOpenLoreConfig } = await import('../config-manager.js');

  const openloreConfig = await readOpenLoreConfig(absDir);
  const configExclude = openloreConfig?.analysis.excludePatterns ?? [];

  const mapper = new RepositoryMapper(absDir, {
    maxFiles: DEFAULT_MAX_FILES,
    excludePatterns: configExclude.length > 0 ? configExclude : undefined,
  });
  const repoMap = await mapper.map();
  const filePaths = repoMap.allFiles.map(f => f.path);

  const envVars = await extractEnvVars(filePaths, absDir);
  return summarizeListInventory({ cached: false, total: envVars.length, envVars }, 'envVars', responseFormat, hint);
}

// ============================================================================
// EXTERNAL PACKAGES HANDLER
// ============================================================================

/**
 * Return direct external dependencies from package manifests
 * (package.json, pyproject.toml, requirements.txt, Cargo.toml, go.mod).
 * Falls back to live extraction if cached artifact is absent.
 */
export async function handleGetExternalPackages(
  directory: string,
): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(directory);
  const artifactPath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_EXTERNAL_PACKAGES);

  try {
    const raw = await readFile(artifactPath, 'utf-8');
    const result = JSON.parse(raw);
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('malformed cached external-packages inventory');
    }
    return { cached: true, ...(result as Record<string, unknown>) };
  } catch { /* not cached or malformed — run live extraction */ }

  const { extractExternalPackages } = await import('../../analyzer/external-packages.js');
  const result = await extractExternalPackages(absDir);
  return { cached: false, ...result };
}

/**
 * Parity audit: report spec coverage gaps without any LLM call.
 * Returns uncovered functions, hub gaps, orphan requirements, and stale domains.
 */
export async function handleAuditSpecCoverage(
  directory: string,
  maxUncovered = 50,
  hubThreshold = 5,
  save = true,
  scope?: { files?: string[]; domains?: string[] },
  analysisArtifacts?: { llmContext: LLMContext; dependencyGraph: DependencyGraphResult },
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  try {
    const report = await openloreAudit({
      rootPath: absDir,
      maxUncovered,
      hubThreshold,
      save,
      files: scope?.files,
      domains: scope?.domains,
      ...(analysisArtifacts ? { analysisArtifacts } : {}),
    });
    const summary = report.mappingCoverage.state === 'available'
      ? report.summary
      : {
          ...report.summary,
          coveredFunctions: null,
          coveragePct: null,
          uncoveredCount: null,
          hubGapCount: null,
          orphanRequirementCount: null,
        };
    return {
      ...report,
      summary,
      mappingCoverage: {
        ...report.mappingCoverage,
        artifactPath: servedRelPath(absDir, report.mappingCoverage.artifactPath),
      },
    };
  } catch (err) {
    return { error: `Audit failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ============================================================================
// TEST GENERATION HANDLERS
// ============================================================================

/**
 * Generate spec-driven test files from OpenSpec scenarios.
 */
export async function handleGenerateTests(args: {
  directory: string;
  domains?: string[];
  framework?: string;
  useLlm?: boolean;
  dryRun?: boolean;
}): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(args.directory);

  const { parseScenarios, generateTests, writeTestFiles, detectFramework } =
    await import('../../../core/test-generator/index.js');
  const { FRAMEWORK_EXTENSIONS } = await import('../../../types/test-generator.js');
  type TestFramework = keyof typeof FRAMEWORK_EXTENSIONS;

  const scenarios = await parseScenarios({
    rootPath: absDir,
    domains: args.domains,
  });

  if (scenarios.length === 0) {
    return { files: [], message: 'No scenarios found. Run "openlore generate" first.' };
  }

  // Resolve framework
  let framework: TestFramework;
  const valid = Object.keys(FRAMEWORK_EXTENSIONS) as TestFramework[];
  if (!args.framework || args.framework === 'auto') {
    framework = await detectFramework(absDir);
  } else if (valid.includes(args.framework as TestFramework)) {
    framework = args.framework as TestFramework;
  } else {
    return { error: `Unknown framework "${args.framework}". Valid: ${valid.join(', ')}` };
  }

  const files = await generateTests({
    scenarios,
    framework,
    outputDir: 'spec-tests',
    rootPath: absDir,
    useLlm: args.useLlm ?? false,
  });

  const dryRun = args.dryRun ?? true; // MCP defaults to dry-run for safety
  const writeResult = await writeTestFiles({
    files,
    rootPath: absDir,
    dryRun,
    merge: false,
  });

  return {
    framework,
    dryRun,
    files: files.map((f) => ({
      path: f.outputPath,
      domain: f.domain,
      scenarioCount: f.scenarios.length,
      content: f.content,
    })),
    summary: writeResult,
  };
}

/**
 * Report spec test coverage for a project.
 */
export async function handleGetTestCoverage(args: {
  directory: string;
  domains?: string[];
  discover?: boolean;
  minCoverage?: number;
}): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(args.directory);

  const { analyzeTestCoverage } = await import('../../../core/test-generator/index.js');

  const report = await analyzeTestCoverage({
    rootPath: absDir,
    testDirs: ['spec-tests', 'src'],
    domains: args.domains,
    minCoverage: args.minCoverage,
    // discover without LLM: tag-based only
    discover: false,
  });

  return report as unknown as Record<string, unknown>;
}

// ============================================================================
// get_minimal_context
// ============================================================================

/**
 * Return the bare minimum an agent needs to safely modify a function:
 * its signature + body, direct callers (signatures), direct callees (signatures),
 * and which test files cover it. Typically 200-600 tokens vs orient's 2000+.
 */
export async function handleGetMinimalContext(
  directory: string,
  functionName: string,
  filePath?: string,
  rankBy: 'distance' | 'pagerank' = 'distance',
  tokenBudget?: number,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) return { error: 'No call graph. Run analyze_codebase first.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  // `llm-context.json` is an untrusted repository artifact (and may arrive through an
  // unsigned portable bundle). Never let one of its node paths become a read target or
  // an output path until it has crossed the same symlink-aware root boundary as a tool
  // argument. Invalid internal neighbours are omitted; an invalid target fails closed as
  // not-found rather than disclosing where the poisoned path points.
  const confinedPaths = new Map<string, string>();
  const confinedPath = (node: (typeof cg.nodes)[number]): string | null => {
    const cached = confinedPaths.get(node.id);
    if (cached) return cached;
    try {
      const path = safeJoin(absDir, node.filePath);
      confinedPaths.set(node.id, path);
      return path;
    } catch {
      return null;
    }
  };
  const nodeMap = new Map(
    cg.nodes
      .filter(n => n.isExternal || confinedPath(n) !== null)
      .map(n => [n.id, n]),
  );

  // Find target node(s)
  const candidates = cg.nodes.filter(n =>
    n.name === functionName &&
    !n.isExternal && !n.isTest &&
    confinedPath(n) !== null &&
    // Anchor on a path separator so "config.ts" doesn't also match "app-config.ts".
    (!filePath || n.filePath === filePath || n.filePath.endsWith('/' + filePath.replace(/^\//, ''))),
  );
  if (candidates.length === 0) return { error: `Function "${functionName}" not found. Run analyze_codebase first.` };
  const target = candidates[0];
  const targetPath = confinedPath(target)!;

  // Risk tier → distance budget + k cap. Neighbours are ranked by nearest
  // call-distance (not arbitrary edge order), so a tightly-coupled chain two hops
  // away can outrank a far neighbour, and when there are more than k the weakest/
  // farthest are dropped first. The budget floors at the maximum direct-edge cost
  // (`name_only` = 3) so a function's DIRECT neighbours are never dropped merely
  // because their resolution is weak; the tier governs only how far past direct a
  // chain is pulled in (see analyzer spec: MinimalContextScopedByNearestDistance).
  const riskLevel: 'high' | 'medium' | 'low' =
    target.fanIn >= 30 || target.fanOut >= 15 ? 'high' :
    target.fanIn >= 15 || target.fanOut >= 8  ? 'medium' : 'low';
  const distanceBudget = riskLevel === 'high' ? 6 : riskLevel === 'medium' ? 4 : 3;
  const kCap = riskLevel === 'high' ? 24 : riskLevel === 'medium' ? 18 : 12;

  const callsEdges = cg.edges.filter(e => !e.kind || e.kind === 'calls');

  const sig = (n: (typeof cg.nodes)[0]) =>
    n.signature ?? n.name + (n.isExternal ? ' [external]' : '');

  // callType of each direct call edge, keyed (callerId → calleeId) so the last hop
  // on a scoped path can report how that neighbour is reached.
  const callTypeByEdge = new Map<string, string>();
  for (const e of callsEdges) callTypeByEdge.set(`${e.callerId}\0${e.calleeId}`, e.callType ?? 'direct');

  const { forward, backward } = buildWeightedAdjacency(cg);
  const pagerank = rankBy === 'pagerank';
  const budget = pagerank ? tokenBudget : undefined;

  // Bounded neighbourhoods the ranking runs over — reused by BOTH rankers, so personalized
  // PageRank stays proportional to the task neighbourhood (the risk-tier distance budget),
  // not the whole repository.
  const callerReach = weightedBfs([target.id], backward, distanceBudget);
  const calleeReach = weightedBfs([target.id], forward, distanceBudget);

  // Query-conditioned relevance over each bounded neighbourhood (pagerank mode only): seed
  // the walk on the target and let connectivity — not just nearest distance — order the
  // candidates. Default mode computes nothing here and stays byte-identical to before.
  const callerScores = pagerank ? personalizedPageRank(backward, [target.id], callerReach.keys()) : new Map<string, number>();
  const calleeScores = pagerank ? personalizedPageRank(forward, [target.id], calleeReach.keys()) : new Map<string, number>();

  // Order -> cap -> (pagerank) token-budget a neighbour list. In default mode this reproduces
  // the prior distance-then-fanIn ordering and JSON shape exactly. In pagerank mode it orders
  // by relevance (id tie-break), attaches the relevance value, and fits the token budget —
  // reporting how many lower-ranked neighbours were omitted rather than silently truncating.
  const select = <T extends { id: string; distance: number; _rank: number; _rel: number }>(items: T[]) => {
    const ordered = pagerank
      ? [...items].sort((a, b) => b._rel - a._rel || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : [...items].sort((a, b) => a.distance - b.distance || b._rank - a._rank);
    // Project to the FINAL returned shape BEFORE budgeting, so the token estimate is
    // costed on what's actually emitted (the long `id`/`_rank`/`_rel` scratch fields are
    // dropped here, not measured) rather than over-counting and over-reporting overflow.
    const projected = ordered.slice(0, kCap).map(({ id: _id, _rank, _rel, ...rest }) =>
      pagerank ? { ...rest, relevance: Math.round(_rel * 1e6) / 1e6 } : rest,
    );
    const { kept, omitted } = budget ? applyTokenBudget(projected, budget) : { kept: projected, omitted: 0 };
    return { list: kept, omitted };
  };

  // Callers: nearest-by-call-distance over the backward (callee→caller) adjacency.
  const callerItems = [...callerReach.entries()]
    .filter(([id]) => id !== target.id)
    .map(([id, r]) => {
      const n = nodeMap.get(id);
      if (!n || n.isExternal) return null;
      const callType = callTypeByEdge.get(`${id}\0${r.predecessor}`) ?? 'direct';
      return { id, name: n.name, file: servedRelPath(absDir, confinedPath(n)!), sig: sig(n), callType, isExternal: false, distance: r.distance, hops: r.hops, _rank: n.fanIn, _rel: callerScores.get(id) ?? 0 };
    })
    .filter((n): n is NonNullable<typeof n> => !!n);
  const { list: callers, omitted: callersOmitted } = select(callerItems);

  // Callees: nearest-by-call-distance over the forward (caller→callee) adjacency,
  // plus direct external callees (synthetic leaves the weighted pass skips) so the
  // function's external dependencies (fetch, db, fs) stay visible.
  const internalCallees = [...calleeReach.entries()]
    .filter(([id]) => id !== target.id)
    .map(([id, r]) => {
      const n = nodeMap.get(id);
      if (!n || n.isExternal) return null;
      const callType = callTypeByEdge.get(`${r.predecessor}\0${id}`) ?? 'direct';
      return { id, name: n.name, file: servedRelPath(absDir, confinedPath(n)!), sig: sig(n), callType, isExternal: false, kind: undefined as string | undefined, distance: r.distance, hops: r.hops, _rank: n.fanOut, _rel: calleeScores.get(id) ?? 0 };
    })
    .filter((n): n is NonNullable<typeof n> => !!n);

  const seenExternal = new Set<string>();
  const externalCallees = callsEdges
    .filter(e => e.callerId === target.id)
    .map(e => nodeMap.get(e.calleeId))
    .filter((n): n is NonNullable<typeof n> => !!n && !!n.isExternal)
    .filter(n => !seenExternal.has(n.id) && (seenExternal.add(n.id), true))
    .map(n => ({
      id: n.id,
      name: `[external] ${n.name}`, file: 'external', sig: sig(n),
      callType: callTypeByEdge.get(`${target.id}\0${n.id}`) ?? 'direct',
      isExternal: true, kind: n.externalKind as string | undefined, distance: 1, hops: 1, _rank: 0, _rel: 0,
    }));

  const { list: callees, omitted: calleesOmitted } = select([...internalCallees, ...externalCallees]);

  // Test coverage — distinguish import-based vs call-based tracing
  const seenTestNames = new Set<string>();
  const testedBy = cg.edges
    .filter(e => e.kind === 'tested_by' && e.callerId === target.id)
    .flatMap(e => {
      if (seenTestNames.has(e.calleeName)) return [];
      seenTestNames.add(e.calleeName);
      const confidence: 'imported' | 'called' = e.confidence === 'import' ? 'imported' : 'called';
      return [{ name: e.calleeName, confidence }];
    });

  // Function body (byte-range slice from source)
  let body: string | null = null;
  try {
    const src = await readFileConfined(absDir, relative(absDir, targetPath));
    body = src.slice(target.startIndex, target.endIndex);
  } catch { /* source unavailable */ }

  // Recursion: the target is intentionally excluded from its own caller/callee
  // lists (it is not a neighbour of itself), so surface a self-call as a flag
  // rather than losing the signal.
  const recursive = callsEdges.some(e => e.callerId === target.id && e.calleeId === target.id);

  return {
    function: {
      name: target.name,
      file: servedRelPath(absDir, targetPath),
      signature: target.signature ?? target.name,
      language: target.language,
      className: target.className ?? null,
      startLine: target.startLine ?? null,
      fanIn: target.fanIn,
      fanOut: target.fanOut,
      community: target.communityLabel ?? null,
      riskLevel,
      recursive,
      body,
    },
    callers,
    callees,
    testedBy,
    ...(pagerank ? { rankedBy: 'pagerank' as const } : {}),
    ...(pagerank && (callersOmitted > 0 || calleesOmitted > 0)
      ? { omittedForBudget: {
          callers: callersOmitted,
          callees: calleesOmitted,
          note: 'lower-ranked neighbours were omitted to fit tokenBudget; raise tokenBudget or fetch a specific neighbour with get_function_body',
        } }
      : {}),
  };
}

// ============================================================================
// get_cluster
// ============================================================================

/**
 * Return all functions in the same community as the given function.
 * Communities are computed via label propagation on the call graph at analyze time.
 * Useful for understanding the "cluster" of related functions without traversing the graph.
 */
export async function handleGetCluster(
  directory: string,
  functionName: string,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) return { error: 'No call graph. Run analyze_codebase first.' };

  const cg = ctx.callGraph as SerializedCallGraph;

  // Find the target node
  const target = cg.nodes.find(n => n.name === functionName && !n.isExternal && !n.isTest);
  if (!target) return { error: `Function "${functionName}" not found.` };
  if (!target.communityId) return { error: `No community data. Re-run analyze_codebase.` };

  return buildClusterView(cg, absDir, target.communityId);
}

/**
 * Function-granularity view of one community: members (by fan-in), spanning files,
 * internal call edges, and density. Shared by `get_cluster` (which resolves a
 * function name to its community) and `get_map`'s drill-in (which has the
 * `communityId` directly), so both render a region identically.
 */
export function buildClusterView(cg: SerializedCallGraph, absDir: string, communityId: string): unknown {
  // All nodes in the same community
  const members = cg.nodes
    .filter(n => n.communityId === communityId && !n.isExternal && !n.isTest)
    .sort((a, b) => b.fanIn - a.fanIn);
  if (members.length === 0) return { error: `No community "${communityId}" found.` };

  // Internal edges within community
  const memberIds = new Set(members.map(n => n.id));
  const nameById = new Map(members.map(n => [n.id, n.name]));
  const rawInternal = cg.edges
    .filter(e => (!e.kind || e.kind === 'calls') && memberIds.has(e.callerId) && memberIds.has(e.calleeId));

  // Deduplicate, count all unique internal edges for density, show top 15
  const seen = new Set<string>();
  const callEdges: string[] = [];
  let uniqueInternalCount = 0;
  for (const e of rawInternal) {
    const key = `${e.callerId}→${e.calleeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueInternalCount++;
    if (callEdges.length < 15) {
      callEdges.push(`${nameById.get(e.callerId)} → ${nameById.get(e.calleeId)}`);
    }
  }

  const m = members.length;
  const clusterDensity = m > 1 ? Math.round((uniqueInternalCount / (m * (m - 1))) * 1000) / 1000 : 0;

  // Files the community spans
  const files = [...new Set(members.map(n => relative(absDir, n.filePath)))].sort();

  return {
    communityLabel: members[0].communityLabel,
    communityId,
    stats: {
      members: m,
      files: files.length,
      internalEdges: uniqueInternalCount,
      clusterDensity,
    },
    files,
    // Internal call edges show WHY these functions cluster together
    internalCallGraph: callEdges,
    functions: members.map(n => ({
      name: n.name,
      file: relative(absDir, n.filePath),
      signature: n.signature ?? n.name,
      fanIn: n.fanIn,
      fanOut: n.fanOut,
    })),
  };
}

// ============================================================================
// detect_changes
// ============================================================================

/** Run git with output redirected to file descriptors — safe inside the MCP
 * server (which owns stdin/stdout). */
function runGit(args: string[], cwd: string): Promise<string> {
  // Redirect git's stdout/stderr straight to temp files via file descriptors.
  // This sidesteps libuv's pipe() (which fails EBADF inside the MCP server,
  // whose FD 0/1 are the JSON-RPC protocol sockets) WITHOUT a shell: git is
  // invoked with an argv array, so an arg can never be reinterpreted as a shell
  // token (mcp-security: Subprocess Argument Safety — no shell-string calls).
  return new Promise((resolve, reject) => {
    const PATH = (process.env.PATH ?? '') + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
    const tmp = mkdtempSync(join(tmpdir(), 'sg-git-'));
    const outPath = join(tmp, 'o');
    const errPath = join(tmp, 'e');
    const outFd = openSync(outPath, 'w');
    const errFd = openSync(errPath, 'w');
    let r: ReturnType<typeof spawnGitSync>;
    try {
      r = spawnGitSync('git', args, {
        cwd,
        stdio: ['ignore', outFd, errFd],
        env: { ...process.env, PATH },
      });
    } finally {
      try { closeSync(outFd); } catch { /* already closed */ }
      try { closeSync(errFd); } catch { /* already closed */ }
    }
    let stdout = '';
    let stderr = '';
    try { stdout = readFileSync(outPath, 'utf8'); } catch { /* no output */ }
    try { stderr = readFileSync(errPath, 'utf8'); } catch { /* no output */ }
    rmSync(tmp, { recursive: true, force: true });
    if (r.error) { reject(r.error); return; }
    if ((r.status ?? 1) !== 0) { reject(new Error(stderr || `git exit ${r.status}`)); return; }
    resolve(stdout);
  });
}

// ── change-type classifier ────────────────────────────────────────────────────
// Signature line patterns across languages (TS/JS, Python, Go, Rust, Java/C++)
const SIG_PATTERN =
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\b|\bdef\s+\w+\s*[([:]|\bfunc\s+(\([^)]*\)\s*)?\w+\s*\(|\bfn\s+\w+\b|\bclass\s+\w+/;
// Control-flow keywords (broad, multi-language)
const LOGIC_PATTERN =
  /\b(if|else|for|while|switch|try|catch|throw|return|yield|await|break|continue|elif|except|raise|match|case)\b/;

type ChangeType = 'signature' | 'logic' | 'config';

function classifyChangeType(
  node: { startLine?: number; endLine?: number },
  addedLines: Map<number, string>,
): ChangeType {
  const fnStart = node.startLine ?? 1;
  const fnEnd = node.endLine ?? fnStart;
  const linesInFn: string[] = [];
  for (const [ln, content] of addedLines) {
    if (ln >= fnStart && ln <= fnEnd) linesInFn.push(content);
  }
  if (linesInFn.length === 0) return 'logic';
  // Signature change: function's own declaration line was modified
  const sigLine = addedLines.get(fnStart);
  if (sigLine !== undefined && SIG_PATTERN.test(sigLine)) return 'signature';
  // Logic change: any added line has a control-flow keyword
  if (linesInFn.some(l => LOGIC_PATTERN.test(l))) return 'logic';
  return 'config';
}

const CHANGE_TYPE_MULTIPLIER: Record<ChangeType, number> = {
  signature: 1.5, // breaking-change candidate
  logic: 1.0,     // default
  config: 0.4,    // literal / comment / config tweak
};

function buildReason(params: {
  changeType: ChangeType;
  directCallers: Array<{ callType?: string }>;
  tests: Array<{ confidence: 'imported' | 'called' }>;
  bScore: number;
  fanIn: number;
}): string {
  const { changeType, directCallers, tests, bScore, fanIn } = params;
  const parts: string[] = [];

  if (changeType === 'signature') parts.push('signature change');
  else if (changeType === 'config') parts.push('config/literal change');

  if (fanIn > 0) {
    const awaitedCount = directCallers.filter(c => c.callType === 'awaited').length;
    const total = directCallers.length || fanIn;
    if (awaitedCount === total && awaitedCount > 0) parts.push('all callers awaited');
    else if (awaitedCount > 0) parts.push(`${awaitedCount} awaited callers`);
    else parts.push(`${fanIn} callers`);
  }

  const calledTests = tests.filter(t => t.confidence === 'called').length;
  if (tests.length === 0) parts.push('no tests');
  else if (calledTests === 0) parts.push('import-only tests');
  else parts.push(`${calledTests} direct test${calledTests > 1 ? 's' : ''}`);

  if (bScore >= 0.67) parts.push('HTTP/DB boundary');
  else if (bScore > 0) parts.push('external boundary');

  return parts.join(' · ') || 'low-risk change';
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect recently changed functions and rank them by blast radius (fanIn of callers via BFS).
 * Runs git diff to find changed files/lines, maps to function nodes, scores by impact.
 */
export async function handleDetectChanges(
  directory: string,
  base?: string,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) return { error: 'No call graph. Run analyze_codebase first.' };

  const ref = base ?? 'HEAD';
  // Validate the caller-supplied base ref against argument injection before it
  // reaches git (mcp-security: Subprocess Argument Safety).
  validateGitRef(ref);
  let diffOutput: string;
  try {
    diffOutput = await runGit(['diff', '--unified=0', ref, '--', '.'], absDir);
    if (!diffOutput.trim()) {
      diffOutput = await runGit(['diff', '--unified=0', '--cached', '--', '.'], absDir);
    }
  } catch (err) {
    return { error: `git diff failed: ${(err as Error).message}` };
  }

  if (!diffOutput.trim()) return { changedFunctions: [], message: 'No changes detected.' };

  // Parse unified diff: collect line ranges AND added-line content per file.
  // --unified=0 means no context lines; only '+' and '-' lines appear in hunks.
  const changedFileData = new Map<string, {
    ranges: Array<[number, number]>;
    addedLines: Map<number, string>; // new-file line# → content
  }>();
  let curFile: string | null = null;
  let newLineNum = 0;
  for (const line of diffOutput.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    // git diff paths are repo-root-relative, matching the call-graph node
    // convention (nodes store relative filePaths). Keep them relative so the
    // node-overlap match below — and the classifyChangeType lookup — line up.
    if (fileMatch) { curFile = fileMatch[1]; newLineNum = 0; continue; }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && curFile) {
      newLineNum = parseInt(hunkMatch[1], 10);
      const count = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      if (count === 0) continue;
      if (!changedFileData.has(curFile)) changedFileData.set(curFile, { ranges: [], addedLines: new Map() });
      changedFileData.get(curFile)!.ranges.push([newLineNum, newLineNum + count - 1]);
      continue;
    }
    if (!curFile || !changedFileData.has(curFile)) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      changedFileData.get(curFile)!.addedLines.set(newLineNum++, line.slice(1));
    }
    // '-' lines don't advance new-file position; no context lines with --unified=0
  }
  // Backward-compat: changedLines used by the node-overlap loop below
  const changedLines = new Map([...changedFileData.entries()].map(([k, v]) => [k, v.ranges]));

  const cg = ctx.callGraph as SerializedCallGraph;
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));

  // Node filePaths are repo-root-relative, but tolerate an absolute path defensively
  // (older analyses, or a future builder change) by normalising to the diff's relative form.
  const relPath = (p: string) => (p.startsWith(absDir) ? relative(absDir, p) : p);

  // Map changed line ranges to function nodes; track overlapping line count per function
  const changedFnIds = new Set<string>();
  const fnChangedLineCount = new Map<string, number>(); // nodeId → #lines overlapping with diff
  for (const [filePath, ranges] of changedLines) {
    const fileNodes = cg.nodes.filter(n => relPath(n.filePath) === filePath && !n.isExternal && !n.isTest && n.startLine);
    for (const node of fileNodes) {
      const fnEnd = node.endLine ?? node.startLine!;
      let overlap = 0;
      for (const [start, end] of ranges) {
        if (node.startLine! <= end && fnEnd >= start) {
          changedFnIds.add(node.id);
          overlap += Math.min(end, fnEnd) - Math.max(start, node.startLine!) + 1;
        }
      }
      if (overlap > 0) fnChangedLineCount.set(node.id, (fnChangedLineCount.get(node.id) ?? 0) + overlap);
    }
    // Fallback: no line match — include all functions in the file
    if (fileNodes.length > 0 && !fileNodes.some(n => changedFnIds.has(n.id))) {
      for (const n of fileNodes) changedFnIds.add(n.id);
    }
  }

  if (changedFnIds.size === 0) {
    return { changedFunctions: [], message: 'Changed files found but no matching function nodes. Re-run analyze_codebase.' };
  }

  const callsEdges = cg.edges.filter(e => !e.kind || e.kind === 'calls');

  // callerIndex: calleeId → [{id, callType}] — callType weights BFS contribution
  const callerIndex = new Map<string, Array<{ id: string; callType?: string }>>();
  for (const e of callsEdges) {
    if (!callerIndex.has(e.calleeId)) callerIndex.set(e.calleeId, []);
    callerIndex.get(e.calleeId)!.push({ id: e.callerId, callType: e.callType });
  }

  // calleeIndex: callerId → calleeIds (for boundary score)
  const calleeIndex = new Map<string, string[]>();
  for (const e of callsEdges) {
    if (!calleeIndex.has(e.callerId)) calleeIndex.set(e.callerId, []);
    calleeIndex.get(e.callerId)!.push(e.calleeId);
  }

  // awaited callers most sensitive; callback least (detached, survives interface change)
  const callTypeWeight = (ct?: string) =>
    ct === 'awaited' ? 1.0 : ct === 'direct' ? 0.7 : ct === 'method' ? 0.6 :
    ct === 'callback' ? 0.4 : 0.5; // 0.5 default covers 'constructor' and unknown

  // Distance-weighted BFS: Σ weight/d² — clamped to prevent cross-repo drift
  const transitiveScore = (startId: string): number => {
    const visited = new Set<string>();
    // Head-index drain — the caller frontier is graph-sized and shift() is O(n).
    // (change: optimize-serving-hot-path-caches)
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 1 }];
    let score = 0;
    for (let head = 0; head < queue.length; head++) {
      const { id, depth } = queue[head];
      for (const caller of callerIndex.get(id) ?? []) {
        if (!visited.has(caller.id)) {
          visited.add(caller.id);
          score += callTypeWeight(caller.callType) / (depth * depth);
          queue.push({ id: caller.id, depth: depth + 1 });
        }
      }
    }
    return Math.min(score, TRANSITIVE_SCORE_MAX);
  };

  // Boundary score: outgoing edges to external nodes; http/db weighted 3×, others 1×; normalized
  const boundaryScore = (nodeId: string): number => {
    let raw = 0;
    for (const calleeId of calleeIndex.get(nodeId) ?? []) {
      const callee = nodeMap.get(calleeId);
      if (!callee?.isExternal) continue;
      raw += (callee.externalKind === 'http' || callee.externalKind === 'database') ? 3 : 1;
    }
    return Math.min(raw / 3, 1);
  };

  // testedBy map: nodeId → [{name, confidence}]
  const testedByMap = new Map<string, Array<{ name: string; confidence: 'imported' | 'called' }>>();
  for (const e of cg.edges.filter(e => e.kind === 'tested_by')) {
    if (!testedByMap.has(e.callerId)) testedByMap.set(e.callerId, []);
    const arr = testedByMap.get(e.callerId)!;
    if (!arr.some(x => x.name === e.calleeName)) {
      arr.push({ name: e.calleeName, confidence: e.confidence === 'import' ? 'imported' : 'called' });
    }
  }

  const scored = [...changedFnIds].map(id => {
    const n = nodeMap.get(id)!;
    const fnLength = Math.max(1, (n.endLine ?? n.startLine ?? 1) - (n.startLine ?? 1) + 1);
    const changed = fnChangedLineCount.get(id) ?? Math.round(fnLength * 0.5);
    // Blend relative (sensitivity) + absolute (log scale) — prevents tiny fully-changed fns
    // from outranking large ones; log(201)≈5.3 so 200 changed lines ≈ absScore 1.0
    const relScore = changed / fnLength;
    const absScore = Math.log(1 + changed) / Math.log(201);
    const rawChangeScore = Math.min(0.6 * relScore + 0.4 * absScore, 1);
    // Semantic modifier: signature changes are higher risk than config/literal tweaks
    const changeType = classifyChangeType(n, changedFileData.get(relPath(n.filePath))?.addedLines ?? new Map());
    const changeScore = Math.min(rawChangeScore * CHANGE_TYPE_MULTIPLIER[changeType], 1);
    const tests = testedByMap.get(id) ?? [];
    const testCoverage: 'none' | 'import-only' | 'direct' =
      tests.length === 0 ? 'none' :
      tests.some(t => t.confidence === 'called') ? 'direct' : 'import-only';
    // called-edges are direct proof; imported-only is weaker (survives vi.mock)
    const effectiveTests = tests.reduce((s, t) => s + (t.confidence === 'called' ? 1.0 : 0.3), 0);
    const coveragePenalty = 1 / (1 + Math.log(1 + effectiveTests));
    const tScore = transitiveScore(id);
    const bScore = boundaryScore(id);
    // Multiplicative model: risk = likelihood × impact
    // Decouples change probability from structural blast radius; prevents correlated
    // signals (fanIn ↔ transitive) from triple-stacking additively
    const likelihood = changeScore * (1 + coveragePenalty);
    const impact = Math.log(1 + n.fanIn) * 0.8 + tScore + bScore;
    const riskScore = Math.round(likelihood * impact * 100) / 100;
    const directCallers = callerIndex.get(id) ?? [];
    const reason = buildReason({ changeType, directCallers, tests, bScore, fanIn: n.fanIn });
    return {
      name: n.name,
      file: relPath(n.filePath),
      startLine: n.startLine ?? null,
      endLine: n.endLine ?? null,
      fanIn: n.fanIn,
      blastRadius: Math.round(tScore * 100) / 100,
      changeType,
      riskScore,
      reason,
      testCoverage,
      testedBy: testedByMap.get(id) ?? [],
    };
  }).sort((a, b) => b.riskScore - a.riskScore);

  const testGaps = scored
    .filter(f => f.testCoverage === 'none')
    .map(f => ({ name: f.name, file: f.file, riskScore: f.riskScore, changeType: f.changeType }));

  return {
    base: ref,
    totalChanged: scored.length,
    changedFunctions: scored,
    testGaps,
  };
}
