/**
 * find_path (change: add-landmark-pathfinding).
 *
 * Goal-conditioned navigation: "get from A to B". Endpoints may be exact/fuzzy
 * names OR selectors (`landmark:<id>`, `role:entrypoint|hub|sink`, `file:<path>`),
 * so an agent can route by KIND of endpoint without naming both ends. Returns the
 * single CHEAPEST call path (by call-distance, or fewest hops if disabled) plus a
 * bounded set of alternates and a stated reason -- never a raw multi-path dump.
 *
 * Extends, not replaces, trace_execution_path: reuses its name-matching and the
 * weighted traversal (weightedBfs) from add-call-distance-scoping.
 */

import { relative, isAbsolute } from 'node:path';
import { validateDirectory, readCachedContext, notReadyResult } from './utils.js';
import { resolveFederationScope, locateSymbolProducers } from '../../federation/resolver.js';
import { buildWeightedAdjacency, weightedBfs } from './graph.js';
import { loadTraversalIndex, traversalIndexFor } from './traversal.js';
import type { TraversalIndex, TraversalFilter } from '../../analyzer/condensation.js';
import type { WeightedReach } from './graph.js';
import { assembleBoundary, buildPairEdgeIndex, computeStaleness, edgeBasisForChains } from './confidence-boundary.js';
import { SUBGRAPH_MAX_DEPTH_LIMIT } from '../../../constants.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';

export const MAX_ALTERNATES = 3;
/** Cost budget for the call-distance traversal (a path beyond this is "too far"). */
const PATH_MAX_DISTANCE = 12;

export type EndpointKind = 'name' | 'landmark' | 'role:entrypoint' | 'role:hub' | 'role:sink' | 'file' | 'error';

export interface ResolvedEndpoint {
  kind: EndpointKind;
  nodes: FunctionNode[];
}

/**
 * Resolve an endpoint spec to concrete functions. Each `role` resolves through an
 * EXISTING classifier with no new threshold; `sink` is parameter-free (a called
 * leaf: zero outgoing internal call edges AND fan-in >= 1).
 */
export function resolveEndpoint(
  spec: string,
  cg: SerializedCallGraph,
  traversal: TraversalIndex,
  filter?: TraversalFilter,
): ResolvedEndpoint {
  const real = (ns: FunctionNode[]) => ns.filter(n => !n.isExternal && !n.isTest);

  if (spec.startsWith('role:')) {
    const role = spec.slice(5);
    if (role === 'entrypoint') return { kind: 'role:entrypoint', nodes: real(cg.entryPoints) };
    if (role === 'hub') return { kind: 'role:hub', nodes: real(cg.hubFunctions) };
    if (role === 'sink') {
      // A called leaf: terminates an internal call chain and has at least one caller.
      const nodes = real(cg.nodes).filter(n => (n.fanIn ?? 0) >= 1 && traversal.degree(n.id, 'forward', filter) === 0);
      return { kind: 'role:sink', nodes };
    }
    return { kind: 'error', nodes: [] };
  }
  if (spec.startsWith('landmark:')) {
    const key = spec.slice(9).toLowerCase();
    const exact = real(cg.nodes).filter(n => n.id.toLowerCase() === key || n.name.toLowerCase() === key);
    const nodes = exact.length > 0 ? exact : real(cg.nodes).filter(n => n.id.toLowerCase().includes(key));
    return { kind: 'landmark', nodes };
  }
  if (spec.startsWith('file:')) {
    const p = spec.slice(5).replace(/^\/+/, '').toLowerCase();
    return { kind: 'file', nodes: real(cg.nodes).filter(n => n.filePath.toLowerCase().includes(p)) };
  }
  // exact / fuzzy name (case-insensitive substring, like trace_execution_path)
  const low = spec.toLowerCase();
  return { kind: 'name', nodes: real(cg.nodes).filter(n => n.name.toLowerCase().includes(low)) };
}

export interface PathResult {
  found: boolean;
  /** Cheapest path, when found. */
  best?: { ids: string[]; hops: number; distance: number };
  /** Up to MAX_ALTERNATES next-best paths (to other resolved to-seeds). */
  alternates: Array<{ ids: string[]; hops: number; distance: number }>;
  /** How many nodes the search reached (for the no-path answer). */
  reached: number;
}

/**
 * Unit-cost weighted adjacency (distance == hops) read off the precomputed
 * traversal structure. Only the `useCallDistance: false` branch needs it; the
 * default call-distance branch uses {@link buildWeightedAdjacency}, a different
 * structure (per-edge call-distance weights), which is deliberately outside the
 * reachability index — it is not a reachability question.
 */
function unitAdjacency(
  traversal: TraversalIndex,
  filter?: TraversalFilter,
): Map<string, Array<{ to: string; cost: number }>> {
  const out = new Map<string, Array<{ to: string; cost: number }>>();
  for (let i = 0; i < traversal.nodeCount; i++) {
    const id = traversal.idAt(i);
    out.set(id, traversal.neighborIds(id, 'forward', filter).map(to => ({ to, cost: 1 })));
  }
  return out;
}

function reconstruct(reach: Map<string, WeightedReach>, toId: string): { ids: string[]; hops: number; distance: number } {
  const ids: string[] = [];
  let cur: string | null = toId;
  while (cur) { ids.push(cur); cur = reach.get(cur)?.predecessor ?? null; }
  ids.reverse();
  const r = reach.get(toId)!;
  return { ids, hops: r.hops, distance: r.distance };
}

/**
 * Cheapest forward call path from any `from` seed to the nearest `to` seed. Uses
 * call-distance weights by default; unit (hop) costs when `useCallDistance` is
 * false. Returns the cheapest path plus up to MAX_ALTERNATES paths to other
 * reachable to-seeds.
 */
export function findCheapestPath(
  cg: SerializedCallGraph,
  fromSeeds: string[],
  toSeeds: string[],
  opts: { useCallDistance?: boolean; maxDistance?: number; traversal?: TraversalIndex; filter?: TraversalFilter } = {},
): PathResult {
  const adjacency = opts.useCallDistance === false
    ? unitAdjacency(opts.traversal ?? traversalIndexFor(cg), opts.filter)
    : buildWeightedAdjacency(cg).forward;
  const maxDistance = opts.useCallDistance === false
    ? SUBGRAPH_MAX_DEPTH_LIMIT
    : (opts.maxDistance ?? PATH_MAX_DISTANCE);

  const fromSet = new Set(fromSeeds);
  const reach = weightedBfs(fromSeeds, adjacency, maxDistance);

  const hits = toSeeds
    .filter(id => !fromSet.has(id) && reach.has(id))
    .map(id => reconstruct(reach, id))
    .sort((a, b) => a.distance - b.distance || a.hops - b.hops || a.ids.join().localeCompare(b.ids.join()));

  if (hits.length === 0) return { found: false, alternates: [], reached: reach.size };
  return { found: true, best: hits[0], alternates: hits.slice(1, 1 + MAX_ALTERNATES), reached: reach.size };
}

export async function handleFindPath(
  directory: string,
  from: string,
  to: string,
  opts: { useCallDistance?: boolean; directResolvedOnly?: boolean; federation?: boolean; federationRepos?: string[] } = {},
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) return notReadyResult('No call graph. Run analyze_codebase first.', 'index-absent');
  const rawCg = ctx.callGraph as SerializedCallGraph;
  // Strict mode: drop synthesized dynamic-dispatch edges so both the unit and the
  // weighted adjacency built below rest only on directly-resolved edges
  // (spec: add-synthesized-dynamic-dispatch-edges).
  const cg = opts.directResolvedOnly
    ? { ...rawCg, edges: rawCg.edges.filter(e => e.confidence !== 'synthesized') }
    : rawCg;
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  // The traversal structure precomputed for this generation, replacing the
  // per-call adjacency rebuild (change: optimize-reachability-precompute). Strict
  // mode filters `cg.edges` above into a fresh object, so the index is loaded for
  // the ORIGINAL graph (the generation's identity) and the filter is applied at
  // traversal time — the two are equivalent, and only this way is it memoizable.
  const traversal = await loadTraversalIndex(absDir, rawCg);
  const filtered: TraversalFilter | undefined = opts.directResolvedOnly ? { directResolvedOnly: true } : undefined;
  // Confidence boundary: the returned path's edges are the basis; the staleness
  // marker is shared by every exit. (spec: add-confidence-boundary-disclosure)
  const staleness = await computeStaleness(absDir);
  const pairIndex = buildPairEdgeIndex(cg.edges);

  const fromRes = resolveEndpoint(from, cg, traversal, filtered);
  const toRes = resolveEndpoint(to, cg, traversal, filtered);
  const SELECTOR_HELP = 'Use a function name, landmark:<id>, role:entrypoint|hub|sink, or file:<path>.';
  if (fromRes.kind === 'error') return { error: `Unknown "from" selector "${from}". ${SELECTOR_HELP}` };
  if (toRes.kind === 'error') return { error: `Unknown "to" selector "${to}". ${SELECTOR_HELP}` };

  const describe = (r: ResolvedEndpoint, selector: string) => ({
    selector, kind: r.kind, matched: r.nodes.length, sample: r.nodes.slice(0, 5).map(n => n.name),
  });
  const resolvedFrom = describe(fromRes, from);
  const resolvedTo = describe(toRes, to);

  // Federation (opt-in): name which scoped repos *define* the `to` symbol and
  // whether the home repo bridges to it (home call sites that reach it as an
  // external reference). This explains a cross-repo path without ever merging
  // graphs, and lets a `to` that lives in ANOTHER repo resolve at all.
  // (change: add-multi-repo-federation)
  let federationBlock: Record<string, unknown> | undefined;
  const fedScope = resolveFederationScope(absDir, { federation: opts.federation, federationRepos: opts.federationRepos });
  if (fedScope.active) {
    // Determine the single symbol name (if any) the `to` selector denotes, for the
    // cross-repo producer lookup. A bare name or `name:foo` is a symbol name. A
    // `landmark:foo` whose id is a plain symbol name (not a `file::name` node id) is
    // also a symbol reference, so it resolves cross-repo identically to `name:foo`.
    // `role:` and `file:` denote a role/path, not a symbol, so they have no name
    // unless they happened to resolve locally to a single named node.
    let toName: string | undefined;
    if (/^(role:|file:)/.test(to)) {
      toName = toRes.kind === 'name' ? toRes.nodes[0]?.name : undefined;
    } else if (to.startsWith('landmark:')) {
      const id = to.slice('landmark:'.length);
      toName = id && !id.includes('/') && !id.includes('::')
        ? id
        : (toRes.kind === 'name' ? toRes.nodes[0]?.name : undefined);
    } else {
      toName = to.replace(/^name:/, '');
    }
    const bridgeCallers = toName && ctx.edgeStore
      ? [...new Set(ctx.edgeStore.getExternalConsumers(toName).map(e => e.callerId))]
          .map(id => ctx.edgeStore!.getNode(id)?.name ?? id)
      : [];
    const located = toName ? await locateSymbolProducers(fedScope, toName) : { producers: [], coverage: { applied: true, reposConsulted: [], reposSkipped: [], caveats: [] } };
    federationBlock = {
      to: toName ?? to,
      producers: located.producers.map(p => ({ repo: p.repo, file: p.node.file, stableId: p.node.stableId })),
      bridge: { present: bridgeCallers.length > 0, fromHomeCallers: bridgeCallers },
      reposConsulted: located.coverage.reposConsulted.map(r => r.name),
      reposSkipped: located.coverage.reposSkipped.map(r => ({ name: r.name, state: r.state, reason: r.reason })),
      caveats: located.producers.length > 0
        ? ['Cross-repo producer located by exact symbol name; no merged graph — the home and producer paths are reported separately, bridged at the external call site.']
        : [],
    };
  }
  const withFed = <T extends Record<string, unknown>>(obj: T): T => (federationBlock ? { ...obj, federation: federationBlock } : obj);

  if (fromRes.nodes.length === 0) return withFed({ error: `"${from}" resolved to no functions.` });
  if (toRes.nodes.length === 0) {
    // `to` isn't in the home graph. When federation locates it in another repo,
    // answer with the cross-repo location + bridge instead of a bare error.
    const producers = (federationBlock?.producers as unknown[] | undefined) ?? [];
    if (producers.length > 0) {
      // Report the stripped symbol name (federation.to), not the raw selector, so
      // `to:"name:greet"` reads as `"greet" is not defined…` rather than echoing
      // the selector prefix.
      const toLabel = (federationBlock?.to as string | undefined) ?? to;
      // Only claim a bridge when one actually exists. The home repo may *not* call
      // the cross-repo symbol (no external call site), in which case bridge.present
      // is false — asserting "the home path reaches it" would be a false statement.
      const hasBridge = (federationBlock?.bridge as { present?: boolean } | undefined)?.present === true;
      const note = hasBridge
        ? `"${toLabel}" is not defined in the home repo; it is published by another federated repo (see federation.producers). The home path reaches it at the external call site(s) named in federation.bridge.fromHomeCallers.`
        : `"${toLabel}" is not defined in the home repo; it is published by another federated repo (see federation.producers). The home repo has no call site that bridges to it, so there is no cross-repo path from "${from}".`;
      return withFed({
        from, to, resolvedFrom, resolvedTo, path: null,
        crossRepo: true,
        note,
      });
    }
    return withFed({ error: `"${to}" resolved to no functions.` });
  }

  // Same-endpoint query: every resolved target is also a source — no traversal needed.
  const fromIds = new Set(fromRes.nodes.map(n => n.id));
  if (toRes.nodes.every(n => fromIds.has(n.id))) {
    return withFed({
      from, to, resolvedFrom, resolvedTo, path: null,
      note: 'from and to resolve to the same function(s) — no path to compute.',
      confidenceBoundary: assembleBoundary({ basis: edgeBasisForChains([], pairIndex), staleness, integrity: ctx?.integrity }),
    });
  }

  const useCallDistance = opts.useCallDistance !== false;
  const result = findCheapestPath(cg, fromRes.nodes.map(n => n.id), toRes.nodes.map(n => n.id), { useCallDistance, traversal, filter: filtered });
  // Call-graph node paths are already repo-relative (e.g. "src/app.ts"); only an
  // absolute path needs relativizing. The bare `relative(absDir, …)` mis-resolved a
  // repo-relative path against process.cwd(), emitting "../../…/abs/cwd/src/app.ts"
  // garbage whenever the MCP server's cwd differed from the analyzed directory (the
  // normal case) — it only looked right when cwd happened to equal absDir.
  const displayFile = (filePath: string): string => (isAbsolute(filePath) ? relative(absDir, filePath) : filePath);
  const toChain = (p: { ids: string[]; hops: number; distance: number }) => ({
    chain: p.ids.map(id => { const n = nodeMap.get(id); return { name: n?.name ?? id, file: n ? displayFile(n.filePath) : '' }; }),
    hops: p.hops,
    distance: useCallDistance ? p.distance : undefined,
  });

  if (!result.found) {
    return withFed({
      from, to, resolvedFrom, resolvedTo, path: null,
      noPath: {
        reason: `No call path from "${from}" to "${to}" within ${useCallDistance ? `call-distance ${PATH_MAX_DISTANCE}` : `depth ${SUBGRAPH_MAX_DEPTH_LIMIT}`}.`,
        reachedNodes: result.reached,
        hint: 'The endpoints may be in different connected components, or only linked by a longer path — try the other endpoint kinds.',
      },
      confidenceBoundary: assembleBoundary({ basis: edgeBasisForChains([], pairIndex), staleness, integrity: ctx?.integrity }),
    });
  }

  const best = result.best!;
  const chainIds = [best.ids, ...result.alternates.map(a => a.ids)];
  return withFed({
    from, to, resolvedFrom, resolvedTo,
    path: toChain(best),
    alternates: result.alternates.map(toChain),
    reason: useCallDistance
      ? `Cheapest by call-distance (cost ${best.distance}, ${best.hops} hops); ${result.alternates.length} alternate(s).`
      : `Fewest hops (${best.hops}); ${result.alternates.length} alternate(s).`,
    confidenceBoundary: assembleBoundary({ basis: edgeBasisForChains(chainIds, pairIndex), staleness, integrity: ctx?.integrity }),
  });
}
