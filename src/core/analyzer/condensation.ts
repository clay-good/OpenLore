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
 *    kind/confidence bits the existing filters need (today: `synthesized`, so
 *    `directResolvedOnly` stays expressible). Slots are stored in the original
 *    `cg.edges` order within each source group and are NOT pre-deduplicated, so
 *    any filtered view reproduces `buildAdjacency`'s insertion-ordered `Set`
 *    exactly — see {@link TraversalIndex.neighborIds}.
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
import { join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { ARTIFACT_TRAVERSAL_INDEX } from '../../constants.js';
import type { SerializedCallGraph } from './call-graph.js';

/**
 * The invalidation key binding a persisted structure to the graph it was built
 * from: the SHA-256 of the exact `llm-context.json` content. Writer and reader
 * both derive it from the same bytes, so a structure can never be served over a
 * graph from another generation — and no separate freshness bookkeeping (mtimes,
 * generation counters) can drift out of step with it.
 */
export function artifactDigest(contextJson: string): string {
  return createHash('sha256').update(contextJson).digest('hex');
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

/** Edge-slot flag bits carried in the parallel per-edge mask. */
const FLAG_SYNTHESIZED = 1 << 0;

/** Serialized-artifact schema version. Bumped when the layout changes. */
export const TRAVERSAL_INDEX_VERSION = 1;

interface Csr {
  offsets: Int32Array;
  targets: Int32Array;
  flags: Uint8Array;
}

/** The compact, precomputed traversal structure. See the module header. */
export interface TraversalIndex {
  /** Number of distinct node ids in the traversal universe. */
  readonly nodeCount: number;
  /** Number of forward edge slots (== the number of usable `cg.edges`). */
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
    opts?: { sortNeighbors?: boolean },
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
  // `forwardEligible` = the ids that are KEYS in buildAdjacency's forward map:
  // the graph's own nodes plus every callee (which gets an entry created for it).
  const forwardEligible = new Set<number>();
  for (const n of nodes) forwardEligible.add(indexById.get(n.id)!);
  for (const e of edges) {
    if (!e.calleeId) continue;
    forwardEligible.add(intern(e.calleeId));
  }
  for (const e of edges) {
    if (!e.calleeId) continue;
    intern(e.callerId);
  }

  const nodeCount = nodeIds.length;

  // ── Usable edge slots, in cg.edges order. `flags` carries the per-edge
  //    kind/confidence bits the filters read.
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
    const flags = e.confidence === 'synthesized' ? FLAG_SYNTHESIZED : 0;
    if (forwardEligible.has(caller)) {
      srcF.push(caller); dstF.push(callee); flagF.push(flags);
    }
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
    condForward: condense(nodeCount, forward),
    condBackward: condense(nodeCount, backward),
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
function condense(nodeCount: number, csr: Csr): Condensation {
  const { component, componentCount } = tarjanScc(nodeCount, csr);
  const topoOrder = new Int32Array(componentCount);
  for (let c = 0; c < componentCount; c++) topoOrder[c] = componentCount - 1 - c;
  return {
    component,
    componentCount,
    topoOrder,
    members: buildMembers(nodeCount, componentCount, component),
    compAdj: buildComponentCsr(componentCount, component, csr),
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
function tarjanScc(nodeCount: number, fwd: Csr): { component: Int32Array; componentCount: number } {
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
        const w = fwd.targets[frameEdge[top]++];
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
function buildComponentCsr(componentCount: number, component: Int32Array, csr: Csr): Csr {
  const src: number[] = [];
  const dst: number[] = [];
  const nodeCount = component.length;
  const seen = new Set<number>();
  for (let v = 0; v < nodeCount; v++) {
    const cv = component[v];
    for (let k = csr.offsets[v]; k < csr.offsets[v + 1]; k++) {
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
  const keep = (flags: number, filter?: TraversalFilter): boolean =>
    !(filter?.directResolvedOnly && (flags & FLAG_SYNTHESIZED) !== 0);

  function neighborIds(id: string, dir: Direction, filter?: TraversalFilter): string[] {
    const v = indexById.get(id);
    if (v === undefined) return [];
    const csr = csrFor(dir);
    const out: string[] = [];
    const seen = new Set<number>();
    for (let k = csr.offsets[v]; k < csr.offsets[v + 1]; k++) {
      if (!keep(csr.flags[k], filter)) continue;
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
        if (!keep(csr.flags[k], filter)) continue;
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
          if (!keep(csr.flags[k], filter)) continue;
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
        if (!sortNeighbors && !keep(csr.flags[from + s], filter)) continue;
        const w = slots[s];
        if (depthOf[w] !== -1) continue;
        depthOf[w] = d + 1;
        depth.set(nodeIds[w], d + 1);
        if (wantParents) parent.set(nodeIds[w], nodeIds[v]);
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
        if (keep(csr.flags[k], filter)) seen.add(csr.targets[k]);
      }
      return seen.size;
    },
    reachAll,
    bfsDepths: (seeds, dir, maxDepth, filter, opts) =>
      bfsCore(seeds, dir, maxDepth, filter, opts?.sortNeighbors === true, false).depth,
    bfsWithParents: (seeds, dir, maxDepth, filter, opts) =>
      bfsCore(seeds, dir, maxDepth, filter, opts?.sortNeighbors === true, true),
  };
}

// ============================================================================
// SERIALIZATION
// ============================================================================

/**
 * The persisted form. `nodeIds` carries the string universe; every other array is
 * a base64-encoded typed-array buffer. `contextDigest` binds the structure to the
 * exact bytes of the `llm-context.json` it was built from — a structure whose
 * digest does not match the graph being served is discarded, never traversed, so
 * it can never survive a graph it was not built from.
 */
export interface SerializedTraversalIndex {
  version: number;
  /** SHA-256 of the llm-context.json content this structure was built from. */
  contextDigest: string;
  /** Typed arrays are host-endian; a foreign-endian artifact is rejected. */
  littleEndian: boolean;
  nodeCount: number;
  /** Component counts, per direction (the two condensations can differ). */
  componentCounts: { forward: number; backward: number };
  nodeIds: string[];
  arrays: Record<string, string>;
}

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

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

/** Serialize an index built by {@link buildTraversalIndex}, bound to `contextDigest`. */
export function serializeTraversalIndex(cg: SerializedCallGraph, contextDigest: string): string {
  const parts = buildIndexParts(cg);
  const cond = (prefix: string, c: Condensation): Record<string, string> => ({
    [`${prefix}Component`]: encode(c.component),
    [`${prefix}TopoOrder`]: encode(c.topoOrder),
    [`${prefix}MemberOffsets`]: encode(c.members.offsets),
    [`${prefix}MemberTargets`]: encode(c.members.targets),
    [`${prefix}CompOffsets`]: encode(c.compAdj.offsets),
    [`${prefix}CompTargets`]: encode(c.compAdj.targets),
  });
  const payload: SerializedTraversalIndex = {
    version: TRAVERSAL_INDEX_VERSION,
    contextDigest,
    littleEndian: IS_LITTLE_ENDIAN,
    nodeCount: parts.nodeIds.length,
    componentCounts: {
      forward: parts.condForward.componentCount,
      backward: parts.condBackward.componentCount,
    },
    nodeIds: parts.nodeIds,
    arrays: {
      fwdOffsets: encode(parts.forward.offsets),
      fwdTargets: encode(parts.forward.targets),
      fwdFlags: encode(parts.forward.flags),
      bwdOffsets: encode(parts.backward.offsets),
      bwdTargets: encode(parts.backward.targets),
      bwdFlags: encode(parts.backward.flags),
      ...cond('fwd', parts.condForward),
      ...cond('bwd', parts.condBackward),
    },
  };
  return JSON.stringify(payload);
}

/**
 * Build and persist the structure for `cg` next to the analysis artifacts, stamped
 * with the digest of the `llm-context.json` content it accompanies. The single
 * writer both surfaces use — a full `analyze` (artifact-generator) and an
 * incremental watcher flush — so the two can never disagree about the layout or
 * the invalidation key.
 *
 * The write is atomic (temp + rename); the caller owns any lock discipline.
 */
export async function writeTraversalIndexArtifact(
  outputDir: string,
  cg: SerializedCallGraph,
  contextJson: string,
): Promise<void> {
  await atomicWriteFile(
    join(outputDir, ARTIFACT_TRAVERSAL_INDEX),
    serializeTraversalIndex(cg, artifactDigest(contextJson)),
  );
}

/**
 * Rehydrate a persisted index, or return null when it cannot be trusted: wrong
 * schema version, foreign endianness, a `contextDigest` that does not match the
 * graph being served, or any structural inconsistency. Null means "rebuild in
 * memory" — a wrong structure is never preferred to a slower correct one.
 */
export function deserializeTraversalIndex(raw: string, expectedDigest: string): TraversalIndex | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Partial<SerializedTraversalIndex>;
    if (p.version !== TRAVERSAL_INDEX_VERSION) return null;
    if (p.littleEndian !== IS_LITTLE_ENDIAN) return null;
    if (typeof p.contextDigest !== 'string' || p.contextDigest !== expectedDigest) return null;
    if (!Array.isArray(p.nodeIds)) return null;
    const counts = p.componentCounts;
    if (counts === null || typeof counts !== 'object') return null;
    if (typeof counts.forward !== 'number' || typeof counts.backward !== 'number') return null;
    const a = p.arrays;
    if (a === null || typeof a !== 'object') return null;
    const nodeIds = p.nodeIds as string[];
    const nodeCount = nodeIds.length;
    if (p.nodeCount !== nodeCount) return null;

    const forward: Csr = {
      offsets: decodeI32(a.fwdOffsets), targets: decodeI32(a.fwdTargets), flags: decodeU8(a.fwdFlags),
    };
    const backward: Csr = {
      offsets: decodeI32(a.bwdOffsets), targets: decodeI32(a.bwdTargets), flags: decodeU8(a.bwdFlags),
    };

    // Structural coherence: a truncated or hand-edited artifact must fail closed
    // rather than index out of bounds mid-traversal.
    const csrOk = (c: Csr, n: number, withFlags: boolean) =>
      c.offsets.length === n + 1 &&
      c.offsets[0] === 0 &&
      c.offsets[n] === c.targets.length &&
      (!withFlags || c.flags.length === c.targets.length);
    if (!csrOk(forward, nodeCount, true)) return null;
    if (!csrOk(backward, nodeCount, true)) return null;

    const readCond = (prefix: string, componentCount: number): Condensation | null => {
      const component = decodeI32(a[`${prefix}Component`]);
      const topoOrder = decodeI32(a[`${prefix}TopoOrder`]);
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
      if (topoOrder.length !== componentCount) return null;
      if (members.targets.length !== nodeCount) return null;
      if (!csrOk(members, componentCount, false)) return null;
      if (!csrOk(compAdj, componentCount, false)) return null;
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
