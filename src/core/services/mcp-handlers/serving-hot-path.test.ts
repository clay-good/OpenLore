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
  _readArtifactBoundedForTesting,
} from './artifact-cache.js';
import { EdgeStore } from '../edge-store.js';
import {
  buildBm25Corpus,
  bm25CandidateDocs,
  bm25Score,
  _patchBm25CorpusForTesting,
  _patchBm25CorpusCarryingPostingsForTesting,
  _bm25WorkCountersForTesting,
  _resetBm25WorkCountersForTesting,
} from '../../analyzer/vector-index.js';
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

  it('artifactStamp distinguishes two same-length writes that land in the same millisecond', async () => {
    const { stat } = await import('node:fs/promises');
    const path = join(dir, 'rapid.json');
    // Keep writing until two consecutive writes actually share an mtimeMs — otherwise
    // this would pass against a millisecond-resolution stamp and prove nothing.
    let observed = false;
    for (let i = 0; i < 400 && !observed; i++) {
      await writeFile(path, '{"a":1}');
      const first = await stat(path, { bigint: true });
      const before = await artifactStamp(path);
      await writeFile(path, '{"a":2}');
      const second = await stat(path, { bigint: true });
      if (first.mtimeMs !== second.mtimeMs) continue;
      observed = true;
      expect(before).not.toBeNull();
      expect(await artifactStamp(path)).not.toBe(before);
    }
    // Nanosecond resolution is what makes this reachable; if the filesystem never
    // produced a collision, say so rather than reporting a pass that proved nothing.
    expect(observed, 'no same-millisecond write pair occurred on this filesystem').toBe(true);
  });

  // Regression: the stamp used to be re-taken from the PATH after the read. A writer
  // landing in that window made the cache store the OLD content under the NEW file's
  // stamp — strictly worse than no stamp, because every later call then hit the cache
  // and served stale content believing it current.
  it('the stamp describes the bytes actually read, not whatever is on the path afterwards', async () => {
    const path = join(dir, 'raced.json');
    await writeFile(path, '{"v":"OLD"}');
    const read = await _readArtifactBoundedForTesting(path);
    expect(read?.text).toBe('{"v":"OLD"}');
    // Same length, so only the identity part of the stamp can separate them.
    await writeFile(path, '{"v":"NEW"}');
    expect(await artifactStamp(path)).not.toBe(read?.stamp);
  });

  it('a symlink in place of an artifact is refused, not followed', async () => {
    const { symlink } = await import('node:fs/promises');
    const real = join(dir, 'elsewhere.json');
    const link = join(dir, 'linked.json');
    await writeFile(real, '{"v":1}');
    await symlink(real, link);
    expect(await _readArtifactBoundedForTesting(link)).toBeNull();
    expect(await readJsonArtifactCached(link, 'k', (p: unknown) => p)).toBeNull();
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

  // The requirement is about WORK, so count it — a length comparison would pass even
  // if every document were scored.
  it('the number of documents scored is the match count, whatever the corpus size', () => {
    for (const size of [500, 20_000]) {
      _resetBm25WorkCountersForTesting();
      const found = bm25CandidateDocs(corpusWithNeedles(size, [1, 2, 3]), ['needleterm']);
      expect(found.length).toBe(3);
      expect(_bm25WorkCountersForTesting().docsScored).toBe(3);
    }
    _resetBm25WorkCountersForTesting();
  });

  // Regression: the postings index was memoized on the corpus OBJECT, and an incremental
  // patch returns a NEW object — so every watcher save threw the index away and the next
  // search rebuilt it over the whole corpus. In an edit-heavy agent loop that is the
  // common case, and it made keyword search several times SLOWER than the full scan it
  // replaced. The patch must carry the index forward.
  it('an incremental patch carries the postings index forward instead of rebuilding it', () => {
    const before = Array.from({ length: 400 }, (_, i) => ({
      id: `src/f${i}.ts::fn`, filePath: `src/f${i}.ts`, text: `alpha token${i}`,
    }));
    const corpus = buildBm25Corpus(before.map(r => ({ id: r.id, text: r.text })));

    _resetBm25WorkCountersForTesting();
    bm25CandidateDocs(corpus, ['token7']);
    expect(_bm25WorkCountersForTesting().postingsBuilds).toBe(1);

    const added = [{ id: 'src/f7.ts::fn', filePath: 'src/f7.ts', text: 'alpha replacedToken' }];
    const patched = _patchBm25CorpusCarryingPostingsForTesting(corpus, before, new Set(['src/f7.ts']), added);

    // No second build: the patch handed the derived index to the cache.
    bm25CandidateDocs(patched, ['replacedtoken']);
    expect(_bm25WorkCountersForTesting().postingsBuilds).toBe(1);
    _resetBm25WorkCountersForTesting();
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

  it('every keyword-cache insertion strips the embedding column', async () => {
    const source = await readFile(join(SRC_ROOT, 'core/analyzer/vector-index.ts'), 'utf-8');
    // Every place rows are materialized from the table and then RETAINED must pass
    // through the stripper — a guard covering only some of them would stay green while
    // one path put vectors straight back into the cache.
    const materializations = source.match(/(?:const rows|allRows) = [\s\S]{0,240}?isRepoFunctionRow\)/g) ?? [];
    expect(materializations.length).toBeGreaterThanOrEqual(3);
    for (const site of materializations) expect(site).toContain('withoutEmbeddingColumn');
    // And the patch path, which splices caller-supplied rows into the same cache.
    expect(source).toMatch(/patchBm25Corpus\([\s\S]{0,160}?withoutEmbeddingColumn\(newRows\)/);
  });

  // Regression: the postings index is keyed by document id, so a corpus with duplicate
  // ids cannot be patched by id — removing one of the twins would delete the SURVIVOR
  // from its terms. The guard that catches this must survive the patch, or the survivor
  // silently disappears from keyword search for the life of the cache.
  it('a corpus with duplicate document ids is not patched by id', () => {
    const before = [
      { id: 'X', filePath: 'a.ts', text: 'foo' },
      { id: 'X', filePath: 'b.ts', text: 'foo' },
      { id: 'Y', filePath: 'c.ts', text: 'bar' },
    ];
    const corpus = buildBm25Corpus(before.map(r => ({ id: r.id, text: r.text })));
    bm25CandidateDocs(corpus, ['foo']);  // build the postings, duplicates and all

    const patched = _patchBm25CorpusCarryingPostingsForTesting(corpus, before, new Set(['a.ts']), []);

    const found = bm25CandidateDocs(patched, ['foo']);
    const bruteForce = patched.docs.map((_, i) => i).filter(i => bm25Score(patched, ['foo'], i) > 0);
    expect(found).toEqual(bruteForce);
    expect(found.length).toBe(1);  // b.ts survived and is still findable
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
    // The wanted path is shorter: it is a suffix of stored paths — BOTH match, in
    // table order (src/a.ts was inserted first).
    expect(store.getProvenanceForFiles(['a.ts']).map(r => r.filePath)).toEqual(['src/a.ts', 'other/a.ts']);
    // No match is empty, not everything.
    expect(store.getProvenanceForFiles(['src/missing.ts'])).toEqual([]);
    // An empty request short-circuits.
    expect(store.getProvenanceForFiles([])).toEqual([]);
    expect(store.getProvenanceForFiles([''])).toEqual([]);
  });

  // Regression: an earlier form of the suffix predicate used SQL `LIKE`, which is
  // ASCII-case-INSENSITIVE by default, so `get_change_coupling {file: "Utils.ts"}`
  // silently answered with `src/utils.ts`'s record. Path matching is case-sensitive.
  it('the suffix match is case-sensitive, like the comparator it replaced', () => {
    store.insertProvenance(['src/Utils.ts'].map(provenanceFor));
    expect(store.getProvenanceForFiles(['Utils.ts']).map(r => r.filePath)).toEqual(['src/Utils.ts']);
    expect(store.getProvenanceForFiles(['utils.ts'])).toEqual([]);
    expect(store.getProvenanceForFiles(['UTILS.TS'])).toEqual([]);
    expect(store.getProvenanceForFiles(['src/utils.ts'])).toEqual([]);
  });

  // Callers take `records[0]` and `slice(0, 10)` from these lists, so the order the
  // previous full-scan implementation returned (the table's own order) is observable.
  it('rows come back in table order, not sorted by path', () => {
    const inserted = ['src/z.ts', 'src/a.ts', 'src/m.ts'];
    store.insertProvenance(inserted.map(provenanceFor));
    expect(store.getProvenanceForFiles(inserted).map(r => r.filePath)).toEqual(inserted);
    // A basename hint matching several rows keeps insertion order too.
    store.insertProvenance(['b/dup.ts', 'a/dup.ts'].map(provenanceFor));
    expect(store.getProvenanceForFiles(['dup.ts']).map(r => r.filePath)).toEqual(['b/dup.ts', 'a/dup.ts']);
  });

  it('a path holding SQL wildcard characters matches literally', () => {
    store.insertProvenance(['src/a%b.ts', 'src/axb.ts'].map(provenanceFor));
    expect(store.getProvenanceForFiles(['src/a%b.ts']).map(r => r.filePath)).toEqual(['src/a%b.ts']);
    expect(store.getProvenanceForFiles(['a_b.ts'])).toEqual([]);
  });

  it('one file out of many is answered without materializing the rest', async () => {
    store.insertProvenance(
      Array.from({ length: 5_000 }, (_, i) => provenanceFor(`src/gen/file-${i}.ts`)),
    );
    const rows = store.getProvenanceForFiles(['src/gen/file-4321.ts']);
    expect(rows.map(r => r.filePath)).toEqual(['src/gen/file-4321.ts']);

    // Observable, not merely asserted by the title: the row fetch is answered from the
    // primary key, and the pass that must scan reads only the indexed column.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'call-graph.db'), { readOnly: true });
    try {
      const planOf = (sql: string): string =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as Array<{ detail: string }>)
          .map(r => r.detail).join(' | ');
      expect(planOf('SELECT rowid AS __rowid, * FROM provenance WHERE file_path IN (?)'))
        .toMatch(/USING (PRIMARY KEY|INDEX)/i);
      expect(planOf('SELECT file_path FROM provenance')).toMatch(/COVERING INDEX/i);
    } finally {
      db.close();
    }
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

  it('both batch edge reads chunk their bound-parameter lists', async () => {
    // Behavioural proof is not available here: this Node build's SQLite accepts far more
    // bound parameters than the 999 of a pre-3.32 build, so an over-long IN list does not
    // fail on this runtime. The chunking exists for the builds where it does, so pin it
    // structurally — the way the repo pins its other portability invariants.
    const source = await readFile(join(SRC_ROOT, 'core/services/edge-store.ts'), 'utf-8');
    for (const method of ['getCalleesForIds', 'getCallersForIds']) {
      const body = source.slice(source.indexOf(`${method}(`), source.indexOf(`${method}(`) + 700);
      expect(body, `${method} must chunk its IN list`).toContain('chunkForSqlIn');
    }
    // And no unbounded id list is built anywhere in the file.
    expect(source).not.toMatch(/ids\.map\(\(\) => '\?'\)/);
  });

  it('a graph-sized frontier is answered correctly in a single call', () => {
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
    await walk('.');
    expect(offenders).toEqual([]);
  });

  it('weighted adjacency is memoized per call graph, and the memo equals a fresh build', async () => {
    const { buildWeightedAdjacency, computeWeightedAdjacency } = await import('./graph.js');
    const cg = {
      nodes: [
        { id: 'a::f', name: 'f', filePath: 'a.ts' },
        { id: 'b::g', name: 'g', filePath: 'b.ts' },
      ],
      edges: [{ callerId: 'a::f', calleeId: 'b::g', calleeName: 'g', confidence: 'import', kind: 'calls' }],
    } as never;

    const first = buildWeightedAdjacency(cg);
    expect(buildWeightedAdjacency(cg)).toBe(first);            // same object: not rebuilt
    const fresh = computeWeightedAdjacency(cg);
    expect(fresh).not.toBe(first);                              // …and the memo is not trivial
    expect([...first.forward.entries()]).toEqual([...fresh.forward.entries()]);
    expect([...first.backward.entries()]).toEqual([...fresh.backward.entries()]);
  });

  // Not a cache — config is re-read, never cached — so what this pins is that ONE orient
  // does not parse .openlore/config.json three times, which is what it used to do.
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
