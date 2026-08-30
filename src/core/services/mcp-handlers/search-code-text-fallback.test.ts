/**
 * search_code literal-text fallback (decision fd256fde).
 *
 * The symbol index is symbol-derived, so a literal string in static markup
 * (a "Message completed" banner in index.html) produces no symbol rows and is
 * invisible. These tests prove handleSearchCode falls back to the separate
 * literal-text line index on zero symbol hits, honours mode:'text', and does
 * NOT touch the text index when symbol hits exist. BM25-only — no embedder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorIndex, _resetVectorIndexCachesForTesting } from '../../analyzer/vector-index.js';
import { TextLineIndex, _resetTextLineIndexCachesForTesting } from '../../analyzer/text-line-index.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';

function makeNode(o: Partial<FunctionNode>): FunctionNode {
  return {
    id: 'x', name: 'x', filePath: 'src/x.ts', language: 'TypeScript',
    isAsync: false, startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0, ...o,
  } as FunctionNode;
}

const NODES: FunctionNode[] = [
  makeNode({ id: 'src/auth.ts::authenticate', name: 'authenticate', filePath: 'src/auth.ts', fanIn: 5 }),
];

describe('search_code → literal-text fallback', () => {
  let projectDir: string;
  let outputDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'openlore-text-fallback-'));
    outputDir = join(projectDir, '.openlore', 'analysis');
    vi.stubEnv('EMBED_BASE_URL', '');
    vi.stubEnv('EMBED_MODEL', '');
    _resetVectorIndexCachesForTesting();
    _resetTextLineIndexCachesForTesting();
    // Symbol index (BM25-only) + a separate text-line index over index.html.
    await VectorIndex.build(outputDir, NODES, [], new Set(), new Set(), null);
    await TextLineIndex.build(outputDir, [
      { filePath: 'public/index.html', content: '<div class="ok">Message completed</div>' },
    ]);
    _resetVectorIndexCachesForTesting();
    _resetTextLineIndexCachesForTesting();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    _resetVectorIndexCachesForTesting();
    _resetTextLineIndexCachesForTesting();
    await rm(projectDir, { recursive: true, force: true });
  });

  it('falls back to the text index when symbol search returns zero hits', async () => {
    const { handleSearchCode } = await import('./semantic.js');
    const res = await handleSearchCode(projectDir, 'Message completed banner', 5) as {
      searchMode: string; count: number;
      results: Array<{ filePath: string; line: number; text: string; scoreKind: string; kind: string }>;
    };
    expect(res.searchMode).toBe('text_fallback');
    expect(res.count).toBeGreaterThan(0);
    expect(res.results[0].filePath).toBe('public/index.html');
    expect(res.results[0].scoreKind).toBe('bm25');
    expect(res.results[0].kind).toBe('text');
    expect(res.results[0].text).toContain('Message completed');
    expect(res.results[0].line).toBe(1);
  });

  it('mode:"text" searches the text index directly', async () => {
    const { handleSearchCode } = await import('./semantic.js');
    const res = await handleSearchCode(projectDir, 'completed', 5, undefined, undefined, undefined, 'text') as {
      searchMode: string; results: Array<{ text: string; scoreKind: string; kind: string }>;
    };
    expect(res.searchMode).toBe('text');
    expect(res.results.every((r) => r.scoreKind === 'bm25')).toBe(true);
    expect(res.results.some((r) => r.text.includes('Message completed'))).toBe(true);
  });

  it('zero symbol hits with no text index returns a normal empty response, not an error', async () => {
    // Build a fresh project with ONLY a symbol index (no text-line index), so the
    // fallback finds nothing to query and must degrade to the empty symbol result.
    const bareDir = await mkdtemp(join(tmpdir(), 'openlore-no-text-'));
    const bareOut = join(bareDir, '.openlore', 'analysis');
    await VectorIndex.build(bareOut, NODES, [], new Set(), new Set(), null);
    _resetVectorIndexCachesForTesting();
    try {
      const { handleSearchCode } = await import('./semantic.js');
      const res = await handleSearchCode(bareDir, 'zzzznomatch literal banner', 5) as {
        error?: string; searchMode: string; count: number; results: unknown[];
      };
      expect(res.error).toBeUndefined();
      expect(res.searchMode).toBe('bm25_fallback');
      expect(res.count).toBe(0);
      expect(res.results).toEqual([]);
    } finally {
      await rm(bareDir, { recursive: true, force: true });
    }
  });

  it('does NOT fall back when symbol search has hits', async () => {
    const { handleSearchCode } = await import('./semantic.js');
    const res = await handleSearchCode(projectDir, 'authenticate', 5) as {
      searchMode: string; results: Array<{ name?: string; kind?: string }>;
    };
    expect(res.searchMode).toBe('bm25_fallback');
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r) => r.kind !== 'text')).toBe(true);
  });
});
