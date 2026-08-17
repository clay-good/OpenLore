/**
 * openlore audit — programmatic API
 *
 * Compares current codebase state to the spec snapshot to report coverage gaps.
 * No LLM required.
 */

import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { readOpenLoreConfig } from '../core/services/config-manager.js';
import { SpecSnapshotGenerator } from '../core/analyzer/spec-snapshot-generator.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_AUDIT_REPORT,
  OPENSPEC_DIR,
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
import { normalizeAnchorPath } from '../core/generator/spec-link-index.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import type { SerializedCallGraph, FunctionNode } from '../core/analyzer/call-graph.js';
import { readGenerationSnapshot, REQUIRED_ANALYSIS_ARTIFACTS } from '../core/runtime/analysis-generation.js';

const DEFAULT_MAX_UNCOVERED = 50;
const DEFAULT_HUB_THRESHOLD = 5;

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

export async function openloreAudit(options: AuditApiOptions = {}): Promise<AuditReport> {
  const rootPath = options.rootPath ?? process.cwd();
  const maxUncovered = options.maxUncovered ?? DEFAULT_MAX_UNCOVERED;
  const hubThreshold = options.hubThreshold ?? DEFAULT_HUB_THRESHOLD;
  const shouldSave = options.save ?? true;
  const fileScope = options.files ? new Set(options.files) : null;
  const domainScope = options.domains ? new Set(options.domains) : null;
  const analysisDir = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  // Load (or refresh) snapshot
  const openloreConfig = await readOpenLoreConfig(rootPath);
  const openspecRelPath = openloreConfig?.openspecPath ?? OPENSPEC_DIR;
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

  const llmContext = supplied?.llmContext ?? (llmContextRaw ? JSON.parse(llmContextRaw) as LLMContext : null);
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
  };

  if (shouldSave) {
    await writeFile(join(analysisDir, ARTIFACT_AUDIT_REPORT), JSON.stringify(report, null, 2));
  }

  return report;
}
