/**
 * End-to-end load-path tests for the index integrity attestation
 * (change: add-index-integrity-attestation). Builds a real on-disk index
 * (call-graph.db + llm-context.json + index-attestation.json), then drives the real
 * readCachedContext load path and asserts the reconciliation verdict it attaches.
 *
 * Plain `.test.ts` (not *.integration.test.ts) so it runs in CI — this is a
 * CI-protected soundness guard, not an opt-in integration check.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EdgeStore, SCHEMA_VERSION } from '../edge-store.js';
import { computeAttestation, writeAttestation } from '../../analyzer/index-attestation.js';
import { readCachedContext, _resetContextCacheForTesting } from './utils.js';
import { handleFindDeadCode } from './reachability.js';
import { handleGetHealthMap } from './health-map.js';
import { handleAnalyzeImpact } from './graph.js';
import { handleSelectTests } from './test-impact.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT, ARTIFACT_INDEX_ATTESTATION } from '../../../constants.js';
import type { FunctionNode, CallEdge, ClassNode } from '../../analyzer/call-graph.js';
import type { ConfidenceBoundary } from './confidence-boundary.js';

const TOTAL = 40; // > SMALL_REPO_MIN_FUNCTIONS so the ratio floor is in play

function makeNodes(n: number): FunctionNode[] {
  return Array.from({ length: n }, (_, i): FunctionNode => ({
    id: `src/f${i % 5}.ts::fn${i}`, name: `fn${i}`, filePath: `src/f${i % 5}.ts`,
    isAsync: false, language: 'TypeScript', startIndex: i, endIndex: i + 1, fanIn: 0, fanOut: 0,
  }));
}
function makeEdges(nodes: FunctionNode[]): CallEdge[] {
  return nodes.slice(0, -1).map((n, i): CallEdge => ({
    callerId: n.id, calleeId: nodes[i + 1].id, calleeName: nodes[i + 1].name, confidence: 'import',
  }));
}
const CLASSES: ClassNode[] = [{
  id: 'src/f0.ts::C', name: 'C', filePath: 'src/f0.ts', language: 'TypeScript',
  parentClasses: [], interfaces: [], methodIds: [], fanIn: 0, fanOut: 0, isModule: false,
}];

/**
 * Lay down an index on disk. `storedNodeCount` lets a build "partially land" (fewer
 * rows in the DB than the JSON/attestation committed); `attestationSchema` lets the
 * attestation claim a different schema than the store was built at.
 */
async function layIndex(opts: { committed: number; storedNodeCount?: number; attestationSchema?: number; withAttestation?: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'idx-integrity-'));
  const analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(analysisDir, { recursive: true });

  const committedNodes = makeNodes(opts.committed);
  const committedEdges = makeEdges(committedNodes);

  // The DB may carry fewer nodes than were committed (simulated partial persist).
  const storedNodes = committedNodes.slice(0, opts.storedNodeCount ?? opts.committed);
  const storedEdges = makeEdges(storedNodes);
  const store = EdgeStore.open(EdgeStore.dbPath(analysisDir));
  store.insertNodes(storedNodes);
  store.insertEdges(storedEdges);
  store.insertClasses(CLASSES);
  store.close();

  if (opts.withAttestation !== false) {
    const att = computeAttestation(opts.attestationSchema ?? SCHEMA_VERSION, committedNodes, committedEdges, CLASSES);
    await writeAttestation(analysisDir, att);
  }

  // The JSON context lists the full committed production graph (it landed; the DB may not have).
  await writeFile(
    join(analysisDir, ARTIFACT_LLM_CONTEXT),
    JSON.stringify({ callGraph: { nodes: committedNodes, edges: committedEdges } }),
  );
  return dir;
}

describe('index integrity — load-path reconciliation', () => {
  const dirs: string[] = [];
  const track = async (p: Promise<string>): Promise<string> => { const d = await p; dirs.push(d); return d; };
  afterEach(async () => {
    _resetContextCacheForTesting(); // close cached EdgeStore handles before rm (Windows locks open .db files)
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('healthy: a fully-landed index reconciles and attaches the store', async () => {
    const dir = await track(layIndex({ committed: TOTAL }));
    const ctx = await readCachedContext(dir);
    expect(ctx?.integrity?.verdict).toBe('healthy');
    expect(ctx?.edgeStore).toBeDefined();
    ctx?.edgeStore?.close();
  });

  it('degraded: a partially-landed index (DB << committed) is labeled, not silently served as complete', async () => {
    // Only 5 of 40 committed nodes landed in the DB — the build did not fully persist.
    const dir = await track(layIndex({ committed: TOTAL, storedNodeCount: 5 }));
    const ctx = await readCachedContext(dir);
    expect(ctx?.integrity?.verdict).toBe('degraded');
    expect(ctx?.integrity?.detail).toMatch(/materially smaller/);
    // No-silent contract: the context is RETURNED but LABELED — never an unlabeled empty/complete result.
    expect(ctx).not.toBeNull();
    ctx?.edgeStore?.close();
  });

  it('mismatched: an index whose attestation was built at a different schema version', async () => {
    const dir = await track(layIndex({ committed: TOTAL, attestationSchema: SCHEMA_VERSION - 1 }));
    const ctx = await readCachedContext(dir);
    expect(ctx?.integrity?.verdict).toBe('mismatched');
    expect(ctx?.integrity?.detail).toMatch(/schema version/);
    ctx?.edgeStore?.close();
  });

  it('unverifiable: a legacy index without an attestation gets no fabricated verdict', async () => {
    const dir = await track(layIndex({ committed: TOTAL, withAttestation: false }));
    const ctx = await readCachedContext(dir);
    expect(ctx?.integrity).toBeUndefined(); // never present absence as a healthy fact
    expect(ctx?.edgeStore).toBeDefined();
    ctx?.edgeStore?.close();
  });

  it('attestation present but call-graph.db absent → no verdict, no crash (unverifiable)', async () => {
    const dir = await track(layIndex({ committed: TOTAL }));
    await rm(EdgeStore.dbPath(join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR)), { force: true });
    const ctx = await readCachedContext(dir);
    expect(ctx?.integrity).toBeUndefined(); // computeIndexIntegrity only runs when the store exists
    ctx?.edgeStore?.close();
  });
});

describe('index integrity — surfaced to agents end-to-end', () => {
  const dirs: string[] = [];
  const track = async (p: Promise<string>): Promise<string> => { const d = await p; dirs.push(d); return d; };
  afterEach(async () => { _resetContextCacheForTesting(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('find_dead_code over a degraded index carries the verdict and is NOT marked complete', async () => {
    const dir = await track(layIndex({ committed: TOTAL, storedNodeCount: 5 }));
    const res = await handleFindDeadCode({ directory: dir }) as { confidenceBoundary?: ConfidenceBoundary };
    expect(res.confidenceBoundary?.integrity?.verdict).toBe('degraded');
    expect(res.confidenceBoundary?.complete).toBe(false);
  });

  it('find_dead_code over a healthy index discloses no integrity verdict', async () => {
    const dir = await track(layIndex({ committed: TOTAL }));
    const res = await handleFindDeadCode({ directory: dir }) as { confidenceBoundary?: ConfidenceBoundary };
    expect(res.confidenceBoundary?.integrity).toBeUndefined();
  });

  it('analyze_impact over a degraded index carries the verdict and is not complete', async () => {
    const dir = await track(layIndex({ committed: TOTAL, storedNodeCount: 5 }));
    // fn1 is among the 5 nodes that landed in the store.
    const res = await handleAnalyzeImpact(dir, 'fn1') as { confidenceBoundary?: ConfidenceBoundary };
    expect(res.confidenceBoundary?.integrity?.verdict).toBe('degraded');
    expect(res.confidenceBoundary?.complete).toBe(false);
  });

  it('select_tests over a degraded index carries the verdict', async () => {
    const dir = await track(layIndex({ committed: TOTAL, storedNodeCount: 5 }));
    const res = await handleSelectTests({ directory: dir, changedSymbols: ['fn1'] }) as { confidenceBoundary?: ConfidenceBoundary };
    expect(res.confidenceBoundary?.integrity?.verdict).toBe('degraded');
  });

  it('a malformed attestation on disk loads as unverifiable, never a fabricated healthy', async () => {
    const dir = await track(layIndex({ committed: TOTAL }));
    // Corrupt the committed counts (the NaN→false-healthy trap) directly on disk.
    const attPath = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_INDEX_ATTESTATION);
    const att = JSON.parse(await readFile(attPath, 'utf-8')) as Record<string, unknown>;
    await writeFile(attPath, JSON.stringify({ ...att, committed: {} }));
    const ctx = await readCachedContext(dir);
    expect(ctx?.integrity).toBeUndefined(); // unverifiable, not healthy
    ctx?.edgeStore?.close();
  });

  it('get_health_map discloses indexIntegrity on a degraded index, and omits it when healthy', async () => {
    const degradedDir = await track(layIndex({ committed: TOTAL, storedNodeCount: 5 }));
    const degraded = await handleGetHealthMap({ directory: degradedDir }) as { indexIntegrity?: { verdict: string } };
    expect(degraded.indexIntegrity?.verdict).toBe('degraded');

    const healthyDir = await track(layIndex({ committed: TOTAL }));
    const healthy = await handleGetHealthMap({ directory: healthyDir }) as { indexIntegrity?: unknown };
    expect(healthy.indexIntegrity).toBeUndefined();
  });

  it('a non-healthy load emits a recoverable telemetry signal (and a healthy load does not)', async () => {
    const prev = process.env['OPENLORE_TELEMETRY'];
    process.env['OPENLORE_TELEMETRY'] = '1';
    try {
      const degradedDir = await track(layIndex({ committed: TOTAL, storedNodeCount: 5 }));
      const ctx = await readCachedContext(degradedDir);
      ctx?.edgeStore?.close();
      const log = await readFile(join(degradedDir, OPENLORE_DIR, 'telemetry', 'cache.jsonl'), 'utf-8');
      expect(log).toMatch(/"event":"index_integrity"/);
      expect(log).toMatch(/"verdict":"degraded"/);

      const healthyDir = await track(layIndex({ committed: TOTAL }));
      const hctx = await readCachedContext(healthyDir);
      hctx?.edgeStore?.close();
      const healthyLog = await readFile(join(healthyDir, OPENLORE_DIR, 'telemetry', 'cache.jsonl'), 'utf-8').catch(() => '');
      expect(healthyLog).not.toMatch(/index_integrity/);
    } finally {
      if (prev === undefined) delete process.env['OPENLORE_TELEMETRY']; else process.env['OPENLORE_TELEMETRY'] = prev;
    }
  });
});
