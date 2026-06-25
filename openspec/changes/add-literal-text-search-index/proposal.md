# Literal-text search: a separate BM25-only line index for the strings symbols can't hold

> Status: IMPLEMENTED (2026-06-20). Decision `fd256fde`. Shipped: `src/core/analyzer/text-line-index.ts` (`TextLineIndex`), commit `03efa06`. (Status corrected 2026-06-25 — was stale DRAFT.)
> Motivated by a real failure: an agent asked to find a green "Message completed" banner in a web app
> ran `orient` then churned greps and never found it; the string lived as static text in `index.html`.
> A human's VSCode find-in-files located it in seconds.

## Why

`search_code`'s corpus is **symbol-derived**. Every searchable row is built from a call-graph node or a
signature entry — `[lang] path qualifiedName signature docstring skeleton`
(`vector-index.ts:256,399,603`). A file that yields no extracted symbols produces **zero rows** and is
invisible to search. Static markup, UI copy, hard-coded error strings, config text — none of it is a
function, class, or signature, so none of it is indexed.

This is not a ranking miss; the text is **never in the index**. The failure mode is severe because it is
*silent*: `search_code` returns confident symbol matches, the agent trusts the tool over a plain grep,
and burns the loop hunting in the wrong index. The deterministic-substrate north star (`c6d1ad07`) is
undermined when the substrate quietly omits an entire class of content the user can see on screen.

## What changes

1. **A separate raw-line text index.** A new LanceDB table holds raw lines of text/markup/config files
   (HTML, CSS, plain text, templates, and the non-symbol remainder of any file), keyed by
   `filePath` + `lineNumber`, with the line text. **BM25-only — no embeddings.** Literal-string lookup
   wants exact lexical match, not vector similarity.

2. **`search_code` falls back to it.** Symbol search runs first; on **zero symbol hits** (or an explicit
   `mode: 'text'`), `search_code` queries the line index and returns `file:line` matches. One tool, same
   call shape — the agent that hit zero symbol results now gets the string instead of a dead end.

3. **The call graph stays pure by construction.** Text lines are a separate store. They are **never**
   nodes, never fed to fanIn/fanOut, hubs, entrypoints, communities, PageRank, `orient`, or `get_map`.
   Purity is structural, not a filter applied at each call site.

4. **Reuse existing BM25 machinery.** `buildBm25Corpus`, `tokenize`, `bm25Score`, and the
   `patchBm25Cache` incremental path already exist in `vector-index.ts`. The text index reuses them
   against its own table rather than inventing a second BM25 implementation.

## What does NOT change

- **No LLM.** Pure lexical indexing and retrieval. North star holds.
- **No new node kind.** Text is not a pseudo-symbol; the graph and all node-level metrics are untouched
  (this is the explicit rejection of option 2a in decision `fd256fde`).
- **No embeddings for text.** BM25-only keeps build cost and index size bounded and keeps results
  deterministic.
- **`search_code`'s symbol path is unchanged** when symbol hits exist; the text index is a fallback, not
  a reranking of code results.

## Why not index text as graph nodes (option 2a, rejected)

Injecting text as pseudo-symbols reuses the existing table and incremental path, but the call graph is
computed *over nodes*: every text line would pollute fanIn/fanOut, hubs, entrypoints, communities,
PageRank, `orient`, `get_map`, `get_critical_hubs`, and force a "is this a text node?" filter at every
present and future call site — a permanent tax that directly contradicts a deterministic structural
substrate. A separate store pays a one-time plumbing cost to keep the graph pure forever. See decision
`fd256fde`.

## Application to OpenLore

- **Index build**: the `FileWalker` already walks `.html`/`.css`/text files (they are not in
  `SKIP_EXTENSIONS`); they are simply dropped today because `detectLanguage` returns `unknown` and no
  symbols extract. The text index consumes exactly those file contents.
- **Incremental update**: the `McpWatcher` already patches the symbol index on file change; it gains a
  parallel patch of the text table (reusing `patchBm25Cache`).
- **Query surface**: `handleSearchCode` (`mcp.ts`) gains the zero-hit fallback and the `mode: 'text'`
  flag; the tool contract classification (`conclusion`) is unchanged — it still returns the computed
  answer (`file:line` hits), not a graph.

## Out of scope

- **Inline `<script>` JS as call-graph symbols** (the separate "#1" improvement). Worthwhile but
  orthogonal: it gives structural reach into inline JS, whereas this change is about literal-string
  retrieval. Tracked separately.
- **Semantic/NL search over text.** This is exact-lexical only. Embedding text is deliberately excluded.
- **Indexing binary or generated files** already excluded by `SKIP_EXTENSIONS` / `SKIP_FILENAMES`.

## Research basis

Classic inverted-index lexical retrieval (BM25) applied to the content class a symbol index structurally
cannot represent. The design choice mirrors how IDEs keep a separate full-text index (find-in-files)
distinct from their symbol index (go-to-definition) — the two answer different questions and conflating
them degrades both.
