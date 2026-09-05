/**
 * Serving hot path — bounded per-call work and honest cache invalidation.
 *
 * Pins the two `mcp-handlers` requirements and the one `analyzer` requirement added by
 * change `optimize-serving-hot-path-caches`:
 *
 *   • DerivedGraphStructuresAreMemoizedPerAnalysis — derived structures that are pure
 *     functions of the analysis artifact are computed once per analysis version, and a
 *     graph-walking tool does not rebuild adjacency per invocation.
 *   • ServingCachesInvalidateOnExternalAnalyze — a cache of an on-disk artifact
 *     invalidates when ANOTHER process rewrites that artifact.
 *   • KeywordSearchDoesNotScanTheWholeCorpusPerQuery — per-query work is bounded by
 *     what the query can actually match, not by corpus size.
 *
 * Every assertion here is either an observable behaviour (same input → same answer
 * across a rewrite) or a structural guard on the source, in the style of
 * `artifact-write-atomicity.test.ts`. None of them is a timing measurement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadMappingIndex, clearMappingCache } from './utils.js';
import {
  artifactStamp,
  readJsonArtifactCached,
  _resetJsonArtifactCacheForTesting,
  _jsonArtifactCacheSizeForTesting,
} from './artifact-cache.js';
import { EdgeStore } from '../edge-store.js';
import { buildBm25Corpus, bm25CandidateDocs, bm25Score, _patchBm25CorpusForTesting } from '../../analyzer/vector-index.js';
import type { FileProvenance } from '../../provenance/git-provenance.js';

const SRC_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeMapping(dir: string, requirement: string): Promise<void> {
  const analysis = join(dir, '.openlore', 'analysis');
  await mkdir(analysis, { recursive: true });
  await writeFile(
    join(analysis, 'mapping.json'),
    JSON.stringify({
      mappings: [{
        requirement,
        service: 'svc',
        domain: 'core',
        specFile: 'openspec/specs/core/spec.md',
        functions: [{ name: 'handler', file: 'src/handler.ts', line: 1, kind: 'function', confidence: 'exact' }],
      }],
    }),
  );
}

// ── ServingCachesInvalidateOnExternalAnalyze ─────────────────────────────────

describe('serving caches invalidate when another process rewrites the artifact', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tmp('hot-path-invalidate-');
    clearMappingCache();
    _resetJsonArtifactCacheForTesting();
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('loadMappingIndex reflects a mapping.json rewritten underneath it', async () => {
    await writeMapping(dir, 'RequirementBeforeGenerate');
    const first = await loadMappingIndex(dir);
    expect(first?.entries[0].requirement).toBe('RequirementBeforeGenerate');

    // What `openlore generate` / `openlore mapping refresh` does — from another process.
    await writeMapping(dir, 'RequirementAfterGenerateWhichIsLonger');

    const second = await loadMappingIndex(dir);
    expect(second?.entries[0].requirement).toBe('RequirementAfterGenerateWhichIsLonger');
  });

  it('an unchanged mapping.json is parsed once — the second read returns the same index object', async () => {
    await writeMapping(dir, 'StableRequirement');
    const first = await loadMappingIndex(dir);
    const second = await loadMappingIndex(dir);
    expect(second).toBe(first);
  });

  it('a deleted mapping.json stops being served', async () => {
    await writeMapping(dir, 'GoesAway');
    expect(await loadMappingIndex(dir)).not.toBeNull();
    await rm(join(dir, '.openlore', 'analysis', 'mapping.json'));
    expect(await loadMappingIndex(dir)).toBeNull();
  });

  it('readJsonArtifactCached re-derives after a rewrite and reuses the derivation otherwise', async () => {
    const path = join(dir, 'artifact.json');
    await writeFile(path, JSON.stringify({ n: 1 }));

    let derivations = 0;
    const derive = (parsed: unknown) => { derivations++; return parsed as { n: number }; };

    expect((await readJsonArtifactCached(path, 'k', derive))?.n).toBe(1);
    expect((await readJsonArtifactCached(path, 'k', derive))?.n).toBe(1);
    expect(derivations).toBe(1);

    await writeFile(path, JSON.stringify({ n: 22 }));
    expect((await readJsonArtifactCached(path, 'k', derive))?.n).toBe(22);
    expect(derivations).toBe(2);
  });

  it('two derivations of the same artifact do not read each other’s cached value', async () => {
    const path = join(dir, 'shared.json');
    await writeFile(path, JSON.stringify({ n: 7 }));
    const asNumber = await readJsonArtifactCached(path, 'as-number', (p: unknown) => (p as { n: number }).n);
    const asString = await readJsonArtifactCached(path, 'as-string', (p: unknown) => String((p as { n: number }).n));
    expect(asNumber).toBe(7);
    expect(asString).toBe('7');
  });

  it('a malformed artifact caches nothing, so a repaired one is picked up', async () => {
    const path = join(dir, 'half-written.json');
    await writeFile(path, '{"n": ');
    expect(await readJsonArtifactCached(path, 'k', (p: unknown) => p)).toBeNull();
    await writeFile(path, '{"n": 3}');
    expect(await readJsonArtifactCached(path, 'k', (p: unknown) => p)).toEqual({ n: 3 });
  });

  it('artifactStamp distinguishes two writes of equal length inside the same millisecond', async () => {
    const path = join(dir, 'rapid.json');
    await writeFile(path, '{"a":1}');
    const before = await artifactStamp(path);
    await writeFile(path, '{"a":2}');
    const after = await artifactStamp(path);
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it('artifactStamp is null for an absent file rather than throwing', async () => {
    expect(await artifactStamp(join(dir, 'nope.json'))).toBeNull();
  });

  it('the sibling-artifact cache is bounded — a caller-supplied path cannot grow it forever', async () => {
    for (let i = 0; i < 200; i++) {
      const path = join(dir, `artifact-${i}.json`);
      await writeFile(path, JSON.stringify({ i }));
      await readJsonArtifactCached(path, 'k', (p: unknown) => p);
    }
    expect(_jsonArtifactCacheSizeForTesting()).toBeLessThanOrEqual(64);
    // The most recent entry survived eviction.
    expect(await readJsonArtifactCached(join(dir, 'artifact-199.json'), 'k', (p: unknown) => p)).toEqual({ i: 199 });
  });
});

// ── KeywordSearchDoesNotScanTheWholeCorpusPerQuery ───────────────────────────

describe('keyword search work is bounded by what the query can match', () => {
  /** A corpus where exactly three documents carry the query term. */
  function corpusWithNeedles(size: number, needleAt: number[]) {
    return buildBm25Corpus(
      Array.from({ length: size }, (_, i) => ({
        id: `doc-${String(i).padStart(5, '0')}`,
        text: needleAt.includes(i) ? `alpha needleTerm beta ${i}` : `alpha beta gamma ${i}`,
      })),
    );
  }

  it('the candidate set is exactly the documents that score above zero', () => {
    const corpus = corpusWithNeedles(2_000, [3, 917, 1_884]);
    const candidates = bm25CandidateDocs(corpus, ['needleterm']);

    const bruteForce = corpus.docs
      .map((_, i) => i)
      .filter((i) => bm25Score(corpus, ['needleterm'], i) > 0);

    expect(candidates).toEqual(bruteForce);
    expect(candidates.length).toBe(3);
  });

  it('candidate work does not grow with corpus size for a fixed match count', () => {
    const small = bm25CandidateDocs(corpusWithNeedles(500, [1, 2, 3]), ['needleterm']);
    const large = bm25CandidateDocs(corpusWithNeedles(20_000, [1, 2, 3]), ['needleterm']);
    expect(small.length).toBe(3);
    expect(large.length).toBe(3);
  });

  it('several token sets union without duplicates and stay ascending', () => {
    const corpus = buildBm25Corpus([
      { id: 'a', text: 'one two' },
      { id: 'b', text: 'two three' },
      { id: 'c', text: 'four' },
    ]);
    expect(bm25CandidateDocs(corpus, ['one'], ['two'])).toEqual([0, 1]);
    expect(bm25CandidateDocs(corpus, ['four'], ['one'])).toEqual([0, 2]);
  });

  it('an unknown term yields no candidates rather than the whole corpus', () => {
    const corpus = corpusWithNeedles(300, [5]);
    expect(bm25CandidateDocs(corpus, ['termThatAppearsNowhere'])).toEqual([]);
  });

  it('a term in every document still returns every document — the bound is match count, not a cap', () => {
    const corpus = corpusWithNeedles(50, []);
    expect(bm25CandidateDocs(corpus, ['alpha']).length).toBe(50);
  });

  // The postings index is memoized per corpus OBJECT. An incremental patch returns a NEW
  // corpus, so the postings must be rebuilt with it — otherwise a warm server would keep
  // answering from the pre-edit posting lists.
  it('an incrementally patched corpus gets its own candidate set, not the previous one', () => {
    const before = [
      { id: 'src/a.ts::fn', filePath: 'src/a.ts', text: 'alpha oldToken' },
      { id: 'src/b.ts::fn', filePath: 'src/b.ts', text: 'alpha beta' },
    ];
    const corpus = buildBm25Corpus(before.map(r => ({ id: r.id, text: r.text })));
    expect(bm25CandidateDocs(corpus, ['oldtoken'])).toHaveLength(1);
    expect(bm25CandidateDocs(corpus, ['newtoken'])).toHaveLength(0);

    const added = [{ id: 'src/a.ts::fn', filePath: 'src/a.ts', text: 'alpha newToken' }];
    const { corpus: patched } = _patchBm25CorpusForTesting(corpus, before, new Set(['src/a.ts']), added);

    expect(bm25CandidateDocs(patched, ['newtoken'])).toHaveLength(1);
    expect(bm25CandidateDocs(patched, ['oldtoken'])).toHaveLength(0);
    // …and the pre-patch corpus is untouched, since a concurrent search may hold it.
    expect(bm25CandidateDocs(corpus, ['oldtoken'])).toHaveLength(1);
  });

  it('the keyword cache does not retain the embedding column', async () => {
    const source = await readFile(join(SRC_ROOT, 'core/analyzer/vector-index.ts'), 'utf-8');
    // Both cold-load sites must pass their rows through the stripper before caching.
    const cachedLoads = source.match(/allRows = [\s\S]{0,200}?isRepoFunctionRow\)/g) ?? [];
    expect(cachedLoads.length).toBeGreaterThan(0);
    for (const load of cachedLoads) expect(load).toContain('withoutEmbeddingColumn');
  });
});

// ── Bounded tail costs: per-file store reads and symbol anchor resolution ─────

describe('per-file store reads are answered through the file_path index', () => {
  let dir: string;
  let store: EdgeStore;

  const provenanceFor = (filePath: string): FileProvenance => ({
    filePath,
    lastAuthor: { name: 'A', email: 'a@example.com' },
    lastDate: '2026-01-01T00:00:00Z',
    lastCommit: 'abc1234',
    lastSubject: 'subject',
    recentAuthors: [{ name: 'A', email: 'a@example.com' }],
    prs: [],
  });

  beforeEach(async () => {
    dir = await tmp('hot-path-store-');
    store = EdgeStore.open(join(dir, 'call-graph.db'));
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the same rows the tolerant full-scan comparator would', () => {
    const paths = ['src/a.ts', 'src/nested/b.ts', 'src/c.ts', 'other/a.ts'];
    store.insertProvenance(paths.map(provenanceFor));

    // Exact match.
    expect(store.getProvenanceForFiles(['src/c.ts']).map(r => r.filePath)).toEqual(['src/c.ts']);
    // Leading-slash tolerance.
    expect(store.getProvenanceForFiles(['/src/c.ts']).map(r => r.filePath)).toEqual(['src/c.ts']);
    // The wanted path is longer: a stored path is its suffix.
    expect(store.getProvenanceForFiles(['/abs/repo/src/nested/b.ts']).map(r => r.filePath))
      .toEqual(['src/nested/b.ts']);
    // The wanted path is shorter: it is a suffix of stored paths — BOTH match.
    expect(store.getProvenanceForFiles(['a.ts']).map(r => r.filePath)).toEqual(['other/a.ts', 'src/a.ts']);
    // No match is empty, not everything.
    expect(store.getProvenanceForFiles(['src/missing.ts'])).toEqual([]);
    // An empty request short-circuits.
    expect(store.getProvenanceForFiles([])).toEqual([]);
    expect(store.getProvenanceForFiles([''])).toEqual([]);
  });

  it('a path holding SQL LIKE wildcards matches literally', () => {
    store.insertProvenance(['src/a%b.ts', 'src/axb.ts'].map(provenanceFor));
    expect(store.getProvenanceForFiles(['src/a%b.ts']).map(r => r.filePath)).toEqual(['src/a%b.ts']);
    expect(store.getProvenanceForFiles(['a_b.ts'])).toEqual([]);
  });

  it('one file out of many is answered without materializing the rest', () => {
    store.insertProvenance(
      Array.from({ length: 5_000 }, (_, i) => provenanceFor(`src/gen/file-${i}.ts`)),
    );
    const rows = store.getProvenanceForFiles(['src/gen/file-4321.ts']);
    expect(rows.map(r => r.filePath)).toEqual(['src/gen/file-4321.ts']);
  });

  it('change coupling answers the same way', () => {
    store.insertChangeCoupling({
      churn: new Map([['src/a.ts', 4], ['src/b.ts', 9]]),
      coupling: new Map([['src/a.ts', [{ file: 'src/b.ts', support: 3, confidence: 0.75 }]]]),
      stats: { commitsScanned: 10, bulkCommitsFiltered: 0, filesTracked: 2 },
    });
    expect(store.getChangeCouplingForFiles(['src/b.ts']).map(r => r.filePath)).toEqual(['src/b.ts']);
    expect(store.getChangeCouplingForFiles(['/repo/src/a.ts']).map(r => r.filePath)).toEqual(['src/a.ts']);
    expect(store.getChangeCouplingForFiles(['src/none.ts'])).toEqual([]);
  });

  it('neither getter falls back to a full table scan', async () => {
    const source = await readFile(join(SRC_ROOT, 'core/services/edge-store.ts'), 'utf-8');
    expect(source).not.toContain("'SELECT * FROM provenance'");
    expect(source).not.toContain("'SELECT * FROM change_coupling'");
  });

  it('an id list larger than SQLite’s bound-variable ceiling is chunked, not rejected', () => {
    const callerIds = Array.from({ length: 2_500 }, (_, i) => `src/f${i}.ts::fn${i}`);
    store.insertEdges(callerIds.map((callerId, i) => ({
      callerId,
      calleeId: 'src/target.ts::target',
      calleeName: 'target',
      confidence: 'import' as const,
      line: i + 1,
    })));

    // Both directions: one graph-sized frontier in a single call.
    expect(store.getCalleesForIds(callerIds).length).toBe(2_500);
    expect(store.getCallersForIds(['src/target.ts::target']).length).toBe(2_500);
  });
});

// ── DerivedGraphStructuresAreMemoizedPerAnalysis ─────────────────────────────

describe('graph-walking tools do not rebuild adjacency per invocation', () => {
  it('buildAdjacency has no production caller — the traversal index serves the handlers', async () => {
    const graphSource = await readFile(join(SRC_ROOT, 'core/services/mcp-handlers/graph.ts'), 'utf-8');
    // It survives only as the frozen reference the traversal index is pinned against.
    expect(graphSource).toContain('export function buildAdjacency');

    const { readdir } = await import('node:fs/promises');
    const offenders: string[] = [];
    const walk = async (relDir: string): Promise<void> => {
      for (const entry of await readdir(join(SRC_ROOT, relDir), { withFileTypes: true })) {
        const rel = join(relDir, entry.name);
        if (entry.isDirectory()) { await walk(rel); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if (entry.name.endsWith('.test.ts') || rel.includes('fixtures')) continue;
        if (rel.endsWith(join('mcp-handlers', 'graph.ts'))) continue;      // the definition
        if (rel.endsWith(join('analyzer', 'condensation.ts'))) continue;   // documents it in prose
        const body = await readFile(join(SRC_ROOT, rel), 'utf-8');
        if (/\bbuildAdjacency\s*\(/.test(body)) offenders.push(rel);
      }
    };
    await walk('core');
    expect(offenders).toEqual([]);
  });

  it('orient reads the repository config once per call', async () => {
    const source = await readFile(join(SRC_ROOT, 'core/services/mcp-handlers/orient.ts'), 'utf-8');
    const reads = source.match(/await readOpenLoreConfig\(/g) ?? [];
    expect(reads.length).toBe(1);
  });

  it('orient reads its sibling artifacts through the stamp-keyed cache', async () => {
    const source = await readFile(join(SRC_ROOT, 'core/services/mcp-handlers/orient.ts'), 'utf-8');
    expect(source).not.toMatch(/readFile\(join\(outputDir, 'dependency-graph\.json'\)/);
    expect(source).not.toMatch(/readFile\(join\(outputDir, ARTIFACT_STYLE_FINGERPRINT\)/);
  });

  it('get_function_body reads the analysis through the shared context cache', async () => {
    const source = await readFile(join(SRC_ROOT, 'core/services/mcp-handlers/analysis.ts'), 'utf-8');
    // A single-symbol tool must not parse the whole artifact outside the cache.
    expect(source).not.toMatch(/readFile\(contextPath, 'utf-8'\)/);
  });
});
