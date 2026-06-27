# Tasks — Literal-text search line index

> Status: DRAFT (2026-06-20). Decision `fd256fde` recorded before code. BM25-only, separate store,
> call graph untouched. Reuses `buildBm25Corpus` / `tokenize` / `bm25Score` / `patchBm25Cache`.

## 1. Text corpus build
- [ ] Define the file set: walked files whose content is not already captured as symbols — markup
      (`.html`, `.css`, `.scss`), templates, plain text, and the non-symbol remainder. Reuse
      `FileWalker` output; exclude what `SKIP_EXTENSIONS`/`SKIP_FILENAMES` already drop.
- [ ] Build the line records: `{ filePath, lineNumber, text }`, skipping blank/whitespace-only lines
      and lines over a max length (truncate, don't drop).
- [ ] Write a new LanceDB table (e.g. `text_lines`) — **BM25-only, no vector column**. Reuse
      `buildBm25Corpus` + `tokenize` against this table; do not duplicate the BM25 implementation.
- [ ] Persist alongside the existing index under the analysis output dir; record table meta for
      freshness.

## 2. Query path
- [ ] Add a BM25-only `searchText(outputDir, query, opts)` to the text index module returning
      `{ filePath, lineNumber, text, score }[]`.
- [ ] In `handleSearchCode` (`mcp.ts`): run the existing symbol search first; if it yields **zero**
      hits, fall back to `searchText` and return `file:line` results tagged as text matches.
- [ ] Add an explicit `mode: 'text'` flag to `search_code` to force the text path (bypassing symbol
      search) for known literal-string lookups.
- [ ] Ensure the response stays conclusion-shaped (`file:line` hits with the matched line), never a
      graph. Tool-contract classification unchanged.

## 3. Incremental update (watcher)
- [x] In `McpWatcher.handleBatch`: on changed/added source files, re-extract their lines and patch the
      text table. → `updateTextLines`, runs regardless of the embed setting.
- [x] `TextLineIndex.updateFiles` supports `deletedPaths` (drops a path's rows) — unit-tested.
- [~] Feeding deletions FROM the watcher: not wired. The watcher is change-only (no `'unlink'`
      handler), so deleted-file lines — like the symbol index's deleted-file nodes — linger until the
      next full `analyze` overwrites the table. Documented at the call site. Wiring an `'unlink'` path
      (for both indexes) is a separate change.
- [x] Symbol-index incremental path is unaffected (text update is a separate store + separate call).

## 4. Purity guard (the load-bearing invariant)
- [ ] Assert in tests that text lines are **never** present as call-graph nodes and do not appear in
      `orient`, `get_map`, `get_critical_hubs`, fanIn/fanOut, communities, or PageRank inputs.
- [ ] No new node kind is introduced anywhere in the graph types.

## 5. Tests
- [ ] Unit: a string in an `.html` file (static markup) is found via `search_code` zero-hit fallback —
      the exact regression for the motivating failure ("Message completed" in `index.html`).
- [ ] Unit: a string present only inside an inline `<script>` literal is found via the text index
      (covers the case `#1`/skeletons would miss).
- [ ] Unit: symbol search with hits does NOT trigger the text fallback (no behavior change for code).
- [ ] Unit: `mode: 'text'` forces the text path.
- [ ] Incremental: editing a text file updates its lines; deleting removes them.
- [ ] Purity: the assertions from task 4.
- [ ] Full suite green.

## 6. Docs
- [ ] Update `search_code`'s tool description: now also finds literal strings in markup/text via a
      separate line index when symbol search returns nothing.
- [ ] Update the CLAUDE.md tools table row for `search_code` accordingly.
- [ ] Dogfood report: reproduce the original failure on a fixture, show it now resolves.
