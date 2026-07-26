/**
 * Tests for find_path: endpoint resolution, cost-based pathfinding, the handler,
 * and the tool-surface placement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  notReadyResult: (error: string, reason: string) => ({ error, notReady: true, reason, remedy: 'openlore analyze' }),
  validateDirectory: vi.fn(async (dir: string) => dir),
  readCachedContext: vi.fn(async () => null),
}));

import { resolveEndpoint, findCheapestPath, handleFindPath } from './pathfind.js';
import { buildTraversalIndex } from '../../analyzer/condensation.js';
import { readCachedContext } from './utils.js';
import { TOOL_PRESETS } from '../../../cli/commands/mcp.js';
import { TOOL_OUTPUT_CLASS, assertConclusionShape } from './tool-contract.js';
import type { FunctionNode, CallEdge, SerializedCallGraph } from '../../analyzer/call-graph.js';

const mockCtx = vi.mocked(readCachedContext);

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id, filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'typescript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, ...over,
  };
}
function edgeC(callerId: string, calleeId: string, confidence: CallEdge['confidence']): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1] ?? calleeId, confidence, kind: 'calls' };
}
function graph(nodes: FunctionNode[], edges: CallEdge[], over: Partial<SerializedCallGraph> = {}): SerializedCallGraph {
  return {
    nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [],
    layerViolations: [], stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 }, ...over,
  };
}

describe('resolveEndpoint', () => {
  const entry = node({ id: 'a.ts::main', fanIn: 0, fanOut: 1 });
  const hub = node({ id: 'a.ts::hubFn', fanIn: 9, fanOut: 1 });
  const sink = node({ id: 'b.ts::writeDb', fanIn: 3, fanOut: 0 });   // called leaf
  const orphan = node({ id: 'b.ts::orphanLeaf', fanIn: 0, fanOut: 0 }); // uncalled leaf
  const cg = graph([entry, hub, sink, orphan], [edgeC(hub.id, sink.id, 'import')], { entryPoints: [entry], hubFunctions: [hub] });
  const traversal = buildTraversalIndex(cg);

  it('resolves role:entrypoint / role:hub from existing classifiers', () => {
    expect(resolveEndpoint('role:entrypoint', cg, traversal).nodes.map(n => n.name)).toEqual(['main']);
    expect(resolveEndpoint('role:hub', cg, traversal).nodes.map(n => n.name)).toEqual(['hubFn']);
  });

  it('resolves role:sink as a called leaf (fan-in >= 1, no outgoing) and excludes uncalled leaves', () => {
    const names = resolveEndpoint('role:sink', cg, traversal).nodes.map(n => n.name);
    expect(names).toContain('writeDb');     // called leaf
    expect(names).not.toContain('orphanLeaf'); // uncalled leaf — not a sink
    expect(names).not.toContain('main');    // has an outgoing edge → not a leaf
  });

  it('resolves file: and fuzzy name selectors', () => {
    expect(resolveEndpoint('file:b.ts', cg, traversal).nodes.map(n => n.name).sort()).toEqual(['orphanLeaf', 'writeDb']);
    expect(resolveEndpoint('hub', cg, traversal).nodes.map(n => n.name)).toEqual(['hubFn']);
    expect(resolveEndpoint('landmark:a.ts::hubFn', cg, traversal).nodes.map(n => n.name)).toEqual(['hubFn']);
  });

  it('returns an error kind for an unknown role', () => {
    expect(resolveEndpoint('role:bogus', cg, traversal).kind).toBe('error');
  });
});

describe('findCheapestPath', () => {
  // A ->(name_only,3) Z   [1 hop, distance 3]
  // A ->(import,1) M ->(import,1) Z  [2 hops, distance 2]  <- cheaper by call-distance
  const A = node({ id: 'a.ts::A' }), M = node({ id: 'm.ts::M' }), Z = node({ id: 'z.ts::Z' });
  const cg = graph([A, M, Z], [
    edgeC(A.id, Z.id, 'name_only'),
    edgeC(A.id, M.id, 'import'),
    edgeC(M.id, Z.id, 'import'),
  ]);

  it('selects the strong longer path under call-distance', () => {
    const r = findCheapestPath(cg, [A.id], [Z.id], { useCallDistance: true });
    expect(r.found).toBe(true);
    expect(r.best!.ids).toEqual([A.id, M.id, Z.id]);
    expect(r.best!.distance).toBe(2);
    expect(r.best!.hops).toBe(2);
  });

  it('selects the fewest-hops path when call-distance is disabled', () => {
    const r = findCheapestPath(cg, [A.id], [Z.id], { useCallDistance: false });
    expect(r.best!.ids).toEqual([A.id, Z.id]);
    expect(r.best!.hops).toBe(1);
  });

  it('reports not-found when no path connects the seeds', () => {
    const isolated = graph([A, Z], []); // no edges
    const r = findCheapestPath(isolated, [A.id], [Z.id], { useCallDistance: true });
    expect(r.found).toBe(false);
    expect(r.reached).toBeGreaterThanOrEqual(1);
  });
});

describe('handleFindPath', () => {
  beforeEach(() => vi.clearAllMocks());
  const entry = node({ id: 'a.ts::main', fanIn: 0, fanOut: 1 });
  const writer = node({ id: 'db/writer.ts::writeRow', fanIn: 1, fanOut: 0 });
  const cg = graph([entry, writer], [edgeC(entry.id, writer.id, 'import')], { entryPoints: [entry] });

  it('routes from a role endpoint to a file endpoint and shows resolved endpoints', async () => {
    mockCtx.mockResolvedValue({ callGraph: cg } as never);
    const r = await handleFindPath('/p', 'role:entrypoint', 'file:db/writer.ts') as {
      resolvedFrom: { kind: string }; resolvedTo: { kind: string };
      path: { chain: Array<{ name: string }>; hops: number }; reason: string;
    };
    expect(r.resolvedFrom.kind).toBe('role:entrypoint');
    expect(r.resolvedTo.kind).toBe('file');
    expect(r.path.chain.map(s => s.name)).toEqual(['main', 'writeRow']);
    expect(r.path.hops).toBe(1);
    assertConclusionShape('find_path', r); // conclusion-shaped: chain + bounded alternates, no edge dump
  });

  // Regression: call-graph node paths are already repo-relative. The chain must show
  // them verbatim, NOT run them through relative(absDir, …) — which mis-resolved a
  // repo-relative path against process.cwd() and emitted "../../…/cwd/db/writer.ts"
  // garbage whenever the server's cwd differed from the analyzed directory.
  it('shows repo-relative chain file paths even when the analyzed dir is not cwd', async () => {
    mockCtx.mockResolvedValue({ callGraph: cg } as never);
    const r = await handleFindPath('/some/other/abs/project', 'role:entrypoint', 'file:db/writer.ts') as {
      path: { chain: Array<{ name: string; file: string }> };
    };
    expect(r.path.chain.map(s => s.file)).toEqual(['a.ts', 'db/writer.ts']);
    for (const step of r.path.chain) expect(step.file).not.toMatch(/\.\.\//); // never an escaping relative path
  });

  it('returns a structured no-path answer (not an empty array)', async () => {
    mockCtx.mockResolvedValue({ callGraph: graph([entry, writer], [], { entryPoints: [entry] }) } as never); // disconnected
    const r = await handleFindPath('/p', 'role:entrypoint', 'file:db/writer.ts') as {
      path: null; noPath: { reason: string; reachedNodes: number };
    };
    expect(r.path).toBeNull();
    expect(r.noPath.reason).toMatch(/No call path/);
    expect(typeof r.noPath.reachedNodes).toBe('number');
  });

  it('errors clearly on an unresolvable selector', async () => {
    mockCtx.mockResolvedValue({ callGraph: cg } as never);
    expect((await handleFindPath('/p', 'role:nope', 'main') as { error: string }).error).toMatch(/Unknown "from" selector/);
  });

  it('returns a clear note when from and to are the same endpoint (no traversal needed)', async () => {
    mockCtx.mockResolvedValue({ callGraph: cg } as never);
    const r = await handleFindPath('/p', 'main', 'main') as { path: null; note: string; confidenceBoundary: { complete: boolean } };
    expect(r.path).toBeNull();
    expect(r.note).toMatch(/same function/);
    expect(r.confidenceBoundary.complete).toBe(true); // same-endpoint return attaches a boundary too
  });

  // confidenceBoundary wiring (spec: add-confidence-boundary-disclosure). The fixture
  // dir has no fingerprint artifact, so staleness is silent and `complete` tracks the
  // edge basis alone.
  it('attaches a complete confidenceBoundary for an all-direct path', async () => {
    mockCtx.mockResolvedValue({ callGraph: cg } as never);
    const r = await handleFindPath('/p', 'role:entrypoint', 'file:db/writer.ts') as { confidenceBoundary: { complete: boolean; basis: { directEdges: number; synthesizedEdges: number } } };
    expect(r.confidenceBoundary.complete).toBe(true);
    expect(r.confidenceBoundary.basis.directEdges).toBeGreaterThanOrEqual(1);
    expect(r.confidenceBoundary.basis.synthesizedEdges).toBe(0);
  });

  it('reports incomplete and discloses the rule when the path crosses a synthesized edge', async () => {
    const synthCg = graph([entry, writer], [edgeC(entry.id, writer.id, 'synthesized')], { entryPoints: [entry] });
    synthCg.edges[0].synthesizedBy = 'callback-registration';
    mockCtx.mockResolvedValue({ callGraph: synthCg } as never);
    const r = await handleFindPath('/p', 'role:entrypoint', 'file:db/writer.ts') as { path: unknown; confidenceBoundary: { complete: boolean; knownUnknowable: Array<{ rule?: string }> } };
    expect(r.path).not.toBeNull();
    expect(r.confidenceBoundary.complete).toBe(false);
    expect(r.confidenceBoundary.knownUnknowable.some(c => c.rule === 'callback-registration')).toBe(true);
  });

  it('attaches a confidenceBoundary on the no-path answer', async () => {
    mockCtx.mockResolvedValue({ callGraph: graph([entry, writer], [], { entryPoints: [entry] }) } as never);
    const r = await handleFindPath('/p', 'role:entrypoint', 'file:db/writer.ts') as { path: null; confidenceBoundary: { complete: boolean } };
    expect(r.path).toBeNull();
    expect(typeof r.confidenceBoundary.complete).toBe('boolean');
  });
});

describe('find_path tool surface', () => {
  it('is classified conclusion and lives in the navigation preset, not minimal', () => {
    expect(TOOL_OUTPUT_CLASS.find_path).toBe('conclusion');
    expect(TOOL_PRESETS.navigation.has('find_path')).toBe(true);
    expect(TOOL_PRESETS.minimal.has('find_path')).toBe(false);
  });
});
