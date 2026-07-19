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
import { join } from 'node:path';
import { quietNativeLoggingOnce } from './lance-logging.js';
import {
  buildBm25Corpus,
  tokenize,
  bm25Score,
  type Bm25Corpus,
} from './vector-index.js';

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
const TABLE_NAME = 'text_lines';

/** Lines longer than this are truncated (not dropped) to keep rows bounded. */
const MAX_LINE_LEN = 1000;

// Module-level BM25 corpus cache, keyed by dbPath. Invalidated by build();
// patched in place by updateFiles().
const _bm25Cache = new Map<
  string,
  { corpus: Bm25Corpus; rows: TextLineRecord[] }
>();

/** Test-only: clear the in-memory BM25 cache to force the cold path. */
export function _resetTextLineIndexCachesForTesting(): void {
  _bm25Cache.clear();
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
  /** Returns true if a text-line index has been built for this output dir. */
  static exists(outputDir: string): boolean {
    return existsSync(join(outputDir, DB_FOLDER));
  }

  /**
   * Build (or rebuild) the text-line index from a set of files. Overwrites any
   * existing table. Files that yield no indexable lines contribute nothing.
   * Returns the number of lines indexed.
   */
  static async build(outputDir: string, files: TextFileInput[]): Promise<{ lines: number; files: number }> {
    const records: TextLineRecord[] = [];
    let indexedFiles = 0;
    for (const f of files) {
      const lines = extractLines(f.filePath, f.content);
      if (lines.length > 0) indexedFiles++;
      for (const l of lines) records.push(l);
    }

    const dbPath = join(outputDir, DB_FOLDER);
    quietNativeLoggingOnce();
    const { connect } = await import('@lancedb/lancedb');
    const db = await connect(dbPath);

    if (records.length === 0) {
      // Nothing to index. If a stale table exists, overwrite it with an empty
      // schema-bearing row set by dropping it; otherwise leave it absent.
      _bm25Cache.delete(dbPath);
      try {
        await db.dropTable(TABLE_NAME);
      } catch {
        /* table did not exist */
      }
      return { lines: 0, files: 0 };
    }

    await db.createTable(TABLE_NAME, records as unknown as Record<string, unknown>[], {
      mode: 'overwrite',
    });
    _bm25Cache.delete(dbPath);
    return { lines: records.length, files: indexedFiles };
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
    if (predicate) await table.delete(predicate);
    if (newRecords.length > 0) {
      await table.add(newRecords as unknown as Record<string, unknown>[]);
    }

    TextLineIndex._patchCache(dbPath, affectedPaths, newRecords);
    return { lines: newRecords.length };
  }

  /**
   * BM25-only search over the text lines. Returns up to `limit` `file:line`
   * matches ordered by relevance. Optionally restrict to a single file.
   */
  static async searchText(
    outputDir: string,
    query: string,
    opts: { limit?: number; filePath?: string } = {},
  ): Promise<TextSearchResult[]> {
    const { limit = 10, filePath } = opts;
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

    const recById = new Map(rows.map((r) => [r.id, r]));

    return corpus.docs
      .map((_, i) => ({ idx: i, score: bm25Score(corpus, queryTokens, i) }))
      .filter(({ score }) => score > 0)
      // Deterministic ordering: score desc, then id asc on ties.
      .sort((a, b) =>
        b.score - a.score ||
        (corpus.docs[a.idx].id < corpus.docs[b.idx].id ? -1 : 1),
      )
      .map(({ idx, score }) => {
        const rec = recById.get(corpus.docs[idx].id);
        return rec ? { rec, score } : null;
      })
      .filter((x): x is { rec: TextLineRecord; score: number } => x !== null)
      .filter(({ rec }) => (filePath ? rec.filePath === filePath : true))
      .slice(0, limit)
      .map(({ rec, score }) => ({
        filePath: rec.filePath,
        lineNumber: rec.lineNumber,
        text: rec.text,
        score,
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
