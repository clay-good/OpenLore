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
  summary: { escapes: number; direct: number; propagated: number; handledInternally: number };
  escapes: Array<{ type: string; kind: string; originFunction: string; path: string[] }>;
  handledInternally: Array<{ type: string; caughtIn: string; fromCallee: string }>;
  boundaries: string[];
  externalCalleesNotAnalyzed?: { count: number; sample: string[] };
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
