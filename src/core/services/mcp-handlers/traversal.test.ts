/**
 * The load-once-per-generation contract for the precomputed traversal structure
 * (change: optimize-reachability-precompute).
 *
 * Two properties are load-bearing and both are pinned here:
 *  1. A structure is served ONLY alongside the graph it was built from — an
 *     external `openlore analyze` that rewrites the artifacts while a daemon holds
 *     a loaded structure must not be answered from the old one.
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
  artifactDigest,
  writeTraversalIndexArtifact,
  serializeTraversalIndex,
} from '../../analyzer/condensation.js';
import {
  loadTraversalIndex,
  traversalIndexFor,
  recordArtifactDigest,
  traversalIndexMayBeCurrent,
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

describe('persisted traversal structure', () => {
  it('is written by the analyze path and then served for that generation', async () => {
    const cg = graph(GEN_A);
    const contextJson = JSON.stringify({ callGraph: cg });
    await writeTraversalIndexArtifact(analysisDir, cg, contextJson);
    expect(existsSync(indexPath())).toBe(true);

    recordArtifactDigest(cg, artifactDigest(contextJson));
    const ix = await loadTraversalIndex(dir, cg);
    expect([...ix.reachAll(['x.ts::a'], 'forward')].sort()).toEqual(['x.ts::a', 'x.ts::b', 'x.ts::c']);
  });

  it('a structure from another generation is never served — the answer comes from the new graph', async () => {
    // Generation A: write the artifact, then re-analyze into generation B WITHOUT
    // rewriting it. This is exactly the "external analyze under a warm daemon" case:
    // the on-disk structure now describes a graph that is no longer being served.
    const cgA = graph(GEN_A);
    await writeTraversalIndexArtifact(analysisDir, cgA, JSON.stringify({ callGraph: cgA }));
    const staleOnDisk = readFileSync(indexPath(), 'utf-8');

    const cgB = graph(GEN_B);
    const contextB = JSON.stringify({ callGraph: cgB });
    recordArtifactDigest(cgB, artifactDigest(contextB));

    const ix = await loadTraversalIndex(dir, cgB);
    // Generation A's structure would answer `a` reaches `c`. Generation B's must not.
    expect([...ix.reachAll(['x.ts::a'], 'forward')].sort()).toEqual(['x.ts::a', 'x.ts::b']);
    // And the stale artifact was left alone, not silently trusted.
    expect(readFileSync(indexPath(), 'utf-8')).toBe(staleOnDisk);
  });

  it('a flush that rewrites the artifact makes the new structure servable', async () => {
    const cgB = graph(GEN_B);
    const contextB = JSON.stringify({ callGraph: cgB });
    await writeTraversalIndexArtifact(analysisDir, cgB, contextB);
    recordArtifactDigest(cgB, artifactDigest(contextB));
    const ix = await loadTraversalIndex(dir, cgB);
    expect([...ix.reachAll(['x.ts::d'], 'forward')].sort()).toEqual(['x.ts::c', 'x.ts::d']);
  });

  it('falls back to an in-memory build — with identical answers — when the artifact is unusable', async () => {
    const cg = graph(GEN_A);
    const contextJson = JSON.stringify({ callGraph: cg });
    const expected = [...traversalIndexFor(graph(GEN_A)).reachAll(['x.ts::a'], 'forward')].sort();

    const unusable: Array<string | undefined> = [
      undefined,                                                  // no artifact at all
      'not json',                                                 // unparseable
      '{}',                                                       // wrong shape
      serializeTraversalIndex(graph(GEN_A), 'a-different-digest'), // stale generation
      serializeTraversalIndex(graph(GEN_A), artifactDigest(contextJson)).replace(/"fwdTargets":"[^"]*"/, '"fwdTargets":"AAAA"'), // truncated CSR
    ];
    for (const broken of unusable) {
      rmSync(indexPath(), { force: true });
      if (broken !== undefined) writeFileSync(indexPath(), broken);
      // A fresh graph object each time so the WeakMap memo cannot mask the reload.
      const fresh = graph(GEN_A);
      recordArtifactDigest(fresh, artifactDigest(contextJson));
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

describe('staleness pre-check (cost, not correctness)', () => {
  // Validating the structure means digesting a multi-MB context (~29 ms here) and
  // reading the structure (~10 ms). That is worth paying only when the structure
  // could still be current. The watcher rewrites `llm-context.json` on every flush
  // and deliberately does NOT rebuild the structure, so without this check every
  // cold read after a flush would pay the full cost only to reject the result —
  // permanently, until the next full `analyze`.
  const contextPath = () => join(analysisDir, 'llm-context.json');

  it('says yes when the structure was written after the context (the analyze order)', async () => {
    writeFileSync(contextPath(), '{}');
    await new Promise(r => setTimeout(r, 12));
    await writeTraversalIndexArtifact(analysisDir, graph(GEN_A), '{}');
    expect(await traversalIndexMayBeCurrent(analysisDir)).toBe(true);
  });

  it('says no when the context was rewritten after it — the post-flush steady state', async () => {
    await writeTraversalIndexArtifact(analysisDir, graph(GEN_A), '{}');
    await new Promise(r => setTimeout(r, 12));
    writeFileSync(contextPath(), '{"changed":true}'); // what a watcher flush does
    expect(await traversalIndexMayBeCurrent(analysisDir)).toBe(false);
  });

  it('says no when either file is missing', async () => {
    expect(await traversalIndexMayBeCurrent(analysisDir)).toBe(false); // neither
    writeFileSync(contextPath(), '{}');
    expect(await traversalIndexMayBeCurrent(analysisDir)).toBe(false); // no structure
    rmSync(contextPath());
    await writeTraversalIndexArtifact(analysisDir, graph(GEN_A), '{}');
    expect(await traversalIndexMayBeCurrent(analysisDir)).toBe(false); // no context
  });

  it('is only a cost gate — a structure that passes it is still digest-checked', async () => {
    // Same mtime ordering as a real analyze, but the structure belongs to a
    // different generation. The pre-check waves it through; the digest must not.
    writeFileSync(contextPath(), '{}');
    await new Promise(r => setTimeout(r, 12));
    await writeTraversalIndexArtifact(analysisDir, graph(GEN_A), '{"other":"generation"}');
    expect(await traversalIndexMayBeCurrent(analysisDir)).toBe(true);

    const cg = graph(GEN_B);
    recordArtifactDigest(cg, artifactDigest('{}'));
    const ix = await loadTraversalIndex(dir, cg);
    expect([...ix.reachAll(['x.ts::a'], 'forward')].sort()).toEqual(['x.ts::a', 'x.ts::b']);
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
