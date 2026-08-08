/**
 * The load-once-per-generation contract for the precomputed traversal structure
 * (change: optimize-reachability-precompute), re-keyed to the graph digest
 * (change: shrink-traversal-index-invalidation-scope).
 *
 * Two properties are load-bearing and both are pinned here:
 *  1. A structure is served ONLY alongside the graph it was built from — an
 *     external `openlore analyze` that rewrites the artifacts while a daemon holds
 *     a loaded structure must not be answered from the old one. Currency is decided
 *     by the graph digest the context carries, not by the artifact's bytes.
 *  2. Anything the persisted artifact cannot prove (absent, stale digest, wrong
 *     version, truncated) degrades to an in-memory rebuild with the SAME answers,
 *     never to a wrong or empty one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_TRAVERSAL_INDEX,
} from '../../../constants.js';
import {
  graphDigest,
  writeTraversalIndexArtifact,
  serializeTraversalIndex,
} from '../../analyzer/condensation.js';
import {
  loadTraversalIndex,
  traversalIndexFor,
  recordGraphDigest,
} from './traversal.js';
import type { CallEdge, FunctionNode, SerializedCallGraph } from '../../analyzer/call-graph.js';

function node(id: string): FunctionNode {
  return {
    id, name: id.split('::')[1] ?? id, filePath: id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'typescript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0,
  } as FunctionNode;
}
function edge(from: string, to: string): CallEdge {
  return { callerId: from, calleeId: to, calleeName: to.split('::')[1] ?? to, confidence: 'name_only' } as CallEdge;
}
function graph(pairs: Array<[string, string]>): SerializedCallGraph {
  const ids = [...new Set(pairs.flat())];
  return {
    nodes: ids.map(node), edges: pairs.map(([a, b]) => edge(a, b)),
    classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: ids.length, totalEdges: pairs.length, avgFanIn: 0, avgFanOut: 0 },
  } as unknown as SerializedCallGraph;
}

const GEN_A: Array<[string, string]> = [['x.ts::a', 'x.ts::b'], ['x.ts::b', 'x.ts::c']];
/** Generation B rewires the graph: `a` no longer reaches `c`. */
const GEN_B: Array<[string, string]> = [['x.ts::a', 'x.ts::b'], ['x.ts::d', 'x.ts::c']];

let dir: string;
let analysisDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openlore-traversal-'));
  analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  mkdirSync(analysisDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const indexPath = () => join(analysisDir, ARTIFACT_TRAVERSAL_INDEX);

describe('the graph digest is stable across two equal graphs and moves with the graph', () => {
  it('two structurally identical graphs digest identically; a rewire changes the digest', () => {
    expect(graphDigest(graph(GEN_A))).toBe(graphDigest(graph(GEN_A)));
    expect(graphDigest(graph(GEN_A))).not.toBe(graphDigest(graph(GEN_B)));
  });

  it('a synthesized edge digests differently from a resolved one', () => {
    const base = graph([['x.ts::a', 'x.ts::b']]);
    const synth = graph([['x.ts::a', 'x.ts::b']]);
    (synth.edges as CallEdge[])[0].confidence = 'synthesized';
    expect(graphDigest(base)).not.toBe(graphDigest(synth));
  });
});

describe('persisted traversal structure', () => {
  it('is written by the analyze path and then served for that generation', async () => {
    const cg = graph(GEN_A);
    await writeTraversalIndexArtifact(analysisDir, cg, graphDigest(cg));
    expect(existsSync(indexPath())).toBe(true);

    recordGraphDigest(cg, graphDigest(cg));
    const ix = await loadTraversalIndex(dir, cg);
    expect([...ix.reachAll(['x.ts::a'], 'forward')].sort()).toEqual(['x.ts::a', 'x.ts::b', 'x.ts::c']);
  });

  it('a structure from another generation is never served — the answer comes from the new graph', async () => {
    // Generation A: write the artifact, then re-analyze into generation B WITHOUT
    // rewriting it. This is exactly the "external analyze under a warm daemon" case:
    // the on-disk structure now describes a graph that is no longer being served.
    const cgA = graph(GEN_A);
    await writeTraversalIndexArtifact(analysisDir, cgA, graphDigest(cgA));
    const staleOnDisk = readFileSync(indexPath(), 'utf-8');

    const cgB = graph(GEN_B);
    recordGraphDigest(cgB, graphDigest(cgB));

    const ix = await loadTraversalIndex(dir, cgB);
    // Generation A's structure would answer `a` reaches `c`. Generation B's must not.
    expect([...ix.reachAll(['x.ts::a'], 'forward')].sort()).toEqual(['x.ts::a', 'x.ts::b']);
    // And the stale artifact was left alone, not silently trusted.
    expect(readFileSync(indexPath(), 'utf-8')).toBe(staleOnDisk);
  });

  it('a signature-only flush leaves the structure servable — the graph digest is unchanged', async () => {
    // The whole point of the change: a flush rewrites llm-context.json bytes but the
    // graph is untouched, so the digest the context carries still matches the stamp,
    // and a later cold read LOADS the structure rather than rebuilding it. Model that
    // by serving the SAME graph the structure was stamped with — the digest agrees,
    // so the persisted structure (not an in-memory rebuild) is returned.
    const cg = graph(GEN_A);
    await writeTraversalIndexArtifact(analysisDir, cg, graphDigest(cg));
    const onDisk = readFileSync(indexPath(), 'utf-8');

    // A fresh graph object with the same structure — a memo miss, forcing the loader
    // to consult the disk. It must return the persisted structure's answers.
    const served = graph(GEN_A);
    recordGraphDigest(served, graphDigest(served));
    const ix = await loadTraversalIndex(dir, served);
    expect([...ix.reachAll(['x.ts::a'], 'forward')].sort()).toEqual(['x.ts::a', 'x.ts::b', 'x.ts::c']);
    // The structure on disk was accepted as-is, never rewritten by the read path.
    expect(readFileSync(indexPath(), 'utf-8')).toBe(onDisk);
  });

  it('falls back to an in-memory build — with identical answers — when the artifact is unusable', async () => {
    const cg = graph(GEN_A);
    const expected = [...traversalIndexFor(graph(GEN_A)).reachAll(['x.ts::a'], 'forward')].sort();

    const unusable: Array<string | undefined> = [
      undefined,                                                  // no artifact at all
      'not json',                                                 // unparseable
      '{}',                                                       // wrong shape
      serializeTraversalIndex(graph(GEN_A), 'a-different-digest'), // stale generation
      serializeTraversalIndex(graph(GEN_A), graphDigest(cg)).replace(/"fwdTargets":"[^"]*"/, '"fwdTargets":"AAAA"'), // truncated CSR
    ];
    for (const broken of unusable) {
      rmSync(indexPath(), { force: true });
      if (broken !== undefined) writeFileSync(indexPath(), broken);
      // A fresh graph object each time so the WeakMap memo cannot mask the reload.
      const fresh = graph(GEN_A);
      recordGraphDigest(fresh, graphDigest(fresh));
      const ix = await loadTraversalIndex(dir, fresh);
      expect([...ix.reachAll(['x.ts::a'], 'forward')].sort()).toEqual(expected);
    }
  });

  it('without a recorded digest the artifact is not consulted at all', async () => {
    const cg = graph(GEN_A);
    // A structure whose contents contradict the graph, and no digest to check it
    // against: the loader must not read it, and must build from the graph instead.
    writeFileSync(indexPath(), serializeTraversalIndex(graph(GEN_B), 'some-digest'));
    const ix = await loadTraversalIndex(dir, cg);
    expect([...ix.reachAll(['x.ts::a'], 'forward')].sort()).toEqual(['x.ts::a', 'x.ts::b', 'x.ts::c']);
  });
});

describe('load-once memoization', () => {
  it('returns the same structure for one generation and a different one for the next', async () => {
    const cgA = graph(GEN_A);
    const first = await loadTraversalIndex(dir, cgA);
    const second = await loadTraversalIndex(dir, cgA);
    expect(second).toBe(first); // one structure per generation, not one per call

    const cgB = graph(GEN_B); // a new generation is a new object → a new structure
    expect(await loadTraversalIndex(dir, cgB)).not.toBe(first);
  });

  it('the sync path shares the memo with the async one', async () => {
    const cg = graph(GEN_A);
    const viaSync = traversalIndexFor(cg);
    expect(await loadTraversalIndex(dir, cg)).toBe(viaSync);
  });
});
