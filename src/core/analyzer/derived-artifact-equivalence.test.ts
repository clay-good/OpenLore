/** Standing derived-artifact certification matrix (change: certify-derived-artifact-equivalence). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DERIVED_ARTIFACT_EQUIVALENCE_MATRIX,
  OPERATIONAL_ANSWER_PATHS,
  SEMANTIC_ANSWER_PROJECTION,
  semanticAnswerBytes,
  type EquivalenceRowId,
} from './derived-artifact-equivalence.js';
import { VectorIndex, _resetVectorIndexCachesForTesting, _vectorIndexCacheStatsForTesting } from './vector-index.js';
import {
  _contextCacheSizeForTesting,
  _resetContextCacheForTesting,
  readCachedContext,
} from '../services/mcp-handlers/utils.js';
import { publishGeneration, REQUIRED_ANALYSIS_ARTIFACTS } from '../runtime/analysis-generation.js';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';

const REQUIRED_ROWS = new Set<EquivalenceRowId>([
  'cold-warm-context',
  'memo-hit-miss',
  'parallel-serial-extraction',
  'precomputed-live-traversal',
  'incremental-full-repair',
  'imported-local-structural',
  'bm25-cached-uncached',
  'function-vector-repair',
  'spec-vector-repair',
]);

function node(id: string, name: string, filePath: string): FunctionNode {
  return {
    id, name, filePath, language: 'TypeScript', isAsync: false,
    startIndex: 0, endIndex: 10, fanIn: 1, fanOut: 0,
  };
}

const NODES = [
  node('src/auth.ts::authenticate', 'authenticate', 'src/auth.ts'),
  node('src/session.ts::createSession', 'createSession', 'src/session.ts'),
];

const SIGNATURES: FileSignatureMap[] = [{
  path: 'src/auth.ts',
  language: 'TypeScript',
  entries: [{
    kind: 'function',
    name: 'authenticate',
    signature: 'function authenticate(token: string): User',
    docstring: 'Authenticate a session token',
  }],
}];

describe('derived-artifact equivalence registry', () => {
  it('registers every standing row exactly once with an executable CI assertion', () => {
    const ids = DERIVED_ARTIFACT_EQUIVALENCE_MATRIX.map((row) => row.id);
    expect(new Set(ids)).toEqual(REQUIRED_ROWS);
    expect(ids).toHaveLength(REQUIRED_ROWS.size);

    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const gate = packageJson.scripts['test:equivalence'];
    expect(gate).toBeTruthy();

    for (const row of DERIVED_ARTIFACT_EQUIVALENCE_MATRIX) {
      expect(row.assertion).toBe(SEMANTIC_ANSWER_PROJECTION);
      expect(row.authoritativeInputs).toEqual([
        'repository-snapshot:normalized-paths-and-bytes',
        'reachable-git-history',
        'normalized-analysis-configuration',
        'registered-analyzer-capabilities',
      ]);
      expect(row.fixtures.length, `${row.id} must bind at least one fixture`).toBeGreaterThan(0);
      expect(row.cacheModes || row.workerCounts, `${row.id} must bind its differing operating mode`).toBeTruthy();
      expect(row.ciTests.length, `${row.id} must name at least one executable test`).toBeGreaterThan(0);
      for (const test of row.ciTests) {
        expect(test).toMatch(/\.test\.ts$/);
        expect(existsSync(resolve(test)), `${row.id}: ${test} must exist`).toBe(true);
        expect(gate, `${row.id}: ${test} must run in test:equivalence`).toContain(test);
      }
    }
  });

  it('canonicalizes key order but preserves ordered result semantics', () => {
    const a = { results: [{ score: 2, id: 'a' }, { score: 1, id: 'b' }], count: 2 };
    const same = { count: 2, results: [{ id: 'a', score: 2 }, { id: 'b', score: 1 }] };
    const reversed = { count: 2, results: [{ id: 'b', score: 1 }, { id: 'a', score: 2 }] };
    expect(semanticAnswerBytes(a)).toBe(semanticAnswerBytes(same));
    expect(semanticAnswerBytes(a)).not.toBe(semanticAnswerBytes(reversed));
  });

  it('separates operational evidence without hiding conclusion mutations', () => {
    const baseline = {
      cached: true,
      freshness: { state: 'fresh' },
      results: [{ id: 'src/auth.ts::authenticate', verdict: 'reachable' }],
    };
    const cold = {
      cached: false,
      freshness: { state: 'recomputed' },
      results: [{ id: 'src/auth.ts::authenticate', verdict: 'reachable' }],
    };
    const broken = {
      cached: false,
      results: [{ id: 'src/auth.ts::authenticate', verdict: 'no-path-found' }],
    };

    expect(OPERATIONAL_ANSWER_PATHS.has('$.cached')).toBe(true);
    expect(semanticAnswerBytes(baseline)).toBe(semanticAnswerBytes(cold));
    expect(semanticAnswerBytes(baseline)).not.toBe(semanticAnswerBytes(broken));

    const nestedConclusionA = { results: [{ freshness: 'verified-at-source' }] };
    const nestedConclusionB = { results: [{ freshness: 'inferred' }] };
    expect(semanticAnswerBytes(nestedConclusionA)).not.toBe(semanticAnswerBytes(nestedConclusionB));

    expect(semanticAnswerBytes({ receipts: ['src/a.ts:1'] }))
      .not.toBe(semanticAnswerBytes({ receipts: ['src/a.ts:2'] }));
  });

});

describe('cold ≡ warm served answer', () => {
  let root: string;
  let outputDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-equivalence-'));
    outputDir = join(root, '.openlore', 'analysis');
    vi.stubEnv('EMBED_BASE_URL', '');
    vi.stubEnv('EMBED_MODEL', '');
    _resetVectorIndexCachesForTesting();
    _resetContextCacheForTesting();
    await VectorIndex.build(outputDir, NODES, SIGNATURES, new Set(), new Set(), null);
    await mkdir(outputDir, { recursive: true });
    for (const artifact of REQUIRED_ANALYSIS_ARTIFACTS) {
      const body = artifact === 'llm-context.json'
        ? JSON.stringify({ callGraph: { nodes: NODES, edges: [] }, signatures: SIGNATURES })
        : '{}';
      await writeFile(join(outputDir, artifact), body, 'utf8');
    }
    await publishGeneration(outputDir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    _resetVectorIndexCachesForTesting();
    _resetContextCacheForTesting();
    await rm(root, { recursive: true, force: true });
  });

  it('serves the same semantic search response before and after process-cache hydration', async () => {
    const { handleSearchCode } = await import('../services/mcp-handlers/semantic.js');
    _resetVectorIndexCachesForTesting();
    expect(_vectorIndexCacheStatsForTesting()).toEqual({ tableHits: 0, tableMisses: 0, bm25Hits: 0, bm25Misses: 0 });
    const cold = await handleSearchCode(root, 'authenticate session token', 5);
    expect(_vectorIndexCacheStatsForTesting()).toEqual({ tableHits: 0, tableMisses: 1, bm25Hits: 0, bm25Misses: 1 });
    expect(_contextCacheSizeForTesting()).toBe(1);
    const hydratedContext = await readCachedContext(root);
    expect(hydratedContext?.callGraph?.nodes).toHaveLength(2);
    const warm = await handleSearchCode(root, 'authenticate session token', 5);
    expect(_vectorIndexCacheStatsForTesting()).toEqual({ tableHits: 1, tableMisses: 1, bm25Hits: 1, bm25Misses: 1 });
    expect(await readCachedContext(root)).toBe(hydratedContext);

    expect(semanticAnswerBytes(warm)).toBe(semanticAnswerBytes(cold));
    expect(semanticAnswerBytes(cold)).toContain('authenticate');
  });
});
