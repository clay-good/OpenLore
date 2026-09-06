/**
 * Architecture Writer
 *
 * Shared logic for building a high-level architecture overview from cached
 * static analysis artifacts (dependency-graph.json + llm-context.json).
 *
 * Used by:
 *   - MCP tool `get_architecture_overview` (mcp.ts)
 *   - `openlore analyze` — writes ARCHITECTURE.md into .openlore/analysis/
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DependencyGraphResult } from './dependency-graph.js';
import type { LLMContext } from './artifact-generator.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ClusterSummary {
  id: string;
  name: string;
  fileCount: number;
  role: string;
  entryPointCount: number;
  hubCount: number;
  dependsOn: string[];   // cluster ids
  keyFiles: string[];    // relative paths (hubs + entries, up to 5)
}

export interface ArchitectureOverview {
  generatedAt: string;
  summary: {
    totalFiles: number;
    totalClusters: number;
    totalEdges: number;
    cycles: number;
    layerViolations: number;
  };
  clusters: ClusterSummary[];
  globalEntryPoints: Array<{ name: string; file: string; language: string }>;
  criticalHubs: Array<{ name: string; file: string; fanIn: number; fanOut: number }>;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Infer a module cluster's architectural role from aggregate metrics.
 */
export function inferClusterRole(
  entryCount: number,
  hubCount: number,
  fileCount: number
): string {
  if (entryCount > fileCount * 0.5) return 'entry_layer';   // most files are entry points
  if (hubCount > 0 && entryCount > 0) return 'orchestrator'; // both hubs and entries
  if (hubCount > 0) return 'core_utilities';                 // heavily depended-on helpers
  if (entryCount > 0) return 'api_layer';                    // exposed but not hub-heavy
  return 'internal';                                         // implementation detail
}

// ============================================================================
// BUILD
// ============================================================================

/**
 * Build an ArchitectureOverview from pre-loaded dependency graph and LLM context.
 * Both can be null if one artifact is missing; at least one must be non-null.
 *
 * @param depGraph  Parsed dependency-graph.json (or null)
 * @param ctx       Parsed llm-context.json (or null)
 * @param absDir    Absolute project root path — used to normalize cluster file paths
 */
export function buildArchitectureOverview(
  depGraph: DependencyGraphResult | null,
  ctx: LLMContext | null,
  absDir: string
): ArchitectureOverview {
  // Cluster files use absolute paths; call graph uses relative paths.
  // Normalise both to relative using absDir as base.
  const toRel = (p: string) => p.startsWith(absDir) ? p.slice(absDir.length + 1) : p;

  // Build sets of relative filePaths for hubs / entry points from call graph
  const hubFiles = new Set<string>(
    (ctx?.callGraph?.hubFunctions ?? []).map(h => toRel(h.filePath))
  );
  const entryFiles = new Set<string>(
    (ctx?.callGraph?.entryPoints ?? []).map(e => toRel(e.filePath))
  );

  // Build inter-cluster dependency edges from dep graph edges
  const clusterOfFile = new Map<string, string>(); // absolute path → cluster id
  for (const cl of depGraph?.clusters ?? []) {
    for (const fileId of cl.files) {
      clusterOfFile.set(fileId, cl.id);
    }
  }

  const clusterEdges = new Map<string, Set<string>>();
  for (const edge of depGraph?.edges ?? []) {
    const from = clusterOfFile.get(edge.source);
    const to = clusterOfFile.get(edge.target);
    if (from && to && from !== to) {
      if (!clusterEdges.has(from)) clusterEdges.set(from, new Set());
      clusterEdges.get(from)!.add(to);
    }
  }

  // Summarize clusters
  const clusters: ClusterSummary[] = (depGraph?.clusters ?? [])
    .map(cl => {
      const relFiles = cl.files.map(toRel);
      const clusterHubCount = relFiles.filter(f => hubFiles.has(f)).length;
      const clusterEntryCount = relFiles.filter(f => entryFiles.has(f)).length;
      const role = inferClusterRole(clusterEntryCount, clusterHubCount, cl.files.length);
      const dependsOn = [...(clusterEdges.get(cl.id) ?? [])];

      return {
        id: cl.id,
        name: cl.name ?? cl.id,
        fileCount: cl.files.length,
        role,
        entryPointCount: clusterEntryCount,
        hubCount: clusterHubCount,
        dependsOn,
        keyFiles: relFiles
          .filter(f => hubFiles.has(f) || entryFiles.has(f))
          .slice(0, 5),
      };
    })
    .sort((a, b) => b.fileCount - a.fileCount);

  const globalEntryPoints = (ctx?.callGraph?.entryPoints ?? [])
    .slice(0, 20)
    .map(n => ({ name: n.name, file: n.filePath, language: n.language }));

  const criticalHubs = (ctx?.callGraph?.hubFunctions ?? [])
    .slice(0, 10)
    .map(n => ({ name: n.name, file: n.filePath, fanIn: n.fanIn, fanOut: n.fanOut }));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalFiles: depGraph?.statistics?.nodeCount ?? 0,
      totalClusters: clusters.length,
      totalEdges: depGraph?.statistics?.edgeCount ?? 0,
      cycles: depGraph?.cycles?.length ?? 0,
      layerViolations: ctx?.callGraph?.layerViolations?.length ?? 0,
    },
    clusters,
    globalEntryPoints,
    criticalHubs,
  };
}

// ============================================================================
// MARKDOWN RENDERER
// ============================================================================

const ROLE_BADGE: Record<string, string> = {
  entry_layer:   'entry layer',
  orchestrator:  'orchestrator',
  core_utilities:'core utilities',
  api_layer:     'API layer',
  internal:      'internal',
};

/**
 * Render an ArchitectureOverview as a Markdown document (ARCHITECTURE.md).
 */
export function renderArchitectureMarkdown(overview: ArchitectureOverview): string {
  const { summary, clusters, globalEntryPoints, criticalHubs } = overview;
  const lines: string[] = [];

  lines.push('# Architecture Overview');
  lines.push('');
  lines.push(`> Generated by \`openlore analyze\` on ${overview.generatedAt.slice(0, 10)}.`);
  lines.push('> Re-run `openlore analyze` to refresh.');
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Files | ${summary.totalFiles} |`);
  lines.push(`| Module clusters | ${summary.totalClusters} |`);
  lines.push(`| Dependency edges | ${summary.totalEdges} |`);
  if (summary.cycles > 0) {
    lines.push(`| ⚠️ Cycles | ${summary.cycles} |`);
  }
  if (summary.layerViolations > 0) {
    lines.push(`| ⚠️ Layer violations | ${summary.layerViolations} |`);
  }
  lines.push('');

  // Cluster map
  lines.push('## Module Clusters');
  lines.push('');
  lines.push('Clusters are groups of tightly coupled files detected by static dependency analysis.');
  lines.push('');
  lines.push('| Cluster | Role | Files | Depends on |');
  lines.push('|---------|------|-------|------------|');
  for (const cl of clusters) {
    const role = ROLE_BADGE[cl.role] ?? cl.role;
    const deps = cl.dependsOn.length > 0
      ? cl.dependsOn.map(id => clusters.find(c => c.id === id)?.name ?? id).join(', ')
      : '—';
    lines.push(`| **${cl.name}** | \`${role}\` | ${cl.fileCount} | ${deps} |`);
  }
  lines.push('');

  // Per-cluster detail (only for clusters with key files)
  const withKeys = clusters.filter(cl => cl.keyFiles.length > 0);
  if (withKeys.length > 0) {
    lines.push('### Key files per cluster');
    lines.push('');
    for (const cl of withKeys) {
      lines.push(`**${cl.name}** (\`${ROLE_BADGE[cl.role] ?? cl.role}\`)`);
      for (const f of cl.keyFiles) {
        lines.push(`- \`${f}\``);
      }
      lines.push('');
    }
  }

  // Entry points
  if (globalEntryPoints.length > 0) {
    lines.push('## Entry Points');
    lines.push('');
    lines.push('Functions with no internal callers — the public-facing roots of the codebase.');
    lines.push('');
    for (const ep of globalEntryPoints) {
      lines.push(`- \`${ep.name}\` — \`${ep.file}\` (${ep.language})`);
    }
    lines.push('');
  }

  // Critical hubs
  if (criticalHubs.length > 0) {
    lines.push('## Critical Hubs');
    lines.push('');
    lines.push('High fan-in functions — many callers depend on them. Modify with care.');
    lines.push('');
    lines.push('| Function | File | Fan-in | Fan-out |');
    lines.push('|----------|------|--------|---------|');
    for (const hub of criticalHubs) {
      lines.push(`| \`${hub.name}\` | \`${hub.file}\` | ${hub.fanIn} | ${hub.fanOut} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// FILE WRITER
// ============================================================================

/**
 * Write ARCHITECTURE.md into the given output directory (the analysis dir,
 * `.openlore/analysis/`), alongside CODEBASE.md and the other generated
 * artifacts, so nothing churns at the repo root (Spec 26 B3).
 * Returns the path written.
 */
export async function writeArchitectureMd(
  outputDir: string,
  overview: ArchitectureOverview
): Promise<string> {
  const outPath = join(outputDir, 'ARCHITECTURE.md');
  await writeFile(outPath, renderArchitectureMarkdown(overview), 'utf-8');
  return outPath;
}
