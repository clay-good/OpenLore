/**
 * MCP tool handlers for call-graph analysis:
 * get_call_graph, get_subgraph, analyze_impact, get_critical_hubs,
 * get_leaf_functions, get_low_risk_refactor_candidates, get_god_functions,
 * trace_execution_path.
 */

import { validateDirectory, readCachedContext } from './utils.js';
import { resolveFederationScope, findCrossRepoConsumersBatch, findCrossRepoClientCallers } from '../../federation/resolver.js';
import { extractRoutesFromFile, normalizeUrl, type RouteDefinition, type RouteInventory } from '../../analyzer/http-route-parser.js';
import type { CachedContext } from './utils.js';
import { join, resolve, isAbsolute } from 'node:path';
import {
  RISK_SCORE_FAN_IN_WEIGHT,
  RISK_SCORE_FAN_OUT_WEIGHT,
  RISK_SCORE_HUB_BONUS,
  RISK_SCORE_BLAST_RADIUS_WEIGHT,
  RISK_SCORE_LOW_THRESHOLD,
  RISK_SCORE_MEDIUM_THRESHOLD,
  GOD_FUNCTION_FAN_OUT_THRESHOLD,
  REFACTOR_SRP_FAN_OUT_THRESHOLD,
  LOW_RISK_MAX_FAN_IN,
  LOW_RISK_MAX_FAN_OUT,
  CRITICAL_HUBS_DEFAULT_MIN_FAN_IN,
  SUBGRAPH_DEFAULT_MAX_DEPTH,
  SUBGRAPH_MAX_DEPTH_LIMIT,
  CRITICALITY_FAN_IN_WEIGHT,
  CRITICALITY_FAN_OUT_WEIGHT,
  CRITICALITY_VIOLATION_BONUS,
  STABILITY_SCORE_CAN_REFACTOR,
  STABILITY_SCORE_STABILISE_FIRST,
  LOW_RISK_REFACTOR_CANDIDATES_DEFAULT_LIMIT,
  LEAF_FUNCTIONS_DEFAULT_LIMIT,
  HUB_HIGH_FAN_IN_THRESHOLD,
  HUB_HIGH_FAN_OUT_THRESHOLD,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_ROUTE_INVENTORY,
  TRACE_PATH_DEFAULT_MAX_DEPTH,
  TRACE_PATH_MAX_PATHS,
} from '../../../constants.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';
import { callDistance } from '../../analyzer/call-graph.js';
import type { DecisionNode } from '../../decisions/project.js';
import { isIacLanguage } from '../../analyzer/iac/types.js';
import { getFileGodFunctions, extractSubgraph } from '../../analyzer/subgraph-extractor.js';
import { readOpenLoreConfig } from '../config-manager.js';
import {
  assembleBoundary,
  buildPairEdgeIndex,
  computeStaleness,
  edgeBasis,
  edgeBasisForChains,
  type BoundaryEdge,
} from './confidence-boundary.js';

// ============================================================================
// SHARED GRAPH HELPERS (also exported for chat-tools.ts)
// ============================================================================

/**
 * Build forward (caller→callees) and backward (callee→callers) adjacency maps
 * from a serialised call graph, returning both maps and a node lookup.
 *
 * Inheritance propagation rides on the materialized, provenance-labeled override
 * edges (`kind: 'overrides'`, `confidence: 'synthesized'`) the CHA pass writes into
 * `cg.edges` (spec: add-type-hierarchy-resolved-dispatch) — read here through the
 * same edge loop as call edges, so the in-memory and DB-backed paths agree and
 * `directResolvedOnly` excludes them for free. This replaces the prior class-level
 * all-parent-methods × all-child-methods cross-product, which connected unrelated
 * methods, silently dropped class pairs whose product exceeded 200, and existed
 * only here (so it disagreed with the DB-backed reachability path).
 */
export function buildAdjacency(cg: SerializedCallGraph, opts?: { directResolvedOnly?: boolean }) {
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const forward  = new Map<string, Set<string>>(); // callerId → Set<calleeId>
  const backward = new Map<string, Set<string>>(); // calleeId → Set<callerId>

  for (const n of cg.nodes) {
    forward.set(n.id, new Set());
    backward.set(n.id, new Set());
  }
  for (const e of cg.edges) {
    if (!e.calleeId) continue;
    // Strict mode (spec: add-synthesized-dynamic-dispatch-edges): skip synthesized
    // edges (dynamic-dispatch, CHA virtual-dispatch, and override) so traversal
    // rests only on directly-resolved edges — trading completeness for certainty.
    if (opts?.directResolvedOnly && e.confidence === 'synthesized') continue;
    // Ensure external nodes (not in cg.nodes) get adjacency entries
    if (!forward.has(e.calleeId))  forward.set(e.calleeId,  new Set());
    if (!backward.has(e.calleeId)) backward.set(e.calleeId, new Set());
    forward.get(e.callerId)?.add(e.calleeId);
    backward.get(e.calleeId)?.add(e.callerId);
  }

  return { nodeMap, forward, backward };
}

/** BFS up to `maxDepth`. Returns a map of visited node-id → depth reached. */
export function bfs(
  seeds: string[],
  adjacency: Map<string, Set<string>>,
  maxDepth: number
): Map<string, number> {
  const visited = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = seeds.map(id => ({ id, depth: 0 }));
  for (const id of seeds) visited.set(id, 0);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    for (const nId of adjacency.get(id) ?? []) {
      if (!visited.has(nId)) {
        visited.set(nId, depth + 1);
        queue.push({ id: nId, depth: depth + 1 });
      }
    }
  }
  return visited;
}

/**
 * DB-backed lazy BFS — fetches only edges for visited nodes instead of loading all edges.
 * direction: 'forward' = downstream (callees), 'backward' = upstream (callers).
 */
export function bfsFromDB(
  seeds: string[],
  direction: 'forward' | 'backward',
  maxDepth: number,
  es: CachedContext['edgeStore'],
  opts?: { directResolvedOnly?: boolean }
): Map<string, number> {
  const visited = new Map<string, number>();
  for (const id of seeds) visited.set(id, 0);

  // Level-by-level BFS: one batch query per depth level, O(maxDepth) SQL queries.
  // Recursive CTE was tested but regressed backward BFS on high fan-in hubs (19ms→30ms):
  // SQLite UNION deduplicates on (id,depth) pairs, so (X,1) and (X,2) are both kept,
  // causing path explosion. Iterative frontier never re-visits a node.
  let frontier = seeds.filter(id => !id.startsWith('external::'));

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const rawEdges = direction === 'forward'
      ? es!.getCalleesForIds(frontier)
      : es!.getCallersForIds(frontier);
    // Strict mode: ignore synthesized dynamic-dispatch edges so the traversal rests
    // only on directly-resolved edges (spec: add-synthesized-dynamic-dispatch-edges).
    const edges = opts?.directResolvedOnly
      ? rawEdges.filter(e => e.confidence !== 'synthesized')
      : rawEdges;

    const nextFrontier: string[] = [];
    for (const e of edges) {
      const nId = direction === 'forward' ? e.calleeId : e.callerId;
      if (!visited.has(nId) && !nId.startsWith('external::')) {
        visited.set(nId, depth + 1);
        nextFrontier.push(nId);
      }
    }
    frontier = nextFrontier;
  }
  return visited;
}

/** A node's minimal accumulated call-distance from the seed set. */
export interface WeightedReach {
  /** Sum of edge call-distances along the cheapest path from a seed. */
  distance: number;
  /** Hop count along that cheapest-distance path. */
  hops: number;
  /** Predecessor node id on that path, or null for a seed. */
  predecessor: string | null;
}

/**
 * Build weighted forward/backward adjacency from `calls` edges, each weighted by
 * {@link callDistance}. External (Infinity-cost) edges are omitted so internal
 * scoping never routes through synthetic stdlib/HTTP leaves.
 */
export function buildWeightedAdjacency(cg: SerializedCallGraph) {
  const forward  = new Map<string, Array<{ to: string; cost: number }>>(); // callerId → callees
  const backward = new Map<string, Array<{ to: string; cost: number }>>(); // calleeId → callers
  for (const e of cg.edges) {
    if (!e.calleeId) continue;
    if (e.kind && e.kind !== 'calls') continue; // only call edges carry call-distance
    const cost = callDistance(e);
    if (!Number.isFinite(cost)) continue; // skip external/unresolved
    if (!forward.has(e.callerId))  forward.set(e.callerId,  []);
    if (!backward.has(e.calleeId)) backward.set(e.calleeId, []);
    forward.get(e.callerId)!.push({ to: e.calleeId, cost });
    backward.get(e.calleeId)!.push({ to: e.callerId, cost });
  }
  return { forward, backward };
}

/**
 * Dijkstra over a weighted adjacency (small in-memory neighbourhoods; a linear
 * min-frontier scan is cheaper than a heap here). Returns each reachable node's
 * minimal accumulated call-distance, the hop count along that cheapest path, and
 * its predecessor — sufficient to reconstruct the path. Seeds start at distance
 * 0; nodes whose distance would exceed `maxDistance` are never expanded.
 */
export function weightedBfs(
  seeds: string[],
  adjacency: Map<string, Array<{ to: string; cost: number }>>,
  maxDistance: number,
): Map<string, WeightedReach> {
  const best = new Map<string, WeightedReach>();
  const frontier = new Map<string, number>(); // node → tentative distance
  for (const s of seeds) {
    best.set(s, { distance: 0, hops: 0, predecessor: null });
    frontier.set(s, 0);
  }

  while (frontier.size > 0) {
    // Pop the minimum-distance node — finalized, since all edge costs are ≥ 0.
    let cur = '';
    let curDist = Infinity;
    for (const [id, d] of frontier) if (d < curDist) { curDist = d; cur = id; }
    frontier.delete(cur);

    const curHops = best.get(cur)!.hops;
    for (const { to, cost } of adjacency.get(cur) ?? []) {
      const nd = curDist + cost;
      if (nd > maxDistance) continue;
      const existing = best.get(to);
      if (!existing || nd < existing.distance) {
        best.set(to, { distance: nd, hops: curHops + 1, predecessor: cur });
        frontier.set(to, nd);
      }
    }
  }
  return best;
}

/**
 * Compute a risk score [0–100] for a node.
 *
 * Weights: fan-in × 4, fan-out × 2, isHub × 20, blastRadius × 1.5. Capped at 100.
 */
export function computeRiskScore(node: FunctionNode, blastRadius: number, isHub: boolean): number {
  const raw =
    (node.fanIn  ?? 0) * RISK_SCORE_FAN_IN_WEIGHT +
    (node.fanOut ?? 0) * RISK_SCORE_FAN_OUT_WEIGHT +
    (isHub ? RISK_SCORE_HUB_BONUS : 0) +
    blastRadius * RISK_SCORE_BLAST_RADIUS_WEIGHT;
  return Math.min(100, Math.round(raw));
}

/** Derive a plain-language refactoring strategy from the risk profile. */
export function recommendStrategy(
  riskScore: number,
  fanIn: number,
  fanOut: number,
  isHub: boolean
): { approach: string; rationale: string } {
  if (riskScore <= RISK_SCORE_LOW_THRESHOLD) {
    return {
      approach: 'refactor freely',
      rationale:
        'Low fan-in and fan-out. Safe to rename, extract, or rewrite inline. ' +
        'A single PR with unit tests is sufficient.',
    };
  }
  if (riskScore <= RISK_SCORE_MEDIUM_THRESHOLD) {
    return {
      approach: 'refactor with tests',
      rationale:
        'Moderate caller count. Write characterisation tests before changing the signature. ' +
        'Prefer additive changes (new overload / wrapper) then migrate callers.',
    };
  }
  if (isHub && fanOut > REFACTOR_SRP_FAN_OUT_THRESHOLD) {
    return {
      approach: 'split responsibility (SRP)',
      rationale:
        'God-function: high fan-in AND high fan-out. Extract cohesive sub-responsibilities ' +
        'into smaller functions behind a thin façade. Migrate callers incrementally.',
    };
  }
  if (isHub) {
    return {
      approach: 'introduce façade',
      rationale:
        'Critical hub with many callers. Do not change the public signature. ' +
        'Introduce a façade or adapter layer, move logic behind it, ' +
        'then update callers in waves.',
    };
  }
  if (fanOut > GOD_FUNCTION_FAN_OUT_THRESHOLD) {
    return {
      approach: 'decompose fan-out',
      rationale:
        'Too many outgoing dependencies. Extract orchestration logic into smaller coordinators. ' +
        'Consider dependency injection to decouple from concrete callees.',
    };
  }
  return {
    approach: 'incremental extraction',
    rationale:
      'High risk due to caller count. Use the Strangler-Fig pattern: introduce a parallel ' +
      'implementation, migrate callers one by one, then delete the original.',
  };
}

export function nodeToSummary(n: FunctionNode | undefined) {
  if (!n) return { name: '', file: '', className: null, depth: 0 };
  return { name: n.name, file: n.filePath, className: n.className ?? null, depth: 0 };
}

/**
 * Render a projected decision node as a typed graph neighbor (spec-16).
 * `nodeType: 'decision'` lets callers distinguish governing decisions from code nodes.
 */
export function decisionToNeighbor(d: DecisionNode) {
  return {
    nodeType: 'decision' as const,
    id: d.decisionId,
    title: d.title,
    status: d.status,
    rationale: d.rationale,
    consequences: d.consequences,
    affectedDomains: d.affectedDomains,
    governs: d.affectedFiles,
    ...(d.supersedes ? { supersedes: d.supersedes } : {}),
  };
}

/** A node is infrastructure if its language is one of the IaC ecosystems (spec-17). */
export function isInfraNode(n: FunctionNode | undefined): boolean {
  return !!n && isIacLanguage(n.language);
}

/** Render an IaC resource node as a typed cross-domain neighbor (spec-17). */
export function infraToNeighbor(
  n: FunctionNode,
  direction: 'upstream' | 'downstream',
  depth: number,
) {
  return {
    nodeType: 'infrastructure' as const,
    name: n.name,
    file: n.filePath,
    ecosystem: n.language,
    direction,
    depth,
  };
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Return the call graph summary from cached analysis.
 */
export async function handleGetCallGraph(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };

  const cg = ctx.callGraph;
  return {
    stats: cg.stats,
    hubFunctions: cg.hubFunctions.map(n => ({
      name: n.name, file: n.filePath, className: n.className,
      fanIn: n.fanIn, fanOut: n.fanOut, language: n.language,
    })),
    entryPoints: cg.entryPoints.map(n => ({
      name: n.name, file: n.filePath, className: n.className, language: n.language,
    })),
    layerViolations: cg.layerViolations,
  };
}

/**
 * Extract a depth-limited subgraph centred on a named function.
 * Falls back to semantic search if no exact name match is found.
 */
export async function handleGetSubgraph(
  directory: string,
  functionName: string,
  direction: 'downstream' | 'upstream' | 'both' = 'downstream',
  maxDepth = SUBGRAPH_DEFAULT_MAX_DEPTH,
  format: 'json' | 'mermaid' = 'json',
  directResolvedOnly = false,
): Promise<unknown> {
  maxDepth = Math.max(1, Math.min(maxDepth, SUBGRAPH_MAX_DEPTH_LIMIT));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.edgeStore) return { error: 'Call graph index is empty or unavailable — run analyze_codebase to (re)build it (a version upgrade resets the graph index until the next analyze).' };

  const lower = functionName.toLowerCase();
  let seeds = ctx.edgeStore.searchNodes(lower);

  // searchNodes is a fuzzy FTS match, so a unique symbol can come back alongside
  // incidental hits. Prefer exact name matches so a known symbol resolves to a
  // single deterministic result instead of an ambiguous { matches } list.
  const exact = seeds.filter(s => s.name.toLowerCase() === lower);
  if (exact.length > 0) seeds = exact;

  // Semantic search fallback when no name match
  if (seeds.length === 0) {
    try {
      const { VectorIndex } = await import('../../analyzer/vector-index.js');
      const { resolveEmbedder } = await import('../../analyzer/embedder.js');
      const outputDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

      if (VectorIndex.exists(outputDir)) {
        const cfg = await readOpenLoreConfig(absDir);
        const embedSvc = await resolveEmbedder(cfg);
        if (embedSvc) {
          const results = await VectorIndex.search(outputDir, functionName, embedSvc, { limit: 1 });
          if (results.length > 0) {
            const matched = ctx.edgeStore.getNode(results[0].record.id);
            if (matched) seeds = [matched];
          }
        }
      }
    } catch { /* ignore fallback errors */ }
  }

  if (seeds.length === 0) return { error: `No function matching "${functionName}" found in call graph.` };

  const seedIds = seeds.map(s => s.id);
  const bfsOpts = { directResolvedOnly };
  const fwdVisited = (direction === 'downstream' || direction === 'both')
    ? bfsFromDB(seedIds, 'forward',  maxDepth, ctx.edgeStore, bfsOpts)
    : new Map<string, number>();
  const bwdVisited = (direction === 'upstream' || direction === 'both')
    ? bfsFromDB(seedIds, 'backward', maxDepth, ctx.edgeStore, bfsOpts)
    : new Map<string, number>();
  const visitedIds = new Set([...fwdVisited.keys(), ...bwdVisited.keys()]);

  const resolveNode = (id: string) => ctx.edgeStore!.getNode(id);

  const visibleNodes = Array.from(visitedIds)
    .map(id => resolveNode(id)!)
    .filter(Boolean)
    // stdlib nodes (Array.isArray, t.slice, …) are noise — exclude unless they are a seed
    .filter(n => !n.isExternal || n.externalKind !== 'stdlib' || seeds.some(s => s.id === n.id));

  const subNodes = visibleNodes.map(n => ({
    name: n.isExternal ? `[external] ${n.name}` : n.name,
    file: n.filePath,
    className: n.className,
    fanIn: n.fanIn, fanOut: n.fanOut, language: n.language,
    isExternal: n.isExternal ?? false,
    externalKind: n.externalKind,
    isSeed: seeds.some(s => s.id === n.id),
  }));

  const subEdges = Array.from(visitedIds).flatMap(id =>
    ctx.edgeStore!.getCallees(id)
      .filter(e => e.calleeId && visitedIds.has(e.calleeId))
      .map(e => {
        const callerN = resolveNode(e.callerId);
        const calleeN = resolveNode(e.calleeId);
        return {
          caller: callerN?.name ?? e.callerId,
          callee: calleeN?.isExternal ? `[external] ${calleeN.name}` : (calleeN?.name ?? e.calleeId),
          callerFile: callerN?.filePath,
          calleeFile: calleeN?.filePath,
          kind: e.kind ?? 'calls',
          callType: e.callType,
          // Provenance: flag synthesized dynamic-dispatch edges so the agent sees which
          // edges rest on a heuristic vs direct name resolution (spec: add-synthesized-…).
          ...(e.confidence === 'synthesized' && { synthesized: true, synthesizedBy: e.synthesizedBy }),
        };
      })
  );

  // Governing decisions (spec-16): typed graph neighbors of the subgraph's files,
  // surfaced via the `affects`-edge join — not a post-hoc filter.
  const subgraphFiles = [...new Set(visibleNodes.map(n => n.filePath))];
  const governingDecisions = ctx.edgeStore.getDecisionsForFiles(subgraphFiles).map(decisionToNeighbor);

  if (format === 'mermaid') {
    const idOf = new Map<string, string>();
    subNodes.forEach((n, i) => idOf.set(n.name + '|' + n.file, `n${i}`));
    const nodeLines = subNodes.map(n => {
      const id = idOf.get(n.name + '|' + n.file)!;
      const label = `"${n.name}\\n${n.file}"`;
      return n.isSeed ? `    ${id}[${label}]:::seed` : `    ${id}[${label}]`;
    });
    const edgeLines = subEdges.map(e => {
      const fromId = idOf.get(e.caller + '|' + e.callerFile) ?? e.caller;
      const toId   = idOf.get(e.callee + '|' + e.calleeFile) ?? e.callee;
      return `    ${fromId} --> ${toId}`;
    });
    const deduped = [...new Set(edgeLines)];
    const diagram = [
      'flowchart LR',
      '    classDef seed fill:#f5a623,stroke:#d4891a,color:#000',
      ...nodeLines, ...deduped,
    ].join('\n');
    const decisionNote = governingDecisions.length > 0
      ? ` · ${governingDecisions.length} governing decision${governingDecisions.length > 1 ? 's' : ''}`
      : '';
    return `\`\`\`mermaid\n${diagram}\n\`\`\`\n\n` +
      `_${subNodes.length} nodes · ${deduped.length} edges${decisionNote} · seeds: ${seeds.map(s => s.name).join(', ')}_`;
  }

  // Confidence boundary: the subgraph's own edges are the traversal basis — the
  // `synthesized` flag set above distinguishes heuristic dispatch from direct
  // resolution. (spec: add-confidence-boundary-disclosure)
  const subBasis = edgeBasis(subEdges.map((e): BoundaryEdge => ({
    confidence: e.synthesized ? 'synthesized' : undefined,
    synthesizedBy: e.synthesizedBy,
  })));
  const confidenceBoundary = assembleBoundary({ basis: subBasis, staleness: await computeStaleness(absDir), integrity: ctx?.integrity });

  return {
    query: { functionName, direction, maxDepth },
    seeds: seeds.map(n => ({ name: n.name, file: n.filePath })),
    stats: { nodes: subNodes.length, edges: subEdges.length, governingDecisions: governingDecisions.length },
    nodes: subNodes,
    edges: subEdges,
    ...(governingDecisions.length > 0 ? { governingDecisions } : {}),
    confidenceBoundary,
  };
}

/**
 * Deep impact analysis for a single symbol.
 * Falls back to semantic search if no exact name match is found.
 */
export async function handleAnalyzeImpact(
  directory: string,
  symbol: string,
  depth = 2,
  directResolvedOnly = false,
  valueLevel = false,
  valueParam?: string,
  federation = false,
  federationRepos?: string[],
): Promise<unknown> {
  // Clamp to the documented maximum so a hostile depth (e.g. 1e9) can't drive an
  // unbounded BFS over an adversarial graph (mcp-security: Bounded Computation).
  depth = Math.max(1, Math.min(depth, SUBGRAPH_MAX_DEPTH_LIMIT));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)            return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.edgeStore)  return { error: 'Call graph index is empty or unavailable — run analyze_codebase to (re)build it (a version upgrade resets the graph index until the next analyze).' };

  // `symbol` is required by the MCP inputSchema, but dispatchTool enforces nothing,
  // so a non-conformant caller could reach here with it undefined — return a clean
  // error instead of crashing on `undefined.toLowerCase()`.
  if (typeof symbol !== 'string' || symbol.trim() === '') return { error: 'symbol is required.' };

  const lower = symbol.toLowerCase();
  let seeds = ctx.edgeStore.searchNodes(lower);

  // searchNodes is a fuzzy FTS match, so a unique symbol can come back alongside
  // incidental hits. Prefer exact name matches so a known symbol resolves to a
  // single deterministic result instead of an ambiguous { matches } list.
  const exact = seeds.filter(s => s.name.toLowerCase() === lower);
  if (exact.length > 0) seeds = exact;

  // Semantic search fallback when no name match
  if (seeds.length === 0) {
    try {
      const { VectorIndex } = await import('../../analyzer/vector-index.js');
      const { resolveEmbedder } = await import('../../analyzer/embedder.js');
      const outputDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

      if (VectorIndex.exists(outputDir)) {
        const cfg = await readOpenLoreConfig(absDir);
        const embedSvc = await resolveEmbedder(cfg);
        if (embedSvc) {
          const results = await VectorIndex.search(outputDir, symbol, embedSvc, { limit: 1 });
          if (results.length > 0) {
            const matched = ctx.edgeStore.getNode(results[0].record.id);
            if (matched) seeds = [matched];
          }
        }
      }
    } catch { /* ignore fallback errors */ }
  }

  if (seeds.length === 0) return { error: `No function matching "${symbol}" found in call graph.` };

  const seedIds     = seeds.map(n => n.id);
  const hubIds      = new Set(ctx.edgeStore.getHubs(500).map(n => n.id));
  const bfsOpts = { directResolvedOnly };
  const upstreamMap   = bfsFromDB(seedIds, 'backward', depth, ctx.edgeStore, bfsOpts);

  // Value-level opt-in (spec: add-intraprocedural-cfg-dataflow-overlay): narrow
  // the downstream forward slice to the calls whose arguments are data-dependent
  // on the targeted value, using the reaching-definitions overlay. Strictly
  // opt-in — when the flag is absent the downstream BFS is byte-for-byte the
  // original. Falls back to function granularity when the seed has no overlay.
  let valueLevelInfo: { applied: boolean; parameter?: string; reason?: string; dataDependentCallees?: number; precision?: string } | undefined;
  let downstreamMap: Map<string, number>;
  if (valueLevel && seeds.length === 1) {
   try {
    const cfg = ctx.edgeStore.getCfg(seeds[0].id);
    // The value-level query is well-posed only when its target resolves in the
    // overlay: a named valueParam must be a parameter or a tracked local; an
    // "all parameters" request needs at least one parameter. Otherwise narrowing
    // would silently report zero blast radius (e.g. a mistyped param) — telling
    // an agent a change is safe when we simply couldn't resolve the value. Fall
    // back to function granularity instead.
    const targetExists = !!cfg && (valueParam === undefined
      ? cfg.params.length > 0
      : cfg.params.includes(valueParam) || cfg.defUse.some(e => e.variable === valueParam));
    if (!cfg || !targetExists) {
      valueLevelInfo = { applied: false, reason: !cfg
        ? 'no CFG/def-use overlay for this function (unsupported language or no usable body); returning function-granularity result'
        : valueParam
          ? `value "${valueParam}" is not a parameter or tracked local in this function's overlay; returning function-granularity result`
          : 'function exposes no parameters in the overlay; returning function-granularity result' };
      downstreamMap = bfsFromDB(seedIds, 'forward', depth, ctx.edgeStore, bfsOpts);
    } else {
      const { valueReachableLines } = await import('../../analyzer/cfg.js');
      const reached = valueReachableLines(cfg, valueParam);
      const directCallees = ctx.edgeStore.getCallees(seeds[0].id)
        .filter(e => e.line != null && reached.has(e.line) && e.calleeId && !e.calleeId.startsWith('external::'));
      const calleeIds = [...new Set(directCallees.map(e => e.calleeId))];
      // The data-dependent direct callees are depth-1; expand forward from them.
      downstreamMap = new Map<string, number>();
      for (const id of calleeIds) downstreamMap.set(id, 1);
      if (depth > 1 && calleeIds.length > 0) {
        const expanded = bfsFromDB(calleeIds, 'forward', depth - 1, ctx.edgeStore, bfsOpts);
        for (const [id, d] of expanded) if (!downstreamMap.has(id)) downstreamMap.set(id, d + 1);
      }
      valueLevelInfo = {
        applied: true,
        parameter: valueParam ?? '(all parameters)',
        dataDependentCallees: calleeIds.length,
        precision: 'may (data-dependence crosses the call boundary)',
      };
    }
   } catch (error) {
     // Value-level is strictly best-effort: any overlay error (corrupt blob, a
     // builder surprise) falls back to the full function-granularity blast radius
     // rather than failing analyze_impact.
     if (process.env.DEBUG) console.debug(`[value-level] analyze_impact fell back: ${(error as Error).message}`);
     valueLevelInfo = { applied: false, reason: 'value-level overlay unavailable (error); returning function-granularity result' };
     downstreamMap = bfsFromDB(seedIds, 'forward', depth, ctx.edgeStore, bfsOpts);
   }
  } else {
    downstreamMap = bfsFromDB(seedIds, 'forward', depth, ctx.edgeStore, bfsOpts);
  }

  const resolveNode = (id: string): FunctionNode | undefined =>
    ctx.edgeStore!.getNode(id) ?? undefined;

  // Resolve once, then partition by domain so code chains stay pure code and
  // infrastructure neighbors are surfaced separately, clearly typed (spec-17).
  const resolve = (map: Map<string, number>) =>
    [...map.entries()]
      .filter(([id]) => !seedIds.includes(id))
      .map(([id, d]) => ({ node: resolveNode(id), depth: d }))
      .filter((x): x is { node: FunctionNode; depth: number } => !!x.node && !!x.node.name);

  const upstreamResolved   = resolve(upstreamMap);
  const downstreamResolved = resolve(downstreamMap);

  const upstreamNodes = upstreamResolved
    .filter(x => !isInfraNode(x.node))
    .map(x => ({ ...nodeToSummary(x.node), depth: x.depth }));
  const downstreamNodes = downstreamResolved
    .filter(x => !isInfraNode(x.node))
    .map(x => ({ ...nodeToSummary(x.node), depth: x.depth }));

  // Cross-domain (code↔infra) neighbors — additive, typed, ecosystem-tagged.
  const infraNeighbors = [
    ...upstreamResolved.filter(x => isInfraNode(x.node)).map(x => infraToNeighbor(x.node, 'upstream', x.depth)),
    ...downstreamResolved.filter(x => isInfraNode(x.node)).map(x => infraToNeighbor(x.node, 'downstream', x.depth)),
  ];
  const crossDomain = infraNeighbors.length > 0
    ? {
        reachesInfrastructure: true,
        ecosystems: [...new Set(infraNeighbors.map(n => n.ecosystem))].sort(),
        infrastructure: infraNeighbors,
      }
    : undefined;

  const blastRadius = upstreamNodes.length + downstreamNodes.length + infraNeighbors.length;

  // Governing decisions (spec-16): decisions whose `affects` edges intersect the
  // seed plus its blast radius — the deterministic join that answers "what
  // decisions govern this code, and what does changing it implicate?".
  const involvedFiles = new Set<string>();
  for (const s of seeds) involvedFiles.add(s.filePath);
  for (const n of upstreamNodes) if (n.file) involvedFiles.add(n.file);
  for (const n of downstreamNodes) if (n.file) involvedFiles.add(n.file);
  for (const n of infraNeighbors) if (n.file) involvedFiles.add(n.file);
  const governingDecisions = ctx.edgeStore.getDecisionsForFiles([...involvedFiles]).map(decisionToNeighbor);

  // Confidence boundary: the blast radius rests on the edges traversed within the
  // involved set (seeds + up/downstream). Synthesized edges among them mean the
  // impact estimate leaned on heuristic dispatch. (spec: add-confidence-boundary-disclosure)
  const involvedIds = new Set<string>([...seedIds, ...upstreamMap.keys(), ...downstreamMap.keys()]);
  const impactEdges: BoundaryEdge[] = [];
  for (const id of involvedIds) {
    for (const e of ctx.edgeStore.getCallees(id)) {
      if (e.calleeId && involvedIds.has(e.calleeId)) impactEdges.push({ confidence: e.confidence, synthesizedBy: e.synthesizedBy });
    }
  }
  const confidenceBoundary = assembleBoundary({ basis: edgeBasis(impactEdges), staleness: await computeStaleness(absDir), integrity: ctx?.integrity });

  const results = seeds.map(seed => {
    const isHub     = hubIds.has(seed.id);
    const riskScore = computeRiskScore(seed, blastRadius, isHub);
    const strategy  = recommendStrategy(riskScore, seed.fanIn ?? 0, seed.fanOut ?? 0, isHub);
    const criticalPathLeaves = downstreamNodes.filter(n => n.depth === depth).map(n => n.name);

    return {
      symbol:    seed.name,
      file:      seed.filePath,
      className: seed.className ?? null,
      language:  seed.language,
      metrics:   { fanIn: seed.fanIn ?? 0, fanOut: seed.fanOut ?? 0, isHub },
      blastRadius: {
        total: blastRadius,
        upstream: upstreamNodes.length,
        downstream: downstreamNodes.length,
        ...(infraNeighbors.length > 0 ? { infrastructure: infraNeighbors.length } : {}),
      },
      riskScore,
      riskLevel: riskScore <= 20 ? 'low' : riskScore <= 45 ? 'medium' : riskScore <= 70 ? 'high' : 'critical',
      upstreamChain:          upstreamNodes,
      downstreamCriticalPath: downstreamNodes,
      criticalPathLeaves,
      recommendedStrategy: strategy,
      ...(crossDomain ? { crossDomain } : {}),
      ...(governingDecisions.length > 0 ? { governingDecisions } : {}),
      ...(valueLevelInfo ? { valueLevel: valueLevelInfo } : {}),
    };
  });

  // Federation scope (opt-in): who across the fleet consumes this published
  // symbol? Loads scoped repo indexes lazily and names coverage; never a union
  // graph. (change: add-multi-repo-federation)
  const fedScope = resolveFederationScope(absDir, { federation, federationRepos });
  let federationBlock: Record<string, unknown> | undefined;
  if (fedScope.active) {
    const seedNames = [...new Set(seeds.map(s => s.name))];
    const batch = await findCrossRepoConsumersBatch(fedScope, seedNames);
    const consumers = seedNames.flatMap(n => batch.bySymbol.get(n) ?? []);

    // Cross-service: if a seed is a route handler, surface client call sites in OTHER
    // repos that target its endpoint — the cross-repo blast radius of an API change.
    // Name-based federation can't see these (the call references a URL, not the
    // handler's symbol), so match on the handler's normalized route key instead.
    const homeRoutes = await deriveSeedRoutes(seeds, absDir);
    const crossSvc = homeRoutes.length > 0
      ? await findCrossRepoClientCallers(fedScope, homeRoutes)
      : undefined;

    federationBlock = {
      consumers: consumers.map(c => ({ repo: c.repo, caller: c.caller.name, file: c.caller.file, symbol: c.symbol })),
      consumerCount: consumers.length,
      ...(crossSvc && crossSvc.callers.length > 0 ? {
        crossServiceConsumers: crossSvc.callers.map(c => ({
          repo: c.repo, caller: c.caller.name, file: c.caller.file, method: c.method, path: c.path,
        })),
        crossServiceConsumerCount: crossSvc.callers.length,
      } : {}),
      reposConsulted: batch.coverage.reposConsulted.map(r => r.name),
      reposSkipped: batch.coverage.reposSkipped.map(r => ({ name: r.name, state: r.state, reason: r.reason })),
      ...(batch.truncated > 0 ? { truncated: batch.truncated } : {}),
      ...(crossSvc && crossSvc.truncated > 0 ? { crossServiceTruncated: crossSvc.truncated } : {}),
      caveats: [...batch.coverage.caveats, ...(crossSvc?.coverage.caveats ?? [])],
    };
  }
  const fedOut = federationBlock ? { federation: federationBlock } : {};

  if (seeds.length === 1) {
    return { ...results[0], confidenceBoundary, ...fedOut };
  }
  return { matches: results, confidenceBoundary, ...fedOut };
}

/**
 * Derive the route definition(s) each seed handler serves, so the federation bridge
 * can match other repos' client call sites against them. Deduped on method+path; a
 * seed that registers no route contributes nothing, so a non-handler analyze_impact
 * does no extra work.
 *
 * Primary source: the home repo's persisted route inventory (`route-inventory.json`).
 * It lists EVERY route (method, raw path, handler), so a handler whose route is
 * registered in a DIFFERENT file than its definition — Django (`urls.py`→`views.py`),
 * a dedicated Express routes file — is still found, matching the single-repo
 * `http_endpoint` projection. Falls back to parsing each seed's own file when the
 * inventory artifact is absent (an older index).
 */
async function deriveSeedRoutes(
  seeds: Array<{ name: string; filePath: string }>,
  absDir: string,
): Promise<RouteDefinition[]> {
  const seedNames = new Set(seeds.map(s => s.name));
  const seen = new Set<string>();
  const out: RouteDefinition[] = [];
  const add = (method: string, rawPath: string, handler: string, file: string, framework: string): void => {
    const normalizedPath = normalizeUrl(rawPath);
    const key = `${method}\0${normalizedPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, method, path: rawPath, normalizedPath, handlerName: handler, framework, line: 0, contractSource: 'none' });
  };

  try {
    const invPath = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ROUTE_INVENTORY);
    const { readFile } = await import('node:fs/promises');
    const inv = JSON.parse(await readFile(invPath, 'utf-8')) as RouteInventory;
    if (Array.isArray(inv?.routes)) {
      for (const r of inv.routes) {
        const simple = (r.handler ?? '').split('.').pop() ?? r.handler;
        if (simple && seedNames.has(simple)) add(r.method, r.path, r.handler, r.file, r.framework);
      }
      return out; // the inventory is complete — no per-file fallback needed
    }
  } catch { /* no/unreadable inventory → fall back to per-seed-file extraction below */ }

  const byFile = new Map<string, Set<string>>(); // file → seed handler names in it
  for (const s of seeds) {
    if (!byFile.has(s.filePath)) byFile.set(s.filePath, new Set());
    byFile.get(s.filePath)!.add(s.name);
  }
  for (const [file, names] of byFile) {
    const abs = isAbsolute(file) ? file : resolve(absDir, file);
    let routes;
    try { routes = await extractRoutesFromFile(abs); }
    catch { continue; }
    for (const r of routes) {
      const simple = r.handlerName.split('.').pop() ?? r.handlerName;
      if (names.has(simple)) add(r.method, r.path, r.handlerName, r.file, r.framework);
    }
  }
  return out;
}

/**
 * Return the N safest functions to refactor.
 */
export async function handleGetLowRiskRefactorCandidates(
  directory: string,
  limit = LOW_RISK_REFACTOR_CANDIDATES_DEFAULT_LIMIT,
  filePattern?: string
): Promise<unknown> {
  limit = Math.max(1, Math.min(limit, 500));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg       = ctx.callGraph as SerializedCallGraph;
  const hubIds   = new Set(cg.hubFunctions.map(n => n.id));
  const entryIds = new Set(cg.entryPoints.map(n => n.id));

  let candidates = cg.nodes.filter(n => {
    const fanIn  = n.fanIn  ?? 0;
    const fanOut = n.fanOut ?? 0;
    return !n.isExternal && !n.isTest && fanIn <= LOW_RISK_MAX_FAN_IN && fanOut <= LOW_RISK_MAX_FAN_OUT && !hubIds.has(n.id) && !entryIds.has(n.id);
  });

  if (filePattern) candidates = candidates.filter(n => n.filePath.includes(filePattern));

  candidates.sort((a, b) => {
    const ra = (a.fanIn ?? 0) + (a.fanOut ?? 0);
    const rb = (b.fanIn ?? 0) + (b.fanOut ?? 0);
    return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
  });

  const top = candidates.slice(0, limit).map(n => ({
    name: n.name, file: n.filePath, className: n.className ?? null, language: n.language,
    fanIn: n.fanIn ?? 0, fanOut: n.fanOut ?? 0,
    riskScore: computeRiskScore(n, 0, false),
    rationale: 'Low fan-in, low fan-out, not a hub — safe to rename, extract, or rewrite.',
  }));

  return {
    total: candidates.length, returned: top.length, candidates: top,
    tip: 'Start with the first candidate and work downward. Each can be changed in isolation.',
  };
}

/**
 * Return leaf functions (fan-out === 0).
 */
export async function handleGetLeafFunctions(
  directory: string,
  limit = LEAF_FUNCTIONS_DEFAULT_LIMIT,
  filePattern?: string,
  sortBy: 'fanIn' | 'name' | 'file' = 'fanIn'
): Promise<unknown> {
  limit = Math.max(1, Math.min(limit, 500));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const hasOutgoing = new Set(cg.edges.filter(e => e.calleeId).map(e => e.callerId));
  let leaves = cg.nodes.filter(n => !n.isExternal && !n.isTest && !hasOutgoing.has(n.id));

  if (filePattern) leaves = leaves.filter(n => n.filePath.includes(filePattern));

  leaves.sort((a, b) => {
    if (sortBy === 'fanIn') return (b.fanIn ?? 0) - (a.fanIn ?? 0);
    if (sortBy === 'name')  return a.name.localeCompare(b.name);
    return a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name);
  });

  const top = leaves.slice(0, limit).map(n => ({
    name: n.name, file: n.filePath, className: n.className ?? null, language: n.language,
    fanIn: n.fanIn ?? 0, fanOut: 0, blastRadius: 0,
    riskScore: computeRiskScore(n, 0, false),
    refactorAdvice: (n.fanIn ?? 0) === 0
      ? 'Unreachable or dead code — safe to delete after confirmation.'
      : 'Pure leaf: rewrite freely, then re-run tests for its callers.',
  }));

  return {
    totalLeaves: leaves.length, returned: top.length, sortedBy: sortBy, leaves: top,
    insight: 'Refactoring leaves bottom-up lets you build confidence and test coverage before tackling higher-risk hubs.',
  };
}

/**
 * Return critical hub functions ranked by composite criticality.
 */
export async function handleGetCriticalHubs(
  directory: string,
  limit = 10,
  minFanIn = CRITICAL_HUBS_DEFAULT_MIN_FAN_IN
): Promise<unknown> {
  limit = Math.max(1, Math.min(limit, 500));
  minFanIn = Math.max(1, Math.min(minFanIn, 100));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const violatorFiles = new Set(
    cg.layerViolations.flatMap(v =>
      [nodeMap.get(v.callerId)?.filePath, nodeMap.get(v.calleeId)?.filePath].filter(Boolean) as string[]
    )
  );

  const hubs = cg.nodes
    .filter(n => !n.isExternal && !n.isTest && (n.fanIn ?? 0) >= minFanIn)
    .map(n => {
      const fanIn        = n.fanIn  ?? 0;
      const fanOut       = n.fanOut ?? 0;
      const hasViolation = violatorFiles.has(n.filePath);
      const criticality  = fanIn * CRITICALITY_FAN_IN_WEIGHT + fanOut * CRITICALITY_FAN_OUT_WEIGHT + (hasViolation ? CRITICALITY_VIOLATION_BONUS : 0);
      const stabilityScore = Math.max(0, Math.round(100 - Math.min(100, criticality)));

      let approach: string;
      let approachRationale: string;
      if (fanIn >= HUB_HIGH_FAN_IN_THRESHOLD && fanOut >= HUB_HIGH_FAN_OUT_THRESHOLD) {
        approach = 'split responsibility';
        approachRationale = 'God-function: extract cohesive groups of callees into dedicated modules and expose a minimal coordinator interface.';
      } else if (fanIn >= HUB_HIGH_FAN_IN_THRESHOLD) {
        approach = 'introduce façade';
        approachRationale = 'Heavily depended-upon: keep the signature stable, move implementation behind a façade, then migrate callers to the new interface over time.';
      } else if (fanOut >= HUB_HIGH_FAN_OUT_THRESHOLD) {
        approach = 'delegate';
        approachRationale = "Too many outgoing calls: extract groups of related calls into helper services and delegate to them, reducing this function's orchestration burden.";
      } else {
        approach = 'extract';
        approachRationale = 'Moderate hub: identify the core responsibility, extract secondary logic into well-named helpers, and add integration tests before changing callers.';
      }

      return {
        name: n.name, file: n.filePath, className: n.className ?? null, language: n.language,
        fanIn, fanOut, hasLayerViolation: hasViolation,
        criticality: Math.round(criticality * 10) / 10,
        stabilityScore,
        riskScore: computeRiskScore(n, fanIn + fanOut, true),
        recommendedApproach: { approach, rationale: approachRationale },
        refactoringOrder:
          stabilityScore >= STABILITY_SCORE_CAN_REFACTOR ? 'can refactor now with good test coverage'
          : stabilityScore >= STABILITY_SCORE_STABILISE_FIRST ? 'refactor after stabilising its leaf dependencies'
          : 'defer — stabilise surrounding code first, then tackle incrementally',
      };
    })
    .sort((a, b) => b.criticality - a.criticality)
    .slice(0, limit);

  return {
    totalHubs: cg.nodes.filter(n => !n.isExternal && !n.isTest && (n.fanIn ?? 0) >= minFanIn).length,
    returned: hubs.length, minFanIn, hubs,
    guidance: 'Start with hubs that have the highest stabilityScore (easiest wins). Defer hubs with stabilityScore < 30 until their dependencies are cleaner.',
  };
}

/**
 * Detect god functions (high fan-out) and return their call-graph neighborhood.
 */
export async function handleGetGodFunctions(
  directory: string,
  filePath?: string,
  fanOutThreshold = GOD_FUNCTION_FAN_OUT_THRESHOLD,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  let candidates: FunctionNode[];
  if (filePath) {
    candidates = getFileGodFunctions(cg, filePath, fanOutThreshold);
  } else {
    candidates = cg.nodes.filter(n => !n.isExternal && !n.isTest && n.fanOut >= fanOutThreshold);
  }

  if (candidates.length === 0) {
    return { threshold: fanOutThreshold, count: 0, godFunctions: [], message: `No god functions found with fanOut >= ${fanOutThreshold}` };
  }

  const godFunctions = candidates
    .sort((a, b) => b.fanOut - a.fanOut)
    .map(fn => {
      const sub = extractSubgraph(cg, fn);
      const directCallees = [...new Set(sub.edges.filter(([from]) => from === fn.name).map(([, to]) => to))];
      return { name: fn.name, file: fn.filePath, className: fn.className, fanIn: fn.fanIn, fanOut: fn.fanOut, directCallees, subgraphNodes: sub.nodes.length };
    });

  return { threshold: fanOutThreshold, count: godFunctions.length, godFunctions };
}

/**
 * Return the file-level import dependencies for a given file.
 *
 * Uses the dependency-graph.json produced by `openlore analyze`.
 * direction:
 *   "imports"  — files this file depends on (outgoing edges)
 *   "importedBy" — files that depend on this file (incoming edges)
 *   "both"     — both directions
 */
export async function handleGetFileDependencies(
  directory: string,
  filePath: string,
  direction: 'imports' | 'importedBy' | 'both' = 'both',
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const depGraphPath = join(absDir, '.openlore', 'analysis', 'dependency-graph.json');

  interface DepEdge {
    source: string;
    target: string;
    importedNames: string[];
    isTypeOnly: boolean;
    weight: number;
  }
  interface DepNode {
    id: string;
    file: { path: string; absolutePath: string };
  }
  interface DepGraph { nodes: DepNode[]; edges: DepEdge[] }

  let graph: DepGraph;
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(depGraphPath, 'utf-8');
    graph = JSON.parse(raw) as DepGraph;
  } catch {
    return { error: 'No dependency graph found. Run "openlore analyze" first.' };
  }

  // A valid-but-partial artifact (e.g. {} or an interrupted analyze) parses fine but has
  // no nodes/edges arrays — guard the shape so .find()/.map() can't throw out of the handler.
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { error: 'No dependency graph found. Run "openlore analyze" first.' };
  }

  // Resolve the file path to the same form used in the graph (relative or absolute).
  // node.file may be absent on a malformed node — access it defensively.
  const node = graph.nodes.find(
    n => n.file?.path === filePath || n.file?.absolutePath?.endsWith('/' + filePath.replace(/^\//, ''))
  );
  if (!node) {
    return { error: `File not found in dependency graph: ${filePath}`, hint: 'Use a relative path from the project root, e.g. "src/core/analyzer/vector-index.ts"' };
  }

  const nodeIdToPath = new Map(graph.nodes.map(n => [n.id, n.file?.path ?? n.id]));

  const imports = (direction === 'imports' || direction === 'both')
    ? graph.edges
        .filter(e => e.source === node.id)
        .map(e => ({
          filePath: nodeIdToPath.get(e.target) ?? e.target,
          importedNames: e.importedNames,
          isTypeOnly: e.isTypeOnly,
        }))
    : undefined;

  const importedBy = (direction === 'importedBy' || direction === 'both')
    ? graph.edges
        .filter(e => e.target === node.id)
        .map(e => ({
          filePath: nodeIdToPath.get(e.source) ?? e.source,
          importedNames: e.importedNames,
          isTypeOnly: e.isTypeOnly,
        }))
    : undefined;

  return {
    filePath: node.file.path,
    direction,
    importsCount: imports?.length ?? null,
    importedByCount: importedBy?.length ?? null,
    imports,
    importedBy,
  };
}

/**
 * Find all execution paths between two functions in the call graph.
 * Useful for debugging: "how does request X reach function Y?",
 * "which call chain produced this error?".
 *
 * Uses DFS with visited-set cycle detection. Returns paths ordered
 * by hop count (shortest first), capped at maxPaths.
 */
export async function handleTraceExecutionPath(
  directory: string,
  entryFunction: string,
  targetFunction: string,
  maxDepth = TRACE_PATH_DEFAULT_MAX_DEPTH,
  maxPaths = TRACE_PATH_MAX_PATHS,
  directResolvedOnly = false,
  valueLevel = false,
  valueParam?: string,
): Promise<unknown> {
  maxDepth = Math.max(1, Math.min(maxDepth, SUBGRAPH_MAX_DEPTH_LIMIT));
  maxPaths = Math.max(1, Math.min(maxPaths, 50));

  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const { nodeMap, forward } = buildAdjacency(cg, { directResolvedOnly });

  const entryLower  = entryFunction.toLowerCase();
  const targetLower = targetFunction.toLowerCase();
  const entryMatches  = cg.nodes.filter(n => !n.isTest && n.name.toLowerCase().includes(entryLower));
  const targetMatches = cg.nodes.filter(n => !n.isTest && n.name.toLowerCase().includes(targetLower));

  if (entryMatches.length === 0)  return { error: `No function matching "${entryFunction}" found in call graph.` };
  if (targetMatches.length === 0) return { error: `No function matching "${targetFunction}" found in call graph.` };

  // Prefer EXACT name matches when any exist (same as find_path). Otherwise a query
  // like "area" also resolves "totalArea", and the DFS — which stops at the first
  // target it reaches — can halt at the same-substring node via a direct edge and
  // never reach the literal target (which may be reachable only across a synthesized
  // edge). That produced a misleadingly `complete: true` boundary for a path that
  // never reached the requested target; exact-match keeps the trace and its boundary
  // honest and consistent with find_path / analyze_impact.
  const exactEntry  = entryMatches.filter(n => n.name.toLowerCase() === entryLower);
  const exactTarget = targetMatches.filter(n => n.name.toLowerCase() === targetLower);
  const entryNodes  = exactEntry.length  > 0 ? exactEntry  : entryMatches;
  const targetNodes = exactTarget.length > 0 ? exactTarget : targetMatches;

  // Value-level opt-in (spec: add-intraprocedural-cfg-dataflow-overlay): restrict
  // each entry's first hop to the calls whose arguments are data-dependent on the
  // targeted value, via the reaching-definitions overlay. Opt-in and fail-soft —
  // with the flag absent, or for an entry without an overlay, traversal is the
  // original function-granularity DFS.
  let allowedFirstHop: Map<string, Set<string>> | undefined;
  let valueLevelInfo: { applied: boolean; parameter?: string; reason?: string } | undefined;
  if (valueLevel && ctx.edgeStore) {
   try {
    const { valueReachableLines } = await import('../../analyzer/cfg.js');
    allowedFirstHop = new Map();
    let anyOverlay = false;
    for (const entry of entryNodes) {
      const fnCfg = ctx.edgeStore.getCfg(entry.id);
      if (!fnCfg) continue;
      // Skip an ill-posed query (mistyped valueParam, or no params for an "all
      // params" request) so this entry's first hop stays unrestricted rather than
      // silently filtering every path away.
      const targetExists = valueParam === undefined
        ? fnCfg.params.length > 0
        : fnCfg.params.includes(valueParam) || fnCfg.defUse.some(e => e.variable === valueParam);
      if (!targetExists) continue;
      anyOverlay = true;
      const reached = valueReachableLines(fnCfg, valueParam);
      const allowed = new Set<string>();
      for (const e of ctx.edgeStore.getCallees(entry.id)) {
        if (e.line != null && reached.has(e.line) && e.calleeId) allowed.add(e.calleeId);
      }
      allowedFirstHop.set(entry.id, allowed);
    }
    valueLevelInfo = anyOverlay
      ? { applied: true, parameter: valueParam ?? '(all parameters)' }
      : { applied: false, reason: 'no resolvable value-level overlay for the entry function(s) (no overlay, or the value is not a parameter/local); returning function-granularity paths' };
    if (!anyOverlay) allowedFirstHop = undefined;
   } catch (error) {
     // Value-level is strictly best-effort: any overlay error falls back to the
     // original function-granularity DFS rather than failing the trace.
     if (process.env.DEBUG) console.debug(`[value-level] trace_execution_path fell back: ${(error as Error).message}`);
     allowedFirstHop = undefined;
     valueLevelInfo = { applied: false, reason: 'value-level overlay unavailable (error); returning function-granularity paths' };
   }
  }

  const targetIds = new Set(targetNodes.map(n => n.id));
  const allPaths: string[][] = [];

  function dfs(currentId: string, path: string[], visited: Set<string>): void {
    if (allPaths.length >= maxPaths) return;
    if (targetIds.has(currentId) && path.length > 1) {
      allPaths.push([...path]);
      return; // don't traverse past the target
    }
    if (path.length > maxDepth) return;
    // At the first hop from an entry, honor the value-level data-dependence filter.
    const firstHopFilter = path.length === 1 && allowedFirstHop?.has(path[0]) ? allowedFirstHop.get(path[0]) : undefined;
    for (const neighborId of forward.get(currentId) ?? []) {
      if (firstHopFilter && !firstHopFilter.has(neighborId)) continue;
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        path.push(neighborId);
        dfs(neighborId, path, visited);
        path.pop();
        visited.delete(neighborId);
      }
    }
  }

  for (const entry of entryNodes) {
    if (allPaths.length >= maxPaths) break;
    dfs(entry.id, [entry.id], new Set([entry.id]));
  }

  // Confidence boundary: the returned paths ARE the answer; their edges are the
  // basis. A path that crosses a synthesized edge leaned on heuristic dispatch.
  // (spec: add-confidence-boundary-disclosure)
  const pairIndex = buildPairEdgeIndex(cg.edges);
  const traceStaleness = await computeStaleness(absDir);

  if (allPaths.length === 0) {
    return {
      entryFunction,
      targetFunction,
      pathsFound: 0,
      message: `No execution path found from "${entryFunction}" to "${targetFunction}" within depth ${maxDepth}.`,
      hint: 'Try increasing maxDepth, or check whether both functions are in the same connected component of the call graph.',
      ...(valueLevelInfo ? { valueLevel: valueLevelInfo } : {}),
      confidenceBoundary: assembleBoundary({ basis: edgeBasisForChains([], pairIndex), staleness: traceStaleness, integrity: ctx?.integrity }),
    };
  }

  allPaths.sort((a, b) => a.length - b.length);

  const paths = allPaths.map(pathIds => {
    const steps = pathIds.map(id => {
      const node = nodeMap.get(id);
      return node
        ? { name: node.name, file: node.filePath, className: node.className ?? null }
        : { name: id, file: '', className: null };
    });
    return {
      hops: pathIds.length - 1,
      chain: steps.map(s => s.name).join(' → '),
      steps,
    };
  });

  return {
    entryFunction:  entryNodes[0].name,
    targetFunction: targetNodes[0].name,
    pathsFound: paths.length,
    maxDepth,
    shortestPath: paths[0].chain,
    paths,
    ...(valueLevelInfo ? { valueLevel: valueLevelInfo } : {}),
    confidenceBoundary: assembleBoundary({ basis: edgeBasisForChains(allPaths, pairIndex), staleness: traceStaleness, integrity: ctx?.integrity }),
  };
}
