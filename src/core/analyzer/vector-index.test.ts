import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorIndex, _resetVectorIndexCachesForTesting } from './vector-index.js';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';
import type { EmbeddingService } from './embedding-service.js';

// ============================================================================
// FIXTURES
// ============================================================================

function makeNode(overrides: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id: 'src/auth.ts::authenticate',
    name: 'authenticate',
    filePath: 'src/auth.ts',
    language: 'TypeScript',
    isAsync: true,
    startIndex: 0,
    endIndex: 100,
    fanIn: 3,
    fanOut: 2,
    ...overrides,
  };
}

const SAMPLE_NODES: FunctionNode[] = [
  makeNode({
    id: 'src/auth.ts::authenticate',
    name: 'authenticate',
    filePath: 'src/auth.ts',
    fanIn: 5,
    fanOut: 2,
  }),
  makeNode({
    id: 'src/users.ts::getUser',
    name: 'getUser',
    filePath: 'src/users.ts',
    fanIn: 2,
    fanOut: 1,
  }),
  makeNode({
    id: 'src/db.ts::connect',
    name: 'connect',
    filePath: 'src/db.ts',
    language: 'TypeScript',
    fanIn: 10,
    fanOut: 0,
  }),
];

const SAMPLE_SIGNATURES: FileSignatureMap[] = [
  {
    path: 'src/auth.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'authenticate',
        signature: 'async function authenticate(token: string): Promise<User>',
        docstring: 'Authenticate a user via JWT token',
      },
    ],
  },
  {
    path: 'src/users.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'getUser',
        signature: 'async function getUser(id: string): Promise<User | null>',
        docstring: 'Fetch a user by ID',
      },
    ],
  },
];

// ============================================================================
// MOCK EMBEDDING SERVICE
// ============================================================================

const DIM = 8;

function makeVector(seed: number): number[] {
  return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) * 0.1);
}

function makeMockEmbedSvc(
  strategy: 'fixed' | 'query-similarity' = 'fixed'
): EmbeddingService {
  let callCount = 0;
  return {
    embed: vi.fn().mockImplementation(async (texts: string[]) => {
      if (strategy === 'query-similarity') {
        // Make the first text's vector similar to a "query about authentication"
        return texts.map((t, i) => {
          const seed = t.toLowerCase().includes('auth') ? 0 : (callCount + i + 5) % 10;
          callCount++;
          return makeVector(seed);
        });
      }
      return texts.map((_, i) => makeVector(callCount + i));
    }),
  } as unknown as EmbeddingService;
}

// ============================================================================
// TESTS
// ============================================================================

describe('VectorIndex', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-vector-test-'));
  });

  // Clean up after each test
  // (not strictly needed since tests use unique tmpDirs, but good practice)

  describe('exists()', () => {
    it('returns false when no index has been built', () => {
      expect(VectorIndex.exists(tmpDir)).toBe(false);
    });

    it('returns true after build()', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(
        tmpDir,
        SAMPLE_NODES,
        SAMPLE_SIGNATURES,
        new Set(['src/auth.ts::authenticate']),
        new Set(),
        embedSvc
      );
      expect(VectorIndex.exists(tmpDir)).toBe(true);
    });
  });

  describe('build()', () => {
    it('creates the vector-index folder', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);
      expect(VectorIndex.exists(tmpDir)).toBe(true);
    });

    it('calls embed once with all texts concatenated', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);
      expect(embedSvc.embed).toHaveBeenCalledTimes(1);
      const texts = (embedSvc.embed as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect(texts).toHaveLength(SAMPLE_NODES.length);
    });

    it('throws when nodes array is empty', async () => {
      const embedSvc = makeMockEmbedSvc();
      await expect(
        VectorIndex.build(tmpDir, [], SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc)
      ).rejects.toThrow('No functions to index');
    });

    it('excludes synthetic external call targets and reports the indexed population', async () => {
      const external = makeNode({
        id: 'external::id.startsWith',
        name: 'id.startsWith',
        filePath: 'external',
        isExternal: true,
      });
      const testNode = makeNode({
        id: 'src/auth.test.ts::authenticates',
        name: 'authenticates',
        filePath: 'src/auth.test.ts',
        isTest: true,
      });

      const result = await VectorIndex.build(
        tmpDir,
        [...SAMPLE_NODES, external, testNode],
        SAMPLE_SIGNATURES,
        new Set(),
        new Set(),
        null,
      );

      expect(result).toMatchObject({
        total: SAMPLE_NODES.length + 1,
        productionFunctions: SAMPLE_NODES.length,
        testFunctions: 1,
        signatureOnlySymbols: 0,
      });
      _resetVectorIndexCachesForTesting();
      expect(await VectorIndex.search(tmpDir, 'startsWith', null, { limit: 10 })).toEqual([]);
    });

    it('indexes repository signature symbols when every call-graph node is external', async () => {
      const external = makeNode({
        id: 'external::console.log',
        name: 'console.log',
        filePath: 'external',
        isExternal: true,
      });
      const signatures: FileSignatureMap[] = [{
        path: 'src/config.ts',
        language: 'TypeScript',
        entries: [{
          kind: 'const',
          name: 'DEFAULT_GREETING',
          signature: 'const DEFAULT_GREETING = "hello"',
        }],
      }];

      const result = await VectorIndex.build(
        tmpDir,
        [external],
        signatures,
        new Set(),
        new Set(),
        null,
      );

      expect(result).toMatchObject({
        total: 1,
        productionFunctions: 0,
        testFunctions: 0,
        signatureOnlySymbols: 1,
      });
      const matches = await VectorIndex.search(tmpDir, 'DEFAULT_GREETING', null, { limit: 5 });
      expect(matches.map((match) => match.record.name)).toEqual(['DEFAULT_GREETING']);
    });

    it('marks hub functions correctly', async () => {
      const hubIds = new Set(['src/auth.ts::authenticate']);
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, hubIds, new Set(), embedSvc);

      // Search and verify hub flag
      const results = await VectorIndex.search(tmpDir, 'authenticate', embedSvc, { limit: 10 });
      const authResult = results.find(r => r.record.name === 'authenticate');
      expect(authResult?.record.isHub).toBe(true);

      const getUserResult = results.find(r => r.record.name === 'getUser');
      expect(getUserResult?.record.isHub).toBe(false);
    });

    it('overwrites existing index on second build', async () => {
      const embedSvc = makeMockEmbedSvc();
      // First build
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);
      // Second build (overwrite)
      await expect(
        VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc)
      ).resolves.not.toThrow();
    });
  });

  describe('search()', () => {
    it('returns up to limit results', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'any query', embedSvc, { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('each result has a score field', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'query', embedSvc, { limit: 10 });
      for (const r of results) {
        expect(typeof r.score).toBe('number');
      }
    });

    it('result records do not include the vector field', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'query', embedSvc, { limit: 10 });
      for (const r of results) {
        expect((r.record as Record<string, unknown>)['vector']).toBeUndefined();
      }
    });

    it('filters by language', async () => {
      const mixedNodes: FunctionNode[] = [
        ...SAMPLE_NODES,
        makeNode({
          id: 'src/main.py::run',
          name: 'run',
          filePath: 'src/main.py',
          language: 'Python',
          fanIn: 0,
          fanOut: 1,
        }),
      ];
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, mixedNodes, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'query', embedSvc, {
        limit: 10,
        language: 'Python',
      });
      for (const r of results) {
        expect(r.record.language).toBe('Python');
      }
    });

    it('filters by minFanIn', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      // Only src/db.ts::connect has fanIn=10, src/auth.ts::authenticate has fanIn=5
      const results = await VectorIndex.search(tmpDir, 'query', embedSvc, {
        limit: 10,
        minFanIn: 6,
      });
      for (const r of results) {
        expect(r.record.fanIn).toBeGreaterThanOrEqual(6);
      }
    });

    it('includes signature and docstring in records when available', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'authenticate', embedSvc, { limit: 10 });
      const authResult = results.find(r => r.record.name === 'authenticate');
      expect(authResult?.record.signature).toContain('authenticate');
      expect(authResult?.record.docstring).toContain('JWT');
    });

    it('returns empty array when minFanIn filters out everything', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'query', embedSvc, {
        limit: 10,
        minFanIn: 9999,
      });
      expect(results).toHaveLength(0);
    });
  });

  // ==========================================================================
  // BM25-only build + search (no embedding service) — spec-06
  // ==========================================================================

  describe('BM25-only (no embeddings)', () => {
    const META = 'vector-index-meta.json';

    async function readMeta(dir: string) {
      return JSON.parse(await readFile(join(dir, META), 'utf-8'));
    }

    it('build(embedSvc=null) creates the index and a hasEmbeddings:false sidecar', async () => {
      const res = await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), null);
      expect(VectorIndex.exists(tmpDir)).toBe(true);
      expect(res.hasEmbeddings).toBe(false);
      expect(res.total).toBe(SAMPLE_NODES.length);

      expect(existsSync(join(tmpDir, META))).toBe(true);
      const meta = await readMeta(tmpDir);
      expect(meta.hasEmbeddings).toBe(false);
      expect(meta.dim).toBe(0);
      expect(meta.model).toBeNull();
    });

    it('search(embedSvc=null) returns ranked BM25 results with correct fields', async () => {
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(['src/auth.ts::authenticate']), new Set(), null);
      _resetVectorIndexCachesForTesting();

      const results = await VectorIndex.search(tmpDir, 'authenticate', null, { limit: 10 });
      expect(results.length).toBeGreaterThan(0);
      const auth = results.find(r => r.record.name === 'authenticate');
      expect(auth).toBeDefined();
      expect(auth!.record.isHub).toBe(true);
      expect((auth!.record as Record<string, unknown>)['vector']).toBeUndefined();
      for (const r of results) expect(typeof r.score).toBe('number');
    });

    it('explains morphological and foreign misses from indexed identifiers only', async () => {
      const greet = makeNode({
        id: 'src/main.ts::greet',
        name: 'greet',
        filePath: 'src/main.ts',
      });
      await VectorIndex.build(tmpDir, [greet], [], new Set(), new Set(), null);

      const morphological = await VectorIndex.keywordMissDiagnostics(tmpDir, 'change the greeting');
      expect(morphological.missedTokens).toContain('greeting');
      expect(morphological.nearTokens).toContainEqual({
        queryToken: 'greeting',
        indexedTokens: ['greet'],
      });

      const foreign = await VectorIndex.keywordMissDiagnostics(tmpDir, 'kubernetes ingress rules');
      expect(foreign.missedTokens).toEqual(['kubernetes', 'ingress', 'rules']);
      expect(foreign.nearTokens).toEqual([]);
    });

    it('invalidates the cached identifier vocabulary after an incremental update', async () => {
      const greet = makeNode({ id: 'src/main.ts::greet', name: 'greet', filePath: 'src/main.ts' });
      await VectorIndex.build(tmpDir, [greet], [], new Set(), new Set(), null);
      expect((await VectorIndex.keywordMissDiagnostics(tmpDir, 'greeting')).nearTokens)
        .toContainEqual({ queryToken: 'greeting', indexedTokens: ['greet'] });

      const welcome = makeNode({ id: 'src/main.ts::welcome', name: 'welcome', filePath: 'src/main.ts' });
      await VectorIndex.updateFiles(
        tmpDir,
        [welcome],
        new Set(['src/main.ts']),
        [],
        new Set(),
        new Set(),
        null,
      );

      const updated = await VectorIndex.keywordMissDiagnostics(tmpDir, 'welcomes');
      expect(updated.nearTokens).toContainEqual({ queryToken: 'welcomes', indexedTokens: ['welcome'] });
      expect(updated.nearTokens.flatMap((receipt) => receipt.indexedTokens)).not.toContain('greet');
    });

    it('does NOT embed the query against a hasEmbeddings:false index, even when an embedder is supplied', async () => {
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), null);
      _resetVectorIndexCachesForTesting();

      const spy = makeMockEmbedSvc();
      const results = await VectorIndex.search(tmpDir, 'authenticate', spy, { limit: 10 });
      expect(spy.embed).not.toHaveBeenCalled();
      expect(results.length).toBeGreaterThan(0);
    });

    it('BM25 ranking is deterministic across runs for a fixed query + corpus', async () => {
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), null);

      _resetVectorIndexCachesForTesting();
      const a = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
      _resetVectorIndexCachesForTesting();
      const b = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
      expect(a.map(r => r.record.id)).toEqual(b.map(r => r.record.id));
    });

    it('build with a mock embedder records hasEmbeddings:true with the correct dim', async () => {
      const embedSvc = makeMockEmbedSvc();
      const res = await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);
      expect(res.hasEmbeddings).toBe(true);
      const meta = await readMeta(tmpDir);
      expect(meta.hasEmbeddings).toBe(true);
      expect(meta.dim).toBe(8); // DIM from the mock
    });

    it('incremental rebuild on a no-embedding index does not crash and refreshes the corpus', async () => {
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), null);
      const res = await VectorIndex.build(
        tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), null,
        undefined, /* incremental */ true
      );
      expect(res.hasEmbeddings).toBe(false);
      _resetVectorIndexCachesForTesting();
      const results = await VectorIndex.search(tmpDir, 'authenticate', null, { limit: 10 });
      expect(results.length).toBeGreaterThan(0);
    });

    it('downgrade: embedded → null rebuild converts to BM25-only', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);
      expect((await readMeta(tmpDir)).hasEmbeddings).toBe(true);

      const res = await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), null);
      expect(res.hasEmbeddings).toBe(false);
      expect((await readMeta(tmpDir)).hasEmbeddings).toBe(false);

      // A supplied embedder must now be ignored (BM25 forced by the sidecar).
      _resetVectorIndexCachesForTesting();
      const spy = makeMockEmbedSvc();
      await VectorIndex.search(tmpDir, 'authenticate', spy, { limit: 10 });
      expect(spy.embed).not.toHaveBeenCalled();
    });

    it('upgrade: BM25-only → embedded rebuild restores hybrid search', async () => {
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), null);
      expect((await readMeta(tmpDir)).hasEmbeddings).toBe(false);

      const embedSvc = makeMockEmbedSvc();
      const res = await VectorIndex.build(
        tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc,
        undefined, /* incremental */ true
      );
      expect(res.hasEmbeddings).toBe(true);
      expect((await readMeta(tmpDir)).hasEmbeddings).toBe(true);

      _resetVectorIndexCachesForTesting();
      const spy = makeMockEmbedSvc();
      await VectorIndex.search(tmpDir, 'authenticate', spy, { limit: 10 });
      expect(spy.embed).toHaveBeenCalled(); // ANN path active again
    });
  });
});
