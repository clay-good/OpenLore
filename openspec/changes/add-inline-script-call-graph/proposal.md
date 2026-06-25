# Inline `<script>` JS as call-graph symbols

> Status: IMPLEMENTED (2026-06-20). Decision `5b38bad2`. Shipped: `src/core/analyzer/html-script-extractor.ts`, commit `b2e8115` "feat(analyzer): index inline <script> JS into the call graph". (Status corrected 2026-06-25 — was stale DRAFT.)
> Orthogonal to the literal-text line index (`fd256fde`): that makes literal strings findable; this
> gives the structural graph (callers/callees/impact/search) reach into JavaScript defined inside HTML.

## Why

Functions defined in an inline `<script>` block in an `.html` file are invisible to every structural
tool. `detectLanguage` returns `unknown` for `.html` (`signature-extractor.ts:66`), so the file never
reaches the call-graph builder — no nodes, no edges, no `search_code` / `orient` / `analyze_impact`
coverage. For codebases that put real logic in inline scripts (server-rendered pages, demos, small
apps, embedded widgets), an entire layer of behavior is structurally dark.

The call-graph builder already does the hard part: `CallGraphBuilder.build` accepts
`{ path, content, language }[]` and routes `JavaScript` content to `extractTSGraph`
(`call-graph.ts:4379`). The only thing missing is getting the inline JS *to* it with correct file
positions.

## What changes

1. **Extract inline scripts, feed them as JavaScript.** At the call-graph assembly point
   (`artifact-generator.ts:1164`), `.html`/`.htm` files are pulled out of the `unknown` bucket: their
   `<script>` bodies are extracted and handed to the existing JS extractor with `language: 'JavaScript'`
   and `path` = the HTML file path. Inline functions become first-class nodes.

2. **Offset-preserving blanking — the enabler.** Node line numbers come from `byteToLine` over
   `file.content` (`call-graph.ts:4404`). Parsing a script body standalone makes every offset
   script-relative, so `file:line` would point at the wrong place in the HTML. Instead the builder is
   fed a string the **same length** as the HTML in which every character *outside* a `<script>…</script>`
   body is replaced by a space, **newlines preserved**. Tree-sitter parses the JS islands at their true
   positions; markup regions are valid empty JS. Every script character keeps its exact index, so
   `startIndex` / `endIndex` / `startLine` map correctly back to the HTML file. `extractTSGraph` is
   reused **unchanged**.

3. **Dependency-free script extraction.** A regex (`/<script\b([^>]*)>([\s\S]*?)<\/script>/gi`) with a
   `type` filter — accept `text/javascript`, `module`, or no `type`; skip `application/json`,
   `importmap`, and external `src=` references — locates the inline bodies. `tree-sitter-html` is **not**
   added; `<script>` boundary detection does not warrant a grammar dependency.

## What does NOT change

- **No LLM.** Pure static extraction. North star (`c6d1ad07`) holds.
- **`extractTSGraph` is untouched.** The blanking trick means the JS extractor needs no awareness of
  HTML.
- **Existing call-graph entries are untouched.** This is purely additive — `.html` files that today
  contribute nothing now contribute their inline-JS nodes; every other file is unaffected.
- **No new graph node kind.** Inline-script functions are ordinary `JavaScript` function nodes whose
  `filePath` is the `.html` file.

## Application to OpenLore

- **Build**: one branch in `resolveLang` / the `CALL_GRAPH_LANGS` gate
  (`artifact-generator.ts:1114-1167`) plus an `extractHtmlScripts(content) → blankedContent` helper.
- **Search / skeleton**: the vector index builds rows from call-graph **nodes**, so inline functions
  become searchable automatically; `getSkeletonContent` slices the original HTML by the preserved
  offsets and returns the real script source. No separate signature path required.
- **Reuse**: the JS extractor, the trie resolution, the CFG overlay — all unchanged.

## Out of scope

- **Watch-mode live update.** `mcp-watcher`'s `SOURCE_EXTENSIONS` and `detectLanguage === 'unknown'`
  skip exclude `.html`; widening them is a separate change with its own watch-scope risk. Until then,
  inline-JS edits reconcile at the next full `analyze` (the same posture the text index took).
- **`.vue` / `.svelte` single-file components.** Same `<script>` shape; easy follow-ups once `.html`
  lands.
- **Templating languages inside markup** (EJS/Handlebars/Jinja) — not JavaScript, not in scope.
- **`</script>` appearing inside a JS string literal** — the regex truncates early; rare for inline
  code, and the existing per-file `try/catch` (`call-graph.ts:4424`) contains any resulting parse
  failure.

## Risk

**Low.** Additive at one gate; the JS extractor is reused as-is; the offset-preserving blank keeps all
existing line/offset semantics; parse failures are already contained. No new dependency.

## Research basis

The "blank everything but the embedded language, parse in place" technique is the standard way editors
and language servers provide language features inside embedded code (HTML `<script>`/`<style>`, Markdown
fenced blocks) without a host-language-aware parser — a virtual document whose ranges align 1:1 with the
container. Here it lets a pure-JS tree-sitter extractor produce HTML-accurate node positions.
