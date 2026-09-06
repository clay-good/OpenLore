import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CallGraphBuilder,
  serializeCallGraph,
  __getAnalyzerWorkCountersForTests,
  __resetAnalyzerWorkCountersForTests,
  dispatchFileExtract,
  grammarLoadFailed,
} from './call-graph.js';

const files = [
  {
    path: '/virtual/app.ts',
    language: 'TypeScript',
    content: `
class Base { run(): void {} }
class Child extends Base { run(): void {} }
class Service { first(): void {} second(): void {} }
export function handler(): void {}
export function setup(app: any, emitter: any): void {
  app.get('/api/items', handler);
  emitter.on('ready', handler);
  setTimeout(handler, 1);
}
export function dispatch(emitter: any): void {
  emitter.emit('ready');
  fetch('/api/items');
}
export function inferred(): void {
  const service = new Service();
  service.first();
  service.second();
}
`,
  },
];

// Captured from origin/main@3cf8a077 and updated when exact HTTP call-site offsets made
// the one-line fire() call resolvable. Keep this fixture separate from the retained late-pass
// oracle so shared helper changes cannot bless unrelated output drift.
const preChangeGoldenFiles = [
  {
    path: '/virtual/app.ts',
    language: 'TypeScript',
    content: `
class Base { run(): void {} }
class Child extends Base { run(): void {} }
class Service { first(): void {} second(): void {} }
export function handler(): void {}
export function setup(app: any, emitter: any): void {
  app.get('/api/items', handler);
  emitter.on('ready', handler);
  setTimeout(handler, 1);
}
export function inferred(): void {
  const service = new Service();
  service.first();
  service.second();
}
`,
  },
  {
    path: '/virtual/dispatch.ts',
    language: 'TypeScript',
    content: `export function fire(emitter: any): void { emitter.emit('ready'); fetch('/api/items'); }`,
  },
];

describe('Pass-1 late-fact reuse', () => {
  it('matches the complete serialized graph captured from pristine main', async () => {
    const graph = await new CallGraphBuilder().build(preChangeGoldenFiles);
    const bytes = JSON.stringify(serializeCallGraph(graph));
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('f922c97fc36b0a43759a64256bdd0c2c1810ca43d8ff3d138ebce6f6a4216f00');
    expect(bytes).toHaveLength(11412);
    expect(graph.nodes.size).toBe(12);
    expect(graph.edges).toHaveLength(11);
    expect(graph.inheritanceEdges).toHaveLength(2);
    expect([...graph.nodes.values()].find(node => node.name === 'handler')?.callArity).toEqual({
      required: 0,
      total: 0,
      variadic: false,
      variadicParameterCount: 0,
      hasOptionalOrDefault: false,
      implicitReceiverCount: 0,
    });
  });

  it('is byte-identical to the pre-optimization class and dynamic-dispatch passes', async () => {
    const legacy = await new CallGraphBuilder({ legacyLatePassesForTesting: true }).build(files);
    const optimized = await new CallGraphBuilder().build(files);

    const legacyBytes = JSON.stringify(serializeCallGraph(legacy));
    const optimizedBytes = JSON.stringify(serializeCallGraph(optimized));
    expect(optimizedBytes).toBe(legacyBytes);

    // Prevent a zero-work implementation from satisfying equality by dropping both surfaces.
    expect(optimized.inheritanceEdges.some(edge => edge.parentId.includes('Base'))).toBe(true);
    expect(optimized.edges.some(edge => edge.synthesizedBy === 'event-channel')).toBe(true);
    expect(optimized.edges.some(edge => edge.synthesizedBy === 'route-handler')).toBe(true);
    expect(optimized.edges.some(edge => edge.synthesizedBy === 'callback-registration')).toBe(true);
    expect(optimized.edges.some(edge => edge.confidence === 'http_endpoint')).toBe(true);
  });

  it('parses once, compiles each native query once, and infers once per caller', async () => {
    __resetAnalyzerWorkCountersForTests(true);
    await new CallGraphBuilder().build(files);
    const cold = __getAnalyzerWorkCountersForTests();
    // Also the no-second-parse guard for the dynamic-boundary matcher (change:
    // disclose-dynamic-boundary-regions): it walks the tree the extractor already parsed, so this
    // count must not move when the matcher records sites. See the dedicated case below.
    expect(cold.parses).toBe(1);
    expect(cold.nativeQueryCompiles).toBeGreaterThan(1);
    expect(cold.nativeQueryCompileCounts).toHaveLength(cold.nativeQueryCompiles);
    expect(cold.nativeQueryCompileCounts.every(count => count === 1)).toBe(true);
    // setup(app/emitter), dispatch(emitter), and inferred(service) each contain multiple receiver
    // edges but pay the regex inference passes once for the caller.
    expect(cold.typeInferences).toBe(3);
    const inferredGraph = await new CallGraphBuilder().build(files);
    const inferredCaller = [...inferredGraph.nodes.values()].find(node => node.name === 'inferred')?.id;
    expect(inferredGraph.edges.filter(edge =>
      edge.callerId === inferredCaller &&
      edge.confidence === 'type_inference' &&
      (edge.calleeName === 'first' || edge.calleeName === 'second'),
    ).map(edge => edge.calleeName).sort()).toEqual(['first', 'second']);

    __resetAnalyzerWorkCountersForTests();
    await new CallGraphBuilder().build(files);
    const warm = __getAnalyzerWorkCountersForTests();
    expect(warm.parses).toBe(1);
    expect(warm.nativeQueryCompiles).toBe(0);
    expect(warm.typeInferences).toBe(3);
  });

  it('reuses worker-cloneable cached late facts without parsing or changing bytes', async () => {
    const extracted = await dispatchFileExtract(files[0]);
    expect(extracted?.classRelationships?.length).toBeGreaterThan(0);
    expect(extracted?.dynamicDispatch?.events.length).toBeGreaterThan(0);
    const cloned = structuredClone(extracted);
    const cache = {
      lookup: () => ({ facts: cloned }),
      record: () => { throw new Error('cache hit unexpectedly recorded'); },
    };

    __resetAnalyzerWorkCountersForTests();
    const cached = await new CallGraphBuilder({ pass1Cache: cache }).build(files);
    expect(__getAnalyzerWorkCountersForTests().parses).toBe(0);
    const fresh = await new CallGraphBuilder().build(files);
    expect(JSON.stringify(serializeCallGraph(cached))).toBe(JSON.stringify(serializeCallGraph(fresh)));
  });

  it('is identical through the real worker-thread lane with cross-file facts', async () => {
    const pooledFiles = [
      files[0],
      {
        path: '/virtual/dispatch.ts', language: 'TypeScript',
        content: `export function fire(emitter: any): void { emitter.emit('ready'); fetch('/api/items'); }`,
      },
      {
        path: '/virtual/extra-a.ts', language: 'TypeScript',
        content: `export function extraA(): number { return 1; }`,
      },
      {
        path: '/virtual/extra-b.ts', language: 'TypeScript',
        content: `export function extraB(): number { return 2; }`,
      },
    ];
    const priorNoWorkers = process.env.OPENLORE_NO_WORKERS;
    let serial;
    let pooled;
    try {
      process.env.OPENLORE_NO_WORKERS = '1';
      serial = await new CallGraphBuilder().build(pooledFiles);
      delete process.env.OPENLORE_NO_WORKERS;
      __resetAnalyzerWorkCountersForTests();
      pooled = await new CallGraphBuilder({ extraction: { poolSize: 2 } }).build(pooledFiles);
    } finally {
      if (priorNoWorkers === undefined) delete process.env.OPENLORE_NO_WORKERS;
      else process.env.OPENLORE_NO_WORKERS = priorNoWorkers;
    }
    expect(__getAnalyzerWorkCountersForTests().parses).toBe(0);
    expect(pooled.extractionLane).toMatchObject({ lane: 'pooled', workerFallbackFiles: [], laneDefectFiles: [] });
    expect(JSON.stringify(serializeCallGraph(pooled))).toBe(JSON.stringify(serializeCallGraph(serial)));
    expect(pooled.inheritanceEdges).toContainEqual(expect.objectContaining({ kind: 'extends' }));
    expect(pooled.edges.some(edge => edge.synthesizedBy === 'event-channel')).toBe(true);
    expect(pooled.edges.some(edge => edge.synthesizedBy === 'callback-registration')).toBe(true);
  }, 30_000);

  it('does not recompile native queries when the file count grows under one grammar', async () => {
    __resetAnalyzerWorkCountersForTests(true);
    await new CallGraphBuilder().build(files);
    const oneFileCompiles = __getAnalyzerWorkCountersForTests().nativeQueryCompiles;

    __resetAnalyzerWorkCountersForTests(true);
    await new CallGraphBuilder().build([
      files[0],
      { ...files[0], path: '/virtual/app-copy.ts' },
    ]);
    expect(__getAnalyzerWorkCountersForTests().nativeQueryCompiles).toBe(oneFileCompiles);
  });

  it.each([
    ['C#', 'S.cs', `interface Shape { void Area(); } class Circle : Shape { public void Area() {} }`],
    ['Kotlin', 'S.kt', `interface Shape { fun area(): Double }\nclass Circle : Shape { override fun area(): Double { return 1.0 } }`],
    ['PHP', 'S.php', `<?php interface Shape { public function area(); } class Circle implements Shape { public function area() { return 1; } }`],
    ['Swift', 'S.swift', `class Base { func speak() -> String { return "b" } } class Derived: Base { func speak() -> String { return "d" } }`],
    ['Scala', 'S.scala', `class Base { def speak(): String = "b" }\nclass Derived extends Base { def speak(): String = "d" }`],
    ['Go', 'S.go', `package p\ntype Base struct{}\nfunc (b Base) Speak() {}\ntype Derived struct{ Base }\nfunc (d Derived) Speak() {}`],
  ])('keeps %s hierarchy bytes identical to the retained pre-change pass', async (language, path, content) => {
    const input = [{ path, language, content }];
    const legacy = await new CallGraphBuilder({ legacyLatePassesForTesting: true }).build(input);
    const optimized = await new CallGraphBuilder().build(input);
    expect(JSON.stringify(serializeCallGraph(optimized))).toBe(JSON.stringify(serializeCallGraph(legacy)));
    if (grammarLoadFailed(language)) return;
    expect(optimized.inheritanceEdges.length).toBeGreaterThan(0);
  });
});

describe('the dynamic-boundary matcher adds no parse', () => {
  it('a file dense with dynamic constructs is still parsed exactly once', async () => {
    // The matcher's whole cost claim is "no second parse". A file with none of the trigger tokens
    // never even walks; a file full of them must still parse once and only once.
    __resetAnalyzerWorkCountersForTests(true);
    const graph = await new CallGraphBuilder().build([{
      path: '/virtual/reflective.py',
      language: 'Python',
      content: [
        'import importlib',
        '',
        'def dispatch(handler, action, name):',
        '    getattr(handler, action)()',
        '    eval("1 + 1")',
        '    importlib.import_module(name)',
        '    setattr(handler, name, None)',
        '    TABLE[action]()',
        '    return handler',
      ].join('\n'),
    }]);
    expect(__getAnalyzerWorkCountersForTests().parses).toBe(1);
    // …and it really did record sites, so the assertion above is not vacuous.
    expect(graph.dynamicBoundaryByFile?.get('/virtual/reflective.py')?.sites.length)
      .toBeGreaterThan(0);
  });
});
