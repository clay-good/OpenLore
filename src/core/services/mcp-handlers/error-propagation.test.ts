/**
 * Tests for the `analyze_error_propagation` handler (change: add-error-propagation-graph).
 *
 * Drives the handler over a hand-written analysis cache (llm-context.json) with a
 * small multi-function call graph, so the test is deterministic and offline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { handleAnalyzeErrorPropagation } from './error-propagation.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT, ARTIFACT_DYNAMIC_BOUNDARY } from '../../../constants.js';
import { __resetDynamicBoundaryMemo } from './dynamic-boundary-disclosure.js';

const HELPER = `function helper() {\n  throw new TypeError("boom");\n}\n`;
const CALLER = `function caller() {\n  helper();\n}\n`;
const GUARDED = `function guarded() {\n  try {\n    helper();\n  } catch (e) {\n    return;\n  }\n}\n`;
const EXTCALLER = `function extCaller() {\n  fetch();\n}\n`;
const GOFN = `package p\nfunc goFn() error {\n  return errors.New("boom")\n}\n`;
const AMBIGCALLER = `function ambigCaller() {\n  run();\n}\n`;

interface Node {
  id: string;
  name: string;
  filePath: string;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  language: string;
  isExternal?: boolean;
  isTest?: boolean;
}

function node(id: string, name: string, filePath: string, body: string, language = 'TypeScript'): Node {
  return { id, name, filePath, startIndex: 0, endIndex: body.length, startLine: 1, endLine: body.split('\n').length, language };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'errprop-'));
  writeFileSync(join(dir, 'helper.ts'), HELPER, 'utf-8');
  writeFileSync(join(dir, 'caller.ts'), CALLER, 'utf-8');
  writeFileSync(join(dir, 'guarded.ts'), GUARDED, 'utf-8');
  writeFileSync(join(dir, 'extcaller.ts'), EXTCALLER, 'utf-8');
  writeFileSync(join(dir, 'gofn.go'), GOFN, 'utf-8');
  writeFileSync(join(dir, 'ambigcaller.ts'), AMBIGCALLER, 'utf-8');

  const nodes: Node[] = [
    node('helper', 'helper', 'helper.ts', HELPER),
    node('caller', 'caller', 'caller.ts', CALLER),
    node('guarded', 'guarded', 'guarded.ts', GUARDED),
    node('extCaller', 'extCaller', 'extcaller.ts', EXTCALLER),
    { ...node('goFn', 'goFn', 'gofn.go', GOFN, 'Go'), startIndex: GOFN.indexOf('func'), endIndex: GOFN.lastIndexOf('}') + 1 },
    node('ambigCaller', 'ambigCaller', 'ambigcaller.ts', AMBIGCALLER),
    { id: 'fetchExt', name: 'fetch', filePath: 'lib.ts', startIndex: 0, endIndex: 0, startLine: 0, endLine: 0, language: 'TypeScript', isExternal: true },
  ];
  const edges = [
    { callerId: 'caller', calleeId: 'helper', calleeName: 'helper', line: 2, confidence: 'import' },
    { callerId: 'guarded', calleeId: 'helper', calleeName: 'helper', line: 3, confidence: 'import' },
    { callerId: 'extCaller', calleeId: 'fetchExt', calleeName: 'fetch', line: 2, confidence: 'external' },
  ];
  // An unresolved-ambiguous call site at ambigCaller (change: harden-call-resolution-ambiguity):
  // `run()` matched two definitions, so no edge was bound.
  const ambiguousSites = [
    { callerId: 'ambigCaller', calleeName: 'run', line: 2, strategy: 'name_only', candidateIds: ['a.ts::run', 'b.ts::run'], candidateCount: 2 },
  ];

  const analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  mkdirSync(analysisDir, { recursive: true });
  writeFileSync(join(analysisDir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes, edges, ambiguousSites } }), 'utf-8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Result {
  query: { symbol: string };
  unsupported?: boolean;
  error?: string;
  candidates?: string[];
  summary: { escapes: number; direct: number; propagated: number; handledInternally: number; unresolvedSelfCalls: number; ambiguousCallSites: number };
  escapes: Array<{ type: string; kind: string; originFunction: string; path: string[] }>;
  handledInternally: Array<{ type: string; caughtIn: string; fromCallee: string }>;
  boundaries: string[];
  dynamicBoundaries?: { kind: string; count: number; sites?: Array<{ file: string; line: number; kind: string }>; detail: string };
  externalCalleesNotAnalyzed?: { count: number; sample: string[] };
  unresolvedSelfCalls?: { count: number; sample: string[] };
  ambiguousCallSites?: { count: number; sample: string[] };
}

describe('handleAnalyzeErrorPropagation', () => {
  it('reports a direct throw escaping the throwing function', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'helper' })) as Result;
    expect(res.summary.escapes).toBe(1);
    expect(res.escapes[0]).toMatchObject({ type: 'TypeError', kind: 'direct', originFunction: 'helper::helper.ts' });
  });

  it('propagates a callee exception through an un-guarded caller, with the call path', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'caller' })) as Result;
    expect(res.summary.escapes).toBe(1);
    const e = res.escapes[0];
    expect(e).toMatchObject({ type: 'TypeError', kind: 'propagated', originFunction: 'helper::helper.ts' });
    expect(e.path).toEqual(['caller::caller.ts', 'helper::helper.ts']);
  });

  it('reports an exception caught at the caller as handledInternally, not escaping', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'guarded' })) as Result;
    expect(res.summary.escapes).toBe(0);
    expect(res.summary.handledInternally).toBe(1);
    expect(res.handledInternally[0]).toMatchObject({
      type: 'TypeError',
      caughtIn: 'guarded::guarded.ts',
      fromCallee: 'helper::helper.ts',
    });
  });

  it('discloses an external callee as a boundary, never assumed exception-free', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'extCaller' })) as Result;
    expect(res.summary.escapes).toBe(0);
    expect(res.externalCalleesNotAnalyzed?.count).toBe(1);
    expect(res.externalCalleesNotAnalyzed?.sample).toContain('fetch');
    expect(res.boundaries.some(b => /external\/unresolved callee/.test(b))).toBe(true);
  });

  it('returns Go value-flow output without exception-shaped fields or wording', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'goFn' })) as {
      errorModel: string; escapes: Array<Record<string, unknown>>; note: string;
    };
    expect(res.errorModel).toBe('go-value');
    expect(res.escapes).toEqual([expect.objectContaining({ value: 'error', kind: 'returned_error' })]);
    expect(res.escapes[0]).not.toHaveProperty('type');
    expect(res.note).not.toMatch(/exception|throw|caught/i);
  });

  it('returns an explicit not-found (with candidates) for an unknown symbol', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'help' })) as Result;
    expect(res.error).toMatch(/No indexed function/);
    expect(res.candidates).toContain('helper');
  });

  it('does not parse a traversal node outside the project root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'errprop-outside-'));
    try {
      const secretType = 'OutsideTraversalSecretError';
      const source = `function leakTraversal() { throw new ${secretType}(); }\n`;
      const secretPath = join(outside, 'secret.ts');
      writeFileSync(secretPath, source, 'utf-8');
      writeCache(dir, [node('poison-traversal', 'leakTraversal', relative(dir, secretPath), source)], []);

      const res = await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'leakTraversal' });
      expect(res).toMatchObject({ error: expect.stringMatching(/No indexed function/) });
      expect(JSON.stringify(res)).not.toContain(secretType);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('does not parse an in-root symlink that escapes the project root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'errprop-link-outside-'));
    try {
      const secretType = 'OutsideSymlinkSecretError';
      const source = `function leakSymlink() { throw new ${secretType}(); }\n`;
      const secretPath = join(outside, 'secret.ts');
      writeFileSync(secretPath, source, 'utf-8');
      symlinkSync(secretPath, join(dir, 'linked.ts'));
      writeCache(dir, [node('poison-link', 'leakSymlink', 'linked.ts', source)], []);

      const res = await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'leakSymlink' });
      expect(res).toMatchObject({ error: expect.stringMatching(/No indexed function/) });
      expect(JSON.stringify(res)).not.toContain(secretType);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('discloses an unresolved-ambiguous call site as a boundary, never assumed exception-free', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'ambigCaller' })) as Result;
    // The ambiguous call `run()` was not bound, so no escape is claimed — but the
    // uncertainty is disclosed, not silently treated as exception-free.
    expect(res.summary.ambiguousCallSites).toBe(1);
    expect(res.ambiguousCallSites?.count).toBe(1);
    expect(res.ambiguousCallSites?.sample.some(s => /run/.test(s))).toBe(true);
    expect(res.boundaries.some(b => /unresolved-ambiguous call site/.test(b))).toBe(true);
  });

  it('errors cleanly when no analysis exists', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'errprop-empty-'));
    const res = (await handleAnalyzeErrorPropagation({ directory: empty, symbol: 'x' })) as Result;
    expect(res.error).toMatch(/No analysis found/);
    rmSync(empty, { recursive: true, force: true });
  });

  it('is deterministic across runs', async () => {
    const a = await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'caller' });
    const b = await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'caller' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('chooses the lexicographically smaller equal-length path regardless of edge order', async () => {
    const sources = {
      q: 'function q() { a(); b(); }\n',
      a: 'function a() { leaf(); }\n',
      b: 'function b() { leaf(); }\n',
      leaf: 'function leaf() { throw new Boom(); }\n',
    };
    for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, `${name}.ts`), source);
    const nodes = Object.entries(sources).map(([name, source]) => node(name, name, `${name}.ts`, source));
    const qa = { callerId: 'q', calleeId: 'a', calleeName: 'a', line: 1, confidence: 'same_file' };
    const qb = { callerId: 'q', calleeId: 'b', calleeName: 'b', line: 1, confidence: 'same_file' };
    const al = { callerId: 'a', calleeId: 'leaf', calleeName: 'leaf', line: 1, confidence: 'same_file' };
    const bl = { callerId: 'b', calleeId: 'leaf', calleeName: 'leaf', line: 1, confidence: 'same_file' };

    writeCache(dir, nodes, [qb, bl, qa, al]);
    const reversed = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'q' })) as Result;
    writeCache(dir, nodes, [qa, al, qb, bl]);
    const forward = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'q' })) as Result;

    expect(reversed.escapes[0].path).toEqual(['q::q.ts', 'a::a.ts', 'leaf::leaf.ts']);
    expect(forward.escapes).toEqual(reversed.escapes);
  });

  // Writes 801 real source files to disk twice and parses them; on Windows the
  // filesystem + per-file overhead blows past the hook timeout by minutes. It's a
  // traversal-budget determinism guard, exercised on the Linux CI job.
  it.skipIf(process.platform === 'win32')('applies traversal budgets in stable edge order', async () => {
    const count = 801;
    const querySource = `function budgeted() { ${Array.from({ length: count }, (_, i) => `leaf${i}();`).join(' ')} }\n`;
    writeFileSync(join(dir, 'budgeted.ts'), querySource);
    const nodes: Node[] = [node('budgeted', 'budgeted', 'budgeted.ts', querySource)];
    const edges: Array<Record<string, unknown>> = [];
    for (let i = 0; i < count; i++) {
      const source = `function leaf${i}() { throw new E${i}(); }\n`;
      const file = `leaf${i}.ts`;
      writeFileSync(join(dir, file), source);
      nodes.push(node(`leaf${i}`, `leaf${i}`, file, source));
      edges.push({ callerId: 'budgeted', calleeId: `leaf${i}`, calleeName: `leaf${i}`, line: 1, confidence: 'import' });
    }

    writeCache(dir, nodes, edges);
    const forward = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'budgeted' })) as Result;
    writeCache(dir, nodes, [...edges].reverse());
    const reversed = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'budgeted' })) as Result;

    expect(forward.boundaries.some(boundary => /analysis bounded/.test(boundary))).toBe(true);
    expect(reversed.escapes).toEqual(forward.escapes);
    expect(reversed.boundaries).toEqual(forward.boundaries);
  });

  it('retains distinct recovered Go callees regardless of edge order', async () => {
    const sources = {
      q: 'package p\nfunc q(){ defer func(){ recover() }(); a(); b() }',
      a: 'package p\nfunc a(){ panic("x") }',
      b: 'package p\nfunc b(){ panic("x") }',
    };
    const nodes = Object.entries(sources).map(([name, source]) => {
      writeFileSync(join(dir, `${name}.go`), source);
      return {
        ...node(name, name, `${name}.go`, source, 'Go'),
        startIndex: source.indexOf(`func ${name}`),
      };
    });
    const qa = { callerId: 'q', calleeId: 'a', calleeName: 'a', line: 2, confidence: 'same_file' };
    const qb = { callerId: 'q', calleeId: 'b', calleeName: 'b', line: 2, confidence: 'same_file' };

    writeCache(dir, nodes, [qb, qa]);
    const reversed = await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'q' }) as {
      handledInternally: Array<{ fromCallee?: string }>;
    };
    writeCache(dir, nodes, [qa, qb]);
    const forward = await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'q' }) as {
      handledInternally: Array<{ fromCallee?: string }>;
    };

    expect(forward.handledInternally.map(item => item.fromCallee)).toEqual(['a::a.go', 'b::b.go']);
    expect(reversed.handledInternally).toEqual(forward.handledInternally);
  });

  it('discloses malformed current source instead of returning recovered parser facts', async () => {
    writeFileSync(join(dir, 'helper.ts'), `function helper() { throw new TypeError("boom");`, 'utf-8');
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'helper' })) as Result;
    expect(res.escapes).toEqual([]);
    expect(res.boundaries.some(b => /syntax errors/.test(b))).toBe(true);
  });

  it('discloses and skips a source file above the per-file byte budget', async () => {
    const source = `function huge() { /*${'x'.repeat(4 * 1024 * 1024)}*/ throw new HiddenError(); }\n`;
    writeFileSync(join(dir, 'huge.ts'), source);
    writeCache(dir, [node('huge', 'huge', 'huge.ts', source)], []);

    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'huge' })) as Result;

    expect(res.escapes).toEqual([]);
    expect(res.boundaries.some(boundary => /per-file byte budget/.test(boundary))).toBe(true);
    expect(JSON.stringify(res)).not.toContain('HiddenError');
  });

  it('rejects a stale range that crosses into a sibling function', async () => {
    const oldSource = `class C { void f(){ risky(); risky(); risky(); } void g(){ throw new Boom(); } }`;
    const currentSource = `class C { void f(){} void g(){ throw new Boom(); } }`;
    writeFileSync(join(dir, 'stale.java'), currentSource, 'utf-8');
    const startIndex = oldSource.indexOf('void f');
    const endIndex = oldSource.indexOf(' void g');
    writeCache(dir, [{
      ...node('f', 'f', 'stale.java', oldSource, 'Java'), startIndex, endIndex,
    }], []);

    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'f' })) as Result;
    expect(res.escapes).toEqual([]);
    expect(res.boundaries.some(b => /span is stale/.test(b))).toBe(true);
    expect(JSON.stringify(res)).not.toContain('Boom');
  });

  it('fails soft before recursively resolving a hostile deep function span', async () => {
    const depth = 600;
    const source = `package p\nfunc deep() error {\n${'{\n'.repeat(depth)}return nil\n${'}\n'.repeat(depth + 1)}`;
    writeFileSync(join(dir, 'deep.go'), source, 'utf-8');
    writeCache(dir, [{
      ...node('deep', 'deep', 'deep.go', source, 'Go'),
      startIndex: source.indexOf('func'), endIndex: source.lastIndexOf('}') + 1,
    }], []);

    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'deep' })) as Result;
    expect(res.escapes).toEqual([]);
    expect(res.boundaries.some(b => /AST traversal budget exceeded/.test(b))).toBe(true);
  });
});

// ── Adversarial regressions for the review findings ─────────────────────────

function writeCache(d: string, nodes: Node[], edges: unknown[]): void {
  const analysisDir = join(d, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  mkdirSync(analysisDir, { recursive: true });
  writeFileSync(join(analysisDir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes, edges } }), 'utf-8');
}

describe('handleAnalyzeErrorPropagation — memo poisoning under depth truncation (review H1)', () => {
  let d: string;
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'errprop-memo-'));
    // Deep chain q→a→b→c→d AND a shallow shortcut q→c. d throws. With maxDepth=3 the
    // deep visit reaches c at depth 3 and truncates its call to d (depth 4); c must
    // NOT be memoized as empty, so the shallow q→c→d path still finds the escape.
    const Q = `function q() {\n  a();\n  c();\n}\n`;
    const A = `function a() {\n  b();\n}\n`;
    const B = `function b() {\n  c();\n}\n`;
    const C = `function c() {\n  d();\n}\n`;
    const D = `function d() {\n  throw new TypeError("deep");\n}\n`;
    writeFileSync(join(d, 'q.ts'), Q, 'utf-8');
    writeFileSync(join(d, 'a.ts'), A, 'utf-8');
    writeFileSync(join(d, 'b.ts'), B, 'utf-8');
    writeFileSync(join(d, 'c.ts'), C, 'utf-8');
    writeFileSync(join(d, 'd.ts'), D, 'utf-8');
    const nodes: Node[] = [
      node('q', 'q', 'q.ts', Q),
      node('a', 'a', 'a.ts', A),
      node('b', 'b', 'b.ts', B),
      node('c', 'c', 'c.ts', C),
      node('d', 'd', 'd.ts', D),
    ];
    const edges = [
      { callerId: 'q', calleeId: 'a', calleeName: 'a', line: 2, confidence: 'import' }, // deep first
      { callerId: 'a', calleeId: 'b', calleeName: 'b', line: 2, confidence: 'import' },
      { callerId: 'b', calleeId: 'c', calleeName: 'c', line: 2, confidence: 'import' },
      { callerId: 'c', calleeId: 'd', calleeName: 'd', line: 2, confidence: 'import' },
      { callerId: 'q', calleeId: 'c', calleeName: 'c', line: 3, confidence: 'import' }, // shallow shortcut
    ];
    writeCache(d, nodes, edges);
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('a shallow path still finds an escape that a deep path truncated (no stale memo)', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: d, symbol: 'q', maxDepth: 3 })) as Result;
    // q→c→d is within depth 3; TypeError must surface despite the deep q→a→b→c→d truncation.
    expect(res.escapes.some(e => e.type === 'TypeError')).toBe(true);
  });
});

describe('handleAnalyzeErrorPropagation — nested call-site guard + test-callee exclusion', () => {
  let d: string;
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'errprop-nest-'));
    // Python: risky() is called inside an inner `except KeyError` try wrapped by an outer
    // `except Exception` catch-all. A ValueError from risky is caught by the outer guard.
    const CALLER = `def caller():\n    try:\n        try:\n            risky()\n        except KeyError:\n            pass\n    except Exception:\n        pass\n`;
    const RISKY = `def risky():\n    raise ValueError("x")\n`;
    // Production fn calling a test-only fn that throws.
    const PROD = `function prod() {\n  helperTest();\n}\n`;
    const HELPERTEST = `function helperTest() {\n  throw new TypeError("t");\n}\n`;
    writeFileSync(join(d, 'caller.py'), CALLER, 'utf-8');
    writeFileSync(join(d, 'risky.py'), RISKY, 'utf-8');
    writeFileSync(join(d, 'prod.ts'), PROD, 'utf-8');
    writeFileSync(join(d, 'helper.test.ts'), HELPERTEST, 'utf-8');
    const nodes: Node[] = [
      node('caller', 'caller', 'caller.py', CALLER, 'Python'),
      node('risky', 'risky', 'risky.py', RISKY, 'Python'),
      node('prod', 'prod', 'prod.ts', PROD),
      { ...node('helperTest', 'helperTest', 'helper.test.ts', HELPERTEST), isTest: true } as Node,
    ];
    const edges = [
      { callerId: 'caller', calleeId: 'risky', calleeName: 'risky', line: 4, confidence: 'import' },
      { callerId: 'prod', calleeId: 'helperTest', calleeName: 'helperTest', line: 2, confidence: 'import' },
    ];
    writeCache(d, nodes, edges);
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('an outer catch-all catches a ValueError the inner typed except misses (handled, not escaping)', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: d, symbol: 'caller' })) as Result;
    expect(res.summary.escapes).toBe(0);
    expect(res.summary.handledInternally).toBe(1);
    expect(res.handledInternally[0]).toMatchObject({ type: 'ValueError', caughtIn: 'caller::caller.py' });
  });

  it('excludes a test-only callee from the production escape set, disclosed in boundaries', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: d, symbol: 'prod' })) as Result;
    expect(res.summary.escapes).toBe(0);
    expect(res.boundaries.some(b => /test-only callee/.test(b))).toBe(true);
  });
});

describe('handleAnalyzeErrorPropagation — unresolved intra-object call disclosure (review S2)', () => {
  let d: string;
  // A `this.method()` call the call graph resolves to NO edge (neither a resolved
  // method edge nor an `external::` edge) is the one call shape that would otherwise
  // be silently assumed exception-free. It must be DISCLOSED, never dropped.
  const CALLER = `class K {\n  caller() {\n    this.callee();\n  }\n}\n`;
  const CALLEE = `class K {\n  callee() {\n    throw new TypeError("boom");\n  }\n}\n`;
  const OKCALLER = `class K {\n  okCaller() {\n    this.callee();\n  }\n}\n`;

  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'errprop-self-'));
    writeFileSync(join(d, 'caller.ts'), CALLER, 'utf-8');
    writeFileSync(join(d, 'callee.ts'), CALLEE, 'utf-8');
    writeFileSync(join(d, 'okcaller.ts'), OKCALLER, 'utf-8');
    const nodes: Node[] = [
      node('caller', 'caller', 'caller.ts', CALLER),
      node('callee', 'callee', 'callee.ts', CALLEE),
      node('okCaller', 'okCaller', 'okcaller.ts', OKCALLER),
    ];
    // `caller` has NO edge for its this.callee() (the resolution gap). `okCaller`
    // DOES have a resolved edge for its this.callee() at the matching line.
    const edges = [
      { callerId: 'okCaller', calleeId: 'callee', calleeName: 'callee', line: 3, confidence: 'type_inference' },
    ];
    writeCache(d, nodes, edges);
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('discloses an unresolved this.method() call site instead of silently claiming exception-free', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: d, symbol: 'caller' })) as Result;
    expect(res.summary.escapes).toBe(0);
    expect(res.summary.unresolvedSelfCalls).toBe(1);
    expect(res.unresolvedSelfCalls?.count).toBe(1);
    expect(res.unresolvedSelfCalls?.sample.some(s => /caller::caller\.ts:3 \(callee\)/.test(s))).toBe(true);
    expect(res.boundaries.some(b => /intra-object call site/.test(b))).toBe(true);
  });

  it('does NOT disclose a this.method() call site that the call graph resolved', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: d, symbol: 'okCaller' })) as Result;
    // okCaller→callee resolves; callee throws TypeError, so it escapes (analyzed),
    // and there is NO unresolved-self-call disclosure.
    expect(res.summary.unresolvedSelfCalls).toBe(0);
    expect(res.unresolvedSelfCalls).toBeUndefined();
    expect(res.escapes.some(e => e.type === 'TypeError')).toBe(true);
  });
});

describe('handleAnalyzeErrorPropagation — Go propagation and recovery', () => {
  let d: string;
  const G = `package p\nfunc g() error { return errors.New("x") }\n`;
  const CALL = `package p\nfunc caller() error { return g() }\n`;
  const BOOM = `package p\nfunc boom() { panic("x") }\n`;
  const RECOVER = `package p\nfunc recoverer() { defer func(){ recover() }(); boom() }\n`;
  const LOOKUP = `package p\ntype T struct{}\nfunc lookup() *T { return nil }\n`;
  const PTR = `package p\nfunc pointerCheck() { p := lookup(); if p != nil { use(p) } }\n`;
  const MIXED = `package p\nfunc mixed() error {\n  err := g()\n  if err != nil { log.Print(err) }\n  err = g()\n  if err != nil { return err }\n  return nil\n}\n`;
  const BODY_CALLER = `package p\nfunc bodyCaller() { missing() }\n`;
  const TEST_CALLER = `package p\nfunc testCaller() { testErr() }\n`;
  const TEST_ERR = `package p\nfunc testErr() error { return errors.New("x") }\n`;
  const SAME_LINE = `package p\nfunc sameLine() error { err := g(); if err != nil { log.Print(err) }; err = g(); if err != nil { return err }; return nil }\n`;
  const PAIR = `package p\nfunc pair() (int, error) { return 1, errors.New("x") }\n`;
  const DISCARD_VALUE = `package p\nfunc discardValue() { _, err := pair(); if err != nil { log.Print(err) } }\n`;
  const DISCARD_ERROR = `package p\nfunc discardError() { value, _ := pair(); use(value) }\n`;
  const CHECK_THEN_RETURN = `package p\nfunc checkThenReturn() error { err := g(); if err != nil { log.Print(err) }; return err }\n`;
  const goNode = (id: string, name: string, filePath: string, source: string): Node => ({
    ...node(id, name, filePath, source, 'Go'),
    startIndex: source.indexOf('func'),
    endIndex: source.lastIndexOf('}') + 1,
  });
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'errprop-go-'));
    for (const [file, source] of [['g.go', G], ['caller.go', CALL], ['boom.go', BOOM], ['recover.go', RECOVER], ['lookup.go', LOOKUP], ['ptr.go', PTR], ['mixed.go', MIXED], ['body.go', BODY_CALLER], ['testcaller.go', TEST_CALLER], ['helper_test.go', TEST_ERR], ['same.go', SAME_LINE], ['pair.go', PAIR], ['discard-value.go', DISCARD_VALUE], ['discard-error.go', DISCARD_ERROR], ['check-return.go', CHECK_THEN_RETURN]] as const) writeFileSync(join(d, file), source);
    writeCache(d, [goNode('g', 'g', 'g.go', G), goNode('caller', 'caller', 'caller.go', CALL), goNode('boom', 'boom', 'boom.go', BOOM), goNode('recoverer', 'recoverer', 'recover.go', RECOVER), goNode('lookup', 'lookup', 'lookup.go', LOOKUP), goNode('pointerCheck', 'pointerCheck', 'ptr.go', PTR), goNode('mixed', 'mixed', 'mixed.go', MIXED), goNode('bodyCaller', 'bodyCaller', 'body.go', BODY_CALLER), { ...goNode('testCaller', 'testCaller', 'testcaller.go', TEST_CALLER) }, { ...goNode('testErr', 'testErr', 'helper_test.go', TEST_ERR), isTest: true }, goNode('sameLine', 'sameLine', 'same.go', SAME_LINE), goNode('pair', 'pair', 'pair.go', PAIR), goNode('discardValue', 'discardValue', 'discard-value.go', DISCARD_VALUE), goNode('discardError', 'discardError', 'discard-error.go', DISCARD_ERROR), goNode('checkThenReturn', 'checkThenReturn', 'check-return.go', CHECK_THEN_RETURN), { ...node('missing', 'missing', 'missing.go', '', 'Go'), startIndex: 0, endIndex: 0 }], [
      { callerId: 'caller', calleeId: 'g', calleeName: 'g', line: 2, confidence: 'import' },
      { callerId: 'recoverer', calleeId: 'boom', calleeName: 'boom', line: 2, confidence: 'import' },
      { callerId: 'pointerCheck', calleeId: 'lookup', calleeName: 'lookup', line: 2, confidence: 'import' },
      { callerId: 'mixed', calleeId: 'g', calleeName: 'g', line: 3, confidence: 'import' },
      { callerId: 'mixed', calleeId: 'g', calleeName: 'g', line: 5, confidence: 'import' },
      { callerId: 'bodyCaller', calleeId: 'missing', calleeName: 'missing', line: 2, confidence: 'import' },
      { callerId: 'testCaller', calleeId: 'testErr', calleeName: 'testErr', line: 2, confidence: 'import' },
      { callerId: 'sameLine', calleeId: 'g', calleeName: 'g', line: 2, confidence: 'import' },
      { callerId: 'sameLine', calleeId: 'g', calleeName: 'g', line: 2, confidence: 'import' },
      { callerId: 'discardValue', calleeId: 'pair', calleeName: 'pair', line: 2, confidence: 'import' },
      { callerId: 'discardError', calleeId: 'pair', calleeName: 'pair', line: 2, confidence: 'import' },
      { callerId: 'checkThenReturn', calleeId: 'g', calleeName: 'g', line: 2, confidence: 'import' },
    ]);
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('attributes a returned callee error to its origin with a propagated path', async () => {
    const res = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'caller' }) as { escapes: Array<Record<string, unknown>> };
    expect(res.escapes).toEqual([expect.objectContaining({ kind: 'propagated_error', originFunction: 'g::g.go', path: ['caller::caller.go', 'g::g.go'] })]);
  });

  it('a deferred recovery shields a callee panic', async () => {
    const res = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'recoverer' }) as { escapes: unknown[]; handledInternally: Array<Record<string, unknown>> };
    expect(res.escapes).toEqual([]);
    expect(res.handledInternally).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'recovered_panic', fromCallee: 'boom::boom.go' })]));
  });

  it('does not classify a nil-checked pointer result as a handled error', async () => {
    const res = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'pointerCheck' }) as { handledInternally: unknown[] };
    expect(res.handledInternally).toEqual([]);
  });

  it('correlates handling and returning to separate call sites of the same callee', async () => {
    const res = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'mixed' }) as { escapes: Array<Record<string, unknown>>; handledInternally: Array<Record<string, unknown>> };
    expect(res.escapes).toEqual([expect.objectContaining({ kind: 'propagated_error', originFunction: 'g::g.go' })]);
    expect(res.handledInternally).toEqual([expect.objectContaining({ kind: 'checked_error', handledAtLine: 4 })]);
  });

  it('discloses bodyless and test-only Go callees honestly', async () => {
    const bodyless = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'bodyCaller' }) as { boundaries: string[] };
    expect(bodyless.boundaries.some(b => /no extractable body/.test(b))).toBe(true);
    expect(bodyless.boundaries.join(' ')).not.toMatch(/unsupported language.*Go/i);
    const testOnly = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'testCaller' }) as { boundaries: string[] };
    expect(testOnly.boundaries.some(b => /test-only callee/.test(b))).toBe(true);
  });

  it('does not conflate two same-callee call sites on one physical line', async () => {
    const res = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'sameLine' }) as { escapes: Array<Record<string, unknown>>; handledInternally: unknown[]; boundaries: string[] };
    expect(res.escapes).toEqual([expect.objectContaining({ kind: 'returned_error', originFunction: 'sameLine::same.go' })]);
    expect(res.handledInternally).toEqual([]);
    expect(res.boundaries.some(b => /multiple g call sites on one line/.test(b))).toBe(true);
  });

  it('correlates discarded positions to the callee error result', async () => {
    const value = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'discardValue' }) as { boundaries: string[] };
    expect(value.boundaries.join(' ')).not.toMatch(/discard(?:s|ed).*error result/i);
    const error = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'discardError' }) as { boundaries: string[] };
    expect(error.boundaries.some(b => /discards error result 1/.test(b))).toBe(true);
  });

  it('does not report a checked error handled when the same result is returned later', async () => {
    const result = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'checkThenReturn' }) as { escapes: Array<Record<string, unknown>>; handledInternally: unknown[] };
    expect(result.escapes).toEqual([expect.objectContaining({ kind: 'propagated_error', originFunction: 'g::g.go' })]);
    expect(result.handledInternally).toEqual([]);
  });
});

describe('handleAnalyzeErrorPropagation — Java and C# follow-on', () => {
  let d: string;
  const JAVA = `class C {\n  void risky() throws IOException { throw new IOException(); }\n}\n`;
  const JAVA_CALLER = `class D {\n  void caller() { try { risky(); } catch (IOException e) {} }\n}\n`;
  const JAVA_SUPPRESS = `class E {\n  void suppress() { try { risky(); } finally { return; } }\n}\n`;
  const CSHARP = `class C {\n  void Risky() { throw new InvalidOperationException(); }\n}\n`;
  const methodNode = (id: string, name: string, filePath: string, source: string, language: string): Node => {
    const startIndex = source.indexOf('void');
    const endIndex = source.indexOf('\n}', startIndex);
    return { ...node(id, name, filePath, source, language), startIndex, endIndex };
  };
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'errprop-jvm-'));
    writeFileSync(join(d, 'C.java'), JAVA);
    writeFileSync(join(d, 'D.java'), JAVA_CALLER);
    writeFileSync(join(d, 'E.java'), JAVA_SUPPRESS);
    writeFileSync(join(d, 'C.cs'), CSHARP);
    writeCache(d, [methodNode('java', 'risky', 'C.java', JAVA, 'Java'), methodNode('javaCaller', 'caller', 'D.java', JAVA_CALLER, 'Java'), methodNode('javaSuppress', 'suppress', 'E.java', JAVA_SUPPRESS, 'Java'), methodNode('cs', 'Risky', 'C.cs', CSHARP, 'C#')], [
      { callerId: 'javaCaller', calleeId: 'java', calleeName: 'risky', line: 2, confidence: 'import' },
      { callerId: 'javaSuppress', calleeId: 'java', calleeName: 'risky', line: 2, confidence: 'import' },
    ]);
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('reports Java throws declarations separately from direct throws', async () => {
    const res = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'risky' }) as { escapes: Array<Record<string, unknown>>; summary: Record<string, number>; boundaries: string[] };
    expect(res.escapes).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'IOException', kind: 'declared' }), expect.objectContaining({ type: 'IOException', kind: 'direct' })]));
    expect(res.summary.declared).toBe(1);
    expect(res.summary.propagated).toBe(0);
    expect(res.boundaries.some(b => /constructor call/.test(b))).toBe(true);
  });

  it('reports a direct C# throw in the exception-shaped result', async () => {
    const res = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'Risky' }) as { escapes: Array<Record<string, unknown>> };
    expect(res.escapes).toEqual([expect.objectContaining({ type: 'InvalidOperationException', kind: 'direct' })]);
  });

  it('does not propagate a callee exception through a definitely abrupt finally', async () => {
    const res = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'suppress' }) as { escapes: unknown[]; boundaries: string[] };
    expect(res.escapes).toEqual([]);
    expect(res.boundaries.some(b => /abrupt finally suppresses/.test(b))).toBe(true);
  });

  it('contains Java callee escapes in a matching typed catch', async () => {
    const res = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'caller' }) as { escapes: unknown[]; handledInternally: Array<Record<string, unknown>> };
    expect(res.escapes).toEqual([]);
    expect(res.handledInternally).toEqual([expect.objectContaining({ type: 'IOException', caughtIn: 'caller::D.java' })]);
  });
});

describe('handleAnalyzeErrorPropagation — Go truncation memo safety', () => {
  let d: string;
  const sources: Record<string, string> = {
    q: `package p\nfunc q(){ a(); c() }\n`, a: `package p\nfunc a(){ b() }\n`,
    b: `package p\nfunc b(){ c() }\n`, c: `package p\nfunc c(){ d() }\n`,
    d: `package p\nfunc d(){ panic("deep") }\n`,
  };
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'errprop-go-memo-'));
    const nodes = Object.entries(sources).map(([name, source]) => {
      writeFileSync(join(d, `${name}.go`), source);
      return { ...node(name, name, `${name}.go`, source, 'Go'), startIndex: source.indexOf('func'), endIndex: source.lastIndexOf('}') + 1 };
    });
    writeCache(d, nodes, [
      { callerId: 'q', calleeId: 'a', calleeName: 'a', line: 2 }, { callerId: 'a', calleeId: 'b', calleeName: 'b', line: 2 },
      { callerId: 'b', calleeId: 'c', calleeName: 'c', line: 2 }, { callerId: 'c', calleeId: 'd', calleeName: 'd', line: 2 },
      { callerId: 'q', calleeId: 'c', calleeName: 'c', line: 2 },
    ]);
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('recomputes a shallow path after a deeper path truncates the same node', async () => {
    const res = await handleAnalyzeErrorPropagation({ directory: d, symbol: 'q', maxDepth: 3 }) as { escapes: Array<Record<string, unknown>> };
    expect(res.escapes).toEqual([expect.objectContaining({ kind: 'panic', originFunction: 'd::d.go' })]);
  });

  it('does not let a shallow memo bypass the bound on a later deep path, regardless of edge order', async () => {
    const nodes = Object.entries(sources).map(([name, source]) => ({
      ...node(name, name, `${name}.go`, source, 'Go'),
      startIndex: source.indexOf('func'),
      endIndex: source.lastIndexOf('}') + 1,
    }));
    const deep = [
      { callerId: 'q', calleeId: 'a', calleeName: 'a', line: 2 },
      { callerId: 'a', calleeId: 'b', calleeName: 'b', line: 2 },
      { callerId: 'b', calleeId: 'c', calleeName: 'c', line: 2 },
      { callerId: 'c', calleeId: 'd', calleeName: 'd', line: 2 },
    ];
    const shallow = { callerId: 'q', calleeId: 'c', calleeName: 'c', line: 2 };
    const snapshots: string[] = [];
    for (const edges of [[shallow, ...deep], [...deep, shallow]]) {
      writeCache(d, nodes, edges);
      snapshots.push(JSON.stringify(await handleAnalyzeErrorPropagation({ directory: d, symbol: 'q', maxDepth: 2 })));
    }
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(JSON.parse(snapshots[0]).escapes).toEqual([
      expect.objectContaining({ originFunction: 'd::d.go', path: ['q::q.go', 'c::c.go', 'd::d.go'] }),
    ]);
  });
});

describe('analyze_error_propagation discloses the dynamic boundary in scope', () => {
  /** Write a site artifact into the fixture repo the outer `beforeEach` already built. */
  function withSite(filePath: string, line = 2, kind = 'reflective-invoke'): void {
    writeFileSync(
      join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DYNAMIC_BOUNDARY),
      JSON.stringify({
        version: 1, totalSites: 1, totalFiles: 1, byKind: [], byLanguage: [],
        files: [{
          filePath, language: 'TypeScript',
          sites: [{ line, kind, refusal: 'no-static-target', evidence: 'o[n]()', unattributed: true }],
        }],
      }),
      'utf-8',
    );
    __resetDynamicBoundaryMemo();
  }

  it('carries the structured crossing AND renders its free text from that same crossing', async () => {
    // A callee reached only through a reflective dispatch is not in the escape set at all, which is
    // exactly why a clean escape set next to a site must not read as "this function throws nothing".
    withSite('caller.ts');
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'caller' })) as Result;

    expect(res.dynamicBoundaries?.kind).toBe('dynamic-boundary');
    expect(res.dynamicBoundaries?.sites)
      .toEqual([{ file: 'caller.ts', line: 2, kind: 'reflective-invoke' }]);
    // The free-text list is RENDERED FROM the structured crossing — one source, so the two can
    // never say different things.
    expect(res.boundaries).toContain(res.dynamicBoundaries!.detail);
    // …and the answer is still returned.
    expect(res.summary.escapes).toBeGreaterThan(0);
  });

  it('discloses nothing for a traversal that crosses no site', async () => {
    withSite('unrelated.ts');
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'caller' })) as Result;
    expect(res.dynamicBoundaries).toBeUndefined();
    expect(res.boundaries.some(b => /cannot follow/.test(b))).toBe(false);
  });

  it('discloses a site in a callee\'s file, not only the query\'s own', async () => {
    // `caller` throws through `helper`; a site in `helper.ts` bounds the answer just as much.
    withSite('helper.ts', 1, 'computed-member');
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'caller' })) as Result;
    expect(res.dynamicBoundaries?.sites?.[0].file).toBe('helper.ts');
  });
});
