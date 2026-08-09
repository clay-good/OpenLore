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
  ARTIFACT_MAPPING,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_AUDIT_REPORT,
  OPENSPEC_DIR,
} from '../constants.js';
import type {
  AuditReport,
  AuditUncoveredFunction,
  AuditOrphanRequirement,
  AuditStaleDomain,
} from '../types/index.js';
import type { AuditApiOptions } from './types.js';
import type { LLMContext } from '../core/analyzer/artifact-generator.js';
import { mappingSourceFingerprint, type MappingArtifact } from '../core/generator/mapping-generator.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import type { SerializedCallGraph, FunctionNode } from '../core/analyzer/call-graph.js';

const DEFAULT_MAX_UNCOVERED = 50;
const DEFAULT_HUB_THRESHOLD = 5;

// ============================================================================
// HELPERS
// ============================================================================

function buildCoveredSet(mapping: MappingArtifact): Set<string> {
  const covered = new Set<string>();
  for (const m of mapping.mappings) {
    for (const fn of m.functions) {
      if (fn.name && fn.name !== '*') {
        covered.add(`${fn.file}::${fn.name}`);
        covered.add(fn.name);
      }
    }
  }
  return covered;
}

function isNodeCovered(node: FunctionNode, covered: Set<string>): boolean {
  return covered.has(`${node.filePath}::${node.name}`) || covered.has(node.name);
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
  const analysisDir = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  // Load (or refresh) snapshot
  const openloreConfig = await readOpenLoreConfig(rootPath);
  const openspecRelPath = openloreConfig?.openspecPath ?? OPENSPEC_DIR;
  const snapshotGen = new SpecSnapshotGenerator(rootPath, openspecRelPath);
  const snapshot = await snapshotGen.generate().catch(() => null);

  // Load raw artifacts for deep analysis
  const [llmContextRaw, mappingRaw, depGraphRaw] = await Promise.all([
    readFile(join(analysisDir, ARTIFACT_LLM_CONTEXT), 'utf-8').catch(() => null),
    readFile(join(analysisDir, ARTIFACT_MAPPING), 'utf-8').catch(() => null),
    readFile(join(analysisDir, ARTIFACT_DEPENDENCY_GRAPH), 'utf-8').catch(() => null),
  ]);

  const llmContext = llmContextRaw ? JSON.parse(llmContextRaw) as LLMContext : null;
  const mappingPath = join(analysisDir, ARTIFACT_MAPPING);
  let mapping: MappingArtifact | null = null;
  let mappingCoverage: AuditReport['mappingCoverage'] = {
    state: 'missing', reason: 'mapping.json has not been generated', artifactPath: mappingPath,
  };
  if (!mappingRaw) {
    mappingCoverage = { state: 'missing', reason: 'mapping.json has not been generated', artifactPath: mappingPath };
  } else {
    try {
      mapping = JSON.parse(mappingRaw) as MappingArtifact;
      const depGraph = depGraphRaw ? JSON.parse(depGraphRaw) as DependencyGraphResult : null;
      if (!mapping.version || !mapping.sourceAnalysisFingerprint || !depGraph) {
        mappingCoverage = { state: 'stale', reason: 'mapping.json has no compatible source-analysis provenance', artifactPath: mappingPath };
        mapping = null;
      } else if (mapping.sourceAnalysisFingerprint !== mappingSourceFingerprint(depGraph)) {
        mappingCoverage = { state: 'stale', reason: 'mapping.json does not match the current dependency graph', artifactPath: mappingPath };
        mapping = null;
      } else {
        mappingCoverage = { state: 'available', artifactPath: mappingPath };
      }
    } catch {
      mappingCoverage = { state: 'invalid', reason: 'mapping.json is not valid JSON', artifactPath: mappingPath };
    }
  }

  const callGraph = llmContext?.callGraph as SerializedCallGraph | undefined;
  const allNodes = callGraph?.nodes ?? [];
  const hubNodes = new Set((callGraph?.hubFunctions ?? []).map(n => n.id));

  // Build coverage set
  const covered = mapping ? buildCoveredSet(mapping) : new Set<string>();

  // 1. Uncovered functions
  // A missing or stale mapping cannot establish either coverage or a gap.  Do
  // not turn absence of this optional provenance artifact into a fabricated
  // list of uncovered functions.
  const uncoveredNodes = mapping ? allNodes.filter(n => !isNodeCovered(n, covered)) : [];
  const uncoveredFunctions: AuditUncoveredFunction[] = uncoveredNodes
    .slice(0, maxUncovered)
    .map(n => toAuditFunction(n, hubNodes.has(n.id) || n.fanIn >= hubThreshold));

  // 2. Hub gaps (hubs with no spec coverage)
  const hubGaps: AuditUncoveredFunction[] = mapping ? allNodes
    .filter(n => (hubNodes.has(n.id) || n.fanIn >= hubThreshold) && !isNodeCovered(n, covered))
    .map(n => toAuditFunction(n, true)) : [];

  // 3. Orphan requirements (requirements in mapping with no matched function)
  const orphanRequirements: AuditOrphanRequirement[] = mapping
    ? mapping.mappings
        .filter(m => m.functions.length === 0 || m.functions.every(f => f.name === '*'))
        .map(m => ({ requirement: m.requirement, domain: m.domain, specFile: m.specFile }))
    : [];

  // 4. Stale domains (source files modified after spec)
  const staleDomains: AuditStaleDomain[] = snapshot
    ? snapshot.domains
        .filter(d => d.sourcesModifiedAt > d.specModifiedAt)
        .map(d => ({
          name: d.name,
          specFile: d.specFile,
          specModifiedAt: d.specModifiedAt,
          sourcesModifiedAt: d.sourcesModifiedAt,
          staleSince: d.sourcesModifiedAt,
        }))
    : [];

  const coveredCount = mapping ? allNodes.length - uncoveredNodes.length : 0;
  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    mappingCoverage,
    summary: {
      totalFunctions: allNodes.length,
      coveredFunctions: coveredCount,
      coveragePct: allNodes.length > 0 ? Math.round((coveredCount / allNodes.length) * 100) : 0,
      uncoveredCount: uncoveredNodes.length,
      hubGapCount: hubGaps.length,
      orphanRequirementCount: orphanRequirements.length,
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
