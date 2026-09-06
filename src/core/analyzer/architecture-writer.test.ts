/**
 * Architecture Writer Tests
 *
 * Covers:
 *   - inferClusterRole (pure, 5 branches)
 *   - buildArchitectureOverview (pure, various inputs)
 *   - renderArchitectureMarkdown (pure, markdown structure)
 *   - writeArchitectureMd (async file writer)
 */

import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  inferClusterRole,
  buildArchitectureOverview,
  renderArchitectureMarkdown,
  writeArchitectureMd,
} from './architecture-writer.js';
import type { ArchitectureOverview } from './architecture-writer.js';
import type { DependencyGraphResult, DependencyEdge, FileCluster } from './dependency-graph.js';
import type { LLMContext } from './artifact-generator.js';
import type { SerializedCallGraph, FunctionNode, LayerViolation } from './call-graph.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// FIXTURES
// ============================================================================

function makeCluster(overrides: Partial<FileCluster> & { id: string; files: string[] }): FileCluster {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    files: overrides.files,
    internalEdges: overrides.internalEdges ?? 0,
    externalEdges: overrides.externalEdges ?? 0,
    cohesion: overrides.cohesion ?? 0,
    coupling: overrides.coupling ?? 0,
    suggestedDomain: overrides.suggestedDomain ?? 'general',
    color: overrides.color ?? '#ccc',
    isStructural: overrides.isStructural ?? false,
  };
}

function makeEdge(source: string, target: string): DependencyEdge {
  return { source, target, importedNames: [], isTypeOnly: false, weight: 1 };
}

function makeFn(name: string, filePath: string): FunctionNode {
  return { id: `${filePath}::${name}`, name, filePath, language: 'typescript', isAsync: false, startIndex: 0, endIndex: 100, fanIn: 0, fanOut: 1 };
}

function makeCallGraph(
  entryPoints: FunctionNode[] = [],
  hubFunctions: FunctionNode[] = [],
  layerViolations: LayerViolation[] = [],
): SerializedCallGraph {
  return {
    nodes: [],
    edges: [],
    classes: [],
    inheritanceEdges: [],
    entryPoints,
    hubFunctions,
    layerViolations,
    stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
}

function makeDepGraph(overrides: Partial<DependencyGraphResult> = {}): DependencyGraphResult {
  return {
    nodes: [],
    edges: [],
    clusters: [],
    structuralClusters: [],
    cycles: [],
    rankings: {
      byImportance: [],
      byConnectivity: [],
      clusterCenters: [],
      leafNodes: [],
      bridgeNodes: [],
      orphanNodes: [],
    },
    statistics: {
      nodeCount: 5,
      edgeCount: 3,
      importEdgeCount: 3,
      httpEdgeCount: 0,
      avgDegree: 1.2,
      density: 0.1,
      clusterCount: 0,
      structuralClusterCount: 0,
      cycleCount: 0,
    },
    ...overrides,
  };
}

function makeCtx(callGraph?: SerializedCallGraph): LLMContext {
  return {
    phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
    phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
    phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
    callGraph,
  };
}

function makeOverview(overrides: Partial<ArchitectureOverview> = {}): ArchitectureOverview {
  return {
    generatedAt: '2026-03-12T00:00:00.000Z',
    summary: { totalFiles: 10, totalClusters: 2, totalEdges: 5, cycles: 0, layerViolations: 0 },
    clusters: [],
    globalEntryPoints: [],
    criticalHubs: [],
    ...overrides,
  };
}

// ============================================================================
// inferClusterRole
// ============================================================================

describe('inferClusterRole', () => {
  it('returns entry_layer when entries > 50% of files', () => {
    // 4 entries / 6 files = 66%
    expect(inferClusterRole(4, 0, 6)).toBe('entry_layer');
  });

  it('returns entry_layer when entries equal fileCount', () => {
    expect(inferClusterRole(5, 0, 5)).toBe('entry_layer');
  });

  it('returns orchestrator when both hubs and entries exist (but entries ≤ 50%)', () => {
    // 2/6 = 33%, 1 hub
    expect(inferClusterRole(2, 1, 6)).toBe('orchestrator');
  });

  it('returns core_utilities when hubs exist but no entries', () => {
    expect(inferClusterRole(0, 3, 10)).toBe('core_utilities');
  });

  it('returns api_layer when entries exist but no hubs (and entries ≤ 50%)', () => {
    // 1/10 = 10%
    expect(inferClusterRole(1, 0, 10)).toBe('api_layer');
  });

  it('returns internal when neither hubs nor entries', () => {
    expect(inferClusterRole(0, 0, 8)).toBe('internal');
  });
});

// ============================================================================
// buildArchitectureOverview
// ============================================================================

describe('buildArchitectureOverview', () => {
  const ROOT = '/project/root';

  it('returns empty overview when both depGraph and ctx are null', () => {
    const overview = buildArchitectureOverview(null, null, ROOT);
    expect(overview.summary.totalFiles).toBe(0);
    expect(overview.summary.totalEdges).toBe(0);
    expect(overview.summary.cycles).toBe(0);
    expect(overview.clusters).toHaveLength(0);
    expect(overview.globalEntryPoints).toHaveLength(0);
    expect(overview.criticalHubs).toHaveLength(0);
  });

  it('uses depGraph statistics when provided', () => {
    const graph = makeDepGraph({
      statistics: {
        nodeCount: 42, edgeCount: 100, importEdgeCount: 80, httpEdgeCount: 20,
        avgDegree: 2.5, density: 0.05, clusterCount: 3, structuralClusterCount: 2, cycleCount: 0,
      },
    });
    const overview = buildArchitectureOverview(graph, null, ROOT);
    expect(overview.summary.totalFiles).toBe(42);
    expect(overview.summary.totalEdges).toBe(100);
  });

  it('counts cycles from depGraph', () => {
    const graph = makeDepGraph({ cycles: [['a', 'b', 'a'], ['c', 'd', 'c']] });
    const overview = buildArchitectureOverview(graph, null, ROOT);
    expect(overview.summary.cycles).toBe(2);
  });

  it('normalizes absolute file paths in clusters to relative', () => {
    const graph = makeDepGraph({
      clusters: [makeCluster({ id: 'c1', name: 'Core', files: [`${ROOT}/src/index.ts`, `${ROOT}/src/util.ts`] })],
    });
    const overview = buildArchitectureOverview(graph, null, ROOT);
    expect(overview.clusters).toHaveLength(1);
    expect(overview.clusters[0].fileCount).toBe(2);
    expect(overview.clusters[0].name).toBe('Core');
  });

  it('assigns orchestrator role when cluster has both hub and entry files', () => {
    const graph = makeDepGraph({
      clusters: [makeCluster({ id: 'c1', name: 'API', files: [`${ROOT}/a.ts`, `${ROOT}/b.ts`, `${ROOT}/c.ts`, `${ROOT}/d.ts`] })],
    });
    const ctx = makeCtx(makeCallGraph(
      [{ ...makeFn('main', `${ROOT}/a.ts`), fanIn: 0 }],    // 1 entry (25%)
      [{ ...makeFn('util', `${ROOT}/b.ts`), fanIn: 3 }],    // 1 hub
    ));
    const overview = buildArchitectureOverview(graph, ctx, ROOT);
    expect(overview.clusters[0].role).toBe('orchestrator');
  });

  it('assigns entry_layer role when majority of files are entry points', () => {
    const graph = makeDepGraph({
      clusters: [makeCluster({ id: 'c1', name: 'Routes', files: [`${ROOT}/a.ts`, `${ROOT}/b.ts`, `${ROOT}/c.ts`] })],
    });
    // 2/3 entries = 66% > 50% → entry_layer
    const ctx = makeCtx(makeCallGraph([makeFn('a', `${ROOT}/a.ts`), makeFn('b', `${ROOT}/b.ts`)]));
    const overview = buildArchitectureOverview(graph, ctx, ROOT);
    expect(overview.clusters[0].role).toBe('entry_layer');
  });

  it('assigns core_utilities role when cluster has hubs but no entries', () => {
    const graph = makeDepGraph({
      clusters: [makeCluster({ id: 'c1', name: 'Util', files: [`${ROOT}/util.ts`, `${ROOT}/helper.ts`] })],
    });
    const ctx = makeCtx(makeCallGraph([], [makeFn('helper', `${ROOT}/helper.ts`)]));
    const overview = buildArchitectureOverview(graph, ctx, ROOT);
    expect(overview.clusters[0].role).toBe('core_utilities');
  });

  it('assigns internal role when no entries or hubs', () => {
    const graph = makeDepGraph({
      clusters: [makeCluster({ id: 'c1', name: 'Misc', files: [`${ROOT}/misc.ts`] })],
    });
    const overview = buildArchitectureOverview(graph, null, ROOT);
    expect(overview.clusters[0].role).toBe('internal');
  });

  it('builds inter-cluster dependency edges', () => {
    const graph = makeDepGraph({
      clusters: [
        makeCluster({ id: 'c1', name: 'A', files: [`${ROOT}/a.ts`] }),
        makeCluster({ id: 'c2', name: 'B', files: [`${ROOT}/b.ts`] }),
      ],
      edges: [makeEdge(`${ROOT}/a.ts`, `${ROOT}/b.ts`)],
    });
    const overview = buildArchitectureOverview(graph, null, ROOT);
    const clusterA = overview.clusters.find(c => c.id === 'c1');
    expect(clusterA?.dependsOn).toContain('c2');
  });

  it('does not create self-referential cluster dependencies', () => {
    const graph = makeDepGraph({
      clusters: [makeCluster({ id: 'c1', name: 'A', files: [`${ROOT}/a.ts`, `${ROOT}/b.ts`] })],
      edges: [makeEdge(`${ROOT}/a.ts`, `${ROOT}/b.ts`)],
    });
    const overview = buildArchitectureOverview(graph, null, ROOT);
    expect(overview.clusters[0].dependsOn).toHaveLength(0);
  });

  it('populates globalEntryPoints from ctx callGraph (max 20)', () => {
    const entries = Array.from({ length: 25 }, (_, i) => makeFn(`ep${i}`, `${ROOT}/ep${i}.ts`));
    const ctx = makeCtx(makeCallGraph(entries));
    const overview = buildArchitectureOverview(null, ctx, ROOT);
    expect(overview.globalEntryPoints).toHaveLength(20);
  });

  it('populates criticalHubs from ctx callGraph (max 10)', () => {
    const hubs = Array.from({ length: 15 }, (_, i) => ({ ...makeFn(`hub${i}`, `${ROOT}/hub${i}.ts`), fanIn: 5 }));
    const ctx = makeCtx(makeCallGraph([], hubs));
    const overview = buildArchitectureOverview(null, ctx, ROOT);
    expect(overview.criticalHubs).toHaveLength(10);
  });

  it('counts layer violations from ctx callGraph', () => {
    const violations: LayerViolation[] = [
      { callerId: 'a::fn', calleeId: 'b::fn', callerLayer: 'api', calleeLayer: 'db', reason: 'x' },
      { callerId: 'c::fn', calleeId: 'd::fn', callerLayer: 'api', calleeLayer: 'db', reason: 'y' },
    ];
    const ctx = makeCtx(makeCallGraph([], [], violations));
    const overview = buildArchitectureOverview(null, ctx, ROOT);
    expect(overview.summary.layerViolations).toBe(2);
  });

  it('sorts clusters by fileCount descending', () => {
    const graph = makeDepGraph({
      clusters: [
        makeCluster({ id: 'c1', name: 'Small', files: [`${ROOT}/a.ts`] }),
        makeCluster({ id: 'c2', name: 'Large', files: [`${ROOT}/b.ts`, `${ROOT}/c.ts`, `${ROOT}/d.ts`] }),
        makeCluster({ id: 'c3', name: 'Medium', files: [`${ROOT}/e.ts`, `${ROOT}/f.ts`] }),
      ],
    });
    const overview = buildArchitectureOverview(graph, null, ROOT);
    expect(overview.clusters[0].name).toBe('Large');
    expect(overview.clusters[1].name).toBe('Medium');
    expect(overview.clusters[2].name).toBe('Small');
  });

  it('limits keyFiles to 5', () => {
    const files = Array.from({ length: 8 }, (_, i) => `${ROOT}/f${i}.ts`);
    const graph = makeDepGraph({ clusters: [makeCluster({ id: 'c1', name: 'Big', files })] });
    const entries = files.map((f, i) => makeFn(`ep${i}`, f));
    const ctx = makeCtx(makeCallGraph(entries));
    const overview = buildArchitectureOverview(graph, ctx, ROOT);
    expect(overview.clusters[0].keyFiles).toHaveLength(5);
  });

  it('sets generatedAt to a valid ISO timestamp', () => {
    const overview = buildArchitectureOverview(null, null, ROOT);
    expect(new Date(overview.generatedAt).toISOString()).toBe(overview.generatedAt);
  });
});

// ============================================================================
// renderArchitectureMarkdown
// ============================================================================

describe('renderArchitectureMarkdown', () => {
  it('includes title and generated-at date', () => {
    const md = renderArchitectureMarkdown(makeOverview());
    expect(md).toContain('# Architecture Overview');
    expect(md).toContain('2026-03-12');
  });

  it('renders summary table with files, clusters, and edges', () => {
    const overview = makeOverview({
      summary: { totalFiles: 42, totalClusters: 3, totalEdges: 15, cycles: 0, layerViolations: 0 },
    });
    const md = renderArchitectureMarkdown(overview);
    expect(md).toContain('| Files | 42 |');
    expect(md).toContain('| Module clusters | 3 |');
    expect(md).toContain('| Dependency edges | 15 |');
  });

  it('does NOT show cycles row when cycles === 0', () => {
    const md = renderArchitectureMarkdown(makeOverview());
    expect(md).not.toContain('Cycles');
  });

  it('shows cycles row when cycles > 0', () => {
    const overview = makeOverview({ summary: { ...makeOverview().summary, cycles: 3 } });
    const md = renderArchitectureMarkdown(overview);
    expect(md).toContain('Cycles');
    expect(md).toContain('3');
  });

  it('does NOT show layer violations row when layerViolations === 0', () => {
    const md = renderArchitectureMarkdown(makeOverview());
    expect(md).not.toContain('Layer violations');
  });

  it('shows layer violations row when layerViolations > 0', () => {
    const overview = makeOverview({ summary: { ...makeOverview().summary, layerViolations: 2 } });
    const md = renderArchitectureMarkdown(overview);
    expect(md).toContain('Layer violations');
    expect(md).toContain('2');
  });

  it('renders cluster table with role badge', () => {
    const overview = makeOverview({
      clusters: [{
        id: 'c1', name: 'Core', fileCount: 5, role: 'core_utilities',
        entryPointCount: 0, hubCount: 2, dependsOn: [], keyFiles: [],
      }],
    });
    const md = renderArchitectureMarkdown(overview);
    expect(md).toContain('## Module Clusters');
    expect(md).toContain('**Core**');
    expect(md).toContain('core utilities');
    expect(md).toContain('5');
  });

  it('renders cluster dependency names (not IDs)', () => {
    const overview = makeOverview({
      clusters: [
        { id: 'c1', name: 'API', fileCount: 3, role: 'api_layer', entryPointCount: 1, hubCount: 0, dependsOn: ['c2'], keyFiles: [] },
        { id: 'c2', name: 'DB', fileCount: 2, role: 'internal', entryPointCount: 0, hubCount: 0, dependsOn: [], keyFiles: [] },
      ],
    });
    const md = renderArchitectureMarkdown(overview);
    expect(md).toContain('DB');
    // The raw ID "c2" should not appear as a standalone column value
    expect(md).not.toMatch(/\| c2 \|/);
  });

  it('shows "—" when cluster has no dependencies', () => {
    const overview = makeOverview({
      clusters: [{ id: 'c1', name: 'Util', fileCount: 2, role: 'internal', entryPointCount: 0, hubCount: 0, dependsOn: [], keyFiles: [] }],
    });
    const md = renderArchitectureMarkdown(overview);
    expect(md).toContain('—');
  });

  it('renders key files per cluster section when keyFiles exist', () => {
    const overview = makeOverview({
      clusters: [{ id: 'c1', name: 'Core', fileCount: 2, role: 'core_utilities', entryPointCount: 0, hubCount: 1, dependsOn: [], keyFiles: ['src/util.ts'] }],
    });
    const md = renderArchitectureMarkdown(overview);
    expect(md).toContain('### Key files per cluster');
    expect(md).toContain('src/util.ts');
  });

  it('does NOT render key files section when no cluster has keyFiles', () => {
    const overview = makeOverview({
      clusters: [{ id: 'c1', name: 'Misc', fileCount: 1, role: 'internal', entryPointCount: 0, hubCount: 0, dependsOn: [], keyFiles: [] }],
    });
    const md = renderArchitectureMarkdown(overview);
    expect(md).not.toContain('### Key files per cluster');
  });

  it('renders Entry Points section when present', () => {
    const overview = makeOverview({
      globalEntryPoints: [{ name: 'main', file: 'src/index.ts', language: 'typescript' }],
    });
    const md = renderArchitectureMarkdown(overview);
    expect(md).toContain('## Entry Points');
    expect(md).toContain('`main`');
    expect(md).toContain('src/index.ts');
  });

  it('does NOT render Entry Points section when empty', () => {
    const md = renderArchitectureMarkdown(makeOverview({ globalEntryPoints: [] }));
    expect(md).not.toContain('## Entry Points');
  });

  it('renders Critical Hubs section when present', () => {
    const overview = makeOverview({
      criticalHubs: [{ name: 'router', file: 'src/router.ts', fanIn: 12, fanOut: 3 }],
    });
    const md = renderArchitectureMarkdown(overview);
    expect(md).toContain('## Critical Hubs');
    expect(md).toContain('`router`');
    expect(md).toContain('12');
  });

  it('does NOT render Critical Hubs section when empty', () => {
    const md = renderArchitectureMarkdown(makeOverview({ criticalHubs: [] }));
    expect(md).not.toContain('## Critical Hubs');
  });

  it('uses correct ROLE_BADGE labels for all roles', () => {
    const roles: Array<[string, string]> = [
      ['entry_layer', 'entry layer'],
      ['orchestrator', 'orchestrator'],
      ['core_utilities', 'core utilities'],
      ['api_layer', 'API layer'],
      ['internal', 'internal'],
    ];
    for (const [role, label] of roles) {
      const overview = makeOverview({
        clusters: [{ id: 'c1', name: 'X', fileCount: 1, role, entryPointCount: 0, hubCount: 0, dependsOn: [], keyFiles: [] }],
      });
      expect(renderArchitectureMarkdown(overview)).toContain(label);
    }
  });
});

// ============================================================================
// writeArchitectureMd
// ============================================================================

describe('writeArchitectureMd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes ARCHITECTURE.md into the given output dir and returns the path', async () => {
    const { writeFile } = await import('node:fs/promises');
    const overview = makeOverview();
    const outputDir = join('/my/project', '.openlore', 'analysis');
    const result = await writeArchitectureMd(outputDir, overview);

    // A real filesystem path, so the NATIVE separator is the correct output — the
    // expectation is built the same way rather than hard-coding the POSIX form.
    expect(result).toBe(join(outputDir, 'ARCHITECTURE.md'));
    expect(writeFile).toHaveBeenCalledWith(
      join(outputDir, 'ARCHITECTURE.md'),
      expect.stringContaining('# Architecture Overview'),
      'utf-8',
    );
  });

  it('writes rendered markdown content', async () => {
    const { writeFile } = await import('node:fs/promises');
    const overview = makeOverview({
      summary: { totalFiles: 7, totalClusters: 1, totalEdges: 2, cycles: 0, layerViolations: 0 },
    });
    await writeArchitectureMd('/root/.openlore/analysis', overview);

    const [, content] = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(content).toContain('| Files | 7 |');
  });
});
