/**
 * Change footprint projection + pairwise hazard classification
 * (change: add-change-footprint-projection, the foundation of
 * PARALLEL-WORK-COORDINATION).
 *
 * Generalizes `blast_radius` from "one symbol" to "a declared task": given a
 * caller-supplied {@link TaskDescriptor}, compute a deterministic three-region
 * {@link Footprint} (write / read / affected) plus a soft co-change annotation,
 * and a pure {@link classifyHazard} over two footprints returning the strongest
 * data-hazard between them (WAW / shared-append / RAW / WAR / soft-coupling /
 * none).
 *
 * Design invariants (mirrors the proposal's Decision + Scope contract):
 * - **Borrow-checker, not a lock.** Everything here is a pure function of the
 *   graph state, the change-coupling store, and the descriptor — no persistence,
 *   no clock, no new MCP tool, no graph-schema change. The consumer
 *   (`plan_parallel_work`, proposal 2) holds any state.
 * - **Declared, not inferred.** The write-set is the caller's declared seeds,
 *   normalized to enclosing scope — never a prediction of the edits an agent
 *   will make. It is reported as advisory with a known-unknowable disclosure.
 * - **Reuse, don't reinvent.** The affected-set is the existing backward
 *   reachability (`bfs` over the same adjacency `analyze_impact`/`blast_radius`
 *   use); the read-set is the existing call-distance-scoped forward closure
 *   (`weightedBfs`); coupling-neighbors come from the existing change-coupling
 *   store thresholds. No new traversal semantics.
 * - **Honesty over coverage.** An unresolved seed yields an empty footprint with
 *   an explicit note, never a fabricated region. Ambient (ubiquitous) symbols
 *   are excluded from the read-set and from generating RAW edges, but a
 *   deliberate *write* of an ambient symbol still creates a hazard.
 */

import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';
import type { FileChangeCoupling } from '../../provenance/change-coupling.js';
import { buildWeightedAdjacency, weightedBfs } from './graph.js';
import { traversalIndexFor } from './traversal.js';

/** Whether a declared write is a pure append to a registration site or a modify of existing code. */
export type WriteMode = 'append' | 'modify';

/**
 * A unit of proposed work, described by the *caller* (an agent or human) — never
 * invented by the system. At least one seed (symbol or file) is required.
 */
export interface TaskDescriptor {
  /** Caller-chosen id, unique within a single planning call. */
  id: string;
  /** Symbol names or canonical ids the task will edit. */
  seedSymbols?: string[];
  /** File paths the task will edit (every symbol in the file enters the write-set). */
  seedFiles?: string[];
  /** Optional free text — used only by the caller to widen sparse seeds via semantic search, never to guess edits. */
  intent?: string;
  /**
   * Caller-declared annotation that this task's seeds are pure *additions* to a
   * registration site (a new switch case, a new array/registry entry) rather
   * than a change to existing code. Default `modify` (the conservative
   * assumption). Never inferred by the system.
   */
  writeMode?: WriteMode;
}

/** A symbol in a footprint region. */
export interface FootprintMember {
  id: string;
  name: string;
  filePath: string;
}

/** A write-set member, carrying its declared write mode. */
export interface WriteMember extends FootprintMember {
  writeMode: WriteMode;
}

/**
 * The footprint of one task: three structural regions plus a soft co-change
 * annotation. A deterministic function of (graph, coupling, descriptor).
 */
export interface Footprint {
  taskId: string;
  /**
   * The declared region the task is expected to modify: its seeds resolved to
   * symbols and normalized to enclosing scope, each carrying its declared
   * `writeMode`. Advisory — see {@link Footprint.advisory}.
   */
  writeSet: WriteMember[];
  /**
   * Forward call closure (callees/dependencies) of the write-set, bounded by the
   * existing call-distance scoping and with ambient symbols excluded. The region
   * the task reads to function.
   */
  readSet: string[];
  /**
   * Ambient (ubiquitous, high-fan-in) symbols that were in the forward closure
   * but excluded from {@link Footprint.readSet}. Disclosed for transparency and
   * retained so that a peer task's deliberate *write* of one still raises a RAW
   * hazard (the ambient exclusion applies to read membership, not to a write).
   */
  ambientReadDeps: string[];
  /**
   * Backward reachability (callers) of the write-set — equivalent to the blast
   * radius of the write-set. Informational human-facing output only; NOT an
   * input to {@link classifyHazard}.
   */
  affectedSet: string[];
  /**
   * Files that co-change with the write-set's files above the existing support
   * and confidence thresholds, with no requirement of a static call relation.
   * A separate advisory annotation — never merged into the static regions.
   */
  couplingNeighbors: string[];
  /** Seeds that resolved to nothing in the graph (unknown symbol / untracked file). */
  unresolvedSeeds: string[];
  /** The write-set is always a *declared* region, not a prediction. */
  advisory: true;
  /** Known-unknowable disclosure carried with every footprint. */
  disclosure: string;
}

/** The data-hazard between two footprints. */
export type HazardKind = 'WAW' | 'shared-append' | 'RAW' | 'WAR' | 'soft-coupling' | 'none';

export interface HazardVerdict {
  kind: HazardKind;
  /**
   * The witnessing symbol ids (or file paths, for `WAR` same-file and
   * `soft-coupling`) that explain the verdict. Sorted for determinism.
   */
  witnesses: string[];
  /** For the ordering hazard `RAW`: which task must run after which. */
  direction?: 'A after B' | 'B after A' | 'bidirectional';
}

export interface FootprintOptions {
  /** Hop-depth for the backward (affected) reachability. Default {@link FOOTPRINT_AFFECTED_MAX_DEPTH}. */
  affectedMaxDepth?: number;
  /** Call-distance bound for the forward (read) closure. Default {@link FOOTPRINT_READ_MAX_DISTANCE}. */
  readMaxDistance?: number;
  /** Fan-in percentile above which a symbol is treated as ambient. Default {@link AMBIENT_FANIN_PERCENTILE}. */
  ambientFanInPercentile?: number;
  /**
   * Absolute fan-in threshold for ambient classification, overriding the
   * percentile when set (a symbol is ambient iff `fanIn > this`). Primarily for
   * deterministic tests; production uses the percentile.
   */
  ambientFanInThreshold?: number;
  /**
   * Extra seed ids the caller derived from `intent` via semantic search. Kept
   * out of the pure core so this function stays deterministic and I/O-free; the
   * caller (proposal 2) performs the search and passes the resulting candidate
   * ids here. Never fabricates a write target — only widens declared seeds.
   */
  extraSeedIds?: string[];
  /**
   * Change-coupling lookup, injected so the core stays pure and testable. The
   * real consumer passes `edgeStore.getChangeCouplingForFiles`; tests pass a
   * fixture. When absent, `couplingNeighbors` is empty.
   */
  couplingLookup?: (files: string[]) => FileChangeCoupling[];
}

/** Hop-depth for the backward (affected) reachability — mirrors `analyze_impact`'s default. */
export const FOOTPRINT_AFFECTED_MAX_DEPTH = 2;
/**
 * Call-distance bound for the forward (read) closure. Smaller than pathfind's
 * `PATH_MAX_DISTANCE` (12) because a read-set is the task's near dependencies,
 * not a whole-program reach: 6 admits a handful of strongly-resolved hops (cost
 * 1 each) or fewer weakly-resolved ones (cost 2–4).
 */
export const FOOTPRINT_READ_MAX_DISTANCE = 6;
/**
 * Fan-in percentile above which a symbol is "ambient" (ubiquitous infrastructure
 * — a logger, a directory validator, the call-graph primitives). The top ~1% of
 * symbols by fan-in carry no real ordering signal and would bloat read-sets
 * toward the whole graph, so they are excluded from read-sets and from
 * generating RAW edges.
 */
export const AMBIENT_FANIN_PERCENTILE = 0.99;

const DISCLOSURE =
  'The write-set is a declared/advisory region, not a prediction of every edit; ' +
  'an agent may edit outside it (proposal 3 checks for that). Static footprints ' +
  'reduce conflict probability and shift detection left — integration tests remain ' +
  'the ground truth for safe parallelism.';

/**
 * The deterministic ambient fan-in threshold for a graph: a symbol is ambient
 * iff its fan-in strictly exceeds this value. Derived from the fan-in
 * distribution at the configured percentile (or an explicit override). Symbols
 * with the value at the percentile index are NOT ambient — only those above it.
 */
export function ambientFanInThreshold(graph: SerializedCallGraph, opts: FootprintOptions = {}): number {
  if (opts.ambientFanInThreshold !== undefined) return opts.ambientFanInThreshold;
  const percentile = opts.ambientFanInPercentile ?? AMBIENT_FANIN_PERCENTILE;
  const fanIns = graph.nodes
    .filter(n => !n.isExternal)
    .map(n => n.fanIn ?? 0)
    .sort((a, b) => a - b);
  if (fanIns.length === 0) return Infinity;
  const idx = Math.min(fanIns.length - 1, Math.ceil(percentile * (fanIns.length - 1)));
  return fanIns[idx];
}

/** Resolve a single seed (canonical id, exact symbol name, or file path) to graph node ids. */
function resolveSeed(
  seed: string,
  nodeById: Map<string, FunctionNode>,
  nodesByName: Map<string, FunctionNode[]>,
  fileToNodeIds: Map<string, string[]>,
): string[] {
  // 1. Exact canonical id.
  if (nodeById.has(seed)) return [seed];
  // 2. File path — every symbol declared in the file is in scope (the file is the enclosing scope).
  const fileIds = fileToNodeIds.get(seed);
  if (fileIds && fileIds.length > 0) return fileIds;
  // 3. Exact symbol name (may resolve to several overloads/definitions — all are declared targets).
  const named = nodesByName.get(seed);
  if (named && named.length > 0) return named.map(n => n.id);
  return [];
}

/**
 * Compute the footprint of one task descriptor over a serialized call graph.
 * Pure and deterministic for a fixed (graph, coupling, descriptor) — the same
 * inputs always yield a byte-identical footprint.
 */
export function computeFootprint(
  graph: SerializedCallGraph,
  descriptor: TaskDescriptor,
  opts: FootprintOptions = {},
): Footprint {
  const writeMode: WriteMode = descriptor.writeMode ?? 'modify';

  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const nodesByName = new Map<string, FunctionNode[]>();
  const fileToNodeIds = new Map<string, string[]>();
  for (const n of graph.nodes) {
    (nodesByName.get(n.name) ?? nodesByName.set(n.name, []).get(n.name)!).push(n);
    (fileToNodeIds.get(n.filePath) ?? fileToNodeIds.set(n.filePath, []).get(n.filePath)!).push(n.id);
  }

  const rawSeeds = [
    ...(descriptor.seedSymbols ?? []),
    ...(descriptor.seedFiles ?? []),
    ...(opts.extraSeedIds ?? []),
  ];

  const writeIds = new Set<string>();
  const unresolvedSeeds: string[] = [];
  for (const seed of rawSeeds) {
    const ids = resolveSeed(seed, nodeById, nodesByName, fileToNodeIds);
    if (ids.length === 0) unresolvedSeeds.push(seed);
    else for (const id of ids) writeIds.add(id);
  }

  // Unresolved-only descriptor → empty footprint with a note, never a fabricated region.
  if (writeIds.size === 0) {
    return {
      taskId: descriptor.id,
      writeSet: [],
      readSet: [],
      ambientReadDeps: [],
      affectedSet: [],
      couplingNeighbors: [],
      unresolvedSeeds: [...new Set(unresolvedSeeds)].sort(),
      advisory: true,
      disclosure: DISCLOSURE,
    };
  }

  const writeSet: WriteMember[] = [...writeIds]
    .map(id => nodeById.get(id)!)
    .map(n => ({ id: n.id, name: n.name, filePath: n.filePath, writeMode }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // --- read-set: call-distance-scoped forward closure, ambient excluded ---
  const threshold = ambientFanInThreshold(graph, opts);
  const isAmbient = (id: string): boolean => {
    const n = nodeById.get(id);
    return !!n && (n.fanIn ?? 0) > threshold;
  };

  const weighted = buildWeightedAdjacency(graph);
  const readMaxDistance = opts.readMaxDistance ?? FOOTPRINT_READ_MAX_DISTANCE;
  const forwardReach = weightedBfs([...writeIds], weighted.forward, readMaxDistance);

  const readSet: string[] = [];
  const ambientReadDeps: string[] = [];
  for (const id of forwardReach.keys()) {
    if (writeIds.has(id)) continue; // a written symbol is not "read"
    if (!nodeById.has(id)) continue; // skip synthetic/external leaves
    if (isAmbient(id)) ambientReadDeps.push(id);
    else readSet.push(id);
  }
  readSet.sort();
  ambientReadDeps.sort();

  // --- affected-set: hop-depth backward reachability (== blast radius) ---
  // Over the traversal structure precomputed for this graph generation rather than
  // adjacency rebuilt per task (change: optimize-reachability-precompute). It
  // matters most here: `plan_parallel_work` and `map_in_flight_conflicts` call
  // this once PER TASK, so the rebuild was paid N times for one graph.
  const affectedMaxDepth = opts.affectedMaxDepth ?? FOOTPRINT_AFFECTED_MAX_DEPTH;
  const backwardReach = traversalIndexFor(graph).bfsDepths([...writeIds], 'backward', affectedMaxDepth);
  const affectedSet = [...backwardReach.keys()]
    .filter(id => !writeIds.has(id) && nodeById.has(id))
    .sort();

  // --- coupling-neighbors: advisory co-change annotation ---
  const writeFiles = [...new Set(writeSet.map(w => w.filePath))];
  const couplingNeighbors = computeCouplingNeighbors(writeFiles, opts.couplingLookup);

  return {
    taskId: descriptor.id,
    writeSet,
    readSet,
    ambientReadDeps,
    affectedSet,
    couplingNeighbors,
    unresolvedSeeds: [...new Set(unresolvedSeeds)].sort(),
    advisory: true,
    disclosure: DISCLOSURE,
  };
}

/** Files co-changing with the write-set's files above threshold, excluding the write-set's own files. */
function computeCouplingNeighbors(
  writeFiles: string[],
  couplingLookup?: (files: string[]) => FileChangeCoupling[],
): string[] {
  if (!couplingLookup || writeFiles.length === 0) return [];
  const own = new Set(writeFiles);
  const neighbors = new Set<string>();
  for (const rec of couplingLookup(writeFiles)) {
    for (const c of rec.coupledWith) {
      if (!own.has(c.file)) neighbors.add(c.file);
    }
  }
  return [...neighbors].sort();
}

/** Sorted set intersection of two id arrays. */
function intersectSorted(a: Iterable<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const x of a) if (b.has(x)) out.push(x);
  return out.sort();
}

/**
 * Classify the strongest data-hazard between two footprints. A pure function:
 * the verdict is a deterministic, byte-identical function of the two footprints.
 *
 * Precedence (strongest first): WAW > RAW > shared-append > WAR > soft-coupling
 * > none. RAW outranks shared-append because an ordering constraint is stronger
 * than a low-risk "appends merge trivially" advisory.
 */
export function classifyHazard(a: Footprint, b: Footprint): HazardVerdict {
  const writeModeA = new Map(a.writeSet.map(w => [w.id, w.writeMode]));
  const writeModeB = new Map(b.writeSet.map(w => [w.id, w.writeMode]));
  const writeIdsA = new Set(writeModeA.keys());
  const writeIdsB = new Set(writeModeB.keys());

  const sharedWrites = intersectSorted(writeIdsA, writeIdsB);

  // --- WAW: shared write where at least one side modifies ---
  const wawWitnesses = sharedWrites.filter(
    id => writeModeA.get(id) === 'modify' || writeModeB.get(id) === 'modify',
  );
  if (wawWitnesses.length > 0) {
    return { kind: 'WAW', witnesses: wawWitnesses };
  }

  // --- RAW: one writes what the other reads (ambient excluded from read membership,
  // but a deliberate write of an ambient symbol still counts via ambientReadDeps) ---
  const readMembA = new Set([...a.readSet, ...a.ambientReadDeps]);
  const readMembB = new Set([...b.readSet, ...b.ambientReadDeps]);
  const aWritesBReads = intersectSorted(writeIdsA, readMembB); // B reads A's writes → B after A
  const bWritesAReads = intersectSorted(writeIdsB, readMembA); // A reads B's writes → A after B
  if (aWritesBReads.length > 0 || bWritesAReads.length > 0) {
    const direction: HazardVerdict['direction'] =
      aWritesBReads.length > 0 && bWritesAReads.length > 0
        ? 'bidirectional'
        : aWritesBReads.length > 0
          ? 'B after A'
          : 'A after B';
    const witnesses = [...new Set([...aWritesBReads, ...bWritesAReads])].sort();
    return { kind: 'RAW', witnesses, direction };
  }

  // --- shared-append: write∩write where both sides append every shared symbol ---
  if (sharedWrites.length > 0) {
    return { kind: 'shared-append', witnesses: sharedWrites };
  }

  // --- WAR / low-risk: same file disjoint symbols, or read-only overlap (ambient excluded) ---
  const filesA = new Set(a.writeSet.map(w => w.filePath));
  const filesB = new Set(b.writeSet.map(w => w.filePath));
  const sharedFiles = intersectSorted(filesA, filesB);
  const sharedReads = intersectSorted(a.readSet, new Set(b.readSet));
  if (sharedFiles.length > 0 || sharedReads.length > 0) {
    const witnesses = [...new Set([...sharedFiles, ...sharedReads])].sort();
    return { kind: 'WAR', witnesses };
  }

  // --- soft-coupling: write-set files co-change, no static relation ---
  const softWitnesses = [
    ...intersectSorted(a.couplingNeighbors, filesB),
    ...intersectSorted(b.couplingNeighbors, filesA),
  ];
  if (softWitnesses.length > 0) {
    return { kind: 'soft-coupling', witnesses: [...new Set(softWitnesses)].sort() };
  }

  return { kind: 'none', witnesses: [] };
}
