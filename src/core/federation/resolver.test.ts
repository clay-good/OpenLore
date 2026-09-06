/**
 * Federation resolver unit tests — cross-repo consumer resolution, producer
 * location, and cross-repo test selection over synthetic on-disk indexes.
 * (change: add-multi-repo-federation)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../services/edge-store.js';
import { OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_LLM_CONTEXT } from '../../constants.js';
import { addRepo } from './registry.js';
import {
  resolveFederationScope,
  findCrossRepoConsumers,
  findCrossRepoConsumersBatch,
  locateSymbolProducers,
  findCrossRepoTests,
} from './resolver.js';
import type { FunctionNode, CallEdge } from '../analyzer/call-graph.js';

function node(id: string, name: string, filePath: string, extra: Partial<FunctionNode> = {}): FunctionNode {
  return { id, name, filePath, isAsync: false, language: 'typescript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, ...extra };
}
function edge(callerId: string, calleeId: string, calleeName: string, confidence: CallEdge['confidence']): CallEdge {
  return { callerId, calleeId, calleeName, confidence };
}

/** Materialize a repo index: SQLite production graph + llm-context callGraph + fingerprint. */
function makeRepoIndex(
  prefix: string,
  prodNodes: FunctionNode[],
  prodEdges: CallEdge[],
  fullCallGraph: { nodes: FunctionNode[]; edges: CallEdge[] },
): string {
  const dir = mkdtempSync(join(tmpdir(), `fed-${prefix}-`));
  created.push(dir);
  const adir = join(dir, OPENLORE_ANALYSIS_REL_PATH);
  mkdirSync(adir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(adir));
  store.clearAll();
  store.insertNodes(prodNodes);
  store.insertEdges(prodEdges);
  store.close();
  const callGraph = {
    ...fullCallGraph, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: fullCallGraph.nodes.length, totalEdges: fullCallGraph.edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
  writeFileSync(join(adir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }));
  writeFileSync(join(adir, 'fingerprint.json'), JSON.stringify({ hash: `fp-${prefix}`, computedAt: '2026-06-19T00:00:00.000Z', fileCount: prodNodes.length }));
  return dir;
}

const created: string[] = [];
let producer: string; // repo A: defines greet
let consumer: string; // repo B: welcome() calls greet (external); testWelcome() tests welcome

beforeEach(() => {
  // Producer A: greet is an internal published symbol.
  const greet = node('src/index.ts::greet', 'greet', 'src/index.ts', { stableId: 'sid:greet(name: string)' });
  producer = makeRepoIndex('producer', [greet], [], { nodes: [greet], edges: [] });

  // Consumer B: welcome → greet (external), runApp → welcome, testWelcome → welcome (test).
  const welcome = node('src/app.ts::welcome', 'welcome', 'src/app.ts');
  const runApp = node('src/app.ts::runApp', 'runApp', 'src/app.ts');
  const greetExt = node('external::greet', 'greet', 'external', { isExternal: true });
  const testWelcome = node('src/app.test.ts::testWelcome', 'testWelcome', 'src/app.test.ts', { isTest: true });
  const prodEdges = [edge('src/app.ts::welcome', 'external::greet', 'greet', 'external')];
  const fullEdges = [
    edge('src/app.ts::welcome', 'external::greet', 'greet', 'external'),
    edge('src/app.ts::runApp', 'src/app.ts::welcome', 'welcome', 'same_file'),
    edge('src/app.test.ts::testWelcome', 'src/app.ts::welcome', 'welcome', 'name_only'),
  ];
  consumer = makeRepoIndex('consumer', [welcome, runApp], prodEdges, {
    nodes: [welcome, runApp, greetExt, testWelcome],
    edges: fullEdges,
  });
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

describe('resolveFederationScope', () => {
  it('is inactive unless federation is requested', () => {
    expect(resolveFederationScope(producer, {}).active).toBe(false);
    expect(resolveFederationScope(producer, { federation: false }).active).toBe(false);
  });

  it('activates with all registered repos when federation=true', () => {
    addRepo(producer, consumer, { name: 'consumer-b' });
    const scope = resolveFederationScope(producer, { federation: true });
    expect(scope.active).toBe(true);
    expect(scope.repos.map(r => r.name)).toEqual(['consumer-b']);
  });

  it('restricts to named repos and reports unknown names', () => {
    addRepo(producer, consumer, { name: 'consumer-b' });
    const scope = resolveFederationScope(producer, { federationRepos: ['consumer-b', 'ghost'] });
    expect(scope.repos.map(r => r.name)).toEqual(['consumer-b']);
    expect(scope.unknownNames).toEqual(['ghost']);
  });
});

describe('findCrossRepoConsumers', () => {
  it('resolves a published symbol to its consumer in an indexed repo', async () => {
    addRepo(producer, consumer, { name: 'consumer-b' });
    const scope = resolveFederationScope(producer, { federation: true });
    const res = await findCrossRepoConsumers(scope, 'greet');
    expect(res.consumers).toHaveLength(1);
    expect(res.consumers[0]).toMatchObject({ repo: 'consumer-b', caller: { name: 'welcome' }, symbol: 'greet' });
    expect(res.coverage.reposConsulted.map(r => r.name)).toEqual(['consumer-b']);
    expect(res.coverage.caveats.join(' ')).toMatch(/collision/i);
  });

  it('reports a stale repo as skipped, never consulted', async () => {
    addRepo(producer, consumer, { name: 'consumer-b' });
    // Drift the consumer fingerprint after registration.
    writeFileSync(join(consumer, OPENLORE_ANALYSIS_REL_PATH, 'fingerprint.json'), JSON.stringify({ hash: 'fp-changed', computedAt: 'x', fileCount: 9 }));
    const scope = resolveFederationScope(producer, { federation: true });
    const res = await findCrossRepoConsumers(scope, 'greet');
    expect(res.consumers).toHaveLength(0);
    expect(res.coverage.reposConsulted).toHaveLength(0);
    expect(res.coverage.reposSkipped[0]).toMatchObject({ name: 'consumer-b', state: 'stale' });
  });

  it('returns nothing for a symbol no one consumes', async () => {
    addRepo(producer, consumer, { name: 'consumer-b' });
    const scope = resolveFederationScope(producer, { federation: true });
    const res = await findCrossRepoConsumers(scope, 'farewell');
    expect(res.consumers).toHaveLength(0);
    expect(res.coverage.reposConsulted.map(r => r.name)).toEqual(['consumer-b']);
  });

  it('batches multiple symbols, loading each repo once', async () => {
    addRepo(producer, consumer, { name: 'consumer-b' });
    const scope = resolveFederationScope(producer, { federation: true });
    const batch = await findCrossRepoConsumersBatch(scope, ['greet', 'farewell']);
    expect(batch.bySymbol.get('greet')).toHaveLength(1);
    expect(batch.bySymbol.get('farewell')).toHaveLength(0);
  });

  // Resilience invariant: a repo whose store opens fine but throws mid-query
  // (SQLite corruption, disk error, DB locked by a concurrent analyze) must be
  // skipped with a reason — never abort the whole fleet query. A thrown federation
  // lookup would otherwise drop find_dead_code's cross-repo liveness check.
  it('skips a repo whose store throws mid-query instead of failing the query', async () => {
    addRepo(producer, consumer, { name: 'consumer-b' });
    const scope = resolveFederationScope(producer, { federation: true });
    const spy = vi.spyOn(EdgeStore.prototype, 'getExternalConsumers').mockImplementation(() => {
      throw new Error('SQLITE_CORRUPT: database disk image is malformed');
    });
    try {
      const res = await findCrossRepoConsumers(scope, 'greet');
      expect(res.consumers).toHaveLength(0);
      expect(res.coverage.reposConsulted).toHaveLength(0);
      expect(res.coverage.reposSkipped[0]).toMatchObject({ name: 'consumer-b' });
      expect(res.coverage.reposSkipped[0].reason).toMatch(/unreadable mid-query/i);
    } finally {
      spy.mockRestore();
    }
  });

  // Regression: the consumer cap bounds the returned LIST, but must never zero a
  // symbol's liveness signal. In a multi-symbol batch (the find_dead_code path),
  // an earlier symbol exhausting the shared cap must NOT leave a later, genuinely-
  // consumed symbol with an empty list — that flipped find_dead_code to a false-
  // positive "dead" (a confidently-wrong "safe to delete"). Each consumed symbol
  // keeps at least one consumer past the cap; the rest are truncated and disclosed.
  it('keeps at least one consumer per symbol when an earlier symbol exhausts the cap', async () => {
    // Consumer repo: 3 callers of farewell, 1 caller of greet.
    const callers: FunctionNode[] = [];
    const fullEdges: CallEdge[] = [];
    const prodEdges: CallEdge[] = [];
    const farewellExt = node('external::farewell', 'farewell', 'external', { isExternal: true });
    const greetExt = node('external::greet', 'greet', 'external', { isExternal: true });
    for (let i = 0; i < 3; i++) {
      const c = node(`src/f${i}.ts::useF${i}`, `useF${i}`, `src/f${i}.ts`);
      callers.push(c);
      const e = edge(c.id, 'external::farewell', 'farewell', 'external');
      prodEdges.push(e); fullEdges.push(e);
    }
    const g = node('src/g.ts::useG', 'useG', 'src/g.ts');
    callers.push(g);
    const ge = edge(g.id, 'external::greet', 'greet', 'external');
    prodEdges.push(ge); fullEdges.push(ge);
    const starve = makeRepoIndex('starve', callers, prodEdges, {
      nodes: [...callers, farewellExt, greetExt], edges: fullEdges,
    });
    addRepo(producer, starve, { name: 'consumer-starve' });
    const scope = resolveFederationScope(producer, { federation: true });
    // Cap of 2: farewell (iterated first) fills it, so without the liveness guard
    // greet's single consumer would be dropped to an empty list.
    const batch = await findCrossRepoConsumersBatch(scope, ['farewell', 'greet'], { maxConsumers: 2 });
    expect(batch.bySymbol.get('farewell')).toHaveLength(2);
    expect(batch.bySymbol.get('greet')).toHaveLength(1); // liveness preserved, not zeroed
    expect(batch.truncated).toBeGreaterThanOrEqual(1);    // the dropped farewell consumer is disclosed
  });
});

describe('locateSymbolProducers', () => {
  it('names the repo that defines a symbol, with its stable id', async () => {
    addRepo(consumer, producer, { name: 'producer-a' });
    const scope = resolveFederationScope(consumer, { federation: true });
    const res = await locateSymbolProducers(scope, 'greet');
    expect(res.producers).toHaveLength(1);
    expect(res.producers[0]).toMatchObject({ repo: 'producer-a', node: { name: 'greet', stableId: 'sid:greet(name: string)' } });
  });
});

describe('findCrossRepoTests', () => {
  it('selects a consumer-repo test that reaches a call site of the changed symbol', async () => {
    addRepo(producer, consumer, { name: 'consumer-b' });
    const scope = resolveFederationScope(producer, { federation: true });
    const res = await findCrossRepoTests(scope, ['greet']);
    expect(res.tests).toHaveLength(1);
    expect(res.tests[0]).toMatchObject({ repo: 'consumer-b', test: { name: 'testWelcome' }, viaSymbol: 'greet' });
  });

  it('selects nothing when the changed symbol has no consumer', async () => {
    addRepo(producer, consumer, { name: 'consumer-b' });
    const scope = resolveFederationScope(producer, { federation: true });
    const res = await findCrossRepoTests(scope, ['farewell']);
    expect(res.tests).toHaveLength(0);
  });

  // Regression: with several changed symbols, each selected test must be attributed
  // to the SPECIFIC symbol whose consumer reached it — not a blanket join of every
  // symbol the repo touches. The seed→symbol grouping carries the attribution.
  it('attributes each cross-repo test to the exact symbol that reached it (multi-symbol)', async () => {
    // Consumer where sayHi → greet (external, tested by testHi) and sayLo →
    // farewell (external, tested by testLo) — two independent symbol→test chains.
    const sayHi = node('src/h.ts::sayHi', 'sayHi', 'src/h.ts');
    const sayLo = node('src/l.ts::sayLo', 'sayLo', 'src/l.ts');
    const greetExt = node('external::greet', 'greet', 'external', { isExternal: true });
    const farewellExt = node('external::farewell', 'farewell', 'external', { isExternal: true });
    const testHi = node('src/h.test.ts::testHi', 'testHi', 'src/h.test.ts', { isTest: true });
    const testLo = node('src/l.test.ts::testLo', 'testLo', 'src/l.test.ts', { isTest: true });
    const prodEdges = [
      edge('src/h.ts::sayHi', 'external::greet', 'greet', 'external'),
      edge('src/l.ts::sayLo', 'external::farewell', 'farewell', 'external'),
    ];
    const multi = makeRepoIndex('multi', [sayHi, sayLo], prodEdges, {
      nodes: [sayHi, sayLo, greetExt, farewellExt, testHi, testLo],
      edges: [
        ...prodEdges,
        edge('src/h.test.ts::testHi', 'src/h.ts::sayHi', 'sayHi', 'name_only'),
        edge('src/l.test.ts::testLo', 'src/l.ts::sayLo', 'sayLo', 'name_only'),
      ],
    });
    addRepo(producer, multi, { name: 'consumer-multi' });
    const scope = resolveFederationScope(producer, { federation: true });
    const res = await findCrossRepoTests(scope, ['greet', 'farewell']);
    const byTest = Object.fromEntries(res.tests.map(t => [t.test.name, t.viaSymbol]));
    expect(byTest['testHi']).toBe('greet');
    expect(byTest['testLo']).toBe('farewell');
  });

  // directResolvedOnly must reach the cross-repo walk: a test that reaches the
  // consumer call site ONLY through a synthesized dynamic-dispatch edge is selected
  // by default but dropped under strict (directly-resolved-only) selection.
  it('honors directResolvedOnly across the repo boundary (drops synthesized-only reach)', async () => {
    const useGreet = node('src/u.ts::useGreet', 'useGreet', 'src/u.ts');
    const greetExt = node('external::greet', 'greet', 'external', { isExternal: true });
    const testSynth = node('src/u.test.ts::testSynth', 'testSynth', 'src/u.test.ts', { isTest: true });
    const synthEdge: CallEdge = {
      callerId: 'src/u.test.ts::testSynth', calleeId: 'src/u.ts::useGreet',
      calleeName: 'useGreet', confidence: 'synthesized',
    };
    const synthRepo = makeRepoIndex('synth', [useGreet], [edge('src/u.ts::useGreet', 'external::greet', 'greet', 'external')], {
      nodes: [useGreet, greetExt, testSynth],
      edges: [edge('src/u.ts::useGreet', 'external::greet', 'greet', 'external'), synthEdge],
    });
    addRepo(producer, synthRepo, { name: 'consumer-synth' });
    const scope = resolveFederationScope(producer, { federation: true });
    const loose = await findCrossRepoTests(scope, ['greet']);
    expect(loose.tests.map(t => t.test.name)).toContain('testSynth');
    const strict = await findCrossRepoTests(scope, ['greet'], { directResolvedOnly: true });
    expect(strict.tests.map(t => t.test.name)).not.toContain('testSynth');
  });

  // Regression: the real analyzer associates a test file with the production it
  // covers via an import-based `tested_by` edge — NOT a test *function* node that
  // calls the production (an inline `it(...)` block produces no callable symbol).
  // The federated walker must honor tested_by like the single-repo handler, else a
  // genuinely-tested consumer selects nothing across the repo boundary.
  it('selects a consumer test associated only by a tested_by edge (no test call node)', async () => {
    // Consumer where welcome → greet (external) and welcome is covered by a
    // tested_by edge to a test file — with no test node and no test→welcome call.
    const welcome = node('src/app.ts::welcome', 'welcome', 'src/app.ts');
    const greetExt = node('external::greet', 'greet', 'external', { isExternal: true });
    const testedByEdge: CallEdge = {
      callerId: 'src/app.ts::welcome', calleeId: 'src/app.test.ts::app.test',
      calleeName: 'app.test', confidence: 'name_only', kind: 'tested_by',
    };
    const consumerTb = makeRepoIndex('consumer-tb', [welcome], [edge('src/app.ts::welcome', 'external::greet', 'greet', 'external')], {
      nodes: [welcome, greetExt],
      edges: [edge('src/app.ts::welcome', 'external::greet', 'greet', 'external'), testedByEdge],
    });
    addRepo(producer, consumerTb, { name: 'consumer-tb' });
    const scope = resolveFederationScope(producer, { federation: true });
    const res = await findCrossRepoTests(scope, ['greet']);
    const tb = res.tests.filter(t => t.repo === 'consumer-tb');
    expect(tb).toHaveLength(1);
    expect(tb[0]).toMatchObject({ repo: 'consumer-tb', test: { name: 'app.test', file: 'src/app.test.ts' }, viaSymbol: 'greet' });
  });
});
