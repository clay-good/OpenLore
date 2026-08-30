/**
 * VectorIndex
 *
 * Builds and queries a LanceDB vector index over the call graph functions.
 * Each function is represented by a document combining its signature, docstring,
 * file path, language, and topological metadata (fanIn/fanOut, hub, entry point).
 *
 * Storage: <outputDir>/vector-index/  (LanceDB database folder)
 * Table name: "functions"
 *
 * Usage:
 *   // Build (after openlore analyze --embed)
 *   await VectorIndex.build(outputDir, nodes, signatures, hubIds, entryPointIds, embedSvc);
 *
 *   // Search
 *   const results = await VectorIndex.search(outputDir, "authenticate user with JWT", embedSvc);
 */

import { constants, existsSync, readFileSync, writeFileSync, rmSync, openSync, readSync, writeSync, closeSync, statSync, fstatSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';
import type { Embedder } from './embedding-service.js';
import { getSkeletonContent, isSkeletonWorthIncluding } from './code-shaper.js';
import { quietNativeLoggingOnce } from './lance-logging.js';
import { noteUpdateAndMaybeCompact } from './index-compaction.js';
import { TOKENIZER_VERSION, tokenize } from './bm25-tokenizer.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { acquireLockAt } from '../runtime/advisory-lock.js';
import {
  LEXICAL_MATCH_FIELDS,
  type MatchEvidence,
  type SearchableFields,
  vectorMatchEvidence,
} from './retrieval-evidence.js';

export type { MatchEvidence, MatchField, RetrievalTier } from './retrieval-evidence.js';

export { TOKENIZER_VERSION, tokenize } from './bm25-tokenizer.js';

// ============================================================================
// TYPES
// ============================================================================

export interface FunctionRecord {
  id: string;
  name: string;
  filePath: string;
  className: string;
  language: string;
  signature: string;
  docstring: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
  isEntryPoint: boolean;
  /** Concatenated text used for embedding */
  text: string;
  /** Embedding vector */
  vector: number[];
}

export interface SearchResult {
  record: Omit<FunctionRecord, 'vector'>;
  /**
   * Relevance score.  For hybrid search (default): RRF score, higher = more relevant.
   * For dense-only search: cosine distance from LanceDB, lower = more similar.
   */
  score: number;
  /** Optional for legacy test doubles; every production search path emits it. */
  scoreKind?: 'rrf' | 'bm25' | 'cosine_distance';
  /** Optional for legacy test doubles; every production search path emits it. */
  matchEvidence?: MatchEvidence;
}

export interface KeywordMissDiagnostics {
  missedTokens: string[];
  nearTokens: Array<{ queryToken: string; indexedTokens: string[] }>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DB_FOLDER = 'vector-index';
const TABLE_NAME = 'functions';

/**
 * Sidecar metadata file, sibling to the LanceDB `vector-index/` folder.
 * Single source of truth for whether ANN (dense) search is available: a
 * BM25-only index has `hasEmbeddings: false` and no `vector` column, so search
 * must never attempt to embed a query or run ANN against it.
 */
const META_FILE = 'vector-index-meta.json';
const META_SCHEMA_VERSION = 1;

export interface VectorIndexMeta {
  hasEmbeddings: boolean;
  dim: number;
  model: string | null;
  builtAt: string;
  /** Changes only after a complete rebuild; incremental mutations preserve it. */
  fullBuildAt?: string;
  schemaVersion: number;
  /**
   * Version of the BM25 tokenizer that produced this index's corpus. A mismatch
   * against the running `TOKENIZER_VERSION` means an incremental patch would mix
   * token sets, so `updateFiles` defers (`deferred: 'tokenizer-changed'`) and a
   * full rebuild re-stamps. A legacy meta without this field is treated as v1.
   */
  tokenizerVersion?: number;
  /** Present only when an incremental update could neither add nor restore rows. */
  degraded?: {
    reason: 'incremental-update-restore-failed';
    recordedAt: string;
  };
}

const INVALID_META = Symbol('invalid-vector-index-meta');
type MetaReadResult = VectorIndexMeta | null | typeof INVALID_META;

interface CachedMeta {
  value: MetaReadResult;
  /** Filesystem identity captured after the sidecar was read. */
  stamp: string | null;
}

// Module-level meta cache, keyed by dbPath. The filesystem stamp makes it
// coherent with rebuilds performed by another process.
const _metaCache = new Map<string, CachedMeta>();

function metaFilePath(outputDir: string): string {
  return join(outputDir, META_FILE);
}

function dbPathFor(outputDir: string): string {
  const absolute = resolve(outputDir, DB_FOLDER);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function metaStamp(outputDir: string): string | null {
  try {
    const stat = statSync(metaFilePath(outputDir), { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
  } catch {
    return null;
  }
}

function openMetaStamp(fd: number): string | null {
  try {
    const stat = fstatSync(fd, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
  } catch {
    return null;
  }
}

/**
 * Read the index metadata sidecar (cached per dbPath).
 * Returns null only when no sidecar exists — e.g. a legacy index built before
 * the sidecar was introduced. A present but malformed sidecar is explicitly
 * invalid, so callers never mistake corruption for a valid dense legacy index.
 */
function readMeta(outputDir: string): MetaReadResult {
  const dbPath = dbPathFor(outputDir);
  const stamp = metaStamp(outputDir);
  const cached = _metaCache.get(dbPath);
  if (cached && cached.stamp === stamp) return cached.value;
  if (cached) invalidateDbPathCaches(dbPath);

  // Require a stable pre/post-read stamp. A concurrent atomic rename causes a
  // retry; a malformed file that exists is never cached as legacy-null.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    let before: string | null = null;
    try {
      fd = openSync(metaFilePath(outputDir), 'r');
      before = openMetaStamp(fd);
      const parsed = JSON.parse(readFileSync(fd, 'utf-8')) as unknown;
      const after = openMetaStamp(fd);
      const currentPath = metaStamp(outputDir);
      if (before !== after || after !== currentPath) continue;
      const meta = isVectorIndexMeta(parsed) ? parsed : INVALID_META;
      _metaCache.set(dbPath, { value: meta, stamp: currentPath });
      return meta;
    } catch {
      const after = fd === undefined ? null : openMetaStamp(fd);
      const currentPath = metaStamp(outputDir);
      if (before !== after || after !== currentPath) continue;
      const value = before === null ? null : INVALID_META;
      _metaCache.set(dbPath, { value, stamp: currentPath });
      return value;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return INVALID_META;
}

function isVectorIndexMeta(value: unknown): value is VectorIndexMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Record<string, unknown>;
  if (typeof meta.hasEmbeddings !== 'boolean') return false;
  if (!Number.isInteger(meta.dim) || (meta.dim as number) < 0) return false;
  if (meta.model !== null && typeof meta.model !== 'string') return false;
  if (typeof meta.builtAt !== 'string' || meta.builtAt.length === 0) return false;
  if (meta.fullBuildAt !== undefined && typeof meta.fullBuildAt !== 'string') return false;
  if (meta.schemaVersion !== META_SCHEMA_VERSION) return false;
  if (meta.tokenizerVersion !== undefined && !Number.isInteger(meta.tokenizerVersion)) return false;
  if (meta.hasEmbeddings) {
    if ((meta.dim as number) === 0 || typeof meta.model !== 'string' || meta.model.length === 0) return false;
  } else if (meta.dim !== 0 || meta.model !== null) {
    return false;
  }
  if (meta.degraded !== undefined) {
    if (!meta.degraded || typeof meta.degraded !== 'object') return false;
    const degraded = meta.degraded as Record<string, unknown>;
    if (degraded.reason !== 'incremental-update-restore-failed'
        || typeof degraded.recordedAt !== 'string') return false;
  }
  return true;
}

/** Missing metadata is the only supported dense legacy shape; corruption fails closed to BM25. */
function metaHasEmbeddings(meta: MetaReadResult): boolean {
  return meta === null || (meta !== INVALID_META && meta.hasEmbeddings);
}

async function writeMeta(outputDir: string, meta: VectorIndexMeta): Promise<void> {
  await atomicWriteFile(metaFilePath(outputDir), JSON.stringify(meta, null, 2) + '\n');
}

/** Convert a raw LanceDB row to a FunctionRecord (without the vector field). */
function rowToRecord(row: Record<string, unknown>): Omit<FunctionRecord, 'vector'> {
  return {
    id:          row.id as string,
    name:        row.name as string,
    filePath:    row.filePath as string,
    className:   row.className as string,
    language:    row.language as string,
    signature:   row.signature as string,
    docstring:   row.docstring as string,
    fanIn:       row.fanIn as number,
    fanOut:      row.fanOut as number,
    isHub:       row.isHub as boolean,
    isEntryPoint: row.isEntryPoint as boolean,
    text:        row.text as string,
  };
}

/** change: fix-empty-orient-and-corpus-honesty */
function isRepoFunction(node: Pick<FunctionNode, 'id' | 'filePath' | 'isExternal'>): boolean {
  return !node.isExternal && node.filePath !== 'external' && !node.id.startsWith('external::');
}

function isRepoFunctionRow(row: Record<string, unknown>): boolean {
  return row.filePath !== 'external' && !(row.id as string | undefined)?.startsWith('external::');
}

// ============================================================================
// BM25 SPARSE RETRIEVAL (#7)
// ============================================================================

export interface Bm25Corpus {
  docs: Array<{ id: string; tfMap: Map<string, number>; length: number }>;
  /** term → number of documents containing it */
  df: Map<string, number>;
  avgLength: number;
  N: number;
}

export function buildBm25Corpus(records: Array<{ id: string; text: string }>): Bm25Corpus {
  const docs: Bm25Corpus['docs'] = [];
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const r of records) {
    const tokens = tokenize(r.text);
    const tfMap = new Map<string, number>();
    for (const t of tokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
    docs.push({ id: r.id, tfMap, length: tokens.length });
    totalLen += tokens.length;
    for (const t of tfMap.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }

  return { docs, df, avgLength: docs.length > 0 ? totalLen / docs.length : 1, N: docs.length };
}

const BM25_K1 = 1.2;
const BM25_B  = 0.75;

export function bm25Score(corpus: Bm25Corpus, queryTokens: string[], docIdx: number): number {
  const doc = corpus.docs[docIdx];
  let score = 0;
  for (const q of queryTokens) {
    const df = corpus.df.get(q) ?? 0;
    if (df === 0) continue;
    const idf = Math.log((corpus.N - df + 0.5) / (df + 0.5) + 1);
    const tf = doc.tfMap.get(q) ?? 0;
    if (tf === 0) continue;
    const tfNorm =
      (tf * (BM25_K1 + 1)) /
      (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / corpus.avgLength)));
    score += idf * tfNorm;
  }
  return score;
}

/** Attribute the ranker's exact aggregate term contributions across one bounded candidate's fields. */
export function bm25MatchEvidence(
  corpus: Bm25Corpus,
  queryTokens: string[],
  docIdx: number,
  fields: SearchableFields,
  tier: 1 | 2 = 1,
): MatchEvidence {
  const doc = corpus.docs[docIdx];
  const fieldScores = new Map(LEXICAL_MATCH_FIELDS.map((field) => [field, 0]));
  const fieldTfMaps = new Map(LEXICAL_MATCH_FIELDS.map((field) => {
    const frequencies = new Map<string, number>();
    for (const token of tokenize(fields[field] ?? '')) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    return [field, frequencies] as const;
  }));
  for (const q of queryTokens) {
    const df = corpus.df.get(q) ?? 0;
    if (df === 0) continue;
    const idf = Math.log((corpus.N - df + 0.5) / (df + 0.5) + 1);
    const tf = doc.tfMap.get(q) ?? 0;
    if (tf === 0) continue;
    const tfNorm =
      (tf * (BM25_K1 + 1)) /
      (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / corpus.avgLength)));
    const termScore = idf * tfNorm;
    for (const field of LEXICAL_MATCH_FIELDS) {
      const fieldTf = fieldTfMaps.get(field)?.get(q) ?? 0;
      if (fieldTf === 0) continue;
      // Attribute the contribution that actually entered the aggregate score.
      // Fields partition the flattened document, so occurrence share preserves
      // the aggregate term contribution instead of re-saturating each field as
      // an independent (and differently ranked) BM25 document.
      fieldScores.set(field, (fieldScores.get(field) ?? 0) + termScore * (fieldTf / tf));
    }
  }
  let winningField: (typeof LEXICAL_MATCH_FIELDS)[number] = LEXICAL_MATCH_FIELDS[0];
  for (const field of LEXICAL_MATCH_FIELDS.slice(1)) {
    if ((fieldScores.get(field) ?? 0) > (fieldScores.get(winningField) ?? 0)) winningField = field;
  }
  return {
    field: winningField,
    terms: queryTokens.filter((token) => (fieldTfMaps.get(winningField)?.get(token) ?? 0) > 0),
    tier,
  };
}

/**
 * Reciprocal Rank Fusion: merges two ranked lists into a single relevance score.
 * k=60 is the standard parameter (Cormack et al., 2009).
 */
function rrfScore(rankDense: number, rankSparse: number, k = 60): number {
  return 1 / (k + rankDense + 1) + 1 / (k + rankSparse + 1);
}

// Module-level BM25 corpus cache: avoids a full table scan on every search call.
// Keyed by dbPath; invalidated by build() when the index is rebuilt.
const _bm25Cache = new Map<string, { corpus: Bm25Corpus; rowCount: number; rows: Record<string, unknown>[] }>();
const _identifierVocabularyCache = new Map<string, string[]>();

// Module-level LanceDB table cache: avoids connect() + openTable() on every search call.
// Invalidated by build() when the index is rebuilt.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _tableCache = new Map<string, { table: any }>();
const _cacheStats = { tableHits: 0, tableMisses: 0, bm25Hits: 0, bm25Misses: 0 };
const _degradedFallback = new Map<string, {
  fullBuildAt: string | null;
  marker: NonNullable<VectorIndexMeta['degraded']>;
}>();

function invalidateDbPathCaches(dbPath: string): void {
  _bm25Cache.delete(dbPath);
  _identifierVocabularyCache.delete(dbPath);
  _tableCache.delete(dbPath);
  _metaCache.delete(dbPath);
}

/** Clear every process-lifetime cache for one on-disk vector index. */
export function invalidateVectorIndexCaches(outputDir: string): void {
  invalidateDbPathCaches(dbPathFor(outputDir));
}

/** Test-only: expose the canonical cache identity used for an index path. */
export const _vectorIndexCacheIdentityForTesting = dbPathFor;

async function withVectorIndexMutation<T>(outputDir: string, operation: () => Promise<T>): Promise<T> {
  let lockDir = resolve(outputDir);
  try { lockDir = realpathSync.native(lockDir); } catch { /* output directory may not exist yet */ }
  const lock = await acquireLockAt(lockDir, '.vector-index.lock');
  if ('held' in lock) throw new Error(`Vector index mutation lock is held: ${lock.lockPath}`);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

/** Test-only: clear in-memory BM25 + LanceDB caches to force cold path. */
export function _resetVectorIndexCachesForTesting(): void {
  _bm25Cache.clear();
  _identifierVocabularyCache.clear();
  _tableCache.clear();
  _metaCache.clear();
  _degradedFallback.clear();
  _cacheStats.tableHits = 0;
  _cacheStats.tableMisses = 0;
  _cacheStats.bm25Hits = 0;
  _cacheStats.bm25Misses = 0;
}

/** Test-only proof that a cold request populated, and a warm request reused, each search cache. */
export function _vectorIndexCacheStatsForTesting(): Readonly<typeof _cacheStats> {
  return { ..._cacheStats };
}

interface MutableTable {
  delete(predicate: string): Promise<unknown>;
  add(rows: Record<string, unknown>[]): Promise<unknown>;
}

async function replaceRowsWithRestore(
  table: MutableTable,
  predicate: string | null,
  replacementRows: Record<string, unknown>[],
  previousRows: Record<string, unknown>[],
  onRestoreFailure: () => Promise<void>,
): Promise<void> {
  if (!predicate) {
    if (replacementRows.length > 0) await table.add(replacementRows);
    return;
  }

  await table.delete(predicate);
  try {
    if (replacementRows.length > 0) await table.add(replacementRows);
  } catch (addError) {
    try {
      // An add that rejects is not assumed to be transactionally empty. Remove
      // any replacement rows it may have partially committed before restoring
      // the captured pre-update set.
      await table.delete(predicate);
      if (previousRows.length > 0) await table.add(previousRows);
    } catch (restoreError) {
      let markerError: unknown;
      try {
        await onRestoreFailure();
      } catch (err) {
        markerError = err;
      }
      throw new AggregateError(
        markerError ? [addError, restoreError, markerError] : [addError, restoreError],
        markerError
          ? 'Vector index update, rollback, and degraded-marker persistence failed.'
          : 'Vector index update and rollback both failed; the index is degraded.',
        { cause: restoreError },
      );
    }
    throw addError;
  }
}

/** Test-only: exercise the transactional delete/add helper without LanceDB. */
export const _replaceRowsWithRestoreForTesting = replaceRowsWithRestore;

/**
 * Surgically patch the cached BM25 corpus for `dbPath` (Spec 13.1): drop the
 * rows belonging to `changedFilePaths` and splice in `newRows`, then rebuild the
 * in-memory corpus. No disk read — if nothing is cached yet this is a no-op and
 * the next search builds the corpus fresh from the table.
 */
function patchBm25Cache(dbPath: string, changedFilePaths: Set<string>, newRows: Record<string, unknown>[]): void {
  _identifierVocabularyCache.delete(dbPath);
  // The on-disk corpus sidecar no longer matches the mutated table; drop it so the
  // next cold start rebuilds from raw text rather than hydrating a stale corpus.
  // Re-serialising per patch is intentionally out of scope (owned by the serving
  // hot-path optimisation). Done before the early return so invalidation happens
  // even when there is no in-memory corpus to patch.
  deleteCorpusSidecar(dbPath);
  const entry = _bm25Cache.get(dbPath);
  if (!entry) return;
  const patched = patchBm25Corpus(entry.corpus, entry.rows, changedFilePaths, newRows);
  _bm25Cache.set(dbPath, { corpus: patched.corpus, rowCount: patched.rows.length, rows: patched.rows });
}

/**
 * Absorb one incremental update into an existing corpus, returning the new corpus and rows.
 *
 * Pure — no cache, no disk — so it can be checked directly against {@link buildBm25Corpus}, which
 * is the only assurance that matters here (see `bm25-incremental-patch.test.ts`).
 */
function patchBm25Corpus(
  previous: Bm25Corpus,
  previousRows: Record<string, unknown>[],
  changedFilePaths: Set<string>,
  newRows: Record<string, unknown>[]
): { corpus: Bm25Corpus; rows: Record<string, unknown>[] } {
  // Patched incrementally rather than rebuilt. `buildBm25Corpus` over every kept row re-tokenized
  // the WHOLE repository on every save — the corpus is per-symbol text for the entire index, so
  // saving one file paid for all of it. That is the cost that matters most for this tool, because
  // the watcher is meant to be always on: it grew with the repository rather than with the edit.
  //
  // Measured, absorbing one changed file (mean of 5, 5 rounds warm):
  //
  // | corpus  | rebuild | patch  |
  // |---------|---------|--------|
  // |  5,000  |  35.2ms |  1.5ms |
  // | 20,000  | 135.6ms |  6.1ms |
  // | 50,000  | 346.4ms | 19.6ms |
  //
  // The patch is still O(docs) rather than O(edit): it copies `df` and walks the doc list. Both
  // are cheap map/array operations — the 20x is tokenization, which is what actually cost. Making
  // it truly O(edit) would mean mutating the previous corpus in place, and a search running
  // concurrently holds a reference to it, so it would observe a half-applied update. Not worth
  // 19.6ms.
  //
  // The patch is exactly equivalent, not an approximation. `df` counts DOCUMENTS containing a
  // token (one increment per doc, taken from `tfMap.keys()`), so removing a doc decrements each of
  // its unique tokens by exactly one and adding a doc increments them by exactly one. `length` and
  // the running total are integers, so the sum is exact regardless of the order it is accumulated
  // in. Surviving docs keep their existing `tfMap`, which is what makes this O(edit) instead of
  // O(repository) — their text did not change, so re-tokenizing them could only reproduce it.
  const removedIdx = new Set<number>();
  previousRows.forEach((r, i) => { if (changedFilePaths.has(r.filePath as string)) removedIdx.add(i); });

  const df = new Map(previous.df);
  const docs: Bm25Corpus['docs'] = [];
  let totalLen = 0;

  for (const [i, doc] of previous.docs.entries()) {
    if (removedIdx.has(i)) {
      for (const t of doc.tfMap.keys()) {
        const next = (df.get(t) ?? 0) - 1;
        if (next > 0) df.set(t, next); else df.delete(t);
      }
      continue;
    }
    docs.push(doc);
    totalLen += doc.length;
  }

  const kept = previousRows.filter((_, i) => !removedIdx.has(i));
  for (const r of newRows) {
    kept.push(r);
    const tokens = tokenize(r.text as string);
    const tfMap = new Map<string, number>();
    for (const t of tokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
    docs.push({ id: r.id as string, tfMap, length: tokens.length });
    totalLen += tokens.length;
    for (const t of tfMap.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const corpus: Bm25Corpus = {
    docs,
    df,
    avgLength: docs.length > 0 ? totalLen / docs.length : 1,
    N: docs.length,
  };
  return { corpus, rows: kept };
}

/** Test-only: drive {@link patchBm25Corpus} directly, to diff it against a full rebuild. */
export const _patchBm25CorpusForTesting = patchBm25Corpus;

// ── Persisted BM25 corpus sidecar ───────────────────────────────────────────
// The keyword corpus is otherwise rebuilt in-memory from the raw `text` column on
// the first query in every process. Persisting the tokenized corpus lets a cold
// start hydrate it without re-tokenizing, and gives `TOKENIZER_VERSION` a real
// serve-time guard: a sidecar stamped under a different tokenizer is ignored and
// the corpus rebuilt, so a mixed-token corpus is never served.

const CORPUS_FILE = 'bm25-corpus.json';
/** Serialization-format version, independent of TOKENIZER_VERSION. */
const CORPUS_SCHEMA_VERSION = 1;
const CORPUS_MIN_MAX_BYTES = 1024 * 1024;
const CORPUS_ABSOLUTE_MAX_BYTES = 512 * 1024 * 1024;

interface SerializedBm25Corpus {
  schemaVersion: number;
  tokenizerVersion: number;
  /** Commitment to the authoritative table rows whose text produced this corpus. */
  contentHash: string;
  /** Commitment to the derived corpus payload itself (all fields below). */
  payloadHash: string;
  avgLength: number;
  N: number;
  df: Array<[string, number]>;
  docs: Array<{ id: string; length: number; tf: Array<[string, number]> }>;
}

function corpusFilePath(dbPath: string): string {
  return join(dbPath, CORPUS_FILE);
}

function hashIndexedRows(records: Iterable<{ id: string; text: string }>): string {
  const rowDigests: string[] = [];
  for (const record of records) {
    rowDigests.push(createHash('sha256').update(JSON.stringify([record.id, record.text])).digest('hex'));
  }
  rowDigests.sort();
  return createHash('sha256')
    .update('openlore-vector-index-rows-v1\0')
    .update(rowDigests.join(''))
    .digest('hex');
}

function hashBm25CorpusPayload(corpus: Bm25Corpus): string {
  const hash = createHash('sha256');
  hash.update('openlore-bm25-corpus-payload-v1\0');
  for (const doc of corpus.docs) {
    const encoded = JSON.stringify({ id: doc.id, length: doc.length, tf: [...doc.tfMap] });
    hash.update(`${Buffer.byteLength(encoded)}:${encoded}\n`);
  }
  const df = JSON.stringify([...corpus.df]);
  hash.update(`${Buffer.byteLength(df)}:${df}\n`);
  hash.update(`${JSON.stringify(corpus.avgLength)}\n${JSON.stringify(corpus.N)}\n`);
  return hash.digest('hex');
}

function serializeBm25Corpus(corpus: Bm25Corpus, contentHash: string): string {
  const payload: SerializedBm25Corpus = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    contentHash,
    payloadHash: hashBm25CorpusPayload(corpus),
    avgLength: corpus.avgLength,
    N: corpus.N,
    df: [...corpus.df],
    docs: corpus.docs.map((d) => ({ id: d.id, length: d.length, tf: [...d.tfMap] })),
  };
  return JSON.stringify(payload);
}

/** Parse a sidecar back into a corpus, or null if absent/corrupt/version-skewed. */
function deserializeBm25Corpus(json: string): { corpus: Bm25Corpus; contentHash: string } | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    if (p.schemaVersion !== CORPUS_SCHEMA_VERSION) return null;
    if (p.tokenizerVersion !== TOKENIZER_VERSION) return null;
    if (typeof p.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.contentHash)) return null;
    if (typeof p.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.payloadHash)) return null;
    if (!Array.isArray(p.docs) || !Array.isArray(p.df)) return null;
    if (!Number.isSafeInteger(p.N) || (p.N as number) < 0 || p.N !== p.docs.length) return null;
    if (typeof p.avgLength !== 'number' || !Number.isFinite(p.avgLength) || p.avgLength <= 0) return null;

    // Validate the complete shape before constructing the corpus Maps. This
    // prevents hostile-but-valid JSON from smuggling negative/duplicate counts,
    // non-finite arithmetic, or inconsistent aggregate fields into scoring.
    const expectedDf = new Map<string, number>();
    const seenDocIds = new Set<string>();
    let totalLength = 0;
    for (const rawDoc of p.docs) {
      if (!rawDoc || typeof rawDoc !== 'object') return null;
      const doc = rawDoc as Record<string, unknown>;
      if (typeof doc.id !== 'string' || doc.id.length === 0 || seenDocIds.has(doc.id)) return null;
      seenDocIds.add(doc.id);
      if (!Number.isSafeInteger(doc.length) || (doc.length as number) < 0) return null;
      if (!Array.isArray(doc.tf)) return null;
      const seen = new Set<string>();
      let counted = 0;
      for (const pair of doc.tf) {
        if (!Array.isArray(pair) || pair.length !== 2
          || typeof pair[0] !== 'string' || pair[0].length === 0
          || !Number.isSafeInteger(pair[1]) || (pair[1] as number) <= 0
          || seen.has(pair[0])) return null;
        seen.add(pair[0]);
        counted += pair[1] as number;
        if (!Number.isSafeInteger(counted)) return null;
      }
      if (counted !== doc.length) return null;
      totalLength += doc.length as number;
      if (!Number.isSafeInteger(totalLength)) return null;
      for (const token of seen) expectedDf.set(token, (expectedDf.get(token) ?? 0) + 1);
    }
    const seenDf = new Set<string>();
    for (const pair of p.df) {
      if (!Array.isArray(pair) || pair.length !== 2
        || typeof pair[0] !== 'string' || pair[0].length === 0
        || !Number.isSafeInteger(pair[1]) || (pair[1] as number) <= 0
        || (pair[1] as number) > (p.N as number) || seenDf.has(pair[0])
        || expectedDf.get(pair[0]) !== pair[1]) return null;
      seenDf.add(pair[0]);
    }
    if (seenDf.size !== expectedDf.size) return null;
    const expectedAverage = (p.N as number) > 0 ? totalLength / (p.N as number) : 1;
    if (p.avgLength !== expectedAverage) return null;

    const corpus: Bm25Corpus = {
        docs: p.docs.map((rawDoc) => {
          const doc = rawDoc as { id: string; length: number; tf: Array<[string, number]> };
          return { id: doc.id, length: doc.length, tfMap: new Map(doc.tf) };
        }),
        df: new Map(p.df as Array<[string, number]>),
        avgLength: p.avgLength,
        N: p.N as number,
    };
    if (hashBm25CorpusPayload(corpus) !== p.payloadHash) return null;
    return {
      corpus,
      contentHash: p.contentHash,
    };
  } catch {
    return null;
  }
}

function corpusSidecarMaxBytes(records: readonly { id: string; text: string }[]): number {
  let inputBytes = 0;
  for (const record of records) {
    inputBytes = Math.min(
      CORPUS_ABSOLUTE_MAX_BYTES,
      inputBytes + Buffer.byteLength(record.id) + Buffer.byteLength(record.text),
    );
  }
  return Math.min(
    CORPUS_ABSOLUTE_MAX_BYTES,
    Math.max(CORPUS_MIN_MAX_BYTES, inputBytes * 8 + records.length * 1024),
  );
}

function readCorpusSidecarBounded(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) return null;
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return null;
    return Buffer.concat(chunks, total).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Best-effort persist (the sidecar is an optional cache — a failure just means
 * the next cold start rebuilds from raw text). */
function persistCorpusSidecar(
  dbPath: string,
  corpus: Bm25Corpus,
  contentHash: string,
): void {
  try {
    writeFileSync(corpusFilePath(dbPath), serializeBm25Corpus(corpus, contentHash), 'utf-8');
  } catch {
    /* optional cache — ignore */
  }
}

/** How many bytes of sidecar text buffer before a write syscall. */
const CORPUS_WRITE_BUFFER_BYTES = 1 << 20;
let corpusTempCounter = 0;

/**
 * Persist the sidecar WITHOUT ever holding the corpus, its serialized payload, or the finished
 * JSON string in memory (issue #304 follow-up).
 *
 * The index-build path only ever built a corpus in order to write it out, and did so by keeping
 * three whole-repository copies alive at once: the corpus (one `Map` of token counts per indexed
 * function, plus the document-frequency map), a complete second copy reshaped into arrays, and
 * then `JSON.stringify` of that — measured at 648 MB + 661 MB + 265 MB = **1,575 MB** on a
 * 152,046-function repository. Nothing read the corpus afterwards.
 *
 * So each record is tokenized, written, and dropped. What remains resident is the document
 * frequency map, which is keyed by DISTINCT TOKEN (~31,000 entries on that same repository), one
 * document's token counts, and one fixed-size digest string per row for an order-independent
 * commitment to the authoritative input. None retains the per-document token corpus.
 *
 * `df` and the totals land at the END of the object because they are only known once every
 * document has been seen. JSON objects are unordered and the reader takes fields by name, so the
 * parsed result is identical to what {@link serializeBm25Corpus} produces — which
 * `bm25-corpus-persistence.test.ts` pins by comparing the two.
 */
function persistCorpusSidecarStreaming(
  dbPath: string,
  records: Iterable<{ id: string; text: string }>,
): void {
  let fd: number | undefined;
  const target = corpusFilePath(dbPath);
  const temp = `${target}.tmp-${process.pid}-${corpusTempCounter++}`;
  let renamed = false;
  try {
    fd = openSync(temp, 'w');
    const df = new Map<string, number>();
    const rowDigests: string[] = [];
    const payloadHash = createHash('sha256');
    payloadHash.update('openlore-bm25-corpus-payload-v1\0');
    let totalLen = 0;
    let n = 0;
    let buf = `{"schemaVersion":${JSON.stringify(CORPUS_SCHEMA_VERSION)},`
      + `"tokenizerVersion":${JSON.stringify(TOKENIZER_VERSION)},"docs":[`;
    const flush = (force: boolean): void => {
      if (!force && buf.length < CORPUS_WRITE_BUFFER_BYTES) return;
      writeSync(fd!, buf);
      buf = '';
    };

    for (const r of records) {
      rowDigests.push(createHash('sha256').update(JSON.stringify([r.id, r.text])).digest('hex'));
      const tokens = tokenize(r.text);
      const tfMap = new Map<string, number>();
      for (const t of tokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
      // Same accumulation order as buildBm25Corpus, so `df`'s entry order matches too.
      for (const t of tfMap.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      totalLen += tokens.length;
      const encodedDoc = JSON.stringify({ id: r.id, length: tokens.length, tf: [...tfMap] });
      payloadHash.update(`${Buffer.byteLength(encodedDoc)}:${encodedDoc}\n`);
      buf += `${n > 0 ? ',' : ''}${encodedDoc}`;
      n++;
      flush(false);
    }

    rowDigests.sort();
    const contentHash = createHash('sha256')
      .update('openlore-vector-index-rows-v1\0')
      .update(rowDigests.join(''))
      .digest('hex');
    const encodedDf = JSON.stringify([...df]);
    const avgLength = n > 0 ? totalLen / n : 1;
    payloadHash.update(`${Buffer.byteLength(encodedDf)}:${encodedDf}\n`);
    payloadHash.update(`${JSON.stringify(avgLength)}\n${JSON.stringify(n)}\n`);
    buf += `],"df":${encodedDf},`
      + `"contentHash":${JSON.stringify(contentHash)},`
      + `"payloadHash":${JSON.stringify(payloadHash.digest('hex'))},`
      + `"avgLength":${JSON.stringify(avgLength)},"N":${n}}`;
    flush(true);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
    renamed = true;
  } catch {
    /* optional cache — ignore */
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    if (!renamed) {
      try { unlinkSync(temp); } catch { /* absent or already renamed */ }
    }
  }
}

function deleteCorpusSidecar(dbPath: string): void {
  try {
    rmSync(corpusFilePath(dbPath), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Load the corpus from the stamped sidecar when it matches the current tokenizer
 * and the table it is joined against; otherwise rebuild from raw text and
 * re-persist. Never throws and never serves a tokenizer-skewed corpus — a
 * missing, corrupt, or version-mismatched sidecar degrades to a rebuild.
 * The `N === allRows.length` check is a defensive cross-check; the primary
 * integrity contract is "sidecar present ⇒ valid" (build overwrites it, every
 * incremental patch deletes it).
 */
function loadOrBuildBm25Corpus(dbPath: string, allRows: Record<string, unknown>[]): Bm25Corpus {
  const authoritativeRecords = allRows.map((r) => ({ id: r.id as string, text: r.text as string }));
  const sidecar = readCorpusSidecarBounded(
    corpusFilePath(dbPath),
    corpusSidecarMaxBytes(authoritativeRecords),
  );
  const loaded = sidecar === null ? null : deserializeBm25Corpus(sidecar);
  const authoritativeHash = hashIndexedRows(authoritativeRecords);
  if (loaded
      && loaded.corpus.N === allRows.length
      && loaded.contentHash === authoritativeHash) return loaded.corpus;

  const corpus = buildBm25Corpus(authoritativeRecords);
  persistCorpusSidecar(dbPath, corpus, authoritativeHash);
  return corpus;
}

/**
 * Build a LanceDB `` `filePath` IN (...) `` predicate, SQL-escaping each path.
 *
 * The column identifier MUST be **backtick**-quoted, not double-quoted: LanceDB's
 * datafusion filter parser treats a double-quoted token as a *string literal*
 * (so `"filePath" = 'x'` compares the constant string 'filePath' to 'x' and is
 * always false — a silent no-op delete), and a *bare* `filePath` is lowercased to
 * `filepath`, which errors (no such column). Backticks are the only form that
 * binds to the camelCase column. Verified empirically against @lancedb/lancedb.
 */
function filePathInPredicate(paths: Set<string>): string | null {
  if (paths.size === 0) return null;
  const list = Array.from(paths).map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
  return `\`filePath\` IN (${list})`;
}

/** Build a prefilter for ANN recall; identifiers stay backtick-quoted. */
function functionSearchPredicate(language?: string, minFanIn?: number): string | null {
  const clauses: string[] = [];
  if (language) clauses.push(`\`language\` = '${language.replace(/'/g, "''")}'`);
  if (minFanIn !== undefined && minFanIn > 0 && Number.isFinite(minFanIn)) {
    clauses.push(`\`fanIn\` >= ${minFanIn}`);
  }
  return clauses.length > 0 ? clauses.join(' AND ') : null;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build the text to embed for a function.
 * Combines language, path, qualified name, signature, docstring, and skeleton body.
 */
function buildText(
  node: FunctionNode,
  signature: string,
  docstring: string,
  fileContents?: Map<string, string>
): string {
  const qualifiedName = node.className
    ? `${node.className}.${node.name}`
    : node.name;

  const parts = [`[${node.language}] ${node.filePath} ${qualifiedName}`];
  if (signature) parts.push(signature);
  if (docstring) parts.push(docstring);

  // Append skeleton body when file contents are available.
  // The skeleton strips noise (logs, comments) while preserving business-logic signals
  // (variable names, control flow, calls, return/throw). Only included when it provides
  // meaningful reduction over the raw body (≥20% smaller).
  if (fileContents && node.startIndex < node.endIndex) {
    const src = fileContents.get(node.filePath);
    if (src) {
      const body = src.slice(node.startIndex, node.endIndex);
      if (body.trim()) {
        const skeleton = getSkeletonContent(body, node.language);
        if (isSkeletonWorthIncluding(body, skeleton)) {
          parts.push(skeleton);
        }
      }
    }
  }

  return parts.join('\n');
}

export function searchableFieldsForFunctionRow(row: Record<string, unknown>): SearchableFields {
  const name = String(row.name ?? '');
  const className = String(row.className ?? '');
  const filePath = String(row.filePath ?? '');
  const signature = String(row.signature ?? '');
  const docstring = String(row.docstring ?? '');
  const language = String(row.language ?? '');
  const text = String(row.text ?? '');
  const symbol = className ? `${className}.${name}` : name;
  const prefix = [`[${language}] ${filePath} ${symbol}`, signature, docstring]
    .filter(Boolean)
    .join('\n');
  const body = text.startsWith(`${prefix}\n`) ? text.slice(prefix.length + 1) : '';
  // Include the language marker with the path because both occupy the same
  // prefix segment in the flattened text scored by BM25. Every attributed
  // token must come from that scored text; fields are not extra query inputs.
  return { symbol, path: `[${language}] ${filePath}`, signature, doc: docstring, body };
}

/**
 * Build a lookup map: filePath → entries[] from FileSignatureMap[]
 */
function buildSignatureIndex(
  signatures: FileSignatureMap[]
): Map<string, FileSignatureMap['entries']> {
  const index = new Map<string, FileSignatureMap['entries']>();
  for (const fsm of signatures) {
    index.set(fsm.path, fsm.entries);
  }
  return index;
}

/**
 * Find the best matching signature entry for a FunctionNode.
 */
function findSignatureEntry(
  node: FunctionNode,
  sigIndex: Map<string, FileSignatureMap['entries']>
): { signature: string; docstring: string } {
  const entries = sigIndex.get(node.filePath) ?? [];
  const match = entries.find(e => e.name === node.name);
  if (!match) return { signature: '', docstring: '' };
  return {
    signature: match.signature ?? '',
    docstring: match.docstring ?? '',
  };
}

// ============================================================================
// VECTOR INDEX
// ============================================================================

export class VectorIndex {
  /** User-facing disclosure for an index whose incremental rollback also failed. */
  static degradationNotice(outputDir: string): string | null {
    const dbPath = dbPathFor(outputDir);
    const meta = readMeta(outputDir);
    if (meta !== null && meta !== INVALID_META && meta.degraded) return 'Index degraded — re-run "openlore analyze".';
    const fallback = _degradedFallback.get(dbPath);
    if (!fallback) return null;
    const observedFullBuild = meta !== null && meta !== INVALID_META
      ? meta.fullBuildAt ?? meta.builtAt
      : null;
    if (observedFullBuild !== fallback.fullBuildAt) {
      _degradedFallback.delete(dbPath);
      return null;
    }
    return 'Index degraded — re-run "openlore analyze".';
  }

  /**
   * Build (or rebuild) the vector index from call graph nodes + signatures.
   *
   * When `incremental` is true and an existing index is found, only functions
   * whose text has changed since the last build are re-embedded.  Unchanged
   * functions reuse their cached vectors.  Pass `incremental: false` (or omit
   * when no index exists) to do a full rebuild.
   *
   * Returns a summary of how many functions were embedded vs reused.
   *
   * When `embedSvc` is null, builds a **keyword-only (BM25)** index: the corpus
   * rows are written without a `vector` column and the meta sidecar records
   * `hasEmbeddings: false`. Search then serves BM25 results and never attempts
   * ANN. Re-building a previously-embedded index with `embedSvc=null` downgrades
   * it to BM25-only (overwrite + meta update), and vice-versa upgrades it.
   */
  static async build(
    outputDir: string,
    nodes: FunctionNode[],
    signatures: FileSignatureMap[],
    hubIds: Set<string>,
    entryPointIds: Set<string>,
    embedSvc: Embedder | null,
    /** Optional map of filePath → source content for skeleton-based body indexing */
    fileContents?: Map<string, string>,
    /** When true, reuse cached vectors for unchanged functions */
    incremental = false
  ): Promise<{
    embedded: number;
    reused: number;
    total: number;
    hasEmbeddings: boolean;
    productionFunctions: number;
    testFunctions: number;
    signatureOnlySymbols: number;
  }> {
    return withVectorIndexMutation(outputDir, () => VectorIndex.buildUnlocked(
      outputDir, nodes, signatures, hubIds, entryPointIds, embedSvc, fileContents, incremental,
    ));
  }

  private static async buildUnlocked(
    outputDir: string,
    nodes: FunctionNode[],
    signatures: FileSignatureMap[],
    hubIds: Set<string>,
    entryPointIds: Set<string>,
    embedSvc: Embedder | null,
    fileContents?: Map<string, string>,
    incremental = false,
  ): Promise<{
    embedded: number;
    reused: number;
    total: number;
    hasEmbeddings: boolean;
    productionFunctions: number;
    testFunctions: number;
    signatureOnlySymbols: number;
  }> {
    quietNativeLoggingOnce();
    const { connect } = await import('@lancedb/lancedb');

    const repoNodes = nodes.filter(isRepoFunction);
    const sigIndex = buildSignatureIndex(signatures);

    // Build candidate records (without vectors)
    const nodeIds = new Set(repoNodes.map(n => n.id));
    const candidates: Omit<FunctionRecord, 'vector'>[] = repoNodes.map(node => {
      const cgDoc = node.docstring ?? '';
      const cgSig = node.signature ?? '';
      // Always check regex index as fallback — CG may miss docstrings when
      // startIndex points inside an export_statement (past the `export` keyword),
      // causing extractDocstringBefore to scan into the export keyword instead of
      // reaching the JSDoc block above it.
      const { signature: regexSig, docstring: regexDoc } = findSignatureEntry(node, sigIndex);
      const signature = cgSig || regexSig;
      const docstring = cgDoc || regexDoc;
      return {
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        className: node.className ?? '',
        language: node.language,
        signature,
        docstring,
        fanIn: node.fanIn,
        fanOut: node.fanOut,
        isHub: hubIds.has(node.id),
        isEntryPoint: entryPointIds.has(node.id),
        text: buildText(node, signature, docstring, fileContents),
      };
    });

    // Also index signature entries that have no call graph node (constants, type aliases, etc.)
    //
    // The (file, name) pairs are indexed ONCE up front. This used to be a `nodes.some(...)` scan
    // per signature entry, and the `nodeIds` short-circuit above it does not save you: node ids
    // are `path::Class.method` while the synthetic id is `path::name`, so every class method
    // misses and falls through to a linear scan of every node in the repository. On a large
    // codebase that is entries × nodes — on the order of 10^10 comparisons — and it dominated the
    // wall clock of the whole index build.
    const nodeFileNames = new Set<string>();
    for (const n of repoNodes) nodeFileNames.add(`${n.filePath}\u0000${n.name}`);

    for (const fsm of signatures) {
      if (fsm.path === 'external') continue;
      for (const entry of fsm.entries) {
        const syntheticId = `${fsm.path}::${entry.name}`;
        if (nodeIds.has(syntheticId)) continue; // already covered by call graph
        // Skip if any call graph node from this file matches the name
        if (nodeFileNames.has(`${fsm.path}\u0000${entry.name}`)) continue;
        const sig = entry.signature ?? '';
        const doc = entry.docstring ?? '';
        candidates.push({
          id: syntheticId,
          name: entry.name,
          filePath: fsm.path,
          className: '',
          language: fsm.language,
          signature: sig,
          docstring: doc,
          fanIn: 0,
          fanOut: 0,
          isHub: false,
          isEntryPoint: false,
          text: `[${fsm.language}] ${fsm.path} ${entry.name}\n${sig}${doc ? '\n' + doc : ''}`,
        });
      }
    }

    if (candidates.length === 0) {
      throw new Error('No repository functions to index');
    }

    const dbPath = dbPathFor(outputDir);
    const productionFunctions = repoNodes.filter((node) => !node.isTest).length;
    const testFunctions = repoNodes.length - productionFunctions;
    const signatureOnlySymbols = candidates.length - repoNodes.length;

    // ── BM25-only build (no embedding service) ───────────────────────────────
    // Write the corpus without a `vector` column so the table can never be
    // searched with ANN, and record `hasEmbeddings: false` in the sidecar.
    if (!embedSvc) {
      const db = await connect(dbPath);
      deleteCorpusSidecar(dbPath);
      await db.createTable(
        TABLE_NAME,
        candidates as unknown as Record<string, unknown>[],
        { mode: 'overwrite' }
      );
      const builtAt = new Date().toISOString();
      // Publish corpus first and metadata LAST: the meta rename is the coherence
      // commit point observed by warm readers in other processes.
      persistCorpusSidecarStreaming(
        dbPath,
        (function* () { for (const r of candidates) yield { id: r.id, text: r.text }; })(),
      );
      await writeMeta(outputDir, {
        hasEmbeddings: false,
        dim: 0,
        model: null,
        builtAt,
        fullBuildAt: builtAt,
        schemaVersion: META_SCHEMA_VERSION,
        tokenizerVersion: TOKENIZER_VERSION,
      });
      _degradedFallback.delete(dbPath);
      invalidateDbPathCaches(dbPath);
      return {
        embedded: 0,
        reused: 0,
        total: candidates.length,
        hasEmbeddings: false,
        productionFunctions,
        testFunctions,
        signatureOnlySymbols,
      };
    }

    // ── Incremental cache lookup ─────────────────────────────────────────────
    let cachedVectors = new Map<string, number[]>(); // id → vector

    // Only reuse vectors from an existing index that actually has them AND was
    // built with the SAME model. A previously BM25-only index (hasEmbeddings:false)
    // has no `vector` column, so rebuild it fully as a hybrid index (upgrade path).
    // A model change (e.g. remote 1536-dim → local 384-dim, or one local model →
    // another) means the cached vectors are a different dimension; reusing them
    // would write a mixed-dimension table that crashes ANN search. Require an exact
    // model match — a sidecar-less legacy index (model unknown) is rebuilt in full.
    const existingMeta = incremental ? readMeta(outputDir) : null;
    const canReuseVectors =
      incremental &&
      VectorIndex.exists(outputDir) &&
      existingMeta !== null && existingMeta !== INVALID_META &&
      existingMeta.hasEmbeddings &&
      existingMeta.model === embedSvc.modelName;

    if (canReuseVectors) {
      try {
        const db = await connect(dbPath);
        const table = await db.openTable(TABLE_NAME);
        // Full table scan to load existing vectors
        const existing = await table.query().toArray();
        for (const row of existing) {
          const id = row.id as string;
          const text = row.text as string;
          // Convert Arrow typed arrays (Float32Array etc.) to plain number[]
          // so LanceDB can re-infer the schema when writing back
          const vector = Array.from(row.vector as ArrayLike<number>);
          // Cache the vector keyed by "id::text" so a text change invalidates it
          cachedVectors.set(`${id}::${text}`, vector);
        }
      } catch {
        // Existing index unreadable — fall back to full build
        cachedVectors = new Map();
      }
    }

    // ── Split into cached vs needs-embedding ────────────────────────────────
    const toEmbed: typeof candidates = [];
    const toEmbedIdx: number[] = []; // index into `candidates`
    const cachedIdx: number[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const r = candidates[i];
      const cacheKey = `${r.id}::${r.text}`;
      if (cachedVectors.has(cacheKey)) {
        cachedIdx.push(i);
      } else {
        toEmbed.push(r);
        toEmbedIdx.push(i);
      }
    }

    // ── Embed only changed / new functions ───────────────────────────────────
    let newVectors: number[][] = [];
    if (toEmbed.length > 0) {
      newVectors = await embedSvc.embed(toEmbed.map(r => r.text));
      if (newVectors.length !== toEmbed.length) {
        throw new Error(
          `Embedding count mismatch: expected ${toEmbed.length}, got ${newVectors.length}`
        );
      }
    }

    // ── Assemble final records ───────────────────────────────────────────────
    const fullRecords: FunctionRecord[] = new Array(candidates.length);
    for (let i = 0; i < cachedIdx.length; i++) {
      const idx = cachedIdx[i];
      const r = candidates[idx];
      fullRecords[idx] = { ...r, vector: cachedVectors.get(`${r.id}::${r.text}`)! };
    }
    for (let i = 0; i < toEmbedIdx.length; i++) {
      const idx = toEmbedIdx[i];
      fullRecords[idx] = { ...candidates[idx], vector: newVectors[i] };
    }

    // ── Write table ──────────────────────────────────────────────────────────
    const db = await connect(dbPath);
    deleteCorpusSidecar(dbPath);
    await db.createTable(TABLE_NAME, fullRecords as unknown as Record<string, unknown>[], { mode: 'overwrite' });

    const builtAt = new Date().toISOString();
    // As above, metadata is the last-published coherence commit.
    persistCorpusSidecarStreaming(
      dbPath,
      (function* () { for (const r of fullRecords) yield { id: r.id, text: r.text }; })(),
    );
    await writeMeta(outputDir, {
      hasEmbeddings: true,
      dim: fullRecords[0]?.vector.length ?? 0,
      // Runtime test doubles and third-party embedders predating `modelName`
      // can omit it despite the current type contract. Persist a valid,
      // conservative identity rather than publishing malformed metadata.
      model: embedSvc.modelName ?? 'unknown',
      builtAt,
      fullBuildAt: builtAt,
      schemaVersion: META_SCHEMA_VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
    });

    // Invalidate search caches — index was just rebuilt
    _degradedFallback.delete(dbPath);
    invalidateDbPathCaches(dbPath);

    return {
      embedded: toEmbed.length,
      reused: cachedIdx.length,
      total: fullRecords.length,
      hasEmbeddings: true,
      productionFunctions,
      testFunctions,
      signatureOnlySymbols,
    };
  }

  /**
   * Watch-mode incremental update (Spec 13.1). Replace only the rows for the
   * changed files with freshly-built records — a row-level delete+add instead of
   * the full-corpus read+overwrite that build() performs. The cold build() path
   * is untouched, protecting the `analyze --embed` contract (G7).
   *
   *  - Embedded index: reuse existing vectors for rows whose embed-text is
   *    unchanged (queried for the changed files only, not the whole corpus),
   *    embed just the new/changed texts, then delete the changed files' old rows
   *    and add the rebuilt ones. The LanceDB table handle in _tableCache stays
   *    valid across row ops, so search() does not pay a reconnect.
   *  - BM25-only index: delete+add the changed files' documents and patch the
   *    cached BM25 corpus in place rather than dropping the whole corpus cache.
   */
  static async updateFiles(
    outputDir: string,
    nodes: FunctionNode[],
    changedFilePaths: Set<string>,
    signatures: FileSignatureMap[],
    hubIds: Set<string>,
    entryPointIds: Set<string>,
    embedSvc: Embedder | null | undefined,
    fileContents?: Map<string, string>,
  ): Promise<{ embedded: number; reused: number; total: number; hasEmbeddings: boolean; deferred?: 'model-changed' | 'tokenizer-changed' }> {
    return withVectorIndexMutation(outputDir, () => VectorIndex.updateFilesUnlocked(
      outputDir, nodes, changedFilePaths, signatures, hubIds, entryPointIds, embedSvc, fileContents,
    ));
  }

  private static async updateFilesUnlocked(
    outputDir: string,
    nodes: FunctionNode[],
    changedFilePaths: Set<string>,
    signatures: FileSignatureMap[],
    hubIds: Set<string>,
    entryPointIds: Set<string>,
    embedSvc: Embedder | null | undefined,
    fileContents?: Map<string, string>,
  ): Promise<{ embedded: number; reused: number; total: number; hasEmbeddings: boolean; deferred?: 'model-changed' | 'tokenizer-changed' }> {
    if (!VectorIndex.exists(outputDir)) {
      return { embedded: 0, reused: 0, total: 0, hasEmbeddings: false };
    }
    const dbPath = dbPathFor(outputDir);
    const existingMeta = readMeta(outputDir);
    const indexHasEmbeddings = metaHasEmbeddings(existingMeta);
    if (changedFilePaths.size === 0) {
      return { embedded: 0, reused: 0, total: 0, hasEmbeddings: indexHasEmbeddings };
    }

    // A changed tokenizer means the on-disk corpus was tokenized under different
    // rules; incrementally patching it in place would mix token sets. Refuse the
    // incremental update (applies to BM25-only indexes too, unlike model-changed)
    // and leave the index consistent until a full `analyze --force` rebuilds and
    // re-stamps it. A legacy meta without the stamp is treated as v1. `deferred`
    // lets the caller surface this honestly rather than logging a no-op.
    if (existingMeta !== null && existingMeta !== INVALID_META
        && (existingMeta.tokenizerVersion ?? 1) !== TOKENIZER_VERSION) {
      return { embedded: 0, reused: 0, total: 0, hasEmbeddings: indexHasEmbeddings, deferred: 'tokenizer-changed' };
    }

    // A changed embedding model means the on-disk vectors are a different dimension;
    // a row-level add would create a mixed-dimension table. Refuse the incremental
    // vector update (signatures still refresh on their own lane) and leave the index
    // dimension-consistent until a full `analyze --force` rebuilds it under the new
    // model. Watch-mode freshness is best-effort; correctness wins over staleness.
    // `deferred` lets the caller surface this honestly rather than logging a no-op.
    if (embedSvc && existingMeta !== null && existingMeta !== INVALID_META && existingMeta.hasEmbeddings &&
        existingMeta.model !== embedSvc.modelName) {
      return { embedded: 0, reused: 0, total: 0, hasEmbeddings: true, deferred: 'model-changed' };
    }

    // ── Build candidate records for the changed files' functions ──────────────
    const repoNodes = nodes.filter(isRepoFunction);
    const sigIndex = buildSignatureIndex(signatures);
    const nodeIds = new Set(repoNodes.map((n) => n.id));
    const candidates: Omit<FunctionRecord, 'vector'>[] = repoNodes.map((node) => {
      const cgDoc = node.docstring ?? '';
      const cgSig = node.signature ?? '';
      const { signature: regexSig, docstring: regexDoc } = findSignatureEntry(node, sigIndex);
      const signature = cgSig || regexSig;
      const docstring = cgDoc || regexDoc;
      return {
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        className: node.className ?? '',
        language: node.language,
        signature,
        docstring,
        fanIn: node.fanIn,
        fanOut: node.fanOut,
        isHub: hubIds.has(node.id),
        isEntryPoint: entryPointIds.has(node.id),
        text: buildText(node, signature, docstring, fileContents),
      };
    });
    // Synthetic entries (constants / type aliases with no call-graph node) for
    // the changed files only.
    // Indexed once, exactly as the full-build path above does. This is the same defect that path
    // had: node ids are `path::Class.method` while the probe builds `path::name`, so the
    // `nodeIds` short-circuit misses EVERY class method — measured, 1,193 of 1,200 entries — and
    // each miss fell through to a linear scan of every node in the repository. Here that cost is
    // paid per incremental update, i.e. on every save the watcher sees: ~5s of added latency on a
    // 250,000-node repository. The full-build path was fixed and this one was missed.
    const nodeFileNames = new Set<string>();
    for (const n of repoNodes) nodeFileNames.add(`${n.filePath}\u0000${n.name}`);

    for (const fsm of signatures) {
      if (!changedFilePaths.has(fsm.path)) continue;
      for (const entry of fsm.entries) {
        const syntheticId = `${fsm.path}::${entry.name}`;
        if (nodeIds.has(syntheticId)) continue;
        if (nodeFileNames.has(`${fsm.path}\u0000${entry.name}`)) continue;
        const sig = entry.signature ?? '';
        const doc = entry.docstring ?? '';
        candidates.push({
          id: syntheticId,
          name: entry.name,
          filePath: fsm.path,
          className: '',
          language: fsm.language,
          signature: sig,
          docstring: doc,
          fanIn: 0,
          fanOut: 0,
          isHub: false,
          isEntryPoint: false,
          text: `[${fsm.language}] ${fsm.path} ${entry.name}\n${sig}${doc ? '\n' + doc : ''}`,
        });
      }
    }

    quietNativeLoggingOnce();

    const { connect } = await import('@lancedb/lancedb');
    const db = await connect(dbPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table: any = await db.openTable(TABLE_NAME);
    const predicate = filePathInPredicate(changedFilePaths);
    const previousRows = predicate
      ? await table.query().where(predicate).toArray() as Record<string, unknown>[]
      : [];
    const markDegraded = async (): Promise<void> => {
      const marker: NonNullable<VectorIndexMeta['degraded']> = {
        reason: 'incremental-update-restore-failed',
        recordedAt: new Date().toISOString(),
      };
      const validExistingMeta = existingMeta === INVALID_META ? null : existingMeta;
      const fullBuildAt = validExistingMeta?.fullBuildAt ?? validExistingMeta?.builtAt ?? null;
      _degradedFallback.set(dbPath, { fullBuildAt, marker });
      const baseMeta: VectorIndexMeta = validExistingMeta ?? {
        hasEmbeddings: indexHasEmbeddings,
        dim: 0,
        model: null,
        builtAt: new Date().toISOString(),
        schemaVersion: META_SCHEMA_VERSION,
        tokenizerVersion: TOKENIZER_VERSION,
      };
      try {
        await writeMeta(outputDir, {
          ...baseMeta,
          degraded: marker,
        });
      } finally {
        invalidateDbPathCaches(dbPath);
      }
    };
    const publishMutation = async (): Promise<void> => {
      const fallback = _degradedFallback.get(dbPath);
      const publishedAt = new Date().toISOString();
      const validExistingMeta = existingMeta === INVALID_META ? null : existingMeta;
      const updatedMeta: VectorIndexMeta = {
        ...(validExistingMeta ?? {
          hasEmbeddings: indexHasEmbeddings,
          dim: 0,
          model: null,
          schemaVersion: META_SCHEMA_VERSION,
          tokenizerVersion: TOKENIZER_VERSION,
        }),
        builtAt: publishedAt,
        fullBuildAt: validExistingMeta?.fullBuildAt ?? validExistingMeta?.builtAt ?? publishedAt,
        ...(validExistingMeta?.degraded || fallback
          ? { degraded: validExistingMeta?.degraded ?? fallback?.marker }
          : {}),
      };
      await writeMeta(outputDir, updatedMeta);
      _metaCache.set(dbPath, { value: updatedMeta, stamp: metaStamp(outputDir) });
      if (updatedMeta.degraded) {
        _degradedFallback.set(dbPath, {
          fullBuildAt: updatedMeta.fullBuildAt ?? updatedMeta.builtAt,
          marker: updatedMeta.degraded,
        });
      }
    };
    const publishMutationOrRestore = async (): Promise<void> => {
      try {
        await publishMutation();
      } catch (publishError) {
        try {
          if (predicate) {
            await table.delete(predicate);
            if (previousRows.length > 0) await table.add(previousRows);
          }
        } catch (restoreError) {
          let markerError: unknown;
          try {
            await markDegraded();
          } catch (error) {
            markerError = error;
          }
          const errors = [publishError, restoreError];
          if (markerError !== undefined) errors.push(markerError);
          throw new AggregateError(
            errors,
            markerError === undefined
              ? 'Vector index metadata publication and rollback both failed'
              : 'Vector index metadata publication, rollback, and degraded marker persistence failed',
            { cause: restoreError },
          );
        } finally {
          invalidateDbPathCaches(dbPath);
        }
        throw publishError;
      }
    };

    // ── BM25-only index ───────────────────────────────────────────────────────
    if (!embedSvc || !indexHasEmbeddings) {
      await replaceRowsWithRestore(
        table,
        predicate,
        candidates as unknown as Record<string, unknown>[],
        previousRows,
        markDegraded,
      );
      await publishMutationOrRestore();
      patchBm25Cache(dbPath, changedFilePaths, candidates as unknown as Record<string, unknown>[]);
      // Reclaim the versions this delete+add left behind (see index-compaction).
      await noteUpdateAndMaybeCompact(
        dbPath,
        table as unknown as Parameters<typeof noteUpdateAndMaybeCompact>[1],
        previousRows.length,
      );
      return { embedded: 0, reused: 0, total: candidates.length, hasEmbeddings: false };
    }

    // ── Embedded index: reuse unchanged vectors for the changed files only ────
    const cachedVectors = new Map<string, number[]>(); // "id::text" → vector
    if (predicate) {
      for (const row of previousRows) {
        const id = row.id as string;
        const text = row.text as string;
        cachedVectors.set(`${id}::${text}`, Array.from(row.vector as ArrayLike<number>));
      }
    }

    const toEmbed: typeof candidates = [];
    const toEmbedIdx: number[] = [];
    const cachedIdx: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const key = `${candidates[i].id}::${candidates[i].text}`;
      if (cachedVectors.has(key)) cachedIdx.push(i);
      else { toEmbed.push(candidates[i]); toEmbedIdx.push(i); }
    }

    let newVectors: number[][] = [];
    if (toEmbed.length > 0) {
      newVectors = await embedSvc.embed(toEmbed.map((r) => r.text));
      if (newVectors.length !== toEmbed.length) {
        throw new Error(`Embedding count mismatch: expected ${toEmbed.length}, got ${newVectors.length}`);
      }
    }

    const fullRecords: FunctionRecord[] = new Array(candidates.length);
    for (const idx of cachedIdx) {
      const r = candidates[idx];
      fullRecords[idx] = { ...r, vector: cachedVectors.get(`${r.id}::${r.text}`)! };
    }
    for (let i = 0; i < toEmbedIdx.length; i++) {
      fullRecords[toEmbedIdx[i]] = { ...candidates[toEmbedIdx[i]], vector: newVectors[i] };
    }

    await replaceRowsWithRestore(
      table,
      predicate,
      fullRecords as unknown as Record<string, unknown>[],
      previousRows,
      markDegraded,
    );
    await publishMutationOrRestore();
    // Reclaim the versions this delete+add left behind (see index-compaction).
    await noteUpdateAndMaybeCompact(
      dbPath,
      table as unknown as Parameters<typeof noteUpdateAndMaybeCompact>[1],
      previousRows.length,
    );

    // Keep the table handle (_tableCache) — row ops don't invalidate it. Patch
    // the BM25 corpus cache in place for the changed files.
    patchBm25Cache(dbPath, changedFilePaths, fullRecords as unknown as Record<string, unknown>[]);

    return { embedded: toEmbed.length, reused: cachedIdx.length, total: fullRecords.length, hasEmbeddings: true };
  }

  /**
   * Hybrid search over the index: dense (ANN) + sparse (BM25) merged via RRF.
   *
   * Dense recall fetches top `limit*5` candidates from the vector index.
   * Sparse recall scores the full corpus with BM25 (cached per session).
   * Reciprocal Rank Fusion (RRF) combines both rankings into a single list.
   *
   * Set `hybrid: false` to use dense-only search (original behaviour).
   * Returns up to `limit` results sorted by relevance (highest first).
   */
  static async search(
    outputDir: string,
    query: string,
    embedSvc: Embedder | null | undefined,
    opts: {
      limit?: number;
      language?: string;
      minFanIn?: number;
      /** Enable hybrid dense+sparse retrieval via RRF (default: true when embedSvc available) */
      hybrid?: boolean;
      /** Internal diagnostic: return the ordinary bounded candidate window before result cutoff. */
      traceCandidates?: boolean;
    } = {}
  ): Promise<SearchResult[]> {
    const { limit = 10, language, minFanIn, hybrid = true, traceCandidates = false } = opts;

    if (!VectorIndex.exists(outputDir)) {
      throw new Error('Vector index not found. Run "openlore analyze --embed" first.');
    }

    const dbPath = dbPathFor(outputDir);
    // readMeta owns the cross-process coherence check and invalidates the table
    // and corpus handles before either can be reused.
    const meta = readMeta(outputDir);
    let tableEntry = _tableCache.get(dbPath);
    if (!tableEntry) {
      _cacheStats.tableMisses++;
      quietNativeLoggingOnce();
      const { connect } = await import('@lancedb/lancedb');
      const db = await connect(dbPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const table: any = await db.openTable(TABLE_NAME);
      tableEntry = { table };
      _tableCache.set(dbPath, tableEntry);
    } else {
      _cacheStats.tableHits++;
    }
    const table = tableEntry.table;

    // ── BM25-only path ─────────────────────────────────────────────────────────
    // Force BM25 when no embedder is available OR when the index was built
    // without embeddings (no `vector` column). The sidecar is the source of
    // truth: a missing sidecar (legacy index) is treated as embeddings-present.
    const indexHasEmbeddings = metaHasEmbeddings(meta);
    if (!embedSvc || !indexHasEmbeddings) {
      return VectorIndex._bm25Only(table, dbPath, query, limit, language, minFanIn, traceCandidates);
    }

    // ── Dense recall ──────────────────────────────────────────────────────────
    let queryVector: number[];
    try {
      [queryVector] = await embedSvc.embed([query]);
    } catch {
      // Embedding server unreachable — fall back to BM25
      return VectorIndex._bm25Only(table, dbPath, query, limit, language, minFanIn, traceCandidates);
    }
    if (!queryVector) throw new Error('Failed to embed query');

    // Dimension safety-net: if the query embedder's dimension disagrees with the
    // index's recorded dimension (e.g. the embedding model was switched without a
    // full rebuild), ANN search would throw deep inside LanceDB. Degrade to BM25
    // rather than crashing the tool — the index is stale, not broken.
    if (meta !== null && meta !== INVALID_META && meta.dim > 0 && queryVector.length !== meta.dim) {
      return VectorIndex._bm25Only(table, dbPath, query, limit, language, minFanIn, traceCandidates);
    }

    const denseFetch = hybrid ? Math.min(limit * 5, 500) : Math.min(limit * 10, 1000);
    let denseQuery = table.query().nearestTo(queryVector);
    const densePredicate = functionSearchPredicate(language, minFanIn);
    // LanceDB applies where() before ANN by default. This prevents a post-fetch
    // filter from starving otherwise-valid results (change: refine-search-serving-quality).
    if (densePredicate) denseQuery = denseQuery.where(densePredicate);
    const denseRows = await denseQuery.limit(denseFetch).toArray() as Record<string, unknown>[];

    const passesFilters = (row: Record<string, unknown>): boolean => {
      if (!isRepoFunctionRow(row)) return false;
      if (language && (row.language as string) !== language) return false;
      if (minFanIn !== undefined && minFanIn > 0 && (row.fanIn as number) < minFanIn) return false;
      return true;
    };

    // ── Dense-only path ───────────────────────────────────────────────────────
    if (!hybrid) {
      return denseRows
        .filter(passesFilters)
        .slice(0, traceCandidates ? undefined : limit)
        .map(row => ({
          record: rowToRecord(row),
          score: row._distance as number,
          scoreKind: 'cosine_distance' as const,
          matchEvidence: vectorMatchEvidence(3),
        }));
    }

    // ── Sparse recall (BM25 over full corpus) ─────────────────────────────────
    let cachedEntry = _bm25Cache.get(dbPath);
    let allRows: Record<string, unknown>[];

    if (!cachedEntry) {
      _cacheStats.bm25Misses++;
      allRows = (await table.query().toArray() as Record<string, unknown>[]).filter(isRepoFunctionRow);
      const corpus = loadOrBuildBm25Corpus(dbPath, allRows);
      cachedEntry = { corpus, rowCount: allRows.length, rows: allRows };
      _bm25Cache.set(dbPath, cachedEntry);
    } else {
      _cacheStats.bm25Hits++;
      // Use cached rows — invalidated by build() when index is rebuilt
      allRows = cachedEntry.rows;
    }

    const { corpus } = cachedEntry;
    const queryTokens = tokenize(query);

    // Score all corpus documents with BM25
    const sparseScored = corpus.docs
      .map((_, i) => ({ idx: i, score: bm25Score(corpus, queryTokens, i) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 5);

    // Build id→row map from allRows for sparse candidates
    const rowById = new Map(allRows.map(r => [r.id as string, r]));

    // ── RRF merge ────────────────────────────────────────────────────────────
    // Candidate union: every dense hit plus every sparse hit with a non-zero BM25
    // signal. Final scores are recomputed below from both rank maps, so the union
    // only needs each candidate's row (dense row wins on collision, dense-first
    // insertion order preserved) — no per-entry score accumulation.
    const candidates = new Map<string, Record<string, unknown>>();

    for (const row of denseRows) {
      const id = row.id as string;
      if (!candidates.has(id)) candidates.set(id, row);
    }

    for (const { idx, score: bm25 } of sparseScored) {
      if (bm25 === 0) continue; // no BM25 signal — skip
      const id = corpus.docs[idx].id;
      const row = rowById.get(id);
      if (!row) continue;
      if (!candidates.has(id)) candidates.set(id, row);
    }

    // Compute RRF scores with both ranks available (sparse rank = Infinity when a
    // candidate never appeared in the sparse list, and vice versa).
    const denseRankById = new Map(denseRows.map((r, i) => [r.id as string, i]));
    const sparseRankById = new Map(sparseScored.map(({ idx }, i) => [corpus.docs[idx].id, i]));
    const sparseEvidenceById = new Map(
      sparseScored
        .filter(({ score }) => score > 0)
        .map(({ idx }) => {
          const id = corpus.docs[idx].id;
          const row = rowById.get(id);
          return [id, row
            ? bm25MatchEvidence(corpus, queryTokens, idx, searchableFieldsForFunctionRow(row), 2)
            : vectorMatchEvidence(2)] as const;
        }),
    );

    const merged = [...candidates.values()].map((row) => {
      const id = row.id as string;
      const dr = denseRankById.get(id) ?? Infinity;
      const sr = sparseRankById.get(id) ?? Infinity;
      return {
        row,
        score: rrfScore(dr, sr),
        matchEvidence: sparseEvidenceById.get(id) ?? vectorMatchEvidence(2),
      };
    });

    return merged
      .sort((a, b) => b.score - a.score)
      .filter(({ row }) => passesFilters(row))
      .slice(0, traceCandidates ? undefined : limit)
      .map(({ row, score, matchEvidence }) => ({
        record: rowToRecord(row), score, scoreKind: 'rrf' as const, matchEvidence,
      }));
  }

  /**
   * BM25-only search: used when no embedding service is available.
   * Scores the full corpus with BM25 and returns the top `limit` results.
   */
  private static async _bm25Only(
    table: { query(): { toArray(): Promise<Record<string, unknown>[]> } },
    dbPath: string,
    query: string,
    limit: number,
    language?: string,
    minFanIn?: number,
    traceCandidates = false,
  ): Promise<SearchResult[]> {
    let cachedEntry = _bm25Cache.get(dbPath);
    let allRows: Record<string, unknown>[];

    if (!cachedEntry) {
      _cacheStats.bm25Misses++;
      allRows = (await table.query().toArray() as Record<string, unknown>[]).filter(isRepoFunctionRow);
      const corpus = loadOrBuildBm25Corpus(dbPath, allRows);
      cachedEntry = { corpus, rowCount: allRows.length, rows: allRows };
      _bm25Cache.set(dbPath, cachedEntry);
    } else {
      _cacheStats.bm25Hits++;
      // Use cached rows — invalidated by build() when index is rebuilt
      allRows = cachedEntry.rows;
    }

    const { corpus } = cachedEntry;
    const queryTokens = tokenize(query);
    const rowById = new Map(allRows.map(r => [r.id as string, r]));

    return corpus.docs
      .map((_, i) => ({ idx: i, score: bm25Score(corpus, queryTokens, i) }))
      .filter(({ score }) => score > 0)
      // Sort by score desc; break ties by id asc so ranking is deterministic
      // across runs for a fixed query + corpus.
      .sort((a, b) => b.score - a.score || (corpus.docs[a.idx].id < corpus.docs[b.idx].id ? -1 : 1))
      .slice(0, limit * 3) // oversample before filtering
      .map(({ idx, score }) => {
        const row = rowById.get(corpus.docs[idx].id);
        return row ? { row, idx, score } : null;
      })
      .filter((x): x is { row: Record<string, unknown>; idx: number; score: number } => x !== null)
      .filter(({ row }) => {
        if (!isRepoFunctionRow(row)) return false;
        if (language && (row.language as string) !== language) return false;
        if (minFanIn !== undefined && minFanIn > 0 && (row.fanIn as number) < minFanIn) return false;
        return true;
      })
      .slice(0, traceCandidates ? undefined : limit)
      .map(({ row, idx, score }) => ({
        record: rowToRecord(row),
        score,
        scoreKind: 'bm25' as const,
        matchEvidence: bm25MatchEvidence(corpus, queryTokens, idx, searchableFieldsForFunctionRow(row), 1),
      }));
  }

  /**
   * Explain an empty keyword result using the corpus already loaded by search().
   * The lookup is bounded and deterministic: at most 12 distinct query tokens,
   * 3 near identifier tokens per miss, and no model or secondary index.
   */
  static async keywordMissDiagnostics(
    outputDir: string,
    query: string,
  ): Promise<KeywordMissDiagnostics> {
    const dbPath = dbPathFor(outputDir);
    let cachedEntry = _bm25Cache.get(dbPath);

    if (!cachedEntry) {
      quietNativeLoggingOnce();
      const { connect } = await import('@lancedb/lancedb');
      const db = await connect(dbPath);
      const table = await db.openTable(TABLE_NAME);
      const rows = (await table.query().toArray() as Record<string, unknown>[]).filter(isRepoFunctionRow);
      const corpus = loadOrBuildBm25Corpus(dbPath, rows);
      cachedEntry = { corpus, rowCount: rows.length, rows };
      _bm25Cache.set(dbPath, cachedEntry);
    }

    const queryTokens = [...new Set(tokenize(query))].slice(0, 12);
    const missedTokens = queryTokens.filter((token) => !cachedEntry.corpus.df.has(token));
    if (missedTokens.length === 0) return { missedTokens, nearTokens: [] };

    let identifierTokens = _identifierVocabularyCache.get(dbPath);
    if (!identifierTokens) {
      identifierTokens = [...new Set(
        cachedEntry.rows.flatMap((row) => tokenize(String(row.name ?? ''))),
      )].sort();
      _identifierVocabularyCache.set(dbPath, identifierTokens);
    }

    const nearTokens = missedTokens.flatMap((queryToken) => {
      const indexedTokens: string[] = [];
      const compare = (a: string, b: string): number =>
        Math.abs(a.length - queryToken.length) - Math.abs(b.length - queryToken.length)
        || a.localeCompare(b);
      for (const token of identifierTokens) {
        if (!token.includes(queryToken) && !queryToken.includes(token)) continue;
        indexedTokens.push(token);
        indexedTokens.sort(compare);
        if (indexedTokens.length > 3) indexedTokens.pop();
      }
      return indexedTokens.length > 0 ? [{ queryToken, indexedTokens }] : [];
    });

    return { missedTokens, nearTokens };
  }

  /**
   * Returns true if a vector index has been built for this output directory.
   */
  static exists(outputDir: string): boolean {
    if (!existsSync(dbPathFor(outputDir))) return false;
    return readMeta(outputDir) !== INVALID_META;
  }
}
