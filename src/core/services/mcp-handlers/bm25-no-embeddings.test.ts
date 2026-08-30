/**
 * spec-06 regression guard — BM25 search path with NO embedding endpoint.
 *
 * This is deliberately a plain unit test (not *.integration.test.ts) so it runs
 * in the CI "Unit Tests" job (`npm run test:run`). The original bug shipped
 * precisely because the MCP e2e integration suite — which exercises orient /
 * search_code — is excluded from CI. Here we build a BM25-only index (exactly
 * what `openlore analyze` writes when no embedder is configured) and assert the
 * real handlers return ranked results without an embedding endpoint, so the
 * "embeddings required" regression can never silently come back.
 *
 * Closes TODO(spec-06-followup): exercise BM25 search path in CI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorIndex, _resetVectorIndexCachesForTesting } from '../../analyzer/vector-index.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';
import type { FileSignatureMap } from '../../analyzer/signature-extractor.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeNode(o: Partial<FunctionNode>): FunctionNode {
  return {
    id: 'x', name: 'x', filePath: 'src/x.ts', language: 'TypeScript',
    isAsync: false, startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0, ...o,
  };
}

const NODES: FunctionNode[] = [
  makeNode({ id: 'src/embedding-service.ts::embed', name: 'embed', filePath: 'src/embedding-service.ts', fanIn: 8, fanOut: 1 }),
  makeNode({ id: 'src/auth.ts::authenticate', name: 'authenticate', filePath: 'src/auth.ts', fanIn: 5, fanOut: 2 }),
  makeNode({ id: 'src/db.ts::connect', name: 'connect', filePath: 'src/db.ts', fanIn: 10, fanOut: 0 }),
];

const SIGS: FileSignatureMap[] = [
  { path: 'src/embedding-service.ts', language: 'TypeScript', entries: [
    { kind: 'function', name: 'embed', signature: 'async function embed(texts: string[]): Promise<number[][]>', docstring: 'Embed text into vector using the embedding service' } ] },
  { path: 'src/auth.ts', language: 'TypeScript', entries: [
    { kind: 'function', name: 'authenticate', signature: 'async function authenticate(token: string): Promise<User>', docstring: 'Authenticate a user via JWT token' } ] },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('spec-06: handlers serve a BM25-only index with no embedder', () => {
  let projectDir: string;
  let outputDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'openlore-bm25-noembed-'));
    outputDir = join(projectDir, '.openlore', 'analysis');
    // Guarantee no embedding endpoint is picked up from the dev's environment.
    vi.stubEnv('EMBED_BASE_URL', '');
    vi.stubEnv('EMBED_MODEL', '');
    _resetVectorIndexCachesForTesting();
    // Build the keyword-only index exactly as `openlore analyze` does with embedSvc=null.
    const res = await VectorIndex.build(outputDir, NODES, SIGS, new Set(['src/db.ts::connect']), new Set(), null);
    expect(res.hasEmbeddings).toBe(false);
    _resetVectorIndexCachesForTesting();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('search_code returns ranked BM25 results (not "No analysis found")', async () => {
    const { handleSearchCode } = await import('./semantic.js');
    const res = await handleSearchCode(projectDir, 'embed text into vector using embedding service', 5) as {
      error?: string; searchMode: string; count: number;
      results: Array<{ name: string; filePath: string; score: number; language: string; fanIn: number; fanOut: number }>;
    };
    expect(res.error).toBeUndefined();
    expect(res.searchMode).toBe('bm25_fallback');
    expect(res.count).toBe(res.results.length);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.map(r => r.filePath).some(p => p.includes('embedding'))).toBe(true);
    for (const r of res.results) {
      expect(typeof r.score).toBe('number');
      expect(typeof r.fanIn).toBe('number');
    }
  });

  it('orient returns ranked relevant functions with searchMode bm25_fallback', async () => {
    const { handleOrient } = await import('./orient.js');
    const res = await handleOrient(projectDir, 'authenticate a user with a JWT token', 5) as {
      error?: string; searchMode: string;
      relevantFunctions: Array<{ name: string; filePath: string; score: number }>;
      relevantFiles: string[];
    };
    expect(res.error).toBeUndefined();
    expect(res.searchMode).toBe('bm25_fallback');
    expect(res.relevantFunctions.length).toBeGreaterThan(0);
    expect(res.relevantFiles.length).toBeGreaterThan(0);
    expect(res.relevantFunctions.some(f => f.name === 'authenticate')).toBe(true);
  });

  it('discloses keyword+vocabulary without changing the keyword scale or semantic hint', async () => {
    const vocabularyNodes = [
      makeNode({ id: 'src/target.ts::PmtSvc', name: 'PmtSvc', filePath: 'src/target.ts' }),
      makeNode({ id: 'src/a.ts::bindPayment', name: 'bindPayment', filePath: 'src/a.ts', signature: 'function bindPayment(pmt: Payment)' }),
      makeNode({ id: 'src/b.ts::queuePayment', name: 'queuePayment', filePath: 'src/b.ts', signature: 'function queuePayment(pmt: Payment)' }),
    ];
    await VectorIndex.build(outputDir, vocabularyNodes, [], new Set(), new Set(), null);
    _resetVectorIndexCachesForTesting();

    const { handleSearchCode } = await import('./semantic.js');
    const res = await handleSearchCode(projectDir, 'payment', 10) as {
      searchMode: string;
      retrievalMode: string;
      note: string;
      results: Array<{ name: string; expansionTerms?: string[] }>;
    };
    expect(res.searchMode).toBe('bm25_fallback');
    expect(res.retrievalMode).toBe('keyword+vocabulary');
    expect(res.note).toContain('openlore embed --local');
    expect(res.results.find(result => result.name === 'PmtSvc')?.expansionTerms).toContain('pmt');

    const { handleOrient } = await import('./orient.js');
    const oriented = await handleOrient(projectDir, 'payment', 10) as {
      searchMode: string;
      retrievalMode: string;
      note: string;
      relevantFunctions: Array<{ name: string; expansionTerms?: string[] }>;
    };
    expect(oriented.searchMode).toBe('bm25_fallback');
    expect(oriented.retrievalMode).toBe('keyword+vocabulary');
    expect(oriented.note).toContain('openlore embed --local');
    expect(oriented.relevantFunctions.find(result => result.name === 'PmtSvc')?.expansionTerms).toContain('pmt');
  });

  it('suggest_insertion_points returns ranked candidates over a BM25 index', async () => {
    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const res = await handleSuggestInsertionPoints(projectDir, 'authenticate user token', 5) as {
      error?: string; candidates: Array<{ rank: number; name: string; role: string }>;
    };
    expect(res.error).toBeUndefined();
    expect(res.candidates.length).toBeGreaterThan(0);
  });
});
