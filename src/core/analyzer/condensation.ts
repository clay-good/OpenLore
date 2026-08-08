/**
 * Precomputed reachability structure (change: optimize-reachability-precompute).
 *
 * Every flagship conclusion OpenLore serves — which tests reach this change
 * (`select_tests`), what has no reaching test (`report_coverage_gaps`), what dies
 * if X is deleted (`find_dead_code`), what a diff's blast radius is
 * (`blast_radius`) — is a reachability question. Before this module each of them
 * re-answered from scratch at tool-call time: rebuild `Map<string, Set<string>>`
 * adjacency over the whole graph, run a BFS whose queue was an array drained with
 * `Array.prototype.shift()` (O(n) per pop), then throw all of it away.
 *
 * The graph only changes at analyze/flush. So the traversal structure is built
 * there, once, and served as lookups:
 *
 *  - **Dense integer node ids.** `nodeIds[i]` ⇆ `indexOf(id)`; every traversal
 *    runs on `Int32Array`s, never on Maps of Sets of strings.
 *  - **CSR adjacency, forward and backward.** `offsets[i]..offsets[i+1]` slices
 *    `targets`, with a parallel `flags` byte per edge slot carrying the
 *    kind/confidence bits the existing filters need (`synthesized`, so
 *    `directResolvedOnly` stays expressible) plus the per-filter forward
 *    *eligibility* bits — `buildAdjacency` grows its forward key set as it walks
 *    the filtered edge list, so whether a forward edge is emitted depends on the
 *    filter AND the edge's position, and that verdict is resolved at build time
 *    per slot. Slots are stored in the original `cg.edges` order within each
 *    source group and are NOT pre-deduplicated, so any filtered view reproduces
 *    `buildAdjacency`'s insertion-ordered `Set` exactly — see
 *    {@link TraversalIndex.neighborIds}.
 *  - **SCC condensation + topological order.** Tarjan (iterative, on the dense
 *    ids) collapses cycles; whole-graph reaches then run as a single array scan
 *    over the condensation DAG in topological order — linear and allocation-free,
 *    with member expansion recovering the exact node-level answer.
 *
 * EQUIVALENCE IS THE CONTRACT. This module changes latency, never answers. Every
 * primitive here is specified against the per-call BFS it replaces
 * (`buildAdjacency` + `bfs`/`reachableFrom`/`reachAll` in `mcp-handlers/`), down
 * to neighbor iteration order and the treatment of seeds that are not in the
 * graph, and `condensation.test.ts` pins that equivalence on randomized graphs.
 *
 * Deliberately NOT borrowed from the reachability-index literature: no
 * interval/2-hop labeling (GRAIL/FERRARI class). Labeling pays off orders of
 * magnitude further up the node count and adds an invalidation liability the
 * condensation walk does not have. If profiling at real monorepo scale ever shows
 * condensation walks insufficient, labeling is a follow-up proposal, not this one.
 */

import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { ARTIFACT_TRAVERSAL_INDEX } from '../../constants.js';
import type { SerializedCallGraph } from './call-graph.js';

/**
 * The invalidation key binding a persisted structure to the graph it describes:
 * a SHA-256 over EXACTLY the call-graph facts the structure depends on — the node
 * id set in `cg.nodes` order, then each usable edge's `(callerId, calleeId,
 * synthesized)` in `cg.edges` order. Nothing else. Signatures, phases, and every
 * other `llm-context.json` field are irrelevant to the structure, so an edit that
 * touches only those cannot move this digest and cannot invalidate the structure;
 * conversely any change to a node id, an edge endpoint, an edge's synthesized-ness,
 * or the edge order does move it.
 *
 * `analyze` writes this value INTO `llm-context.json` (change:
 * shrink-traversal-index-invalidation-scope) and stamps the persisted structure
 * with the same value, so the reader gets the key for free from the JSON it has
 * already parsed — no hashing of the multi-MB artifact on the read path. The edge
 * universe fully determines the interned node universe the structure builds, so
 * hashing `cg.nodes` ids plus each edge triple covers the structure's whole
 * dependency set.
 */
export function graphDigest(cg: SerializedCallGraph): string {
  const nodes = Array.isArray(cg.nodes) ? cg.nodes : [];
  const edges = Array.isArray(cg.edges) ? cg.edges : [];
  const h = createHash('sha256');
  // NUL-delimited (\u0000 cannot occur in a symbol id) with distinct section
  // markers, so no id can forge a boundary and no two distinct graphs collide.
  h.update(`n${nodes.length}`);
  for (const n of nodes) { h.update('\u0000'); h.update(n.id); }
  h.update('\u0001e');
  for (const e of edges) {
    if (!e.calleeId) continue;
    h.update('\u0000');
    h.update(e.callerId);
    h.update('\u0000');
    h.update(e.calleeId);
    h.update(e.confidence === 'synthesized' ? '\u0001s' : '\u0001d');
  }
  return h.digest('hex');
}

/** Traversal direction: `forward` = caller→callee, `backward` = callee→caller. */
export type Direction = 'forward' | 'backward';

/**
 * The edge filters the traversal handlers already expose. Kept as an options
 * object (rather than a boolean) so a future filter is additive.
 */
export interface TraversalFilter {
  /**
   * Strict mode (spec: add-synthesized-dynamic-dispatch-edges): skip synthesized
   * dynamic-dispatch / CHA / override edges so traversal rests only on directly
   * resolved edges. Mirrors `buildAdjacency({ directResolvedOnly: true })`.
   */
  directResolvedOnly?: boolean;
}

/**
 * Edge-slot flag bits carried in the parallel per-edge mask.
 *
 * `FWD_ELIGIBLE_*` exist because `buildAdjacency` creates forward-map KEYS as it
 * walks the (already filtered) edge list, so whether a forward edge is emitted at
 * all depends on both the filter and the edge's POSITION in `cg.edges`: an edge
 * out of a caller that is not a `cg.nodes` member is dropped unless some earlier
 * surviving edge already made that caller a key (by naming it as a callee). That
 * predicate is therefore per-slot and per-filter, and is resolved at build time
 * into these bits rather than approximated by a whole-graph pre-pass.
 */
const FLAG_SYNTHESIZED = 1 << 0;
/** This forward slot is emitted in the unfiltered view. */
const FLAG_FWD_ELIGIBLE_ALL = 1 << 1;
/** This forward slot is emitted under `directResolvedOnly`. */
const FLAG_FWD_ELIGIBLE_DIRECT = 1 << 2;

/** Serialized-artifact schema version. Bumped when the layout changes. */
export const TRAVERSAL_INDEX_VERSION = 2;

interface Csr {
  offsets: Int32Array;
  targets: Int32Array;
  flags: Uint8Array;
}

/** The compact, precomputed traversal structure. See the module header. */
export interface TraversalIndex {
  /** Number of distinct node ids in the traversal universe. */
  readonly nodeCount: number;
  /** Number of edge slots — the count of `cg.edges` that carry a `calleeId`. */
  readonly edgeCount: number;
  /** Number of strongly-connected components in the condensation. */
  readonly componentCount: number;
  /** Dense index of `id`, or -1 when the id is not in the graph. */
  indexOf(id: string): number;
  /** The id at dense index `i`. */
  idAt(i: number): string;
  hasNode(id: string): boolean;
  /**
   * The condensation component `id` belongs to, or -1 when the id is not in the
   * graph. Components are numbered in Tarjan completion order, which is a reverse
   * topological order of the condensation DAG.
   */
  componentOf(id: string): number;

  /**
   * `id`'s neighbors in `dir`, deduplicated, in exactly the order
   * `buildAdjacency(cg, filter).{forward,backward}.get(id)` yields — i.e. first
   * appearance among the edges that survive `filter`. An id not in the graph
   * yields `[]` (matching `adjacency.get(unknown) ?? []`).
   */
  neighborIds(id: string, dir: Direction, filter?: TraversalFilter): string[];

  /**
   * The number of DISTINCT neighbors of `id` in `dir` — equivalent to
   * `adjacency.get(id)?.size ?? 0`, which is how `find_path` recognizes a call-chain
   * leaf. 0 for an id that is not in the graph.
   */
  degree(id: string, dir: Direction, filter?: TraversalFilter): number;

  /**
   * Unbounded reach from `seeds` in `dir`, seeds included — the replacement for
   * the handlers' `reachAll` / `reachableFrom`. Runs as a topological scan of the
   * condensation DAG in the unfiltered case; a filtered view falls back to an
   * allocation-free CSR BFS (the condensation is built over the whole graph, and
   * a filtered graph can have strictly finer components).
   *
   * `excludeId`, when given, is removed from BOTH the seeds and the traversal —
   * `find_dead_code`'s "what dies if I delete X?" mode.
   *
   * A seed that is not in the graph is still present in the result (depth 0, no
   * expansion), matching the per-call BFS.
   */
  reachAll(
    seeds: Iterable<string>,
    dir: Direction,
    filter?: TraversalFilter,
    excludeId?: string,
  ): Set<string>;

  /**
   * Depth-bounded BFS returning visited id → depth, equivalent to
   * `bfs(seeds, adjacency, maxDepth)`. Neighbors are expanded in CSR (edge)
   * order; pass `sortNeighbors` to expand them in ascending id order instead
   * (what `select_tests` / `analyze_env_impact` do today, which fixes their
   * `parent` chains deterministically).
   */
  bfsDepths(
    seeds: Iterable<string>,
    dir: Direction,
    maxDepth: number,
    filter?: TraversalFilter,
    opts?: { sortNeighbors?: boolean },
  ): Map<string, number>;

  /**
   * {@link bfsDepths} plus the predecessor each node was first reached from —
   * the `depthOf` + `parent` pair `select_tests` reconstructs its `viaPath` from.
   */
  bfsWithParents(
    seeds: Iterable<string>,
    dir: Direction,
    maxDepth: number,
    filter?: TraversalFilter,
    opts?: {
      sortNeighbors?: boolean;
      /**
       * Stop as soon as this id is reached. The result then covers only what was
       * explored up to that point — enough to reconstruct the path TO `stopAt`,
       * which is all a single-target reachability question needs.
       */
      stopAt?: string;
    },
  ): { depth: Map<string, number>; parent: Map<string, string> };
}

// ============================================================================
// BUILD
// ============================================================================

/**
 * Build the traversal index for a serialized call graph.
 *
 * The node universe reproduces `buildAdjacency`'s exactly: every `cg.nodes` id,
 * plus every `calleeId` (external leaves get adjacency entries there too), plus
 * every `callerId` (which appears inside backward adjacency sets even when it is
 * not itself a key). Forward slots are emitted only for callers that are keys in
 * that map — the `forward.get(e.callerId)?.add(...)` optional-chain drop — so an
 * edge from an unknown caller contributes to backward adjacency only, exactly as
 * today.
 */
export function buildTraversalIndex(cg: SerializedCallGraph): TraversalIndex {
  return makeIndex(buildIndexParts(cg));
}

/** The build proper. Kept separate so serialization can reach the raw arrays. */
function buildIndexParts(cg: SerializedCallGraph): IndexParts {
  const nodes = Array.isArray(cg.nodes) ? cg.nodes : [];
  const edges = Array.isArray(cg.edges) ? cg.edges : [];

  // ── Node universe, in first-appearance order (order is an internal detail;
  //    every ordered output is derived from ids, not from these indices).
  const indexById = new Map<string, number>();
  const nodeIds: string[] = [];
  const intern = (id: string): number => {
    let i = indexById.get(id);
    if (i === undefined) {
      i = nodeIds.length;
      nodeIds.push(id);
      indexById.set(id, i);
    }
    return i;
  };
  for (const n of nodes) intern(n.id);
  for (const e of edges) {
    if (!e.calleeId) continue;
    intern(e.calleeId);
    intern(e.callerId);
  }

  const nodeCount = nodeIds.length;

  // ── Usable edge slots, in cg.edges order. `flags` carries the per-edge
  //    kind/confidence bits and the per-filter forward-eligibility bits.
  //
  //    Forward-key sets are grown here in exactly the order — and with exactly
  //    the interleaving — `buildAdjacency` grows its `forward` map: the callee's
  //    key is created BEFORE the caller's add is attempted (so a self-edge from an
  //    unindexed id lands), and a filtered-out edge never creates a key at all
  //    (so the strict view's key set is strictly smaller, not merely its edges).
  const fwdKeysAll = new Set<number>();
  const fwdKeysDirect = new Set<number>();
  for (const n of nodes) {
    const i = indexById.get(n.id)!;
    fwdKeysAll.add(i);
    fwdKeysDirect.add(i);
  }

  const srcF: number[] = [];
  const dstF: number[] = [];
  const flagF: number[] = [];
  const srcB: number[] = [];
  const dstB: number[] = [];
  const flagB: number[] = [];
  for (const e of edges) {
    if (!e.calleeId) continue;
    const caller = indexById.get(e.callerId)!;
    const callee = indexById.get(e.calleeId)!;
    const synthesized = e.confidence === 'synthesized';
    let flags = synthesized ? FLAG_SYNTHESIZED : 0;

    fwdKeysAll.add(callee);
    if (fwdKeysAll.has(caller)) flags |= FLAG_FWD_ELIGIBLE_ALL;
    if (!synthesized) {
      fwdKeysDirect.add(callee);
      if (fwdKeysDirect.has(caller)) flags |= FLAG_FWD_ELIGIBLE_DIRECT;
    }

    srcF.push(caller); dstF.push(callee); flagF.push(flags);
    srcB.push(callee); dstB.push(caller); flagB.push(flags);
  }

  const forward = buildCsr(nodeCount, srcF, dstF, flagF);
  const backward = buildCsr(nodeCount, srcB, dstB, flagB);

  // A condensation PER DIRECTION. The two adjacencies are NOT transposes of each
  // other: an edge whose caller is not itself a key in the forward map (the
  // `forward.get(e.callerId)?.add(...)` optional-chain drop) exists only backward.
  // Condensing one direction and reversing it would therefore lose exactly those
  // edges and under-report backward reach — pinned by the `ghostCaller` case in
  // `condensation.test.ts`.
  return {
    nodeIds, indexById, forward, backward,
    // The condensation serves only the UNFILTERED walk, so it is built over the
    // slots that view actually traverses: forward drops slots the caller was not
    // yet a key for; backward traverses every slot.
    condForward: condense(nodeCount, forward, f => (f & FLAG_FWD_ELIGIBLE_ALL) !== 0),
    condBackward: condense(nodeCount, backward, () => true),
  };
}

/**
 * SCC condensation + topological order of one direction's adjacency.
 *
 * Tarjan closes a component only after every component it can reach, so its
 * completion numbering is already a REVERSE topological order of the condensation
 * DAG. `topoOrder` materializes the source→sink order rather than leaving that
 * invariant implicit at every read site; `condensation.test.ts` pins it.
 */
function condense(nodeCount: number, csr: Csr, slotOk: (flags: number) => boolean): Condensation {
  const { component, componentCount } = tarjanScc(nodeCount, csr, slotOk);
  const topoOrder = new Int32Array(componentCount);
  for (let c = 0; c < componentCount; c++) topoOrder[c] = componentCount - 1 - c;
  return {
    component,
    componentCount,
    topoOrder,
    members: buildMembers(nodeCount, componentCount, component),
    compAdj: buildComponentCsr(componentCount, component, csr, slotOk),
  };
}

/** Group `(src → dst, flag)` slots by source into CSR arrays, preserving input order. */
function buildCsr(nodeCount: number, src: number[], dst: number[], flag: number[]): Csr {
  const m = src.length;
  const offsets = new Int32Array(nodeCount + 1);
  for (let k = 0; k < m; k++) offsets[src[k] + 1]++;
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] += offsets[i];
  const targets = new Int32Array(m);
  const flags = new Uint8Array(m);
  const cursor = Int32Array.from(offsets.subarray(0, nodeCount));
  // Stable counting sort: within a source group, slots keep their cg.edges order.
  for (let k = 0; k < m; k++) {
    const p = cursor[src[k]]++;
    targets[p] = dst[k];
    flags[p] = flag[k];
  }
  return { offsets, targets, flags };
}

/** node → component id, numbered in Tarjan completion (reverse topological) order. */
function tarjanScc(
  nodeCount: number,
  fwd: Csr,
  slotOk: (flags: number) => boolean,
): { component: Int32Array; componentCount: number } {
  const UNVISITED = -1;
  const index = new Int32Array(nodeCount).fill(UNVISITED);
  const lowlink = new Int32Array(nodeCount);
  const onStack = new Uint8Array(nodeCount);
  const component = new Int32Array(nodeCount).fill(UNVISITED);
  const stack = new Int32Array(nodeCount);
  let stackTop = 0;
  // Explicit frame stack (iterative Tarjan — a recursive one blows the JS stack
  // on deep graphs; the same shape `refactor-analyzer.ts` uses, on dense ints).
  const frameNode = new Int32Array(nodeCount);
  const frameEdge = new Int32Array(nodeCount);
  let counter = 0;
  let componentCount = 0;

  for (let root = 0; root < nodeCount; root++) {
    if (index[root] !== UNVISITED) continue;
    let top = 0;
    frameNode[0] = root;
    frameEdge[0] = fwd.offsets[root];
    index[root] = lowlink[root] = counter++;
    stack[stackTop++] = root;
    onStack[root] = 1;

    while (top >= 0) {
      const v = frameNode[top];
      if (frameEdge[top] < fwd.offsets[v + 1]) {
        const slot = frameEdge[top]++;
        if (!slotOk(fwd.flags[slot])) continue;
        const w = fwd.targets[slot];
        if (index[w] === UNVISITED) {
          index[w] = lowlink[w] = counter++;
          stack[stackTop++] = w;
          onStack[w] = 1;
          top++;
          frameNode[top] = w;
          frameEdge[top] = fwd.offsets[w];
        } else if (onStack[w] === 1 && index[w] < lowlink[v]) {
          lowlink[v] = index[w];
        }
      } else {
        if (lowlink[v] === index[v]) {
          const c = componentCount++;
          for (;;) {
            const w = stack[--stackTop];
            onStack[w] = 0;
            component[w] = c;
            if (w === v) break;
          }
        }
        top--;
        if (top >= 0) {
          const parent = frameNode[top];
          if (lowlink[v] < lowlink[parent]) lowlink[parent] = lowlink[v];
        }
      }
    }
  }
  return { component, componentCount };
}

/** component → its member node indices, as a CSR over components. */
function buildMembers(nodeCount: number, componentCount: number, component: Int32Array): Csr {
  const offsets = new Int32Array(componentCount + 1);
  for (let i = 0; i < nodeCount; i++) offsets[component[i] + 1]++;
  for (let c = 0; c < componentCount; c++) offsets[c + 1] += offsets[c];
  const targets = new Int32Array(nodeCount);
  const cursor = Int32Array.from(offsets.subarray(0, componentCount));
  for (let i = 0; i < nodeCount; i++) targets[cursor[component[i]]++] = i;
  return { offsets, targets, flags: new Uint8Array(0) };
}

/**
 * The condensation DAG's adjacency, in the same direction as `csr`. Self-loops
 * (intra-component edges) are dropped; duplicate component pairs are collapsed so
 * a topological scan touches each condensation edge exactly once.
 */
function buildComponentCsr(
  componentCount: number,
  component: Int32Array,
  csr: Csr,
  slotOk: (flags: number) => boolean,
): Csr {
  const src: number[] = [];
  const dst: number[] = [];
  const nodeCount = component.length;
  const seen = new Set<number>();
  for (let v = 0; v < nodeCount; v++) {
    const cv = component[v];
    for (let k = csr.offsets[v]; k < csr.offsets[v + 1]; k++) {
      if (!slotOk(csr.flags[k])) continue;
      const cw = component[csr.targets[k]];
      if (cv === cw) continue;
      // Pair key: componentCount ≤ nodeCount, and a graph with > 2^26 nodes is far
      // outside any real repo, so a 52-bit product key stays exact.
      const key = cv * componentCount + cw;
      if (seen.has(key)) continue;
      seen.add(key);
      src.push(cv); dst.push(cw);
    }
  }
  return buildCsr(componentCount, src, dst, new Array<number>(src.length).fill(0));
}

// ============================================================================
// TRAVERSAL
// ============================================================================

/** One direction's SCC condensation: components, their DAG, and its topological order. */
interface Condensation {
  /** node index → component id (Tarjan completion order == reverse topological). */
  component: Int32Array;
  componentCount: number;
  /** Components in topological order, source→sink for this direction's DAG. */
  topoOrder: Int32Array;
  /** component → member node indices. */
  members: Csr;
  /** The condensation DAG, in this direction. */
  compAdj: Csr;
}

interface IndexParts {
  nodeIds: string[];
  indexById: Map<string, number>;
  forward: Csr;
  backward: Csr;
  condForward: Condensation;
  condBackward: Condensation;
}

function makeIndex(p: IndexParts): TraversalIndex {
  const { nodeIds, indexById, forward, backward } = p;
  const nodeCount = nodeIds.length;

  const csrFor = (dir: Direction) => (dir === 'forward' ? forward : backward);
  const condFor = (dir: Direction) => (dir === 'forward' ? p.condForward : p.condBackward);
  /**
   * Whether an edge slot is part of `dir`'s adjacency under `filter`.
   *
   * Forward reads the precomputed per-filter eligibility bit (see the flag
   * definitions: forward emission is position- and filter-dependent). Backward
   * needs no eligibility bit — `buildAdjacency` creates the callee's backward key
   * immediately before adding to it, so a surviving backward edge always lands.
   */
  const keep = (flags: number, filter: TraversalFilter | undefined, dir: Direction): boolean =>
    dir === 'forward'
      ? (flags & (filter?.directResolvedOnly ? FLAG_FWD_ELIGIBLE_DIRECT : FLAG_FWD_ELIGIBLE_ALL)) !== 0
      : !(filter?.directResolvedOnly && (flags & FLAG_SYNTHESIZED) !== 0);

  function neighborIds(id: string, dir: Direction, filter?: TraversalFilter): string[] {
    const v = indexById.get(id);
    if (v === undefined) return [];
    const csr = csrFor(dir);
    const out: string[] = [];
    const seen = new Set<number>();
    for (let k = csr.offsets[v]; k < csr.offsets[v + 1]; k++) {
      if (!keep(csr.flags[k], filter, dir)) continue;
      const w = csr.targets[k];
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(nodeIds[w]);
    }
    return out;
  }

  /** Allocation-free CSR BFS over the dense ids; `visited` doubles as the dedup. */
  function reachBits(
    seedIdx: number[],
    dir: Direction,
    filter: TraversalFilter | undefined,
    excludeIdx: number,
  ): Uint8Array {
    const csr = csrFor(dir);
    const visited = new Uint8Array(nodeCount);
    const queue = new Int32Array(nodeCount);
    let head = 0;
    let tail = 0;
    for (const s of seedIdx) {
      if (s === excludeIdx || visited[s]) continue;
      visited[s] = 1;
      queue[tail++] = s;
    }
    while (head < tail) {
      const v = queue[head++];
      for (let k = csr.offsets[v]; k < csr.offsets[v + 1]; k++) {
        if (!keep(csr.flags[k], filter, dir)) continue;
        const w = csr.targets[k];
        if (w === excludeIdx || visited[w]) continue;
        visited[w] = 1;
        queue[tail++] = w;
      }
    }
    return visited;
  }

  /**
   * Whole-graph reach as a topological scan of the condensation DAG: mark each
   * seed's component, then sweep components in topological order propagating the
   * mark to successors. One linear pass, no queue, no per-node revisits — the
   * condensation collapses every cycle the node-level BFS would have to re-walk.
   * Member expansion recovers the exact node-level answer.
   */
  function reachBitsCondensed(seedIdx: number[], dir: Direction): Uint8Array {
    const { component, componentCount, topoOrder, members, compAdj } = condFor(dir);
    const marked = new Uint8Array(componentCount);
    for (const s of seedIdx) marked[component[s]] = 1;
    for (let t = 0; t < componentCount; t++) {
      const c = topoOrder[t];
      if (!marked[c]) continue;
      for (let k = compAdj.offsets[c]; k < compAdj.offsets[c + 1]; k++) {
        marked[compAdj.targets[k]] = 1;
      }
    }
    const visited = new Uint8Array(nodeCount);
    for (let c = 0; c < componentCount; c++) {
      if (!marked[c]) continue;
      for (let k = members.offsets[c]; k < members.offsets[c + 1]; k++) visited[members.targets[k]] = 1;
    }
    return visited;
  }

  function reachAll(
    seeds: Iterable<string>,
    dir: Direction,
    filter?: TraversalFilter,
    excludeId?: string,
  ): Set<string> {
    const out = new Set<string>();
    const seedIdx: number[] = [];
    for (const s of seeds) {
      if (excludeId !== undefined && s === excludeId) continue;
      const i = indexById.get(s);
      // A seed outside the graph is still "reached" (the per-call BFS seeds
      // `visited` before ever consulting adjacency) — it just expands to nothing.
      if (i === undefined) out.add(s);
      else seedIdx.push(i);
    }
    const excludeIdx = excludeId !== undefined ? (indexById.get(excludeId) ?? -1) : -1;
    const visited =
      excludeIdx === -1 && !filter?.directResolvedOnly
        ? reachBitsCondensed(seedIdx, dir)
        : reachBits(seedIdx, dir, filter, excludeIdx);
    for (let i = 0; i < nodeCount; i++) if (visited[i]) out.add(nodeIds[i]);
    return out;
  }

  function bfsCore(
    seeds: Iterable<string>,
    dir: Direction,
    maxDepth: number,
    filter: TraversalFilter | undefined,
    sortNeighbors: boolean,
    wantParents: boolean,
    stopAt?: string,
  ): { depth: Map<string, number>; parent: Map<string, string> } {
    const csr = csrFor(dir);
    const depth = new Map<string, number>();
    const parent = new Map<string, string>();
    const depthOf = new Int32Array(nodeCount).fill(-1);
    const queue = new Int32Array(nodeCount);
    let head = 0;
    let tail = 0;
    for (const s of seeds) {
      if (depth.has(s)) continue;
      depth.set(s, 0);
      const i = indexById.get(s);
      if (i === undefined) continue; // unknown seed: recorded, never expanded
      if (depthOf[i] !== -1) continue;
      depthOf[i] = 0;
      queue[tail++] = i;
    }
    const scratch: number[] = [];
    while (head < tail) {
      const v = queue[head++];
      const d = depthOf[v];
      if (d >= maxDepth) continue;
      const from = csr.offsets[v];
      const to = csr.offsets[v + 1];
      let slots: Int32Array | number[];
      if (sortNeighbors) {
        // Match today's `[...(adjacency.get(id) ?? [])].sort()`: default (UTF-16
        // code-unit) string order over the neighbor ids, deduplicated.
        scratch.length = 0;
        const seen = new Set<number>();
        for (let k = from; k < to; k++) {
          if (!keep(csr.flags[k], filter, dir)) continue;
          const w = csr.targets[k];
          if (seen.has(w)) continue;
          seen.add(w);
          scratch.push(w);
        }
        scratch.sort((a, b) => (nodeIds[a] < nodeIds[b] ? -1 : nodeIds[a] > nodeIds[b] ? 1 : 0));
        slots = scratch;
      } else {
        slots = csr.targets.subarray(from, to);
      }
      for (let s = 0; s < slots.length; s++) {
        if (!sortNeighbors && !keep(csr.flags[from + s], filter, dir)) continue;
        const w = slots[s];
        if (depthOf[w] !== -1) continue;
        depthOf[w] = d + 1;
        depth.set(nodeIds[w], d + 1);
        if (wantParents) parent.set(nodeIds[w], nodeIds[v]);
        // Early exit: a caller looking for ONE node (verify_claim's reach kinds)
        // stops the moment it is discovered. The node's depth and predecessor are
        // already final — BFS never revisits — so the reconstructed path is the
        // same one a full walk would produce, for strictly less work.
        if (stopAt !== undefined && nodeIds[w] === stopAt) return { depth, parent };
        queue[tail++] = w;
      }
    }
    return { depth, parent };
  }

  return {
    nodeCount,
    edgeCount: forward.targets.length,
    componentCount: p.condForward.componentCount,
    indexOf: (id) => indexById.get(id) ?? -1,
    idAt: (i) => nodeIds[i],
    hasNode: (id) => indexById.has(id),
    componentOf: (id) => {
      const i = indexById.get(id);
      return i === undefined ? -1 : p.condForward.component[i];
    },
    neighborIds,
    degree: (id, dir, filter) => {
      const v = indexById.get(id);
      if (v === undefined) return 0;
      const csr = csrFor(dir);
      const from = csr.offsets[v];
      const to = csr.offsets[v + 1];
      if (from === to) return 0;
      const seen = new Set<number>();
      for (let k = from; k < to; k++) {
        if (keep(csr.flags[k], filter, dir)) seen.add(csr.targets[k]);
      }
      return seen.size;
    },
    reachAll,
    bfsDepths: (seeds, dir, maxDepth, filter, opts) =>
      bfsCore(seeds, dir, maxDepth, filter, opts?.sortNeighbors === true, false).depth,
    bfsWithParents: (seeds, dir, maxDepth, filter, opts) =>
      bfsCore(seeds, dir, maxDepth, filter, opts?.sortNeighbors === true, true, opts?.stopAt),
  };
}

// ============================================================================
// SERIALIZATION
// ============================================================================

/**
 * The persisted form. `nodeIds` carries the string universe; every other array is
 * a base64-encoded typed-array buffer. `graphDigest` binds the structure to the
 * call-graph facts it describes (see {@link graphDigest}) — a structure whose
 * digest does not match the graph being served is discarded, never traversed, so
 * it can never survive a graph it was not built from.
 */
export interface SerializedTraversalIndex {
  version: number;
  /** {@link graphDigest} of the call graph this structure was built from. */
  graphDigest: string;
  /**
   * SHA-256 over this structure's OWN payload (`nodeIds` + every array).
   *
   * `graphDigest` binds the structure to the right graph; it says nothing about
   * whether the structure's own bytes survived the trip. Length checks alone do
   * not close that: a single flipped base64 character keeps every array the right
   * length and silently changes reachability answers — an out-of-range `targets`
   * entry made `neighborIds` yield `undefined`, and a corrupted `component` made a
   * live node report as unreachable, i.e. a false "dead code" conclusion. Hashing
   * the payload (~2 ms on a 1.2 MB artifact) turns that whole class into a clean
   * refusal-and-rebuild.
   */
  payloadDigest: string;
  /** Typed arrays are host-endian; a foreign-endian artifact is rejected. */
  littleEndian: boolean;
  nodeCount: number;
  /** Component counts, per direction (the two condensations can differ). */
  componentCounts: { forward: number; backward: number };
  nodeIds: string[];
  arrays: Record<string, string>;
}

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Canonical serialization of the payload for {@link SerializedTraversalIndex.payloadDigest}.
 * Independent of JSON key order so a re-serialized artifact still verifies.
 */
function payloadDigestOf(nodeIds: string[], arrays: Record<string, string>): string {
  const h = createHash('sha256');
  h.update(String(nodeIds.length));
  for (const id of nodeIds) { h.update('\u0000'); h.update(id); }
  for (const key of Object.keys(arrays).sort()) {
    h.update('\u0000'); h.update(key); h.update('='); h.update(arrays[key]);
  }
  return h.digest('hex');
}

function encode(a: Int32Array | Uint8Array): string {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
}

function decodeI32(s: string): Int32Array {
  const buf = Buffer.from(s, 'base64');
  if (buf.byteLength % 4 !== 0) throw new Error('traversal index: misaligned Int32 array');
  // Copy rather than view: a base64 Buffer is not guaranteed 4-byte aligned.
  const out = new Int32Array(buf.byteLength / 4);
  Buffer.from(out.buffer, out.byteOffset, out.byteLength).set(buf);
  return out;
}

function decodeU8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** Serialize an index built by {@link buildTraversalIndex}, bound to `graphDigest`. */
export function serializeTraversalIndex(cg: SerializedCallGraph, digest: string): string {
  const parts = buildIndexParts(cg);
  const cond = (prefix: string, c: Condensation): Record<string, string> => ({
    [`${prefix}Component`]: encode(c.component),
    [`${prefix}MemberOffsets`]: encode(c.members.offsets),
    [`${prefix}MemberTargets`]: encode(c.members.targets),
    [`${prefix}CompOffsets`]: encode(c.compAdj.offsets),
    [`${prefix}CompTargets`]: encode(c.compAdj.targets),
  });
  const arrays: Record<string, string> = {
    fwdOffsets: encode(parts.forward.offsets),
    fwdTargets: encode(parts.forward.targets),
    fwdFlags: encode(parts.forward.flags),
    bwdOffsets: encode(parts.backward.offsets),
    bwdTargets: encode(parts.backward.targets),
    bwdFlags: encode(parts.backward.flags),
    ...cond('fwd', parts.condForward),
    ...cond('bwd', parts.condBackward),
  };
  const payload: SerializedTraversalIndex = {
    version: TRAVERSAL_INDEX_VERSION,
    graphDigest: digest,
    payloadDigest: payloadDigestOf(parts.nodeIds, arrays),
    littleEndian: IS_LITTLE_ENDIAN,
    nodeCount: parts.nodeIds.length,
    componentCounts: {
      forward: parts.condForward.componentCount,
      backward: parts.condBackward.componentCount,
    },
    nodeIds: parts.nodeIds,
    arrays,
  };
  return JSON.stringify(payload);
}

/**
 * Build and persist the structure for `cg` next to the analysis artifacts, stamped
 * with the {@link graphDigest} of the graph it describes. The single
 * writer both surfaces use — a full `analyze` (artifact-generator) and an
 * incremental watcher flush — so the two can never disagree about the layout or
 * the invalidation key.
 *
 * The write is atomic (temp + rename); the caller owns any lock discipline.
 */
export async function writeTraversalIndexArtifact(
  outputDir: string,
  cg: SerializedCallGraph,
  /**
   * {@link graphDigest} of `cg` — the value `analyze` also writes into
   * `llm-context.json`, so the reader recovers this key from the parsed context
   * for free rather than hashing the multi-MB artifact on the read path.
   */
  digest: string,
): Promise<void> {
  const path = join(outputDir, ARTIFACT_TRAVERSAL_INDEX);
  try {
    await atomicWriteFile(path, serializeTraversalIndex(cg, digest));
  } catch (err) {
    // The write is atomic, so a failure leaves the PREVIOUS generation's structure
    // on disk. Its digest can never match again, so it would sit there indefinitely
    // — dead weight that every cold read pays a stat, a digest, and a read to
    // reject. Remove it, so a failed write degrades to "no structure" (rebuild in
    // memory) rather than "a structure nothing can ever use".
    await rm(path, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Rehydrate a persisted index, or return null when it cannot be trusted: wrong
 * schema version, foreign endianness, a `graphDigest` that does not match the
 * graph being served, a payload that does not match its own digest, or any
 * structural inconsistency. Null means "rebuild in memory" — a wrong structure is
 * never preferred to a slower correct one.
 *
 * Validation is deliberately layered, because each layer catches a class the one
 * before it cannot:
 *  - `graphDigest`    — the structure belongs to ANOTHER graph generation.
 *  - `payloadDigest`  — the structure's own bytes were altered (bitrot, a partial
 *                       write, a hand edit that kept every length intact).
 *  - shape + range    — a hand-edited artifact whose digest was recomputed. Every
 *                       array that INDEXES another is bounds-checked here, so no
 *                       traversal can read past the end of a typed array and hand
 *                       back an `undefined` id or a silently truncated reach.
 */
export function deserializeTraversalIndex(raw: string, expectedDigest: string): TraversalIndex | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Partial<SerializedTraversalIndex>;
    if (p.version !== TRAVERSAL_INDEX_VERSION) return null;
    if (p.littleEndian !== IS_LITTLE_ENDIAN) return null;
    if (typeof p.graphDigest !== 'string' || p.graphDigest !== expectedDigest) return null;
    if (!Array.isArray(p.nodeIds)) return null;
    const counts = p.componentCounts;
    if (counts === null || typeof counts !== 'object') return null;
    if (typeof counts.forward !== 'number' || typeof counts.backward !== 'number') return null;
    const a = p.arrays;
    if (a === null || typeof a !== 'object') return null;
    const nodeIds = p.nodeIds as string[];
    if (nodeIds.some(id => typeof id !== 'string')) return null;
    const nodeCount = nodeIds.length;
    if (p.nodeCount !== nodeCount) return null;
    if (typeof p.payloadDigest !== 'string') return null;
    if (p.payloadDigest !== payloadDigestOf(nodeIds, a)) return null;

    const forward: Csr = {
      offsets: decodeI32(a.fwdOffsets), targets: decodeI32(a.fwdTargets), flags: decodeU8(a.fwdFlags),
    };
    const backward: Csr = {
      offsets: decodeI32(a.bwdOffsets), targets: decodeI32(a.bwdTargets), flags: decodeU8(a.bwdFlags),
    };

    /** Every value in `arr` is a valid index into an array of length `limit`. */
    const inRange = (arr: Int32Array, limit: number): boolean => {
      for (let i = 0; i < arr.length; i++) if (arr[i] < 0 || arr[i] >= limit) return false;
      return true;
    };
    /** Offsets must be non-negative, non-decreasing, and span exactly `targets`. */
    const csrOk = (c: Csr, n: number, targetLimit: number, withFlags: boolean): boolean => {
      if (c.offsets.length !== n + 1) return false;
      if (c.offsets[0] !== 0) return false;
      if (c.offsets[n] !== c.targets.length) return false;
      if (withFlags && c.flags.length !== c.targets.length) return false;
      for (let i = 0; i < n; i++) if (c.offsets[i] > c.offsets[i + 1]) return false;
      return inRange(c.targets, targetLimit);
    };
    if (!csrOk(forward, nodeCount, nodeCount, true)) return null;
    if (!csrOk(backward, nodeCount, nodeCount, true)) return null;

    const readCond = (prefix: string, componentCount: number): Condensation | null => {
      if (!Number.isInteger(componentCount) || componentCount < 0 || componentCount > nodeCount) return null;
      const component = decodeI32(a[`${prefix}Component`]);
      const members: Csr = {
        offsets: decodeI32(a[`${prefix}MemberOffsets`]),
        targets: decodeI32(a[`${prefix}MemberTargets`]),
        flags: new Uint8Array(0),
      };
      const compAdj: Csr = {
        offsets: decodeI32(a[`${prefix}CompOffsets`]),
        targets: decodeI32(a[`${prefix}CompTargets`]),
        flags: new Uint8Array(0),
      };
      if (component.length !== nodeCount) return null;
      if (!inRange(component, componentCount)) return null;
      if (members.targets.length !== nodeCount) return null;
      if (!csrOk(members, componentCount, nodeCount, false)) return null;
      if (!csrOk(compAdj, componentCount, componentCount, false)) return null;
      // `topoOrder` is derived, never shipped: Tarjan numbers components in reverse
      // topological order, so the source→sink order is just the reverse sequence.
      // Deriving it removes a redundant array — and with it a way for a tampered
      // artifact to reorder the sweep.
      const topoOrder = new Int32Array(componentCount);
      for (let c = 0; c < componentCount; c++) topoOrder[c] = componentCount - 1 - c;
      return { component, componentCount, topoOrder, members, compAdj };
    };
    const condForward = readCond('fwd', counts.forward);
    const condBackward = readCond('bwd', counts.backward);
    if (!condForward || !condBackward) return null;

    const indexById = new Map<string, number>();
    for (let i = 0; i < nodeCount; i++) indexById.set(nodeIds[i], i);
    if (indexById.size !== nodeCount) return null; // duplicate ids

    return makeIndex({ nodeIds, indexById, forward, backward, condForward, condBackward });
  } catch {
    return null;
  }
}
