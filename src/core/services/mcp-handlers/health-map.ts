import { validateDirectory, readCachedContext } from './utils.js';
import type { SerializedCallGraph, FunctionNode, CallEdge } from '../../analyzer/call-graph.js';
import { volatilityLevel } from '../../provenance/change-coupling.js';

const HUB_MIN_FAN_IN = 5;
const GOD_MIN_FAN_OUT = 8;
const DEFAULT_LIMIT = 10;
const MAX_BETWEENNESS_SOURCES = 300;
const BRIDGE_MIN_BETWEENNESS = 0.005;
const UNTESTED_MIN_DEGREE = 10;

export interface GetHealthMapInput {
  directory: string;
  /** Max items per hotspot list and max topRisks (default 10, max 50). */
  limit?: number;
}

type BridgeEntry = { id: string; name: string; file: string; fanIn: number; fanOut: number; betweenness: number };
type UntestedEntry = { id: string; name: string; file: string; degree: number };

function computeBridgeNodes(nodes: FunctionNode[], edges: CallEdge[], topN: number): { entries: BridgeEntry[]; sourcesUsed: number } {
  if (nodes.length === 0) return { entries: [], sourcesUsed: 0 };
  const nodeIds = nodes.map(n => n.id);
  const idxMap = new Map<string, number>(nodeIds.map((id, i) => [id, i]));
  const adj: number[][] = nodeIds.map(() => []);
  for (const e of edges) {
    const si = idxMap.get(e.callerId);
    const ti = idxMap.get(e.calleeId);
    if (si !== undefined && ti !== undefined) adj[si].push(ti);
  }
  const n = nodeIds.length;
  const betweenness = new Float64Array(n);
  const step = Math.max(1, Math.floor(n / MAX_BETWEENNESS_SOURCES));
  for (let srcIdx = 0; srcIdx < n; srcIdx += step) {
    const stack: number[] = [];
    const pred: number[][] = Array.from({ length: n }, () => []);
    const sigma = new Float64Array(n);
    const dist = new Int32Array(n).fill(-1);
    const delta = new Float64Array(n);
    sigma[srcIdx] = 1;
    dist[srcIdx] = 0;
    const queue: number[] = [srcIdx];
    let qi = 0;
    while (qi < queue.length) {
      const v = queue[qi++];
      stack.push(v);
      for (const w of adj[v]) {
        if (dist[w] < 0) { queue.push(w); dist[w] = dist[v] + 1; }
        if (dist[w] === dist[v] + 1) { sigma[w] += sigma[v]; pred[w].push(v); }
      }
    }
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== srcIdx) betweenness[w] += delta[w];
    }
  }
  let maxB = 1;
  for (let i = 0; i < n; i++) if (betweenness[i] > maxB) maxB = betweenness[i];
  const sourcesUsed = Math.ceil(n / step);
  const entries = nodes
    .map((node, i) => ({ node, b: betweenness[i] / maxB }))
    .filter(x => x.b > 0)
    .sort((a, b) => b.b - a.b)
    .slice(0, topN)
    .map(({ node, b }) => ({
      id: node.id,
      name: node.name,
      file: node.filePath,
      fanIn: node.fanIn ?? 0,
      fanOut: node.fanOut ?? 0,
      betweenness: Math.round(b * 1000) / 1000,
    }));
  return { entries, sourcesUsed };
}

function computeUntestedHotspots(nodes: FunctionNode[], edges: CallEdge[], topN: number): UntestedEntry[] {
  const testNodeIds = new Set(nodes.filter(n => n.isTest).map(n => n.id));
  const testedIds = new Set<string>();
  // Direct: testNode → X
  for (const e of edges) { if (testNodeIds.has(e.callerId)) testedIds.add(e.calleeId); }
  // 1-hop transitive: testNode → Y → X
  for (const e of edges) { if (testedIds.has(e.callerId)) testedIds.add(e.calleeId); }
  return nodes
    .filter(n => !n.isTest && !n.isExternal && !testedIds.has(n.id))
    .map(n => ({ id: n.id, name: n.name, file: n.filePath, degree: (n.fanIn ?? 0) + (n.fanOut ?? 0) }))
    .filter(e => e.degree >= UNTESTED_MIN_DEGREE)
    .sort((a, b) => b.degree - a.degree)
    .slice(0, topN);
}

export async function handleGetHealthMap(input: GetHealthMapInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 50));
  const cg = ctx.callGraph as SerializedCallGraph;
  const codeNodes = cg.nodes.filter(n => !n.isExternal && !n.isTest);
  // Structural-health signals are measured on the directly-resolved graph: synthesized
  // dynamic-dispatch edges are heuristic shortcuts that can manufacture false betweenness
  // chokepoints and mask untested hotspots, so they are excluded from centrality/coverage
  // here. (Reachability, impact, and dead-code traverse them by default elsewhere.)
  const directEdges = cg.edges.filter(e => e.confidence !== 'synthesized');

  // --- Hubs (high fan-in) ---
  const hubNodes = codeNodes
    .filter(n => (n.fanIn ?? 0) >= HUB_MIN_FAN_IN)
    .sort((a, b) => (b.fanIn ?? 0) - (a.fanIn ?? 0));

  // --- God functions (high fan-out) ---
  const godNodes = codeNodes
    .filter(n => (n.fanOut ?? 0) >= GOD_MIN_FAN_OUT)
    .sort((a, b) => (b.fanOut ?? 0) - (a.fanOut ?? 0));

  // --- Layer violations ---
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const violations = cg.layerViolations ?? [];
  const violationFiles = new Set<string>(
    violations.flatMap(v =>
      [nodeMap.get(v.callerId)?.filePath, nodeMap.get(v.calleeId)?.filePath].filter((p): p is string => p !== undefined)
    )
  );

  // --- Volatility (from edgeStore if present) ---
  // Fetch all volatile files to get the true total count; slice to limit for display.
  let allVolatileFiles: Array<{ file: string; level: string; changes: number }> = [];
  if (ctx.edgeStore && ctx.edgeStore.countChangeCoupling() > 0) {
    allVolatileFiles = ctx.edgeStore.getTopVolatile(10_000).map(r => ({
      file: r.filePath,
      level: volatilityLevel(r.churn),
      changes: r.churn,
    }));
  }
  const volatileFileList = allVolatileFiles.slice(0, limit);
  const volatileFileSet = new Set(allVolatileFiles.map(v => v.file));

  // --- Bridge nodes (sampled betweenness centrality on the call graph) ---
  // Compute the FULL ranking, then slice for display — the same shape the volatility
  // block above uses, and for the same reason: `summary.bridgeCount` sits beside the
  // genuinely uncapped hubCount/godFunctionCount, so counting a display-capped list
  // there reports `limit` (10) for a repo that has hundreds.
  const { entries: allBridgeNodes, sourcesUsed: betweennessSourceCount } =
    computeBridgeNodes(codeNodes, directEdges, Number.POSITIVE_INFINITY);
  const bridgeCount = allBridgeNodes.filter(b => b.betweenness >= BRIDGE_MIN_BETWEENNESS).length;
  const bridgeNodes = allBridgeNodes.slice(0, limit);
  const bridgeNodeIds = new Set(bridgeNodes.map(b => b.id));
  const bridgeMap = new Map(bridgeNodes.map(b => [b.id, b]));

  // --- Untested hotspots (high-degree nodes not directly called by any test) ---
  const allUntestedHotspots = computeUntestedHotspots(cg.nodes, directEdges, Number.POSITIVE_INFINITY);
  const untestedHotspots = allUntestedHotspots.slice(0, limit);
  const untestedHotspotIds = new Set(untestedHotspots.map(u => u.id));
  const untestedMap = new Map(untestedHotspots.map(u => [u.id, u]));

  // --- Top risks: union of all hotspot signal sources ---
  const bridgeCandidates = codeNodes.filter(n => bridgeNodeIds.has(n.id));
  const untestedCandidates = codeNodes.filter(n => untestedHotspotIds.has(n.id));
  const candidateMap = new Map(
    [...hubNodes.slice(0, limit), ...godNodes.slice(0, limit), ...bridgeCandidates, ...untestedCandidates]
      .map(n => [n.id, n])
  );
  const topRisks = [...candidateMap.values()]
    .map(n => {
      const isHub = (n.fanIn ?? 0) >= HUB_MIN_FAN_IN;
      const isGod = (n.fanOut ?? 0) >= GOD_MIN_FAN_OUT;
      const isVolatile = volatileFileSet.has(n.filePath);
      const hasViolation = violationFiles.has(n.filePath);
      const isBridge = bridgeNodeIds.has(n.id);
      const isUntested = untestedHotspotIds.has(n.id);
      const reasons: string[] = [];
      if (isHub) reasons.push(`hub (${n.fanIn} callers)`);
      if (isGod) reasons.push(`god function (${n.fanOut} callees)`);
      if (isVolatile) reasons.push('volatile file');
      if (hasViolation) reasons.push('layer violation');
      if (isBridge) reasons.push(`bridge (betweenness ${bridgeMap.get(n.id)?.betweenness ?? 0})`);
      if (isUntested) reasons.push(`untested hotspot (degree ${untestedMap.get(n.id)?.degree ?? 0})`);
      const severity: 'critical' | 'high' | 'medium' =
        reasons.length >= 3 ? 'critical' : reasons.length >= 2 ? 'high' : 'medium';
      return {
        name: n.name,
        file: n.filePath,
        fanIn: n.fanIn ?? 0,
        fanOut: n.fanOut ?? 0,
        reasons,
        severity,
      };
    })
    .sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2 } as const;
      return rank[a.severity] - rank[b.severity] || (b.fanIn + b.fanOut) - (a.fanIn + a.fanOut);
    })
    .slice(0, limit);

  return {
    summary: {
      totalFunctions: codeNodes.length,
      hubCount: hubNodes.length,
      godFunctionCount: godNodes.length,
      layerViolationCount: violations.length,
      volatileFileCount: allVolatileFiles.length,
      bridgeCount,
      untestedHotspotCount: allUntestedHotspots.length,
      betweennessApprox: codeNodes.length > MAX_BETWEENNESS_SOURCES,
      betweennessSourceCount,
    },
    // Index integrity verdict (change: add-index-integrity-attestation). Present only
    // when the on-disk index did not reconcile against its build-time attestation — a
    // `degraded` (materially smaller than built) or `mismatched` (different schema)
    // index makes every structural-health signal above suspect, so the health surface
    // discloses it loudly rather than presenting the metrics as complete. Healthy /
    // unverifiable indexes omit the field.
    ...(ctx.integrity && ctx.integrity.verdict !== 'healthy'
      ? { indexIntegrity: { verdict: ctx.integrity.verdict, detail: ctx.integrity.detail } }
      : {}),
    topRisks,
    hotspots: {
      hubs: hubNodes.slice(0, Math.min(limit, 5)).map(n => ({
        name: n.name,
        file: n.filePath,
        fanIn: n.fanIn ?? 0,
        fanOut: n.fanOut ?? 0,
      })),
      godFunctions: godNodes.slice(0, Math.min(limit, 5)).map(n => ({
        name: n.name,
        file: n.filePath,
        fanOut: n.fanOut ?? 0,
      })),
      volatile: volatileFileList.slice(0, Math.min(limit, 5)),
      bridges: bridgeNodes.slice(0, Math.min(limit, 5)).map(({ id: _id, ...rest }) => rest),
      untestedHotspots: untestedHotspots.slice(0, Math.min(limit, 5)).map(({ id: _id, ...rest }) => rest),
    },
    guidance:
      'topRisks covers structural hotspots ranked by signal count: hub, god function, volatile file, ' +
      'layer violation, bridge (betweenness chokepoint), untested hotspot. ' +
      'critical = ≥3 signals, high = 2, medium = 1. ' +
      'Drill in with get_critical_hubs, get_god_functions, get_change_coupling, find_dead_code, or get_surprising_connections.',
  };
}
