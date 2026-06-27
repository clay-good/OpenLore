/**
 * Tests for the `analyze_error_propagation` handler (change: add-error-propagation-graph).
 *
 * Drives the handler over a hand-written analysis cache (llm-context.json) with a
 * small multi-function call graph, so the test is deterministic and offline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAnalyzeErrorPropagation } from './error-propagation.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../../constants.js';

const HELPER = `function helper() {\n  throw new TypeError("boom");\n}\n`;
const CALLER = `function caller() {\n  helper();\n}\n`;
const GUARDED = `function guarded() {\n  try {\n    helper();\n  } catch (e) {\n    return;\n  }\n}\n`;
const EXTCALLER = `function extCaller() {\n  fetch();\n}\n`;
const GOFN = `func goFn() error {\n  return nil\n}\n`;

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

  const nodes: Node[] = [
    node('helper', 'helper', 'helper.ts', HELPER),
    node('caller', 'caller', 'caller.ts', CALLER),
    node('guarded', 'guarded', 'guarded.ts', GUARDED),
    node('extCaller', 'extCaller', 'extcaller.ts', EXTCALLER),
    node('goFn', 'goFn', 'gofn.go', GOFN, 'Go'),
    { id: 'fetchExt', name: 'fetch', filePath: 'lib.ts', startIndex: 0, endIndex: 0, startLine: 0, endLine: 0, language: 'TypeScript', isExternal: true },
  ];
  const edges = [
    { callerId: 'caller', calleeId: 'helper', calleeName: 'helper', line: 2, confidence: 'import' },
    { callerId: 'guarded', calleeId: 'helper', calleeName: 'helper', line: 3, confidence: 'import' },
    { callerId: 'extCaller', calleeId: 'fetchExt', calleeName: 'fetch', line: 2, confidence: 'external' },
  ];

  const analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  mkdirSync(analysisDir, { recursive: true });
  writeFileSync(join(analysisDir, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes, edges } }), 'utf-8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Result {
  query: { symbol: string };
  unsupported?: boolean;
  error?: string;
  candidates?: string[];
  summary: { escapes: number; direct: number; propagated: number; handledInternally: number; unresolvedSelfCalls: number };
  escapes: Array<{ type: string; kind: string; originFunction: string; path: string[] }>;
  handledInternally: Array<{ type: string; caughtIn: string; fromCallee: string }>;
  boundaries: string[];
  externalCalleesNotAnalyzed?: { count: number; sample: string[] };
  unresolvedSelfCalls?: { count: number; sample: string[] };
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

  it('returns an explicit unsupported result for a non-supported language', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'goFn' })) as Result;
    expect(res.unsupported).toBe(true);
    expect(res.escapes).toBeUndefined();
  });

  it('returns an explicit not-found (with candidates) for an unknown symbol', async () => {
    const res = (await handleAnalyzeErrorPropagation({ directory: dir, symbol: 'help' })) as Result;
    expect(res.error).toMatch(/No indexed function/);
    expect(res.candidates).toContain('helper');
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
