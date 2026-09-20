/**
 * openlore audit — programmatic API
 *
 * Compares current codebase state to the spec snapshot to report coverage gaps.
 * No LLM required.
 */

import { join, relative, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { SpecSnapshotGenerator } from '../core/analyzer/spec-snapshot-generator.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_AUDIT_REPORT,
  OPENSPEC_DIR,
  HUB_THRESHOLD,
} from '../constants.js';
import type {
  AuditReport,
  AuditUncoveredFunction,
  AuditOrphanRequirement,
  AuditStaleDomain,
  MappingCoverageStatus,
} from '../types/index.js';
import type { AuditApiOptions } from './types.js';
import type { LLMContext } from '../core/analyzer/artifact-generator.js';
import {
  coveredSymbolKeys,
  orphanRequirementsOf,
  resolveSpecLinkIndex,
} from '../core/generator/spec-link-service.js';
import { normalizeAnchorPath, type SpecRequirementLink } from '../core/generator/spec-link-index.js';
import { loadSpecCorpus } from '../core/generator/spec-link-service.js';
import { parseOpenSpecRequirements } from '../core/generator/openspec-compat.js';
import { checkScenarioShape, SCENARIO_PATH_CAVEAT } from '../core/generator/scenario-checkability.js';
import { createFullGraphReachingTestSelector } from '../core/services/edit-verdict.js';
import { detectLanguage } from '../core/analyzer/language-detection.js';
import { TEST_DETECTION_LANGUAGES } from '../core/analyzer/test-file.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import type { SerializedCallGraph, FunctionNode } from '../core/analyzer/call-graph.js';
import { readGenerationSnapshot, REQUIRED_ANALYSIS_ARTIFACTS } from '../core/runtime/analysis-generation.js';
import { withLoggerOptions } from '../utils/logger.js';
import { errors, isOpenLoreError } from '../utils/errors.js';
import { resolveOpenspecDir } from '../utils/openspec-dir.js';

const DEFAULT_MAX_UNCOVERED = 50;
const MAX_SCENARIO_TEST_NAMES = 3;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Coverage is matched on the FILE-QUALIFIED identity only.
 *
 * Falling back to a bare-name match let one anchor cover every same-named symbol
 * in the repository — `foo::src/a.ts` silently covering `foo` in `src/b.ts` — so
 * the audit reported coverage it had no evidence for.
 */
function isNodeCovered(node: FunctionNode, covered: Set<string>): boolean {
  return covered.has(`${normalizeAnchorPath(node.filePath) ?? node.filePath}::${node.name}`);
}

function toAuditFunction(node: FunctionNode, isHub: boolean): AuditUncoveredFunction {
  return {
    name: node.name,
    file: node.filePath,
    kind: node.className ? 'method' : 'function',
    fanIn: node.fanIn,
    fanOut: node.fanOut,
    isHub,
  };
}

// ============================================================================
// PUBLIC API
// ============================================================================

async function audit(options: AuditApiOptions): Promise<AuditReport> {
  const rootPath = resolve(options.rootPath ?? process.cwd());
  const maxUncovered = options.maxUncovered ?? DEFAULT_MAX_UNCOVERED;
  const hubThreshold = options.hubThreshold ?? HUB_THRESHOLD;
  const shouldSave = options.save ?? true;
  const fileScope = options.files ? new Set(options.files) : null;
  const domainScope = options.domains ? new Set(options.domains) : null;
  const analysisDir = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  // Load (or refresh) snapshot
  const openloreConfig = await readOpenLoreConfig(rootPath, options.configPath);
  if (options.configPath !== undefined && !openloreConfig) {
    throw errors.noConfig(options.configPath);
  }
  const openspecPath = resolveOpenspecDir(rootPath, openloreConfig?.openspecPath ?? OPENSPEC_DIR);
  const openspecRelPath = relative(rootPath, openspecPath) || '.';
  const snapshotGen = new SpecSnapshotGenerator(rootPath, openspecRelPath);
  const snapshot = await snapshotGen.generate({ persist: shouldSave }).catch(() => null);

  const supplied = (options as AuditApiOptions & { analysisArtifacts?: { llmContext: LLMContext; dependencyGraph: DependencyGraphResult } }).analysisArtifacts;
  const coherent = supplied ? null : await readGenerationSnapshot(
    analysisDir,
    [...REQUIRED_ANALYSIS_ARTIFACTS],
    async () => Promise.all([
      readFile(join(analysisDir, ARTIFACT_LLM_CONTEXT), 'utf-8').catch(() => null),
      readFile(join(analysisDir, ARTIFACT_DEPENDENCY_GRAPH), 'utf-8').catch(() => null),
    ]),
  );
  const [llmContextRaw, depGraphRaw] = coherent?.state === 'ok' ? coherent.value : [null, null];

  let llmContext: LLMContext | null = supplied?.llmContext ?? null;
  if (!supplied && llmContextRaw) {
    try {
      llmContext = JSON.parse(llmContextRaw) as LLMContext;
    } catch {
      llmContext = null;
    }
  }
  let depGraph: DependencyGraphResult | null;
  if (supplied) {
    depGraph = supplied.dependencyGraph;
  } else try {
    depGraph = depGraphRaw ? JSON.parse(depGraphRaw) as DependencyGraphResult : null;
  } catch {
    depGraph = null;
  }

  // Coverage comes from the deterministic link index. The persisted mapping cache
  // is used when it is current and rebuilt in memory otherwise, so an audit never
  // depends on a prior generation run having written it.
  const resolution = await resolveSpecLinkIndex({
    rootPath,
    openspecPath: openspecRelPath,
    ...(domainScope ? { domains: [...domainScope] } : {}),
    persist: shouldSave,
    graph: depGraph,
  });
  const mappingCoverage: MappingCoverageStatus = resolution.state === 'available'
    ? {
        state: 'available',
        artifactPath: resolution.artifactPath,
        source: resolution.source,
        ...(resolution.cacheReason ? { cacheReason: resolution.cacheReason } : {}),
      }
    : {
        state: 'unavailable',
        reason: resolution.reason,
        message: resolution.message,
        remediation: resolution.remediation,
        artifactPath: resolution.artifactPath,
      };
  const index = resolution.state === 'available' ? resolution.index : null;

  const callGraph = llmContext?.callGraph as SerializedCallGraph | undefined;
  const selectReachingTests = createFullGraphReachingTestSelector(callGraph);
  const specs = await loadSpecCorpus(rootPath, openspecRelPath, domainScope ? [...domainScope] : undefined, true);
  const graphNodes = new Map<string, FunctionNode[]>();
  for (const node of callGraph?.nodes ?? []) {
    const key = `${normalizeAnchorPath(node.filePath) ?? node.filePath}::${node.name}`;
    const matches = graphNodes.get(key) ?? [];
    matches.push(node);
    graphNodes.set(key, matches);
  }
  const links = new Map<string, SpecRequirementLink[]>();
  for (const link of index?.links ?? []) {
    const key = `${link.specFile}\0${link.requirement}`;
    links.set(key, [...(links.get(key) ?? []), link]);
  }
  const pathCache = new Map<string, ReturnType<typeof selectReachingTests>>();
  const scenarios: NonNullable<AuditReport['scenarioVerification']>['scenarios'] = [];
  for (const spec of specs) for (const requirement of parseOpenSpecRequirements(spec.content)) {
    const matches = links.get(`${spec.specFile}\0${requirement.name}`) ?? [];
    const link = matches.length === 1 ? matches[0] : undefined;
    if (fileScope && (!link || !link.footprintFiles.some(file => fileScope.has(file)))) continue;
    const anchorNodes = link?.functions.map(fn =>
      graphNodes.get(`${normalizeAnchorPath(fn.file) ?? fn.file}::${fn.name}`) ?? []) ?? [];
    const seedIds = anchorNodes.flatMap(nodes => nodes.length === 1 ? [nodes[0].id] : []);
    let assessmentReason: string | undefined;
    if (!index) assessmentReason = mappingCoverage.reason ?? 'mapping-unavailable';
    else if (!callGraph) assessmentReason = 'call-graph-unavailable';
    else if (matches.length > 1) assessmentReason = 'duplicate-requirement-name';
    else if (!link || link.functions.length === 0) assessmentReason = link?.state ?? 'no-resolved-anchor';
    else if (link.functions.some(fn => !TEST_DETECTION_LANGUAGES.has(detectLanguage(fn.file)))) assessmentReason = 'test-detection-unsupported';
    else if (anchorNodes.some(nodes => nodes.length > 1)) assessmentReason = 'ambiguous-call-graph-symbol';
    else if (anchorNodes.some(nodes => nodes.length === 0)) assessmentReason = 'anchor-absent-from-call-graph';

    let reaching = { tests: [] as Array<{ file: string; test: string }>, truncated: false, total: 0 };
    if (!assessmentReason) {
      const key = [...new Set(seedIds)].sort().join('\0');
      let cached = pathCache.get(key);
      if (!cached) {
        cached = selectReachingTests(seedIds);
        pathCache.set(key, cached);
      }
      reaching = {
        tests: cached.tests.slice(0, MAX_SCENARIO_TEST_NAMES).map(test => ({ file: test.file, test: test.test })),
        truncated: cached.truncated || cached.tests.length > MAX_SCENARIO_TEST_NAMES,
        total: cached.tests.length,
      };
      if (cached.tests.length === 0 && llmContext?.partial) assessmentReason = 'partial-index';
      else if (cached.truncated && cached.tests.length === 0) assessmentReason = 'reachability-truncated';
    }
    for (const scenario of requirement.scenarios) {
      const shape = checkScenarioShape(scenario.text);
      scenarios.push({
        domain: spec.domain,
        specFile: spec.specFile,
        requirement: requirement.name,
        scenario: scenario.name,
        checkability: shape ? 'unverifiable-shape' : 'checkable',
        ...(shape ? { shapeReason: shape.reason } : {}),
        label: assessmentReason ? 'not-assessable' : reaching.tests.length ? 'verification-path-exists' : 'no-reaching-test',
        ...(assessmentReason ? { reason: assessmentReason } : {}),
        ...(!assessmentReason && link?.state !== 'linked' ? { reason: `Only resolved symbol anchors assessed; other anchors are ${link?.state}.` } : {}),
        tests: reaching.tests,
        ...(reaching.total ? { testCount: reaching.total } : {}),
        ...(reaching.truncated ? { testsTruncated: true } : {}),
      });
    }
  }
  const allNodes = (callGraph?.nodes ?? []).filter(node => !fileScope || fileScope.has(node.filePath));
  const hubNodes = new Set((callGraph?.hubFunctions ?? []).map(n => n.id));

  const covered = index ? coveredSymbolKeys(index) : new Set<string>();

  // 1. Uncovered functions.  Without a resolvable link index there is no evidence
  // of coverage OR of a gap; the metrics below stay null rather than reporting
  // every analyzed function as uncovered.
  const uncoveredNodes = index ? allNodes.filter(n => !isNodeCovered(n, covered)) : [];
  const uncoveredFunctions: AuditUncoveredFunction[] = uncoveredNodes
    .slice(0, maxUncovered)
    .map(n => toAuditFunction(n, hubNodes.has(n.id) || n.fanIn >= hubThreshold));

  // 2. Hub gaps (hubs with no spec coverage)
  const hubGaps: AuditUncoveredFunction[] = index ? allNodes
    .filter(n => (hubNodes.has(n.id) || n.fanIn >= hubThreshold) && !isNodeCovered(n, covered))
    .map(n => toAuditFunction(n, true)) : [];

  // 3. Orphan requirements: requirements that establish no function coverage.
  const orphanRequirements: AuditOrphanRequirement[] = index
    ? orphanRequirementsOf(index, domainScope ?? undefined)
        .map(({ requirement, domain, specFile }) => ({ requirement, domain, specFile }))
    : [];

  // 4. Stale domains (source files modified after spec)
  const staleDomains: AuditStaleDomain[] = snapshot
    ? snapshot.domains
        .filter(d => (!domainScope || domainScope.has(d.name)) && d.sourcesModifiedAt > d.specModifiedAt)
        .map(d => ({
          name: d.name,
          specFile: d.specFile,
          specModifiedAt: d.specModifiedAt,
          sourcesModifiedAt: d.sourcesModifiedAt,
          staleSince: d.sourcesModifiedAt,
        }))
    : [];

  // Preserve the public v2 API's numeric summary. `mappingCoverage` is the
  // authoritative availability signal; transport/composite adapters replace
  // these compatibility zeros with null before serving agent-facing evidence.
  const coveredCount = allNodes.length - uncoveredNodes.length;
  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    mappingCoverage,
    summary: {
      totalFunctions: allNodes.length,
      coveredFunctions: index ? coveredCount : 0,
      coveragePct: index ? (allNodes.length > 0 ? Math.round((coveredCount / allNodes.length) * 100) : 0) : 0,
      uncoveredCount: index ? uncoveredNodes.length : 0,
      hubGapCount: index ? hubGaps.length : 0,
      orphanRequirementCount: index ? orphanRequirements.length : 0,
      staleDomainCount: staleDomains.length,
    },
    uncoveredFunctions,
    hubGaps,
    orphanRequirements,
    staleDomains,
    scenarioVerification: { caveat: SCENARIO_PATH_CAVEAT, scenarios },
  };

  if (shouldSave) {
    await mkdir(analysisDir, { recursive: true });
    await writeFile(join(analysisDir, ARTIFACT_AUDIT_REPORT), JSON.stringify(report, null, 2));
  }

  return report;
}

export function openloreAudit(options: AuditApiOptions = {}): Promise<AuditReport> {
  return withLoggerOptions({ quiet: options.quiet ?? true }, async () => {
    try {
      return await audit(options);
    } catch (error) {
      if (isOpenLoreError(error)) throw error;
      throw errors.pipelineFailed(`Audit failed: ${(error as Error).message}`, error);
    }
  });
}
