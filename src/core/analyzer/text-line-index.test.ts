/**
 * TextLineIndex — literal-text line index (decision fd256fde).
 *
 * Proves the regression that motivated the feature: a literal string living in
 * static markup (a "Message completed" banner in index.html) is findable, even
 * though it extracts no symbols and is invisible to the symbol index. Also
 * covers inline <script> literals, incremental update, and line extraction.
 * BM25-only — needs no embedding service.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TextLineIndex,
  extractLines,
  _resetTextLineIndexCachesForTesting,
  _setBuildFlushLinesForTesting,
} from './text-line-index.js';

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'ol-text-idx-'));
  _resetTextLineIndexCachesForTesting();
});

afterEach(async () => {
  _resetTextLineIndexCachesForTesting();
  await rm(outputDir, { recursive: true, force: true });
});

describe('extractLines', () => {
  it('skips blank lines and numbers from 1', () => {
    const recs = extractLines('a.html', 'first\n\n   \nfourth');
    expect(recs.map((r) => r.lineNumber)).toEqual([1, 4]);
    expect(recs.map((r) => r.text)).toEqual(['first', 'fourth']);
    expect(recs[0].id).toBe('a.html:1');
  });

  it('truncates over-long lines instead of dropping them', () => {
    const long = 'x'.repeat(5000);
    const recs = extractLines('a.txt', long);
    expect(recs).toHaveLength(1);
    expect(recs[0].text.length).toBe(1000);
  });
});

describe('TextLineIndex — literal search', () => {
  it('finds a static-markup string the symbol index cannot hold', async () => {
    // The motivating failure: "Message completed" lives as static text in index.html.
    const html = [
      '<!DOCTYPE html>',
      '<html>',
      '  <body>',
      '    <div class="status status--ok">Message completed</div>',
      '  </body>',
      '</html>',
    ].join('\n');
    const built = await TextLineIndex.build(outputDir, [{ filePath: 'index.html', content: html }]);
    expect(built.files).toBe(1);
    expect(built.lines).toBeGreaterThan(0);
    _resetTextLineIndexCachesForTesting();

    const hits = await TextLineIndex.searchText(outputDir, 'Message completed');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].filePath).toBe('index.html');
    expect(hits[0].lineNumber).toBe(4);
    expect(hits[0].text).toContain('Message completed');
  });

  it('finds a literal inside an inline <script> string', async () => {
    const html = [
      '<html><head><script>',
      '  function onDone() {',
      '    banner.textContent = "Message completed";',
      '  }',
      '</script></head></html>',
    ].join('\n');
    await TextLineIndex.build(outputDir, [{ filePath: 'page.html', content: html }]);
    _resetTextLineIndexCachesForTesting();

    const hits = await TextLineIndex.searchText(outputDir, 'completed');
    expect(hits.some((h) => h.text.includes('Message completed'))).toBe(true);
  });

  it('returns nothing for a blank query', async () => {
    await TextLineIndex.build(outputDir, [{ filePath: 'a.txt', content: 'hello world' }]);
    _resetTextLineIndexCachesForTesting();
    expect(await TextLineIndex.searchText(outputDir, '   ')).toEqual([]);
  });

  it('exists() is false before build', () => {
    expect(TextLineIndex.exists(outputDir)).toBe(false);
  });
});

/**
 * The build streams (change: fix-text-line-index-oom): it flushes to the table every
 * BUILD_FLUSH_LINES records instead of materializing one record per source line for the whole
 * repository. That was the point at which `openlore install` ran out of heap on a large
 * repository, AFTER the call graph and keyword index had both completed.
 *
 * Everything below crosses the flush threshold, so the multi-batch path is the one under test —
 * the single-batch path is what every other test in this file already covers.
 */
describe('TextLineIndex.build — streaming and batching', () => {
  // Drop the flush threshold so a SMALL fixture crosses it many times. At the production 200k
  // this fixture would fit in a single flush and the multi-batch path — the entire point of
  // these tests — would go untested.
  let restoreFlush = 0;
  beforeEach(() => { restoreFlush = _setBuildFlushLinesForTesting(500); });
  afterEach(() => { _setBuildFlushLinesForTesting(restoreFlush); });

  /** Small, but 4x the lowered threshold per file — so every build here spans many batches. */
  const BIG_FILE_LINES = 2_000;
  // Markers must share NO token with each other. The BM25 tokenizer splits identifiers, so
  // `alphaMarker` and `gammaMarker` both yield "marker" and a search for one matches the other —
  // which made a first draft of these assertions pass even when later flushes clobbered earlier
  // batches. Single opaque words keep the assertions honest.
  const bigFile = (name: string, marker: string) => ({
    filePath: name,
    content: Array.from({ length: BIG_FILE_LINES }, (_, i) =>
      i === BIG_FILE_LINES - 1 ? `const ${marker} = 1;` : `const value${i} = ${i};`).join('\n'),
  });

  it('indexes every line across multiple flushes, and finds one in the LAST batch', async () => {
    // Three files of 2,000 lines against a 500-line threshold = a dozen flushes. The marker sits
    // in the LAST file's LAST line — a build that re-created the table per flush instead of
    // appending would keep only the final batch and lose the earlier markers.
    const files = [
      bigFile('a.ts', 'zebracrossing'),
      bigFile('b.ts', 'plumbago'),
      bigFile('c.ts', 'quixotry'),
    ];
    const built = await TextLineIndex.build(outputDir, files);
    expect(built.files).toBe(3);
    expect(built.lines).toBe(BIG_FILE_LINES * 3);

    // Every batch must survive: the FIRST file's marker, a MIDDLE one, and the LAST. A build that
    // re-created the table per flush instead of appending keeps only the final batch, so the
    // first two lookups are what catch it. Assert the file too — a hit from the wrong file would
    // mean the query matched a shared token rather than the marker.
    for (const [marker, file] of [['zebracrossing', 'a.ts'], ['plumbago', 'b.ts'], ['quixotry', 'c.ts']] as const) {
      _resetTextLineIndexCachesForTesting();
      const hits = await TextLineIndex.searchText(outputDir, marker);
      expect(hits.length, `${marker} missing — an earlier batch was lost`).toBeGreaterThan(0);
      expect(hits[0].filePath).toBe(file);
      expect(hits[0].lineNumber).toBe(BIG_FILE_LINES);
    }
  }, 120_000);

  it('produces the same index from an async iterable as from an array', async () => {
    // `analyze` passes an async generator so it never holds every file's text at once; that must
    // be indistinguishable from the array form every other caller uses.
    const files = [
      bigFile('x.ts', 'sphygmomanometer'),
      bigFile('y.ts', 'zugzwang'),
    ];

    const fromArray = await TextLineIndex.build(outputDir, files);
    _resetTextLineIndexCachesForTesting();
    const arrayHit = await TextLineIndex.searchText(outputDir, 'zugzwang');

    const other = await mkdtemp(join(tmpdir(), 'ol-text-idx-async-'));
    try {
      async function* stream() { for (const f of files) yield f; }
      const fromStream = await TextLineIndex.build(other, stream());
      expect(fromStream).toEqual(fromArray);

      _resetTextLineIndexCachesForTesting();
      const streamHit = await TextLineIndex.searchText(other, 'zugzwang');
      expect(streamHit.map(h => [h.filePath, h.lineNumber]))
        .toEqual(arrayHit.map(h => [h.filePath, h.lineNumber]));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  }, 120_000);

  it('leaves no table behind when nothing is indexable, from either input form', async () => {
    // The first flush is what creates the table with mode:'overwrite'. It must not fire for an
    // empty corpus, or an empty repository would leave an empty table where there was none.
    async function* nothing() { /* yields nothing */ }
    expect(await TextLineIndex.build(outputDir, nothing())).toEqual({ lines: 0, files: 0 });
    expect(await TextLineIndex.searchText(outputDir, 'anything')).toEqual([]);

    expect(await TextLineIndex.build(outputDir, [{ filePath: 'blank.txt', content: '\n  \n\t\n' }]))
      .toEqual({ lines: 0, files: 0 });
    expect(await TextLineIndex.searchText(outputDir, 'anything')).toEqual([]);
  });

  it('a build that throws part-way leaves the PREVIOUS index intact', async () => {
    // Flushing straight into the live table would make the first flush destroy the old index and
    // every later failure leave a truncated one — verified against that shape: the old markers
    // were gone, some new ones were present, and `exists()` still reported a healthy index, so
    // the watcher would have gone on patching a permanently partial corpus. The staged build +
    // rename means the only observable states are "the old index" and "the new one".
    await TextLineIndex.build(outputDir, [
      bigFile('old-a.ts', 'zebracrossing'),
      bigFile('old-b.ts', 'plumbago'),
    ]);
    _resetTextLineIndexCachesForTesting();
    expect((await TextLineIndex.searchText(outputDir, 'zebracrossing')).length).toBeGreaterThan(0);

    async function* explodes(): AsyncGenerator<{ filePath: string; content: string }> {
      yield bigFile('new-a.ts', 'quixotry');
      yield bigFile('new-b.ts', 'sphygmomanometer');
      throw new Error('read failed part-way');
    }
    await expect(TextLineIndex.build(outputDir, explodes())).rejects.toThrow('read failed');

    // The old index must be exactly as it was — not replaced, not truncated, not empty.
    _resetTextLineIndexCachesForTesting();
    expect((await TextLineIndex.searchText(outputDir, 'zebracrossing')).length).toBeGreaterThan(0);
    expect((await TextLineIndex.searchText(outputDir, 'plumbago')).length).toBeGreaterThan(0);
    // …and nothing from the failed build leaked into it.
    expect(await TextLineIndex.searchText(outputDir, 'quixotry')).toEqual([]);
  }, 120_000);

  it('leaves no staging directory behind, on success or on failure', async () => {
    const staged = () => readdirSync(outputDir).filter(n => n.includes('.building-'));

    await TextLineIndex.build(outputDir, [bigFile('ok.ts', 'zebracrossing')]);
    expect(staged(), 'staging survived a successful build').toEqual([]);

    async function* explodes(): AsyncGenerator<{ filePath: string; content: string }> {
      yield bigFile('a.ts', 'quixotry');
      throw new Error('boom');
    }
    await expect(TextLineIndex.build(outputDir, explodes())).rejects.toThrow('boom');
    expect(staged(), 'staging survived a failed build').toEqual([]);
  }, 120_000);

  it('an empty rebuild drops a previously built index rather than leaving it stale', async () => {
    await TextLineIndex.build(outputDir, [{ filePath: 'a.txt', content: 'findableToken here' }]);
    _resetTextLineIndexCachesForTesting();
    expect((await TextLineIndex.searchText(outputDir, 'findableToken')).length).toBeGreaterThan(0);

    async function* nothing() { /* yields nothing */ }
    expect(await TextLineIndex.build(outputDir, nothing())).toEqual({ lines: 0, files: 0 });
    _resetTextLineIndexCachesForTesting();
    expect(await TextLineIndex.searchText(outputDir, 'findableToken')).toEqual([]);
  });
});

describe('TextLineIndex.updateFiles — incremental', () => {
  it('replaces a changed file lines; sibling survives; delete removes', async () => {
    await TextLineIndex.build(outputDir, [
      { filePath: 'a.html', content: '<p>alpha banner</p>' },
      { filePath: 'b.html', content: '<p>beta banner</p>' },
    ]);
    _resetTextLineIndexCachesForTesting();

    expect((await TextLineIndex.searchText(outputDir, 'alpha')).length).toBeGreaterThan(0);

    // Edit a.html — old "alpha" line replaced by "gamma".
    await TextLineIndex.updateFiles(outputDir, [{ filePath: 'a.html', content: '<p>gamma banner</p>' }]);
    _resetTextLineIndexCachesForTesting();

    expect(await TextLineIndex.searchText(outputDir, 'alpha')).toEqual([]);
    expect((await TextLineIndex.searchText(outputDir, 'gamma')).length).toBeGreaterThan(0);
    // Sibling untouched.
    expect((await TextLineIndex.searchText(outputDir, 'beta')).length).toBeGreaterThan(0);
    _resetTextLineIndexCachesForTesting();

    // Delete b.html — its lines go away.
    await TextLineIndex.updateFiles(outputDir, [], ['b.html']);
    _resetTextLineIndexCachesForTesting();
    expect(await TextLineIndex.searchText(outputDir, 'beta')).toEqual([]);
  });
});
