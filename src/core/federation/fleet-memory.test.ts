/**
 * Fleet-level anchored memory (ADR-0019) — a producer-repo memory anchored to a
 * published interface surfaces, with its producer-side freshness verdict, when an
 * agent recalls in a consumer repo. Orphaned/retired producer memories are withheld
 * (the authoritative-recall invariant across the repo boundary). Synthetic on-disk
 * indexes; deterministic; plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../services/edge-store.js';
import { OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_LLM_CONTEXT } from '../../constants.js';
import { addRepo } from './registry.js';
import { resolveFederationScope } from './resolver.js';
import { findFleetMemory } from './fleet-memory.js';
import type { FunctionNode, CallEdge } from '../analyzer/call-graph.js';

const created: string[] = [];

function node(id: string, name: string, filePath: string, extra: Partial<FunctionNode> = {}): FunctionNode {
  return { id, name, filePath, isAsync: false, language: 'typescript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, ...extra };
}
function edge(callerId: string, calleeId: string, calleeName: string, confidence: CallEdge['confidence']): CallEdge {
  return { callerId, calleeId, calleeName, confidence };
}

function makeRepoIndex(prefix: string, prodNodes: FunctionNode[], prodEdges: CallEdge[], full: { nodes: FunctionNode[]; edges: CallEdge[] }): string {
  const dir = mkdtempSync(join(tmpdir(), `fleet-${prefix}-`));
  created.push(dir);
  const adir = join(dir, OPENLORE_ANALYSIS_REL_PATH);
  mkdirSync(adir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(adir));
  store.clearAll();
  store.insertNodes(prodNodes);
  store.insertEdges(prodEdges);
  store.close();
  const callGraph = { ...full, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [], stats: { totalNodes: full.nodes.length, totalEdges: full.edges.length, avgFanIn: 0, avgFanOut: 0 } };
  writeFileSync(join(adir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }));
  writeFileSync(join(adir, 'fingerprint.json'), JSON.stringify({ hash: `fp-${prefix}`, computedAt: '2026-06-19T00:00:00.000Z', fileCount: prodNodes.length }));
  return dir;
}

/** Write a producer repo's memory notes store. */
function writeProducerMemories(dir: string, memories: Array<Record<string, unknown>>): void {
  const mdir = join(dir, '.openlore', 'memory');
  mkdirSync(mdir, { recursive: true });
  const full = memories.map((m, i) => ({ id: `pm${i}`, kind: 'note', content: 'note', anchors: [], recordedAt: '2026-01-01T00:00:00Z', ...m }));
  writeFileSync(join(mdir, 'notes.json'), JSON.stringify({ version: '1', updatedAt: '', memories: full }));
}

/** Write a producer repo's decision store. */
function writeProducerDecisions(dir: string, decisions: Array<Record<string, unknown>>): void {
  const ddir = join(dir, '.openlore', 'decisions');
  mkdirSync(ddir, { recursive: true });
  const full = decisions.map((d, i) => ({
    id: `pd${i}`, status: 'approved', title: 'decision', rationale: '', consequences: '', proposedRequirement: null,
    affectedDomains: [], affectedFiles: [], anchors: [], sessionId: 's', recordedAt: '2026-01-01T00:00:00Z',
    confidence: 'medium', syncedToSpecs: [], ...d,
  }));
  writeFileSync(join(ddir, 'pending.json'), JSON.stringify({ version: '1', sessionId: 's', updatedAt: '', decisions: full }));
}

let producer: string; // repo A — publishes greet
let consumer: string; // repo B — welcome() calls greet (external)

beforeEach(() => {
  const greet = node('src/index.ts::greet', 'greet', 'src/index.ts', { stableId: 'sid:greet(name: string)' });
  producer = makeRepoIndex('producer', [greet], [], { nodes: [greet], edges: [] });
  // Producer's source file exists, so a file-level anchor to it verdicts `fresh`
  // (file present + no baseline hash); an anchor to a missing file verdicts `orphaned`.
  mkdirSync(join(producer, 'src'), { recursive: true });
  writeFileSync(join(producer, 'src', 'index.ts'), 'export function greet(name){ return name; }\n');

  const welcome = node('src/app.ts::welcome', 'welcome', 'src/app.ts');
  const greetExt = node('external::greet', 'greet', 'external', { isExternal: true });
  const prodEdges = [edge('src/app.ts::welcome', 'external::greet', 'greet', 'external')];
  consumer = makeRepoIndex('consumer', [welcome], prodEdges, { nodes: [welcome, greetExt], edges: prodEdges });
});

afterEach(() => {
  for (const d of created.splice(0)) {
    // Windows refuses to delete a directory while any handle inside it is open, and these
    // fixtures hold call-graph.db — the store is closed by the code under test, but the
    // SQLite -shm/-wal siblings and the handle itself clear a beat later. A plain rmSync
    // raced that and every test failed in TEARDOWN with EPERM naming a temp path, which
    // reads as unrelated to the behaviour asserted. Deletion is not what any test here
    // checks, so retry briefly and then leave it to the OS.
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(d, { recursive: true, force: true }); break; }
      catch { /* handle still open; the next pass usually wins */ }
    }
  }
});

describe('edge-store.getExternalReferenceNames', () => {
  it('returns the distinct external callees of a repo (the interfaces it consumes)', async () => {
    const { readCachedContext } = await import('../services/mcp-handlers/utils.js');
    const ctx = await readCachedContext(consumer);
    expect(ctx?.edgeStore?.getExternalReferenceNames()).toEqual(['greet']);
  });
});

describe('findFleetMemory', () => {
  it('surfaces a fresh producer memory anchored to an interface the consumer references', async () => {
    writeProducerMemories(producer, [
      { id: 'pmFresh', content: 'greet must be called with a non-empty name', anchors: [{ symbolName: 'greet', filePath: 'src/index.ts' }] },
    ]);
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    const res = await findFleetMemory(consumer, scope);
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0]).toMatchObject({ repo: 'producer-a', symbol: 'greet', content: 'greet must be called with a non-empty name', freshness: 'fresh' });
    expect(res.coverage.reposConsulted.map((r) => r.name)).toEqual(['producer-a']);
  });

  it('withholds an orphaned producer memory (anchor file gone in producer)', async () => {
    writeProducerMemories(producer, [
      { id: 'pmOrphan', content: 'about a deleted producer symbol', anchors: [{ symbolName: 'greet', filePath: 'src/deleted.ts' }] },
    ]);
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    const res = await findFleetMemory(consumer, scope);
    expect(res.memories).toHaveLength(0);                  // orphaned ⇒ withheld
    expect(res.coverage.reposConsulted.map((r) => r.name)).toEqual(['producer-a']); // repo still consulted
  });

  it('excludes a retired (invalidated) producer memory', async () => {
    writeProducerMemories(producer, [
      { id: 'pmRetired', content: 'an old reverted constraint', anchors: [{ symbolName: 'greet', filePath: 'src/index.ts' }], invalidatedAt: '2026-02-02T00:00:00Z' },
    ]);
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    expect((await findFleetMemory(consumer, scope)).memories).toHaveLength(0);
  });

  it('does not surface a producer memory about an interface the consumer never references', async () => {
    writeProducerMemories(producer, [
      { id: 'pmInternal', content: 'about an internal-only producer symbol', anchors: [{ symbolName: 'internalHelper', filePath: 'src/index.ts' }] },
    ]);
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    expect((await findFleetMemory(consumer, scope)).memories).toHaveLength(0);
  });

  it('caps the result and reports truncation (no silent drop)', async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ id: `pm${i}`, content: `constraint ${i}`, anchors: [{ symbolName: 'greet', filePath: 'src/index.ts' }] }));
    writeProducerMemories(producer, many);
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    const res = await findFleetMemory(consumer, scope, { maxMemories: 2 });
    expect(res.memories).toHaveLength(2);
    expect(res.truncated).toBe(2);
  });

  // Symbol-level freshness across the boundary: the prior cases all used file-level
  // anchors (no contentHash ⇒ always `fresh`), so the nodeHash comparison branch — and
  // `drifted` — went untested. Here a matching span hash verdicts `fresh`, a stale one
  // `drifted`, both computed against the PRODUCER's graph.
  it('verdicts a symbol-level producer memory fresh on a matching span hash and drifted on a stale one', async () => {
    const { makeFreshnessView } = await import('../decisions/anchor-adapter.js');
    const pstore = EdgeStore.open(EdgeStore.dbPath(join(producer, OPENLORE_ANALYSIS_REL_PATH)));
    const liveHash = makeFreshnessView(pstore, producer).nodeHash('src/index.ts::greet');
    pstore.close();
    expect(liveHash, 'producer greet node hashes from its current source span').toBeTruthy();
    writeProducerMemories(producer, [
      { id: 'pmFreshSym', content: 'greet matches its current span', anchors: [{ nodeId: 'src/index.ts::greet', symbolName: 'greet', filePath: 'src/index.ts', contentHash: liveHash }] },
      { id: 'pmDriftSym', content: 'greet body has since changed', anchors: [{ nodeId: 'src/index.ts::greet', symbolName: 'greet', filePath: 'src/index.ts', contentHash: 'deadbeefdeadbeef' }] },
    ]);
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    const res = await findFleetMemory(consumer, scope);
    expect(res.memories.find((m) => m.content.includes('current span'))?.freshness).toBe('fresh');
    expect(res.memories.find((m) => m.content.includes('since changed'))?.freshness).toBe('drifted');
  });

  // Matching is by exact symbol NAME at the consumer's external call sites; arity/overload
  // cannot be confirmed across the boundary, so a producer memory on any `greet` surfaces
  // and that limitation is disclosed as a caveat (never silently presented as exact).
  it('matches by symbol name only and discloses the unconfirmed-arity caveat', async () => {
    writeProducerMemories(producer, [
      { id: 'pmName', content: 'greet trims its argument', anchors: [{ symbolName: 'greet', filePath: 'src/index.ts' }] },
    ]);
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    const res = await findFleetMemory(consumer, scope);
    expect(res.memories).toHaveLength(1);                       // surfaced purely by name match
    expect(res.coverage.caveats.some((c) => /arity\/overload is unconfirmed/.test(c))).toBe(true);
  });

  // ── Decision side (ADR-0019 follow-up) ──────────────────────────────────────
  it('surfaces a fresh producer DECISION anchored to a consumed interface', async () => {
    writeProducerDecisions(producer, [
      { id: 'pdFresh', status: 'approved', title: 'greet is the only public entry point', anchors: [{ symbolName: 'greet', filePath: 'src/index.ts' }] },
    ]);
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    const res = await findFleetMemory(consumer, scope);
    expect(res.decisions).toHaveLength(1);
    expect(res.decisions[0]).toMatchObject({ repo: 'producer-a', symbol: 'greet', title: 'greet is the only public entry point', status: 'approved', freshness: 'fresh' });
  });

  it('withholds an orphaned producer decision and excludes an inactive (rejected) one', async () => {
    writeProducerDecisions(producer, [
      { id: 'pdOrphan', status: 'approved', title: 'about a deleted symbol', anchors: [{ symbolName: 'greet', filePath: 'src/deleted.ts' }] },
      { id: 'pdRejected', status: 'rejected', title: 'a rejected idea', anchors: [{ symbolName: 'greet', filePath: 'src/index.ts' }] },
    ]);
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    const res = await findFleetMemory(consumer, scope);
    expect(res.decisions).toHaveLength(0);                  // orphaned withheld, rejected excluded
    expect(res.coverage.reposConsulted.map((r) => r.name)).toEqual(['producer-a']);
  });

  it('does not surface a producer decision about an interface the consumer never references', async () => {
    writeProducerDecisions(producer, [
      { id: 'pdInternal', status: 'approved', title: 'internal-only', anchors: [{ symbolName: 'internalHelper', filePath: 'src/index.ts' }] },
    ]);
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    expect((await findFleetMemory(consumer, scope)).decisions).toHaveLength(0);
  });
});
