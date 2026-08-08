/**
 * End-to-end proof of the narrowed invalidation key
 * (change: shrink-traversal-index-invalidation-scope), driven through the real
 * `readCachedContext` → `loadTraversalIndex` seam rather than a unit stub.
 *
 * The three spec scenarios, observed on-disk:
 *  1. A signature-only flush (context BYTES change, graph does not) leaves the
 *     persisted structure servable — a later cold read loads it, never rebuilds.
 *  2. A graph change invalidates it — the structure is refused and the answer comes
 *     from the new graph.
 *  3. Establishing currency reads the digest from the parsed context; the read path
 *     never hashes the artifact.
 *
 * To distinguish "loaded the persisted structure" from "rebuilt an equivalent one"
 * (they answer identically by construction), the persisted artifact is a VALID but
 * deliberately DIVERGENT structure stamped with the served graph's digest — the same
 * poison-to-detect technique the sibling suite uses for the "not consulted" case. If
 * the on-disk structure is served, its divergent answer shows; if it is rebuilt, the
 * true graph's answer shows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT, ARTIFACT_TRAVERSAL_INDEX } from '../../../constants.js';
import { graphDigest, serializeTraversalIndex } from '../../analyzer/condensation.js';
import { readCachedContext } from './utils.js';
import { loadTraversalIndex } from './traversal.js';
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

// SERVED: a→b→c. POISON (the on-disk structure, divergent): a→b only. CHANGED: a→b→c→e.
const SERVED = graph([['x.ts::a', 'x.ts::b'], ['x.ts::b', 'x.ts::c']]);
const POISON = graph([['x.ts::a', 'x.ts::b']]);
const CHANGED = graph([['x.ts::a', 'x.ts::b'], ['x.ts::b', 'x.ts::c'], ['x.ts::c', 'x.ts::e']]);

let dir: string;
let contextPath: string;
let indexFilePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openlore-flush-'));
  const analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  mkdirSync(analysisDir, { recursive: true });
  contextPath = join(analysisDir, ARTIFACT_LLM_CONTEXT);
  indexFilePath = join(analysisDir, ARTIFACT_TRAVERSAL_INDEX);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Write a context whose bytes include `signatures`, keyed to `cg`'s graph digest. */
function writeContext(cg: SerializedCallGraph, signaturesFiller: string): void {
  writeFileSync(contextPath, JSON.stringify({
    phase1_survey: { title: 'x', content: '' },
    phase2_deep: { title: 'x', content: '' },
    phase3_validation: { title: 'x', content: '' },
    signatures: [{ filler: signaturesFiller }],
    callGraph: cg,
    graphDigest: graphDigest(cg),
  }));
}

async function reachAFrom(): Promise<string[]> {
  const ctx = await readCachedContext(dir);
  expect(ctx, 'readCachedContext returned a context').not.toBeNull();
  const ix = await loadTraversalIndex(dir, ctx!.callGraph as SerializedCallGraph);
  return [...ix.reachAll(['x.ts::a'], 'forward')].sort();
}

describe('shrink-traversal-index-invalidation-scope: end-to-end flush survival', () => {
  it('a signature-only flush leaves the persisted structure servable; a graph change refuses it', async () => {
    // The on-disk structure is stamped with SERVED's graph digest but describes POISON
    // (a→b, no c). If served, `a` reaches {a,b}; if rebuilt from SERVED, {a,b,c}.
    writeContext(SERVED, 'v1');
    writeFileSync(indexFilePath, serializeTraversalIndex(POISON, graphDigest(SERVED)));

    // 1. Cold read: the persisted (divergent) structure is loaded, proving the disk
    //    artifact — not a rebuild — answered.
    expect(await reachAFrom()).toEqual(['x.ts::a', 'x.ts::b']);

    // 2. Signature-only flush: rewrite the context BYTES (new `signatures`, larger
    //    payload) but keep the same graph and graphDigest, and DO NOT rewrite the
    //    structure. A later cold read must still load it — the flush did not invalidate.
    await sleep(12);
    writeContext(SERVED, 'v2-with-noticeably-more-bytes-than-before');
    expect(await reachAFrom()).toEqual(['x.ts::a', 'x.ts::b']);

    // 3. Graph change: a new graph (and thus a new graphDigest) is served while the
    //    stale structure still on disk is stamped for the old graph. Its digest no
    //    longer matches, so it is refused and the answer comes from the NEW graph.
    await sleep(12);
    writeContext(CHANGED, 'v3');
    expect(await reachAFrom()).toEqual(['x.ts::a', 'x.ts::b', 'x.ts::c', 'x.ts::e']);
  });

  it('a legacy context with no graphDigest field consults no structure', async () => {
    // No graphDigest recorded → the loader never reads the (contradictory) on-disk
    // structure and builds from the served graph instead.
    writeFileSync(contextPath, JSON.stringify({
      phase1_survey: { title: 'x', content: '' },
      phase2_deep: { title: 'x', content: '' },
      phase3_validation: { title: 'x', content: '' },
      callGraph: SERVED,
      // graphDigest intentionally absent (predates the change)
    }));
    writeFileSync(indexFilePath, serializeTraversalIndex(POISON, graphDigest(SERVED)));
    expect(await reachAFrom()).toEqual(['x.ts::a', 'x.ts::b', 'x.ts::c']);
  });
});
