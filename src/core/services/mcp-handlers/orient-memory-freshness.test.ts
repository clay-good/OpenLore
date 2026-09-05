/**
 * orient decision freshness (change: add-code-anchored-memory-staleness).
 *
 * Proves the bullet-proof guarantee at the default entry tool: orient annotates
 * surfaced decisions with a deterministic freshness verdict and NEVER lists an
 * orphaned decision as authoritative (it goes to staleDecisions instead).
 *
 * Only the vector-index modules are mocked (orthogonal to freshness — they just
 * gate orient's "analysis exists" check). readCachedContext, the edge store, the
 * decision store, and the whole anchor engine run for real against a temp repo.
 * Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Make orient believe an index exists; search results are irrelevant here because
// `approved` decisions surface regardless of task relevance.
vi.mock('../../analyzer/vector-index.js', () => ({
  VectorIndex: {
    exists: vi.fn(() => true),
    search: vi.fn(async () => []),
    keywordMissDiagnostics: vi.fn(async () => ({ missedTokens: [], nearTokens: [] })),
  },
}));
vi.mock('../../analyzer/embedding-service.js', () => ({
  EmbeddingService: { fromEnv: vi.fn(() => { throw new Error('no env'); }), fromConfig: vi.fn(() => null) },
}));
vi.mock('../../analyzer/spec-vector-index.js', () => ({
  SpecVectorIndex: { exists: vi.fn(() => false), search: vi.fn(async () => []) },
}));

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../../constants.js';
import { handleOrient } from './orient.js';
import { handleRemember } from './memory.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';
import { _resetContextCacheForTesting } from './utils.js';

let root: string;
const SRC = 'export function fooHandler() {\n  return 1;\n}\n';

function node(filePath: string, name: string, startIndex: number, endIndex: number): FunctionNode {
  return { id: `${filePath}::${name}`, name, filePath, isAsync: false, language: 'typescript', startIndex, endIndex, fanIn: 0, fanOut: 0 };
}

async function analysisDir(): Promise<string> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function buildStore(nodes: FunctionNode[]): Promise<void> {
  const store = EdgeStore.open(EdgeStore.dbPath(await analysisDir()));
  store.clearAll();
  store.insertNodes(nodes);
  store.close();
}

async function writeLlmContext(nodes: FunctionNode[]): Promise<void> {
  const callGraph = {
    nodes, edges: [], classes: [], inheritanceEdges: [],
    hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
  await writeFile(join(await analysisDir(), ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }), 'utf-8');
}

async function writeDecisions(decisions: Array<Record<string, unknown>>): Promise<void> {
  const dir = join(root, OPENLORE_DIR, 'decisions');
  await mkdir(dir, { recursive: true });
  const full = decisions.map((d) => ({
    status: 'approved', title: 'untitled', rationale: '', consequences: '', proposedRequirement: null,
    affectedDomains: [], affectedFiles: [], sessionId: 's', recordedAt: '2026-01-01T00:00:00Z',
    confidence: 'medium', syncedToSpecs: [], ...d,
  }));
  await writeFile(join(dir, 'pending.json'), JSON.stringify({ version: '1', sessionId: 's', updatedAt: '', decisions: full }), 'utf-8');
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'openlore-orient-mem-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'foo.ts'), SRC, 'utf-8');
  const nodes = [node('src/foo.ts', 'fooHandler', 0, Buffer.byteLength(SRC, 'utf-8'))];
  await buildStore(nodes);
  await writeLlmContext(nodes);
});
afterEach(async () => { _resetContextCacheForTesting(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('orient — decision freshness & no-silent-stale guarantee', () => {
  it('annotates a fresh decision and lists it as authoritative (pendingDecisions)', async () => {
    await writeDecisions([{ id: 'fresh1', title: 'keep fooHandler pure', affectedFiles: ['src/foo.ts'] }]);
    const r = (await handleOrient(root, 'work on fooHandler')) as {
      error?: string;
      pendingDecisions?: Array<{ id: string; freshness?: string }>;
      staleDecisions?: Array<{ id: string }>;
    };
    expect(r.error).toBeUndefined();
    const fresh = r.pendingDecisions?.find((d) => d.id === 'fresh1');
    expect(fresh).toBeDefined();
    expect(fresh!.freshness).toBe('fresh');
    expect(r.staleDecisions ?? []).toHaveLength(0);
  });

  it('NEVER lists an orphaned decision as authoritative — it goes to staleDecisions', async () => {
    await writeDecisions([
      { id: 'fresh1', title: 'keep fooHandler pure', affectedFiles: ['src/foo.ts'] },
      { id: 'orphan1', title: 'about a deleted module', affectedFiles: ['src/deleted.ts'] },
    ]);
    const r = (await handleOrient(root, 'work on fooHandler')) as {
      pendingDecisions?: Array<{ id: string; freshness?: string }>;
      staleDecisions?: Array<{ id: string; freshness?: string }>;
    };
    const pendingIds = (r.pendingDecisions ?? []).map((d) => d.id);
    const staleIds = (r.staleDecisions ?? []).map((d) => d.id);

    expect(pendingIds).toContain('fresh1');
    expect(pendingIds).not.toContain('orphan1'); // the guarantee
    expect(staleIds).toContain('orphan1');
    expect(r.staleDecisions!.find((d) => d.id === 'orphan1')!.freshness).toBe('orphaned');
  });

  it('marks a decision whose anchored symbol changed as drifted+verify, still authoritative', async () => {
    await writeDecisions([{
      id: 'drift1', title: 'fooHandler contract',
      affectedFiles: ['src/foo.ts'],
      anchors: [{ nodeId: 'src/foo.ts::fooHandler', symbolName: 'fooHandler', filePath: 'src/foo.ts', contentHash: 'STALE_HASH' }],
    }]);
    const r = (await handleOrient(root, 'fooHandler contract')) as {
      pendingDecisions?: Array<{ id: string; freshness?: string; verify?: boolean }>;
    };
    const drift = r.pendingDecisions?.find((d) => d.id === 'drift1');
    expect(drift).toBeDefined();
    expect(drift!.freshness).toBe('drifted');
    expect(drift!.verify).toBe(true);
    expect((drift as { staleRegion?: boolean }).staleRegion).toBeUndefined(); // a real change, NOT stale-region
  });

  it('labels a stale-region decision with staleRegion (honest, consistent with recall)', async () => {
    // The decision's anchored code is byte-identical; its file was only marked stale
    // by a budget-exceeded incremental update. orient must label it staleRegion, not
    // imply the code changed (fix-transitive-incremental-staleness).
    await writeDecisions([{ id: 'sr1', title: 'keep fooHandler pure', affectedFiles: ['src/foo.ts'] }]);
    const store = EdgeStore.open(EdgeStore.dbPath(await analysisDir()));
    store.markFilesStale(['src/foo.ts']);
    store.close();

    const r = (await handleOrient(root, 'work on fooHandler')) as {
      pendingDecisions?: Array<{ id: string; freshness?: string; verify?: boolean; staleRegion?: boolean }>;
      staleDecisions?: Array<{ id: string }>;
    };
    const d = r.pendingDecisions?.find((x) => x.id === 'sr1');
    expect(d).toBeDefined();          // still authoritative (not orphaned)
    expect(d!.freshness).toBe('drifted');
    expect(d!.verify).toBe(true);
    expect(d!.staleRegion).toBe(true); // the honest marker
  });

  // add-bitemporal-typed-memory-operations: contradiction surfacing at the entry tool.
  it('surfaces two authoritative notes on the same symbol as unreconciledMemories', async () => {
    // An approved decision on src/foo.ts brings the file into orient's scope (search is
    // mocked empty here); the two contradicting notes anchor to fooHandler in that file.
    await writeDecisions([{ id: 'd1', title: 'fooHandler is owned here', affectedFiles: ['src/foo.ts'] }]);
    await handleRemember(root, 'fooHandler returns the count', [{ symbol: 'fooHandler', file: 'src/foo.ts' }]);
    await handleRemember(root, 'fooHandler returns the index', [{ symbol: 'fooHandler', file: 'src/foo.ts' }]);
    const r = (await handleOrient(root, 'work on fooHandler')) as {
      unreconciledMemories?: Array<{ symbol: string; memberIds: string[] }>;
    };
    expect(r.unreconciledMemories).toBeDefined();
    expect(r.unreconciledMemories!.length).toBeGreaterThanOrEqual(1);
    expect(r.unreconciledMemories![0].memberIds.length).toBeGreaterThanOrEqual(2);
  });
});
