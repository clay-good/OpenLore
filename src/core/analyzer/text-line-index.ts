/**
 * TextLineIndex
 *
 * A literal-text line index kept **separate** from the symbol (call-graph /
 * signature) index in `vector-index.ts`. It stores raw lines of walked files —
 * markup, stylesheets, templates, plain text, and the non-symbol remainder of
 * code files — so that literal strings the user can see on screen (UI copy,
 * error messages, hard-coded labels) are findable even when they live in static
 * markup that extracts no symbols (e.g. a "Message completed" banner in
 * index.html).
 *
 * Design (decision fd256fde):
 *  - **Separate LanceDB table** (`text_lines`), never the call graph. Text lines
 *    are never nodes and never contribute to fanIn/fanOut, hubs, entrypoints,
 *    communities or PageRank — graph purity by construction, not by per-call-site
 *    filtering.
 *  - **BM25-only, no embeddings.** Literal lookup wants exact lexical match, not
 *    vector similarity; this keeps build cost and index size bounded and results
 *    deterministic.
 *  - Reuses the BM25 machinery already in `vector-index.ts`
 *    (`buildBm25Corpus` / `tokenize` / `bm25Score`) rather than reimplementing it.
 *
 * Storage: <outputDir>/text-line-index/  (LanceDB database folder)
 * Table name: "text_lines"
 */

import { existsSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { readdir, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { quietNativeLoggingOnce } from './lance-logging.js';
import { noteUpdateAndMaybeCompact } from './index-compaction.js';
import {
  buildBm25Corpus,
  tokenize,
  bm25MatchEvidence,
  bm25Score,
  type Bm25Corpus,
} from './vector-index.js';
import type { MatchEvidence } from './retrieval-evidence.js';
import { compareVocabularyRank, expandVocabularyQuery, scoredExpansionTerms } from './repo-vocabulary.js';

// ============================================================================
// TYPES
// ============================================================================

/** One indexed line of a text file. */
export interface TextLineRecord {
  /** `${filePath}:${lineNumber}` — unique per line. */
  id: string;
  filePath: string;
  /** 1-based line number. */
  lineNumber: number;
  /** The raw line text (truncated if very long). */
  text: string;
}

export interface TextSearchResult {
  filePath: string;
  lineNumber: number;
  text: string;
  /** BM25 relevance score, higher = more relevant. */
  score: number;
  matchEvidence: MatchEvidence;
  expansionTerms?: string[];
}

/** A file to index: its repo-relative path and full content. */
export interface TextFileInput {
  filePath: string;
  content: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DB_FOLDER = 'text-line-index';

/**
 * Prefix of a staging directory. Exported so a leaked one can be recognised: the build stages the
 * new index here and renames it into place, so a process killed mid-build (an OOM-kill, a Ctrl-C)
 * leaves a directory the size of a full index behind.
 */
export const STAGING_PREFIX = `${DB_FOLDER}.building-`;
const TABLE_NAME = 'text_lines';

/** Lines longer than this are truncated (not dropped) to keep rows bounded. */
const MAX_LINE_LEN = 1000;

/**
 * How many line records accumulate before {@link TextLineIndex.build} flushes them to the table.
 *
 * The build used to hold one record object per source line for the WHOLE repository before
 * writing anything, which is what exhausted the heap on a large repository. Flushing in batches
 * makes peak residency a function of this constant instead of the corpus.
 *
 * Large enough that the per-append overhead stays amortized (a flush is a LanceDB write, not a
 * per-row cost), small enough that a batch is a few tens of MB rather than gigabytes.
 */
let BUILD_FLUSH_LINES = 200_000;

/**
 * Test-only: lower the flush threshold so a small fixture exercises the MULTI-BATCH path.
 *
 * Without this a test would need ~500k lines to cross the production threshold twice, because a
 * file's lines are appended whole before the threshold is checked. A fixture that never crosses
 * it twice silently tests only the single-flush path — which is exactly how a mutation that
 * re-created the table on every flush (clobbering earlier batches) passed a first draft of these
 * tests. Returns the previous value so callers can restore it.
 */
export function _setBuildFlushLinesForTesting(n: number): number {
  const previous = BUILD_FLUSH_LINES;
  BUILD_FLUSH_LINES = n;
  return previous;
}

// Module-level BM25 corpus cache, keyed by dbPath. Invalidated by build();
// patched in place by updateFiles().
const _bm25Cache = new Map<
  string,
  { corpus: Bm25Corpus; rows: TextLineRecord[] }
>();

/**
 * The in-memory corpus costs ~0.7 KB per line on real code (measured) and more with
 * short-token lines, so 1 KB is the planning figure. An index whose corpus would take more
 * than a quarter of the heap is searched by streaming instead: loading 5.5M lines needed a
 * 7.4 GB heap and crashed smaller ones (#806).
 */
const CACHED_BYTES_PER_LINE = 1024;
const CACHE_HEAP_SHARE = 0.25;
let cacheLineLimitOverride: number | null = null;

function corpusFitsInMemory(lines: number): boolean {
  const limit = cacheLineLimitOverride
    ?? (getHeapStatistics().heap_size_limit * CACHE_HEAP_SHARE) / CACHED_BYTES_PER_LINE;
  return lines <= limit;
}

/** Test-only: force the streaming path above `n` lines (`null` restores the heap-derived limit). */
export function _setCacheLineLimitForTesting(n: number | null): void {
  cacheLineLimitOverride = n;
}

// Corpus-wide line count and token total for the streaming path, keyed by index path and
// table version, so a write by any process is seen on the next search.
const _streamStats = new Map<string, { version: number; N: number; totalLen: number }>();

/** Test-only: clear the in-memory BM25 cache to force the cold path. */
export function _resetTextLineIndexCachesForTesting(): void {
  _bm25Cache.clear();
  _streamStats.clear();
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Split a file into indexable line records. Blank / whitespace-only lines are
 * skipped; over-long lines are truncated, never dropped.
 */
export function extractLines(filePath: string, content: string): TextLineRecord[] {
  const out: TextLineRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;
    const text = raw.length > MAX_LINE_LEN ? raw.slice(0, MAX_LINE_LEN) : raw;
    const lineNumber = i + 1;
    out.push({ id: `${filePath}:${lineNumber}`, filePath, lineNumber, text });
  }
  return out;
}

/**
 * Build a LanceDB `` `filePath` IN (...) `` predicate, SQL-escaping each path.
 * Backtick-quoting is required to bind to the camelCase column (see the matching
 * note in vector-index.ts).
 */
function filePathInPredicate(paths: Set<string>): string | null {
  if (paths.size === 0) return null;
  const list = Array.from(paths)
    .map((p) => `'${p.replace(/'/g, "''")}'`)
    .join(', ');
  return `\`filePath\` IN (${list})`;
}

function recordsToCorpusInput(rows: TextLineRecord[]): Array<{ id: string; text: string }> {
  return rows.map((r) => ({ id: r.id, text: r.text }));
}

// ============================================================================
// TEXT LINE INDEX
// ============================================================================

export class TextLineIndex {
  /**
   * Remove staging directories left by builds that died before they could rename or clean up.
   *
   * Only directories whose owning process is gone are removed — a staging directory belongs to a
   * live build until it is renamed, and a build on a large repository legitimately runs for a long
   * time, so age alone is not a safe signal. Best effort: a sweep that cannot run must never stop
   * an analysis.
   */
  static async sweepLeakedStaging(outputDir: string): Promise<void> {
    try {
      for (const name of await readdir(outputDir)) {
        if (!name.startsWith(STAGING_PREFIX)) continue;
        const pid = Number(name.slice(STAGING_PREFIX.length));
        if (pid === process.pid) continue;
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            continue; // still running — not ours to remove
          } catch {
            /* no such process: the owner is gone */
          }
        }
        await rm(join(outputDir, name), { recursive: true, force: true }).catch(() => {});
      }
    } catch {
      /* unreadable output dir — nothing to sweep */
    }
  }

  /** Returns true if a text-line index has been built for this output dir. */
  static exists(outputDir: string): boolean {
    return existsSync(join(outputDir, DB_FOLDER));
  }

  /** Whether the literal-text index contains at least one row for a file. */
  static async hasFile(outputDir: string, filePath: string): Promise<boolean> {
    if (!TextLineIndex.exists(outputDir)) return false;
    try {
      quietNativeLoggingOnce();
      const { connect } = await import('@lancedb/lancedb');
      const db = await connect(join(outputDir, DB_FOLDER));
      const table = await db.openTable(TABLE_NAME);
      const escaped = filePath.replace(/'/g, "''");
      const rows = await table.query().where(`\`filePath\` = '${escaped}'`).limit(1).toArray();
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Build (or rebuild) the text-line index from a set of files. Overwrites any
   * existing table. Files that yield no indexable lines contribute nothing.
   * Returns the number of lines indexed.
   *
   * `files` may be an array OR an async iterable, and the async form is the one that matters at
   * scale: this used to materialize ONE RECORD OBJECT PER SOURCE LINE for the entire repository
   * before handing the whole array to LanceDB. On a large repository that is millions of live
   * objects on top of every file's text, and it was the point at which `openlore install` ran out
   * of heap — measured on microsoft/TypeScript (80,113 files), which died here after the call
   * graph and the keyword index had both completed successfully.
   *
   * Records are flushed every {@link BUILD_FLUSH_LINES} lines, so peak residency is one batch
   * rather than the whole corpus. Passing an async iterable additionally lets the CALLER avoid
   * holding every file's content at once; an array argument keeps working unchanged.
   *
   * The build is ATOMIC, and that is not incidental. Flushing incrementally into the live table
   * would mean the first flush destroys the previous index and every later failure leaves a
   * TRUNCATED one — verified by killing a build mid-flush: the old rows were gone, some new ones
   * were present, and `exists()` still reported a healthy index, so the watcher would have gone
   * on patching a permanently partial corpus forever. It also meant a concurrent reader saw a
   * half-built index for the whole build, and two concurrent builds failed outright on a LanceDB
   * commit conflict.
   *
   * So the batches go into a private per-process directory and the finished index is moved into
   * place with a single rename. A build that throws, is killed, or races another build leaves the
   * previous index untouched; the only observable states are "the old index" and "the new one".
   */
  static async build(
    outputDir: string,
    files: Iterable<TextFileInput> | AsyncIterable<TextFileInput>,
  ): Promise<{ lines: number; files: number }> {
    const dbPath = join(outputDir, DB_FOLDER);
    // Sibling of the real index, not the OS temp dir: the rename below must stay on one
    // filesystem to be atomic. The pid keeps two concurrent builds from sharing a staging area.
    const stagePath = join(outputDir, `${STAGING_PREFIX}${process.pid}`);
    quietNativeLoggingOnce();
    const { connect } = await import('@lancedb/lancedb');

    let batch: TextLineRecord[] = [];
    let total = 0;
    let indexedFiles = 0;

    try {
      const stageDb = await connect(stagePath);
      let table: Awaited<ReturnType<typeof stageDb.createTable>> | null = null;

      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const rows = batch as unknown as Record<string, unknown>[];
        batch = []; // a fresh array, so the flushed one can be collected immediately
        if (table === null) {
          table = await stageDb.createTable(TABLE_NAME, rows, { mode: 'overwrite' });
        } else {
          await table.add(rows);
        }
        total += rows.length;
      };

      // `for await` accepts a plain sync iterable too, so array callers are unaffected.
      for await (const f of files) {
        const lines = extractLines(f.filePath, f.content);
        if (lines.length === 0) continue;
        indexedFiles++;
        // Checked per LINE, not per file. Testing only after a whole file is appended makes the
        // real bound `BUILD_FLUSH_LINES + (lines in the largest file)`, which is not the bound
        // this is documented to provide.
        for (const l of lines) {
          batch.push(l);
          if (batch.length >= BUILD_FLUSH_LINES) await flush();
        }
      }
      await flush();

      if (total === 0) {
        // Nothing to index: remove any previous index rather than leaving a stale one, and leave
        // no empty table behind where the old code left none.
        await rm(stagePath, { recursive: true, force: true });
        await rm(dbPath, { recursive: true, force: true });
        _bm25Cache.delete(dbPath);
        return { lines: 0, files: 0 };
      }

      // Swap. The previous index is removed only once the replacement is complete on disk, so a
      // failure anywhere above leaves it exactly as it was.
      await rm(dbPath, { recursive: true, force: true });
      await rename(stagePath, dbPath);
      _bm25Cache.delete(dbPath);
      return { lines: total, files: indexedFiles };
    } catch (err) {
      await rm(stagePath, { recursive: true, force: true }).catch(() => { /* best effort */ });
      throw err;
    }
  }

  /**
   * Incrementally update the index for changed and deleted files. Changed files
   * have their old lines replaced; deleted files have their lines removed. The
   * cached BM25 corpus is patched in place. No-op if the index does not exist.
   */
  static async updateFiles(
    outputDir: string,
    changed: TextFileInput[],
    deletedPaths: string[] = [],
  ): Promise<{ lines: number }> {
    if (!TextLineIndex.exists(outputDir)) return { lines: 0 };

    const dbPath = join(outputDir, DB_FOLDER);
    quietNativeLoggingOnce();
    const { connect } = await import('@lancedb/lancedb');
    const db = await connect(dbPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let table: any;
    try {
      table = await db.openTable(TABLE_NAME);
    } catch {
      // No table yet (e.g. previous build had zero lines) — build from scratch
      // using just the changed files.
      return TextLineIndex.build(outputDir, changed).then((r) => ({ lines: r.lines }));
    }

    const affectedPaths = new Set<string>([
      ...changed.map((c) => c.filePath),
      ...deletedPaths,
    ]);

    const newRecords: TextLineRecord[] = [];
    for (const f of changed) {
      for (const l of extractLines(f.filePath, f.content)) newRecords.push(l);
    }

    const predicate = filePathInPredicate(affectedPaths);
    const deletedRows = predicate ? await table.countRows(predicate) as number : 0;
    if (predicate) await table.delete(predicate);
    if (newRecords.length > 0) {
      await table.add(newRecords as unknown as Record<string, unknown>[]);
    }

    TextLineIndex._patchCache(dbPath, affectedPaths, newRecords);
    // Reclaim the versions this delete+add left behind. LanceDB is append-only, so without this
    // the index grows without bound for as long as the watcher runs — measured at 401 MB holding
    // 36 MB of live rows on a repository whose source is ~9 MB.
    await noteUpdateAndMaybeCompact(
      dbPath,
      table as unknown as Parameters<typeof noteUpdateAndMaybeCompact>[1],
      deletedRows,
    );
    return { lines: newRecords.length };
  }

  /**
   * BM25-only search over the text lines. Returns up to `limit` `file:line`
   * matches ordered by relevance. Optionally restrict to a single file.
   */
  static async searchText(
    outputDir: string,
    query: string,
    opts: { limit?: number; filePath?: string; traceCandidates?: boolean; vocabularyExpansion?: boolean } = {},
  ): Promise<TextSearchResult[]> {
    const { limit = 10, filePath, traceCandidates = false, vocabularyExpansion = true } = opts;
    if (!TextLineIndex.exists(outputDir)) return [];

    const dbPath = join(outputDir, DB_FOLDER);
    let cached = _bm25Cache.get(dbPath);
    if (!cached) {
      quietNativeLoggingOnce();
      const { connect } = await import('@lancedb/lancedb');
      const db = await connect(dbPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let table: any;
      try {
        table = await db.openTable(TABLE_NAME);
      } catch {
        return [];
      }
      const lineCount = (await table.countRows()) as number;
      if (!corpusFitsInMemory(lineCount)) {
        return streamSearchText(table, dbPath, outputDir, query, { limit, filePath, traceCandidates, vocabularyExpansion });
      }
      const rows = (await table.query().toArray()) as Record<string, unknown>[];
      const records: TextLineRecord[] = rows.map((r) => ({
        id: r.id as string,
        filePath: r.filePath as string,
        lineNumber: r.lineNumber as number,
        text: r.text as string,
      }));
      cached = { corpus: buildBm25Corpus(recordsToCorpusInput(records)), rows: records };
      _bm25Cache.set(dbPath, cached);
    }

    const { corpus, rows } = cached;
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const expandedQuery = expandVocabularyQuery(outputDir, queryTokens, vocabularyExpansion);

    const recById = new Map(rows.map((r) => [r.id, r]));

    return corpus.docs
      .map((doc, i) => ({
        idx: i,
        score: bm25Score(corpus, queryTokens, i),
        expansionScore: bm25Score(corpus, expandedQuery.expansionTokens, i),
        id: doc.id,
      }))
      .filter(({ score, expansionScore }) => score > 0 || expansionScore > 0)
      // Deterministic ordering: score desc, then id asc on ties.
      .sort(compareVocabularyRank)
      .map(({ idx, score, expansionScore }) => {
        const rec = recById.get(corpus.docs[idx].id);
        return rec ? { rec, idx, score, expansionScore } : null;
      })
      .filter((x): x is { rec: TextLineRecord; idx: number; score: number; expansionScore: number } => x !== null)
      .filter(({ rec }) => (filePath ? rec.filePath === filePath : true))
      .slice(0, traceCandidates ? limit * 3 : limit)
      .map(({ rec, idx, score, expansionScore }) => ({
        filePath: rec.filePath,
        lineNumber: rec.lineNumber,
        text: rec.text,
        score: score > 0 ? score : expansionScore,
        matchEvidence: bm25MatchEvidence(
          corpus,
          score > 0 ? queryTokens : expandedQuery.expansionTokens,
          idx,
          { body: rec.text },
          score > 0 ? 1 : 2,
        ),
        ...(() => {
          const terms = scoredExpansionTerms(expandedQuery.expansionTokens, corpus.docs[idx].tfMap);
          return terms.length > 0 ? { expansionTerms: terms } : {};
        })(),
      }));
  }

  /**
   * Patch the cached BM25 corpus: drop rows for `affectedPaths`, splice in
   * `newRecords`, rebuild the corpus. No-op when nothing is cached (the next
   * search rebuilds from the table).
   */
  private static _patchCache(
    dbPath: string,
    affectedPaths: Set<string>,
    newRecords: TextLineRecord[],
  ): void {
    const entry = _bm25Cache.get(dbPath);
    if (!entry) return;
    const kept = entry.rows.filter((r) => !affectedPaths.has(r.filePath));
    for (const r of newRecords) kept.push(r);
    _bm25Cache.set(dbPath, {
      corpus: buildBm25Corpus(recordsToCorpusInput(kept)),
      rows: kept,
    });
  }
}

// ============================================================================
// STREAMING SEARCH (#806)
// ============================================================================

/** A one-document corpus view: BM25 over it reads only `df`, `N` and `avgLength` of the corpus. */
function docView(
  doc: { id: string; tfMap: Map<string, number>; length: number },
  df: Map<string, number>,
  N: number,
  avgLength: number,
): Bm25Corpus {
  return { docs: [doc], df, N, avgLength };
}

/**
 * Search the text index without loading it: memory is one Arrow batch plus the result list.
 * Scores, ties and evidence are the in-memory path's exactly. Pass 1 counts each query term's
 * document frequency (and, once per table version, the corpus line and token totals); pass 2
 * scores the lines that contain a query term and keeps the best ones. A token is a lowercase
 * substring of its line, so `includes` skips lines that cannot match without tokenizing them.
 */
async function streamSearchText(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  dbPath: string,
  outputDir: string,
  query: string,
  opts: { limit: number; filePath?: string; traceCandidates: boolean; vocabularyExpansion: boolean },
): Promise<TextSearchResult[]> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const { expansionTokens } = expandVocabularyQuery(outputDir, queryTokens, opts.vocabularyExpansion);
  const terms = [...new Set([...queryTokens, ...expansionTokens])];
  const mayContain = (text: string): boolean => {
    const lower = text.toLowerCase();
    return terms.some((t) => lower.includes(t));
  };
  const termFrequencies = (tokens: string[]): Map<string, number> => {
    const tf = new Map<string, number>();
    for (const t of tokens) if (terms.includes(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  };

  // Pass 1: document frequencies, plus the corpus totals when this table version lacks them.
  const version = (await table.version()) as number;
  let stats = _streamStats.get(dbPath);
  if (stats?.version !== version) stats = undefined;
  const df = new Map<string, number>();
  let N = 0;
  let totalLen = 0;
  for await (const batch of table.query().select(['text'])) {
    const text = batch.getChild('text');
    for (let i = 0; i < batch.numRows; i++) {
      const line = text.get(i) as string;
      if (stats && !mayContain(line)) continue;
      const tokens = tokenize(line);
      N++;
      totalLen += tokens.length;
      for (const t of termFrequencies(tokens).keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  if (!stats) {
    stats = { version, N, totalLen };
    _streamStats.set(dbPath, stats);
  }
  const avgLength = stats.N > 0 ? stats.totalLen / stats.N : 1;

  // Pass 2: score the lines that contain a query term; keep the best `keep`.
  const keep = opts.traceCandidates ? opts.limit * 3 : opts.limit;
  type Hit = { rec: TextLineRecord; doc: { id: string; tfMap: Map<string, number>; length: number }; id: string; score: number; expansionScore: number };
  const best: Hit[] = [];
  for await (const batch of table.query().select(['id', 'filePath', 'lineNumber', 'text'])) {
    const ids = batch.getChild('id');
    const paths = batch.getChild('filePath');
    const lineNumbers = batch.getChild('lineNumber');
    const text = batch.getChild('text');
    for (let i = 0; i < batch.numRows; i++) {
      const line = text.get(i) as string;
      if (!mayContain(line)) continue;
      const path = paths.get(i) as string;
      if (opts.filePath && path !== opts.filePath) continue;
      const tokens = tokenize(line);
      const doc = { id: ids.get(i) as string, tfMap: termFrequencies(tokens), length: tokens.length };
      const view = docView(doc, df, stats.N, avgLength);
      const score = bm25Score(view, queryTokens, 0);
      const expansionScore = bm25Score(view, expansionTokens, 0);
      if (score <= 0 && expansionScore <= 0) continue;
      const hit: Hit = { rec: { id: doc.id, filePath: path, lineNumber: Number(lineNumbers.get(i)), text: line }, doc, id: doc.id, score, expansionScore };
      if (best.length === keep && compareVocabularyRank(hit, best[best.length - 1]) >= 0) continue;
      let at = best.length;
      while (at > 0 && compareVocabularyRank(hit, best[at - 1]) < 0) at--;
      best.splice(at, 0, hit);
      if (best.length > keep) best.pop();
    }
  }

  return best.map(({ rec, doc, score, expansionScore }) => {
    const view = docView(doc, df, stats.N, avgLength);
    const terms = scoredExpansionTerms(expansionTokens, doc.tfMap);
    return {
      filePath: rec.filePath,
      lineNumber: rec.lineNumber,
      text: rec.text,
      score: score > 0 ? score : expansionScore,
      matchEvidence: bm25MatchEvidence(view, score > 0 ? queryTokens : expansionTokens, 0, { body: rec.text }, score > 0 ? 1 : 2),
      ...(terms.length > 0 ? { expansionTerms: terms } : {}),
    };
  });
}
