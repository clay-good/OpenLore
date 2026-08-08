/**
 * End-to-end equivalence check on a REAL analyzed graph
 * (change: optimize-reachability-precompute).
 *
 * `condensation.test.ts` pins equivalence on randomized graphs. This runs the same
 * oracle against an actual `.openlore/analysis/llm-context.json` — real external
 * leaves, real synthesized dispatch edges, real IaC nodes, real cycles — and also
 * exercises the PERSISTED artifact path (digest binding + rehydration), which the
 * unit suite covers only synthetically.
 *
 *   node scripts/verify-reachability-equivalence.mjs [repoDir]
 *
 * Exits non-zero on any divergence.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildTraversalIndex,
  serializeTraversalIndex,
  deserializeTraversalIndex,
  graphDigest,
} from '../dist/core/analyzer/condensation.js';

const repo = process.argv[2] ?? process.cwd();
const analysisDir = join(repo, '.openlore', 'analysis');
const contextRaw = readFileSync(join(analysisDir, 'llm-context.json'), 'utf-8');
const contextParsed = JSON.parse(contextRaw);
const cg = contextParsed.callGraph;
if (!cg) { console.error('No callGraph in llm-context.json — run `openlore analyze` first.'); process.exit(1); }

// ── The frozen pre-change implementations. ──────────────────────────────────
function oracleAdjacency(cg, opts) {
  const forward = new Map(), backward = new Map();
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
function oracleReach(seeds, forward, excludeId) {
  const live = new Set(), queue = [];
  for (const s of seeds) { if (s === excludeId || live.has(s)) continue; live.add(s); queue.push(s); }
  while (queue.length) {
    const id = queue.shift();
    for (const next of forward.get(id) ?? []) {
      if (next === excludeId || live.has(next)) continue;
      live.add(next); queue.push(next);
    }
  }
  return live;
}
function oracleSortedBfs(seeds, adjacency, maxDepth) {
  const depthOf = new Map(), parent = new Map(), queue = [];
  for (const s of seeds) { depthOf.set(s, 0); queue.push({ id: s, depth: 0 }); }
  while (queue.length) {
    const { id, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    for (const caller of [...(adjacency.get(id) ?? [])].sort()) {
      if (!depthOf.has(caller)) {
        depthOf.set(caller, depth + 1); parent.set(caller, id);
        queue.push({ id: caller, depth: depth + 1 });
      }
    }
  }
  return { depthOf, parent };
}

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else { console.error(`  FAIL ${name} ${detail}`); failures++; }
};
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

console.log(`Graph: ${cg.nodes.length.toLocaleString()} nodes, ${cg.edges.length.toLocaleString()} edges`);

const ix = buildTraversalIndex(cg);
console.log(`Index: ${ix.nodeCount.toLocaleString()} nodes, ${ix.edgeCount.toLocaleString()} edges, ` +
  `${ix.componentCount.toLocaleString()} components\n`);

const everyId = new Set();
for (const n of cg.nodes) everyId.add(n.id);
for (const e of cg.edges) { everyId.add(e.callerId); if (e.calleeId) everyId.add(e.calleeId); }
const allIds = [...everyId].sort();

for (const filter of [undefined, { directResolvedOnly: true }]) {
  const label = filter ? 'directResolvedOnly' : 'all edges';
  const adj = oracleAdjacency(cg, filter);
  console.log(`── ${label} ─────────────────────────────`);

  // 1. Neighbour lists, ORDER INCLUDED, for every node in both directions.
  let neighbourOk = true, badId = '';
  for (const id of allIds) {
    for (const [dir, map] of [['forward', adj.forward], ['backward', adj.backward]]) {
      const got = ix.neighborIds(id, dir, filter);
      const want = [...(map.get(id) ?? [])];
      if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
        neighbourOk = false; badId = `${id} (${dir})`; break;
      }
    }
    if (!neighbourOk) break;
  }
  check(`neighbour lists identical, order included (${allIds.length.toLocaleString()} nodes × 2 directions)`,
    neighbourOk, badId);

  // 2. find_dead_code / report_coverage_gaps: whole-graph reach from the real roots.
  const testSeeds = cg.nodes.filter(n => n.isTest && !n.isExternal).map(n => n.id);
  for (const e of cg.edges) if (e.kind === 'tested_by' && e.callerId) testSeeds.push(e.callerId);
  const wantFwd = oracleReach(testSeeds, adj.forward);
  const gotFwd = ix.reachAll(testSeeds, 'forward', filter);
  check(`whole-graph forward reach from ${testSeeds.length.toLocaleString()} test seeds ` +
    `(${wantFwd.size.toLocaleString()} reached)`, sameSet(wantFwd, gotFwd));

  // 3. select_tests: sorted-neighbour backward walk with parent chains, from many
  //    different seeds (the viaPath in the payload is reconstructed from `parent`).
  let bfsOk = true, bfsDetail = '';
  const step = Math.max(1, Math.floor(cg.nodes.length / 200));
  for (let i = 0; i < cg.nodes.length; i += step) {
    const seeds = [cg.nodes[i].id];
    const want = oracleSortedBfs(seeds, adj.backward, 12);
    const got = ix.bfsWithParents(seeds, 'backward', 12, filter, { sortNeighbors: true });
    if (!sameMap(want.depthOf, got.depth)) { bfsOk = false; bfsDetail = `depths from ${seeds[0]}`; break; }
    if (!sameMap(want.parent, got.parent)) { bfsOk = false; bfsDetail = `parent chain from ${seeds[0]}`; break; }
  }
  check('select_tests backward walk: depths AND parent chains identical (200 seeds)', bfsOk, bfsDetail);

  // 4. find_dead_code delete-mode: reach with an excluded node.
  let delOk = true, delDetail = '';
  for (let i = 0; i < cg.nodes.length; i += step) {
    const excluded = cg.nodes[i].id;
    const want = oracleReach(testSeeds, adj.forward, excluded);
    const got = ix.reachAll(testSeeds, 'forward', filter, excluded);
    if (!sameSet(want, got)) { delOk = false; delDetail = `excluding ${excluded}`; break; }
  }
  check('delete-impact reach (excludeId) identical (200 exclusions)', delOk, delDetail);

  // 5. find_path role:sink — degree must match `adjacency.get(id).size`.
  let degOk = true;
  for (const id of allIds) {
    if (ix.degree(id, 'forward', filter) !== (adj.forward.get(id)?.size ?? 0)) { degOk = false; break; }
    if (ix.degree(id, 'backward', filter) !== (adj.backward.get(id)?.size ?? 0)) { degOk = false; break; }
  }
  check('degree() matches adjacency Set size', degOk);
  console.log();
}

// 6. The persisted artifact: digest binding and rehydrated equivalence.
console.log('── persisted artifact ─────────────────────────────');
// The structure is now keyed to the GRAPH, not the artifact bytes (change:
// shrink-traversal-index-invalidation-scope): `analyze` writes graphDigest(cg) into
// llm-context.json and stamps the structure with the same value, so a signature-only
// flush that rewrites the context leaves the structure valid.
const digest = graphDigest(cg);
let onDisk = null;
try { onDisk = JSON.parse(readFileSync(join(analysisDir, 'traversal-index.json'), 'utf-8')); } catch { /* absent */ }
check('analyze wrote traversal-index.json', onDisk !== null);
check('its graphDigest binds it to THIS graph', onDisk?.graphDigest === digest,
  onDisk ? `artifact=${onDisk.graphDigest?.slice(0, 12)} actual=${digest.slice(0, 12)}` : '');
check('llm-context.json carries the same graphDigest for the reader', contextParsed.graphDigest === digest,
  `context=${String(contextParsed.graphDigest).slice(0, 12)} actual=${digest.slice(0, 12)}`);

const rehydrated = deserializeTraversalIndex(serializeTraversalIndex(cg, digest), digest);
check('round-trip rehydrates', rehydrated !== null);
if (rehydrated) {
  let rtOk = true;
  for (const id of allIds) {
    if (rehydrated.neighborIds(id, 'forward').join('\u0000') !== ix.neighborIds(id, 'forward').join('\u0000')) { rtOk = false; break; }
    if (rehydrated.neighborIds(id, 'backward').join('\u0000') !== ix.neighborIds(id, 'backward').join('\u0000')) { rtOk = false; break; }
  }
  check('rehydrated structure answers identically to the built one', rtOk);
}
check('a structure stamped for another generation is refused',
  deserializeTraversalIndex(serializeTraversalIndex(cg, digest), 'other-generation') === null);

console.log();
if (failures > 0) { console.error(`${failures} check(s) FAILED`); process.exit(1); }
console.log('All equivalence checks passed on the real graph.');
