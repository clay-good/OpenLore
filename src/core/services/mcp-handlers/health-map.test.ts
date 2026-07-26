/**
 * Tests for handleGetHealthMap — structural health dashboard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (dir: string) => dir),
  readCachedContext: vi.fn(async () => null),
}));

vi.mock('../../provenance/change-coupling.js', () => ({
  volatilityLevel: vi.fn((churn: number) => (churn >= 12 ? 'high' : churn >= 5 ? 'medium' : 'low')),
}));

import { handleGetHealthMap } from './health-map.js';
import { readCachedContext } from './utils.js';
import { TOOL_OUTPUT_CLASS } from './tool-contract.js';
import type { FunctionNode, CallEdge, SerializedCallGraph, LayerViolation } from '../../analyzer/call-graph.js';

const mockCtx = vi.mocked(readCachedContext);

// ============================================================================
// Helpers
// ============================================================================

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id,
    filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false,
    language: 'typescript',
    startIndex: 0,
    endIndex: 1,
    fanIn: 0,
    fanOut: 0,
    ...over,
  };
}

function violation(callerId: string, calleeId: string): LayerViolation {
  return { callerId, calleeId, callerLayer: 'cli', calleeLayer: 'core', reason: 'layer-skip' };
}

function graph(
  nodes: FunctionNode[],
  edges: CallEdge[] = [],
  layerViolations: LayerViolation[] = [],
): SerializedCallGraph {
  return {
    nodes,
    edges,
    classes: [],
    inheritanceEdges: [],
    hubFunctions: [],
    entryPoints: [],
    layerViolations,
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
}

function noEdgeStore() {
  return undefined;
}

function edgeStore(records: Array<{ filePath: string; churn: number }>) {
  return {
    countChangeCoupling: () => records.length,
    getTopVolatile: (n: number) =>
      [...records].sort((a, b) => b.churn - a.churn).slice(0, n),
  };
}

// ============================================================================
// Error paths
// ============================================================================

describe('handleGetHealthMap — error paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('errors when no analysis cached', async () => {
    mockCtx.mockResolvedValue(null as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as { error: string };
    expect(r.error).toMatch(/No analysis found/);
  });

  it('errors when call graph absent from cache', async () => {
    mockCtx.mockResolvedValue({ callGraph: undefined } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as { error: string };
    expect(r.error).toMatch(/Call graph not available/);
  });
});

// ============================================================================
// Empty graph
// ============================================================================

describe('handleGetHealthMap — empty graph', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns zero-counts on an empty graph', async () => {
    mockCtx.mockResolvedValue({ callGraph: graph([], []) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      summary: { totalFunctions: number; hubCount: number; godFunctionCount: number; layerViolationCount: number; volatileFileCount: number; bridgeCount: number; untestedHotspotCount: number; betweennessApprox: boolean; betweennessSourceCount: number };
      topRisks: unknown[];
    };
    expect(r.summary).toEqual({
      totalFunctions: 0,
      hubCount: 0,
      godFunctionCount: 0,
      layerViolationCount: 0,
      volatileFileCount: 0,
      bridgeCount: 0,
      untestedHotspotCount: 0,
      betweennessApprox: false,
      betweennessSourceCount: 0,
    });
    expect(r.topRisks).toEqual([]);
  });
});

// ============================================================================
// Hub detection (fanIn >= 5)
// ============================================================================

describe('handleGetHealthMap — hubs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('identifies hub nodes and excludes sub-threshold nodes', async () => {
    const hub = node({ id: 'src/a.ts::hub', fanIn: 10 });
    const notHub = node({ id: 'src/b.ts::small', fanIn: 4 });
    mockCtx.mockResolvedValue({ callGraph: graph([hub, notHub]) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      summary: { hubCount: number };
      hotspots: { hubs: Array<{ name: string; fanIn: number }> };
    };
    expect(r.summary.hubCount).toBe(1);
    expect(r.hotspots.hubs).toHaveLength(1);
    expect(r.hotspots.hubs[0].name).toBe('hub');
    expect(r.hotspots.hubs[0].fanIn).toBe(10);
  });

  it('sorts hubs descending by fanIn', async () => {
    const nodes = [
      node({ id: 'src/a.ts::low', fanIn: 5 }),
      node({ id: 'src/b.ts::high', fanIn: 20 }),
      node({ id: 'src/c.ts::mid', fanIn: 12 }),
    ];
    mockCtx.mockResolvedValue({ callGraph: graph(nodes) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      hotspots: { hubs: Array<{ name: string }> };
    };
    expect(r.hotspots.hubs.map(h => h.name)).toEqual(['high', 'mid', 'low']);
  });

  it('excludes external and test nodes', async () => {
    const ext = node({ id: 'src/a.ts::ext', fanIn: 20, isExternal: true });
    const tst = node({ id: 'src/a.test.ts::testHelper', fanIn: 20, isTest: true });
    const internal = node({ id: 'src/b.ts::real', fanIn: 8 });
    mockCtx.mockResolvedValue({ callGraph: graph([ext, tst, internal]) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      summary: { totalFunctions: number; hubCount: number };
    };
    expect(r.summary.totalFunctions).toBe(1);
    expect(r.summary.hubCount).toBe(1);
  });
});

// ============================================================================
// God function detection (fanOut >= 8)
// ============================================================================

describe('handleGetHealthMap — god functions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('identifies god functions and excludes sub-threshold', async () => {
    const god = node({ id: 'src/a.ts::dispatch', fanOut: 12 });
    const normal = node({ id: 'src/b.ts::simple', fanOut: 3 });
    mockCtx.mockResolvedValue({ callGraph: graph([god, normal]) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      summary: { godFunctionCount: number };
      hotspots: { godFunctions: Array<{ name: string; fanOut: number }> };
    };
    expect(r.summary.godFunctionCount).toBe(1);
    expect(r.hotspots.godFunctions[0].name).toBe('dispatch');
    expect(r.hotspots.godFunctions[0].fanOut).toBe(12);
  });

  it('sorts god functions descending by fanOut', async () => {
    const nodes = [
      node({ id: 'src/a.ts::a', fanOut: 8 }),
      node({ id: 'src/b.ts::b', fanOut: 30 }),
    ];
    mockCtx.mockResolvedValue({ callGraph: graph(nodes) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      hotspots: { godFunctions: Array<{ name: string }> };
    };
    expect(r.hotspots.godFunctions[0].name).toBe('b');
  });
});

// ============================================================================
// Layer violations
// ============================================================================

describe('handleGetHealthMap — layer violations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts layer violations and surfaces them in topRisks', async () => {
    const caller = node({ id: 'src/a.ts::caller', fanIn: 6 });
    const callee = node({ id: 'src/b.ts::callee', fanIn: 1 });
    const violations: LayerViolation[] = [violation(caller.id, callee.id)];
    mockCtx.mockResolvedValue({ callGraph: graph([caller, callee], [], violations) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      summary: { layerViolationCount: number };
      topRisks: Array<{ name: string; reasons: string[] }>;
    };
    expect(r.summary.layerViolationCount).toBe(1);
    const risk = r.topRisks.find(x => x.name === 'caller');
    expect(risk).toBeDefined();
    expect(risk!.reasons).toContain('layer violation');
  });

  it('enriches callee-side file with violation signal too', async () => {
    const caller = node({ id: 'src/a.ts::caller', fanIn: 1 });
    const callee = node({ id: 'src/b.ts::calleeHub', fanIn: 7 });
    const violations: LayerViolation[] = [violation(caller.id, callee.id)];
    mockCtx.mockResolvedValue({ callGraph: graph([caller, callee], [], violations) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      topRisks: Array<{ name: string; reasons: string[] }>;
    };
    const risk = r.topRisks.find(x => x.name === 'calleeHub');
    expect(risk).toBeDefined();
    expect(risk!.reasons).toContain('layer violation');
  });
});

// ============================================================================
// Volatile files (edgeStore)
// ============================================================================

describe('handleGetHealthMap — volatile files', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists volatile files when edgeStore has data', async () => {
    const store = edgeStore([
      { filePath: 'src/hot.ts', churn: 20 },
      { filePath: 'src/cold.ts', churn: 1 },
    ]);
    mockCtx.mockResolvedValue({ callGraph: graph([]), edgeStore: store } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      summary: { volatileFileCount: number };
      hotspots: { volatile: Array<{ file: string; level: string; changes: number }> };
    };
    expect(r.summary.volatileFileCount).toBe(2);
    expect(r.hotspots.volatile[0]).toMatchObject({ file: 'src/hot.ts', level: 'high', changes: 20 });
  });

  it('reports zero volatile files when edgeStore is absent', async () => {
    mockCtx.mockResolvedValue({ callGraph: graph([]), edgeStore: noEdgeStore() } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      summary: { volatileFileCount: number };
      hotspots: { volatile: unknown[] };
    };
    expect(r.summary.volatileFileCount).toBe(0);
    expect(r.hotspots.volatile).toEqual([]);
  });

  it('reports zero volatile files when countChangeCoupling is zero', async () => {
    const store = { countChangeCoupling: () => 0, getTopVolatile: () => [] };
    mockCtx.mockResolvedValue({ callGraph: graph([]), edgeStore: store } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      summary: { volatileFileCount: number };
    };
    expect(r.summary.volatileFileCount).toBe(0);
  });

  it('hotspots.volatile is capped at min(limit, 5) while summary.volatileFileCount reflects full count', async () => {
    const records = Array.from({ length: 20 }, (_, i) => ({ filePath: `src/f${i}.ts`, churn: 20 - i }));
    const store = edgeStore(records);
    mockCtx.mockResolvedValue({ callGraph: graph([]), edgeStore: store } as never);
    const r = await handleGetHealthMap({ directory: '/p', limit: 10 }) as {
      summary: { volatileFileCount: number };
      hotspots: { volatile: unknown[] };
    };
    expect(r.summary.volatileFileCount).toBe(20);
    expect(r.hotspots.volatile.length).toBeLessThanOrEqual(5);
  });

  it('marks topRisk as volatile when its file appears in volatile list', async () => {
    const hub = node({ id: 'src/hot.ts::bigHub', fanIn: 8 });
    const store = edgeStore([{ filePath: 'src/hot.ts', churn: 15 }]);
    mockCtx.mockResolvedValue({ callGraph: graph([hub]), edgeStore: store } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      topRisks: Array<{ name: string; reasons: string[] }>;
    };
    const risk = r.topRisks.find(x => x.name === 'bigHub');
    expect(risk!.reasons).toContain('volatile file');
  });
});

// ============================================================================
// Severity ranking
// ============================================================================

describe('handleGetHealthMap — severity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rates medium for single signal', async () => {
    const hub = node({ id: 'src/a.ts::singleHub', fanIn: 6 });
    mockCtx.mockResolvedValue({ callGraph: graph([hub]) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      topRisks: Array<{ severity: string }>;
    };
    expect(r.topRisks[0].severity).toBe('medium');
  });

  it('rates high for two signals (hub + volatile)', async () => {
    const hub = node({ id: 'src/a.ts::dualRisk', fanIn: 7 });
    const store = edgeStore([{ filePath: 'src/a.ts', churn: 20 }]);
    mockCtx.mockResolvedValue({ callGraph: graph([hub]), edgeStore: store } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      topRisks: Array<{ severity: string }>;
    };
    expect(r.topRisks[0].severity).toBe('high');
  });

  it('rates critical for three or more signals', async () => {
    const hubGod = node({ id: 'src/a.ts::tripleRisk', fanIn: 9, fanOut: 10 });
    const plain = node({ id: 'src/b.ts::callee', fanIn: 0 });
    const violations: LayerViolation[] = [violation(hubGod.id, plain.id)];
    const store = edgeStore([{ filePath: 'src/a.ts', churn: 30 }]);
    mockCtx.mockResolvedValue({ callGraph: graph([hubGod, plain], [], violations), edgeStore: store } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      topRisks: Array<{ name: string; severity: string; reasons: string[] }>;
    };
    const risk = r.topRisks.find(x => x.name === 'tripleRisk');
    expect(risk!.severity).toBe('critical');
    expect(risk!.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('sorts topRisks critical → high → medium', async () => {
    const hubGod = node({ id: 'src/a.ts::big', fanIn: 10, fanOut: 15 });
    const violations: LayerViolation[] = [violation(hubGod.id, 'src/x.ts::x')];
    const store = edgeStore([{ filePath: 'src/a.ts', churn: 20 }]);
    const hubOnly = node({ id: 'src/b.ts::hubOnly', fanIn: 6 });
    mockCtx.mockResolvedValue({
      callGraph: graph([hubGod, hubOnly], [], violations),
      edgeStore: store,
    } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      topRisks: Array<{ severity: string }>;
    };
    const severities = r.topRisks.map(x => x.severity);
    const order = { critical: 0, high: 1, medium: 2 } as Record<string, number>;
    for (let i = 1; i < severities.length; i++) {
      expect(order[severities[i]]).toBeGreaterThanOrEqual(order[severities[i - 1]]);
    }
  });
});

// ============================================================================
// topRisks deduplication (hub + god function same node)
// ============================================================================

describe('handleGetHealthMap — deduplication', () => {
  beforeEach(() => vi.clearAllMocks());

  it('merges hub+god same node into one topRisk entry with both reasons', async () => {
    const both = node({ id: 'src/a.ts::megaFn', fanIn: 10, fanOut: 12 });
    mockCtx.mockResolvedValue({ callGraph: graph([both]) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      topRisks: Array<{ name: string; reasons: string[] }>;
    };
    const entries = r.topRisks.filter(x => x.name === 'megaFn');
    expect(entries).toHaveLength(1);
    expect(entries[0].reasons).toContain('hub (10 callers)');
    expect(entries[0].reasons).toContain('god function (12 callees)');
  });
});

// ============================================================================
// limit clamping
// ============================================================================

describe('handleGetHealthMap — limit', () => {
  beforeEach(() => vi.clearAllMocks());

  function manyHubs(n: number) {
    return Array.from({ length: n }, (_, i) =>
      node({ id: `src/f${i}.ts::f${i}`, fanIn: 5 + i }),
    );
  }

  it('defaults to limit=10', async () => {
    const nodes = manyHubs(20);
    mockCtx.mockResolvedValue({ callGraph: graph(nodes) } as never);
    const r = await handleGetHealthMap({ directory: '/p' }) as {
      topRisks: unknown[];
    };
    expect(r.topRisks.length).toBeLessThanOrEqual(10);
  });

  it('respects explicit limit', async () => {
    const nodes = manyHubs(20);
    mockCtx.mockResolvedValue({ callGraph: graph(nodes) } as never);
    const r = await handleGetHealthMap({ directory: '/p', limit: 5 }) as {
      topRisks: unknown[];
    };
    expect(r.topRisks.length).toBeLessThanOrEqual(5);
  });

  it('clamps limit to minimum 1', async () => {
    const nodes = manyHubs(5);
    mockCtx.mockResolvedValue({ callGraph: graph(nodes) } as never);
    const r = await handleGetHealthMap({ directory: '/p', limit: 0 }) as {
      topRisks: unknown[];
    };
    expect(r.topRisks.length).toBeGreaterThanOrEqual(1);
  });

  it('clamps limit to maximum 50', async () => {
    const nodes = manyHubs(60);
    mockCtx.mockResolvedValue({ callGraph: graph(nodes) } as never);
    const r = await handleGetHealthMap({ directory: '/p', limit: 100 }) as {
      topRisks: unknown[];
    };
    expect(r.topRisks.length).toBeLessThanOrEqual(50);
  });
});

// ============================================================================
// Tool surface contract
// ============================================================================

describe('get_health_map tool surface', () => {
  it('is classified conclusion under the contract', () => {
    expect(TOOL_OUTPUT_CLASS.get_health_map).toBe('conclusion');
  });
});

// ============================================================================
// Summary counts must be totals, not display-capped
// ============================================================================

describe('handleGetHealthMap — summary counts are not capped by `limit`', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the TRUE untested-hotspot count when more exist than `limit` shows', async () => {
    // 25 untested functions, each above UNTESTED_MIN_DEGREE (10), with limit 5.
    // `untestedHotspotCount` sits in the same object as the genuinely uncapped
    // hubCount/godFunctionCount, so capping it silently understates the repo's
    // health problem by whatever the display limit happens to be.
    const nodes: FunctionNode[] = [];
    const edges: CallEdge[] = [];
    for (let i = 0; i < 25; i++) {
      nodes.push(node({ id: `f${i}.ts::fn${i}`, fanIn: 6, fanOut: 6 }));
    }
    mockCtx.mockResolvedValue({ callGraph: graph(nodes, edges) } as never);

    const r = await handleGetHealthMap({ directory: '/p', limit: 5 }) as {
      summary: { untestedHotspotCount: number };
      hotspots: { untestedHotspots: unknown[] };
    };

    expect(r.summary.untestedHotspotCount).toBe(25);
    // …while the DISPLAY list stays capped, which is the point of `limit`.
    expect(r.hotspots.untestedHotspots.length).toBeLessThanOrEqual(5);
  });
});
