import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, open, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VectorIndex,
  TOKENIZER_VERSION,
  _resetVectorIndexCachesForTesting,
} from './vector-index.js';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';

// Coverage for `persist-tokenized-keyword-corpus`: the BM25 corpus is persisted to
// a stamped sidecar, hydrated on cold start instead of re-tokenizing, and
// rebuilt-not-served on tokenizer skew / corruption. An incremental patch drops it.

function node(id: string, name: string, filePath: string): FunctionNode {
  return { id, name, filePath, language: 'TypeScript', isAsync: false, startIndex: 0, endIndex: 10, fanIn: 1, fanOut: 0 };
}

const NODES: FunctionNode[] = [
  node('src/users.ts::getUserById', 'getUserById', 'src/users.ts'),
  node('src/db.ts::connectDatabase', 'connectDatabase', 'src/db.ts'),
  // `user` occurs three times in this one document (path, and twice in the name), so a document
  // frequency that counted OCCURRENCES rather than DOCUMENTS would differ here. Without such a
  // node the two are numerically identical and the distinction cannot be tested at all.
  node('src/user/user.ts::userFromUser', 'userFromUser', 'src/user/user.ts'),
];
const SIGS: FileSignatureMap[] = [];
const MARKER = 'zzuniquemarkerzz'; // a token that appears in no node's raw text

describe('BM25 corpus persistence', () => {
  let tmpDir: string;
  let sidecar: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-bm25-persist-'));
    sidecar = join(tmpDir, 'vector-index', 'bm25-corpus.json');
    _resetVectorIndexCachesForTesting();
  });

  /** Inject `MARKER` into the persisted corpus for `getUserById`, so a query for it
   * hits ONLY if the sidecar (not a raw-text rebuild) was consulted. Keeps N and
   * doc ids intact so the integrity cross-check passes. */
  async function injectMarkerIntoSidecar(tokenizerVersion = TOKENIZER_VERSION): Promise<void> {
    const p = JSON.parse(await readFile(sidecar, 'utf-8'));
    p.tokenizerVersion = tokenizerVersion;
    const doc = p.docs.find((d: { id: string }) => d.id === 'src/users.ts::getUserById');
    doc.tf.push([MARKER, 1]);
    doc.length += 1;
    p.df.push([MARKER, 1]);
    await writeFile(sidecar, JSON.stringify(p), 'utf-8');
  }

  it('the streamed sidecar agrees with the documents it wrote', async () => {
    // The build path no longer materializes a corpus at all — it tokenizes each record, writes
    // it, and drops it, because holding the corpus, its array-reshaped payload, and the finished
    // JSON string at once measured 1,575 MB on a 152,046-function repository.
    //
    // The risk that introduces is in the ACCUMULATION: `df`, `avgLength` and `N` are now built
    // incrementally and emitted after the documents, so this re-derives all three from the
    // documents actually written and requires them to agree. A mis-accumulated `df` silently
    // corrupts every ranking, and nothing else in this file would notice.
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    const p = JSON.parse(await readFile(sidecar, 'utf-8'));

    expect(p.docs.length).toBeGreaterThan(0);
    expect(p.N).toBe(p.docs.length);

    const expectedAvg = p.docs.reduce((a: number, d: { length: number }) => a + d.length, 0) / p.docs.length;
    expect(p.avgLength).toBeCloseTo(expectedAvg, 10);

    // Document frequency = how many documents contain the token at all, and its entry order is
    // first-appearance order across documents — both properties of the incremental build.
    //
    // Guard the fixture first: if no document repeats a token, "count documents" and "count
    // occurrences" produce identical numbers and the assertion below proves nothing.
    const repeated = (p.docs as Array<{ tf: Array<[string, number]> }>)
      .some(d => d.tf.some(([, c]) => c > 1));
    expect(repeated, 'fixture cannot distinguish per-document from per-occurrence df').toBe(true);

    const expectedDf = new Map<string, number>();
    for (const d of p.docs as Array<{ tf: Array<[string, number]> }>) {
      for (const [t] of d.tf) expectedDf.set(t, (expectedDf.get(t) ?? 0) + 1);
    }
    expect(p.df).toEqual([...expectedDf]);

    // Each document's token counts must be a proper tally of its own length.
    for (const d of p.docs as Array<{ id: string; length: number; tf: Array<[string, number]> }>) {
      const counted = d.tf.reduce((a, [, c]) => a + c, 0);
      expect(counted, `${d.id}: tf counts must sum to the document length`).toBe(d.length);
      expect(new Set(d.tf.map(([t]) => t)).size, `${d.id}: duplicate token entries`).toBe(d.tf.length);
    }
  });

  it('a sidecar written by streaming is readable by the normal search path', async () => {
    // End-to-end: the cold-start hydration path must accept what the build path now writes.
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    _resetVectorIndexCachesForTesting();
    const results = await VectorIndex.search(tmpDir, 'getUserById', null, { limit: 5 });
    expect(results.some((r) => r.record.name === 'getUserById')).toBe(true);
  });

  it('build() writes a stamped corpus sidecar', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    expect(existsSync(sidecar)).toBe(true);
    const p = JSON.parse(await readFile(sidecar, 'utf-8'));
    expect(p.tokenizerVersion).toBe(TOKENIZER_VERSION);
    expect(p.schemaVersion).toBe(1);
    expect(p.docs).toHaveLength(NODES.length);
  });

  it('a valid-JSON payload mutation is rejected and rebuilt from authoritative text', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    await injectMarkerIntoSidecar();
    _resetVectorIndexCachesForTesting();

    // MARKER is only in the mutated sidecar, never in raw text. Payload integrity
    // validation must reject it even though the authoritative content hash still matches.
    const results = await VectorIndex.search(tmpDir, MARKER, null, { limit: 10 });
    expect(results).toEqual([]);
    expect(await readFile(sidecar, 'utf-8')).not.toContain(MARKER);
  });

  it('a tokenizer-version mismatch rebuilds and never serves the stale sidecar', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    await injectMarkerIntoSidecar(TOKENIZER_VERSION - 1); // stamp it stale
    _resetVectorIndexCachesForTesting();

    // Stale sidecar ignored → MARKER (sidecar-only) must NOT match…
    const marker = await VectorIndex.search(tmpDir, MARKER, null, { limit: 10 });
    expect(marker.length).toBe(0);
    // …but a real query still works (rebuilt from raw text)…
    const real = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(real.some((r) => r.record.name === 'getUserById')).toBe(true);
    // …and the sidecar is re-stamped to the current version (marker dropped).
    const p = JSON.parse(await readFile(sidecar, 'utf-8'));
    expect(p.tokenizerVersion).toBe(TOKENIZER_VERSION);
    expect(JSON.stringify(p).includes(MARKER)).toBe(false);
  });

  it('a tokenizer-stamp rebuild keeps synthetic external nodes out of the corpus', async () => {
    const external = {
      ...node('external::id.startsWith', 'id.startsWith', 'external'),
      isExternal: true,
    };
    await VectorIndex.build(tmpDir, [...NODES, external], SIGS, new Set(), new Set(), null);
    const stale = JSON.parse(await readFile(sidecar, 'utf-8'));
    stale.tokenizerVersion = TOKENIZER_VERSION - 1;
    await writeFile(sidecar, JSON.stringify(stale), 'utf-8');
    _resetVectorIndexCachesForTesting();

    expect(await VectorIndex.search(tmpDir, 'startsWith', null, { limit: 10 })).toEqual([]);
    const rebuilt = JSON.parse(await readFile(sidecar, 'utf-8'));
    expect(rebuilt.docs).toHaveLength(NODES.length);
    expect(rebuilt.docs.some((doc: { id: string }) => doc.id.startsWith('external::'))).toBe(false);
  });

  it('a missing sidecar degrades to a raw-text rebuild (and re-persists)', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    await rm(sidecar);
    _resetVectorIndexCachesForTesting();

    const results = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(results.some((r) => r.record.name === 'getUserById')).toBe(true);
    expect(existsSync(sidecar)).toBe(true); // re-persisted for the next process
  });

  it('a corrupt sidecar degrades without throwing (and re-persists)', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    await writeFile(sidecar, 'not json {{{', 'utf-8');
    _resetVectorIndexCachesForTesting();

    const results = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(results.some((r) => r.record.name === 'getUserById')).toBe(true);
    const p = JSON.parse(await readFile(sidecar, 'utf-8')); // valid again
    expect(p.tokenizerVersion).toBe(TOKENIZER_VERSION);
  });

  it('rejects an oversized sidecar before JSON parsing and rebuilds it', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    const handle = await open(sidecar, 'w');
    try {
      // This fixture's authoritative corpus permits the 1 MiB minimum cap.
      // A sparse file keeps the adversarial test cheap while proving the stat
      // guard runs before allocation/JSON parsing.
      await handle.truncate(1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    _resetVectorIndexCachesForTesting();

    const results = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(results.some(result => result.record.name === 'getUserById')).toBe(true);
    expect((await stat(sidecar)).size).toBeLessThan(1024 * 1024);
  });

  it('rejects malformed numeric corpus fields before constructing scoring maps', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    const malformed = JSON.parse(await readFile(sidecar, 'utf8'));
    malformed.docs[0].length = -1;
    malformed.docs[0].tf[0][1] = -1;
    malformed.avgLength = -1;
    await writeFile(sidecar, JSON.stringify(malformed), 'utf8');
    _resetVectorIndexCachesForTesting();

    const results = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(results.some(result => result.record.name === 'getUserById')).toBe(true);
    const repaired = JSON.parse(await readFile(sidecar, 'utf8'));
    expect(repaired.avgLength).toBeGreaterThan(0);
    expect(repaired.docs.every((doc: { length: number }) => doc.length >= 0)).toBe(true);
  });

  it('an incremental update invalidates the sidecar', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    expect(existsSync(sidecar)).toBe(true);
    _resetVectorIndexCachesForTesting();

    await VectorIndex.updateFiles(tmpDir, NODES, new Set(['src/users.ts']), SIGS, new Set(), new Set(), null);
    expect(existsSync(sidecar)).toBe(false); // dropped so next cold start rebuilds
  });

  it('a defensive doc-count mismatch is ignored in favour of a rebuild', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    const p = JSON.parse(await readFile(sidecar, 'utf-8'));
    p.N = 999; // lie about the corpus size
    await writeFile(sidecar, JSON.stringify(p), 'utf-8');
    _resetVectorIndexCachesForTesting();

    const results = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(results.some((r) => r.record.name === 'getUserById')).toBe(true);
  });

  it('rejects a same-count corpus sidecar after authoritative indexed text changes', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    await injectMarkerIntoSidecar();
    const stale = JSON.parse(await readFile(sidecar, 'utf-8'));

    // Mutate the authoritative table out of band without changing its row count
    // or deleting the old corpus. Count-only validation would serve stale tokens.
    const { connect } = await import('@lancedb/lancedb');
    const db = await connect(join(tmpDir, 'vector-index'));
    const table = await db.openTable('functions');
    const rows = await table.query().toArray() as Record<string, unknown>[];
    const target = rows.find((row) => row.id === 'src/users.ts::getUserById')!;
    target.name = 'findAccountByKey';
    target.text = '[TypeScript] src/users.ts findAccountByKey\nfind account by key';
    await db.createTable('functions', rows, { mode: 'overwrite' });
    _resetVectorIndexCachesForTesting();

    expect(await VectorIndex.search(tmpDir, MARKER, null, { limit: 10 })).toEqual([]);
    const fresh = await VectorIndex.search(tmpDir, 'findAccountByKey', null, { limit: 10 });
    expect(fresh.some((result) => result.record.name === 'findAccountByKey')).toBe(true);

    const rebuilt = JSON.parse(await readFile(sidecar, 'utf-8'));
    expect(rebuilt.N).toBe(stale.N);
    expect(rebuilt.contentHash).not.toBe(stale.contentHash);
  });

  it('hydrated results equal a fresh rebuild for the same query', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    _resetVectorIndexCachesForTesting();
    const hydrated = await VectorIndex.search(tmpDir, 'connect', null, { limit: 10 });

    await rm(sidecar); // force the rebuild path
    _resetVectorIndexCachesForTesting();
    const rebuilt = await VectorIndex.search(tmpDir, 'connect', null, { limit: 10 });

    expect(hydrated.map((r) => r.record.id)).toEqual(rebuilt.map((r) => r.record.id));
    expect(hydrated.map((r) => r.score)).toEqual(rebuilt.map((r) => r.score));
  });
});
