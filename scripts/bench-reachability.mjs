/**
 * Scale benchmark for the precomputed reachability structure
 * (change: optimize-reachability-precompute).
 *
 * Measures the two whole-graph reaches the change is about — the backward walk
 * behind `select_tests` and the unbounded forward reach behind
 * `report_coverage_gaps` / `find_dead_code` — on a synthetic graph, comparing:
 *
 *   before : rebuild Map<string,Set<string>> adjacency + BFS with queue.shift()
 *   after  : one precomputed structure, reused across calls
 *
 * Both are run over the SAME graph and their answers are compared, so a
 * "faster" number that changed an answer fails loudly instead of being reported.
 *
 *   node scripts/bench-reachability.mjs [nodeCount] [callsPerPhase]
 */

import { buildTraversalIndex } from '../dist/core/analyzer/condensation.js';

const NODES = Number(process.argv[2] ?? 50_000);
const CALLS = Number(process.argv[3] ?? 20);
const AVG_FANOUT = 4;

// ── Deterministic synthetic graph, shaped like a real repo: a few high-fan-in
//    hubs, a long tail of ordinary functions, and some cycles.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildGraph(n) {
  const rnd = mulberry32(20260725);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: `src/mod${i % 400}.ts::fn${i}`,
      name: `fn${i}`,
      filePath: `src/mod${i % 400}.ts`,
      language: 'typescript',
      isAsync: false, startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0,
      isTest: i % 50 === 0,
    });
  }
  const hubCount = Math.max(1, Math.floor(n / 500));
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < AVG_FANOUT; k++) {
      // 30% of calls land on a hub (high fan-in), the rest anywhere.
      const j = rnd() < 0.3
        ? Math.floor(rnd() * hubCount)
        : Math.floor(rnd() * n);
      edges.push({
        callerId: nodes[i].id,
        calleeId: nodes[j].id,
        calleeName: nodes[j].name,
        confidence: rnd() < 0.15 ? 'synthesized' : 'name_only',
      });
    }
  }
  return {
    nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [],
    layerViolations: [],
    stats: { totalNodes: n, totalEdges: edges.length, avgFanIn: 0, avgFanOut: AVG_FANOUT },
  };
}

// ── "before": the exact pre-change implementations. ─────────────────────────
function buildAdjacency(cg, opts) {
  const forward = new Map();
  const backward = new Map();
  for (const n of cg.nodes) { forward.set(n.id, new Set()); backward.set(n.id, new Set()); }
  for (const e of cg.edges) {
    if (!e.calleeId) continue;
    if (opts?.directResolvedOnly && e.confidence === 'synthesized') continue;
    if (!forward.has(e.calleeId)) forward.set(e.calleeId, new Set());
    if (!backward.has(e.calleeId)) backward.set(e.calleeId, new Set());
    forward.get(e.callerId)?.add(e.calleeId);
    backward.get(e.calleeId)?.add(e.callerId);
  }
  return { forward, backward };
}
function oldReachAll(seeds, forward) {
  const live = new Set();
  const queue = [];
  for (const s of seeds) { if (!live.has(s)) { live.add(s); queue.push(s); } }
  while (queue.length) {
    const id = queue.shift();
    for (const next of forward.get(id) ?? []) {
      if (live.has(next)) continue;
      live.add(next); queue.push(next);
    }
  }
  return live;
}
/**
 * test-impact.ts's pre-change backward walk, verbatim: sorted neighbours AND parent
 * tracking. Both matter — `select_tests` reconstructs its `viaPath` from `parent`,
 * and the `[...set].sort()` is real work the old code paid. Benchmarking against an
 * unsorted, parentless variant would flatter the replacement.
 */
function oldSortedBfs(seeds, adjacency, maxDepth) {
  const depthOf = new Map();
  const parent = new Map();
  const queue = [];
  for (const s of seeds) { depthOf.set(s, 0); queue.push({ id: s, depth: 0 }); }
  while (queue.length) {
    const { id, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    for (const caller of [...(adjacency.get(id) ?? [])].sort()) {
      if (!depthOf.has(caller)) {
        depthOf.set(caller, depth + 1);
        parent.set(caller, id);
        queue.push({ id: caller, depth: depth + 1 });
      }
    }
  }
  return { depthOf, parent };
}

const ms = (t) => `${t.toFixed(1)} ms`;

/**
 * Median per-call time over TRIALS independent batches, with the observed spread.
 * A single batch on this workload varies by ~2x run to run (GC, allocation
 * pressure from the Map/Set rebuild), so a point estimate would not reproduce —
 * the median and the min-max range are what a reader can check against.
 */
const TRIALS = 5;
function time(label, calls, fn) {
  fn(); // warm
  const samples = [];
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    for (let i = 0; i < calls; i++) fn();
    samples.push((performance.now() - t0) / calls);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    perCall: samples[Math.floor(samples.length / 2)],
    lo: samples[0],
    hi: samples[samples.length - 1],
  };
}

console.log(`Graph: ${NODES.toLocaleString()} nodes, ~${(NODES * AVG_FANOUT).toLocaleString()} edges; ${CALLS} calls per phase\n`);
const cg = buildGraph(NODES);

const testSeeds = cg.nodes.filter(n => n.isTest).map(n => n.id);
const changeSeeds = cg.nodes.slice(0, 25).map(n => n.id);

const tBuild0 = performance.now();
const ix = buildTraversalIndex(cg);
const buildMs = performance.now() - tBuild0;
console.log(`Structure build (once per analyze): ${ms(buildMs)}  ` +
  `[${ix.nodeCount.toLocaleString()} nodes, ${ix.edgeCount.toLocaleString()} edges, ` +
  `${ix.componentCount.toLocaleString()} components]\n`);

// ── Equivalence gate: a speedup that changed an answer is not a speedup. ─────
{
  const { forward, backward } = buildAdjacency(cg);
  const oldFwd = oldReachAll(testSeeds, forward);
  const newFwd = ix.reachAll(testSeeds, 'forward');
  const oldBwd = oldSortedBfs(changeSeeds, backward, 12);
  const newBwd = ix.bfsWithParents(changeSeeds, 'backward', 12, undefined, { sortNeighbors: true });
  const eqMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  const sameSet = oldFwd.size === newFwd.size && [...oldFwd].every(x => newFwd.has(x));
  if (!sameSet || !eqMap(oldBwd.depthOf, newBwd.depth) || !eqMap(oldBwd.parent, newBwd.parent)) {
    console.error('ANSWERS DIVERGED — benchmark aborted.');
    process.exit(1);
  }
  console.log(`Equivalence: forward reach ${newFwd.size.toLocaleString()} nodes; ` +
    `backward depth-12 ${newBwd.depth.size.toLocaleString()} nodes with ` +
    `${newBwd.parent.size.toLocaleString()} parent links — all identical to the per-call BFS.\n`);
}

const rows = [];
rows.push(time('report_coverage_gaps  before (rebuild + BFS)', CALLS, () => {
  const { forward } = buildAdjacency(cg);
  oldReachAll(testSeeds, forward);
}));
rows.push(time('report_coverage_gaps  after  (condensation walk)', CALLS, () => {
  ix.reachAll(testSeeds, 'forward');
}));
rows.push(time('select_tests          before (rebuild + sorted BFS)', CALLS, () => {
  const { backward } = buildAdjacency(cg);
  oldSortedBfs(changeSeeds, backward, 12);
}));
rows.push(time('select_tests          after  (CSR sorted BFS)', CALLS, () => {
  ix.bfsWithParents(changeSeeds, 'backward', 12, undefined, { sortNeighbors: true });
}));

const width = Math.max(...rows.map(r => r.label.length));
console.log(`median of ${TRIALS} trials x ${CALLS} calls (range in brackets)\n`);
for (let i = 0; i < rows.length; i += 2) {
  const [before, after] = [rows[i], rows[i + 1]];
  const range = r => `[${r.lo.toFixed(1)}-${r.hi.toFixed(1)}]`;
  console.log(`${before.label.padEnd(width)}  ${ms(before.perCall).padStart(10)}  ${range(before)}`);
  console.log(`${after.label.padEnd(width)}  ${ms(after.perCall).padStart(10)}  ${range(after)}` +
    `   ${(before.perCall / after.perCall).toFixed(1)}x` +
    `  (worst case ${(before.lo / after.hi).toFixed(1)}x)`);
  console.log();
}
