# HTML asset-dependency edges: link `.html` to its external JS/CSS

> Status: IMPLEMENTED (2026-06-20). Decision `b555b680`. Shipped: `src/core/analyzer/dependency-graph.ts` (`assetKind: script|stylesheet` HTML→asset edges) + `import-parser.ts`. (Status corrected 2026-06-25 — was stale DRAFT.)
> Distinct from the inline-script call graph (`5b38bad2`): that adds *function nodes* for inline
> `<script>` JS; this adds *file→file dependency edges* from an HTML page to the external assets it
> references. Distinct again from the literal-text line index (`fd256fde`).

## Why

An `.html` file has **no edges to the assets it loads**. `<script src="app.js">` and
`<link rel="stylesheet" href="style.css">` are unparsed, so:

- `get_file_dependencies("index.html")` shows nothing — the page looks isolated.
- `analyze_impact("style.css")` / `analyze_impact("app.js")` never lists the HTML pages that consume
  them, so the blast radius of editing a shared stylesheet or script is invisible.
- The dependency graph treats every HTML page as a leaf with no out-edges, distorting the file-level
  topology for any project that wires its front-end through HTML.

The machinery to fix this already exists. `DependencyGraphBuilder.buildEdges` creates a file→file edge
for every entry in a file's `FileAnalysis.imports` that `resolveImport` can resolve to a file already in
the graph (`dependency-graph.ts:331`). `.css` and `.js` files are already walked and present as nodes.
The only missing piece is that HTML files produce **no** `imports`.

## What changes

1. **HTML asset parsing.** Add `parseHtmlAssetImports(content)` producing `ImportInfo[]` for inline
   asset references: `<script src=…>` and `<link rel="stylesheet" href=…>`. Dispatch it from
   `ImportExportParser.parseFile` (`import-parser.ts:1047`) via a new `getFileType` → `'html'` arm.

2. **Relative-href handling.** HTML hrefs are document-relative by nature, but a bare `app.js` does not
   start with `.`, so it must be flagged `isRelative: true` (and normalized to `./app.js`) for the
   existing `buildEdges` skip-rule and `resolveImport` to resolve it against the document's directory.
   Absolute URLs (`http(s)://`, `//`), `data:`, `mailto:`, and `#…` anchors are excluded.

3. **Edges fall out for free.** With HTML files yielding `imports`, `buildEdges` + `resolveImport`
   create the `index.html → app.js` and `index.html → style.css` edges, update the adjacency lists, and
   feed in/out-degree — no change to the edge-building loop itself. `.css`/`.js` targets already being
   nodes means the `fileSet.has(resolvedPath)` guard passes.

## What does NOT change

- **No LLM.** Pure static extraction. North star (`c6d1ad07`) holds.
- **No call-graph change.** These are file-level dependency edges, not function call edges; the inline
  `<script>` call-graph work is separate and complementary.
- **`buildEdges` / `resolveImport` are reused unchanged** (modulo the relative-href normalization done
  in the parser, not the resolver).

## Open design question — edge kind

`DependencyEdge` is `{ source, target, importedNames, isTypeOnly, weight }`. Asset edges carry no
`importedNames`. Options: (a) reuse the shape as-is with `importedNames: []`; (b) add an optional
`kind?: 'asset'` so consumers can distinguish "loads asset" from "imports symbols". Recommend **(b)**,
additive and cheap, so `get_file_dependencies` can label the relationship; default/absent kind keeps all
existing edges unchanged.

## Out of scope

- **Root-absolute / web-root hrefs** (`/assets/app.js`) — resolving these assumes a configured web
  root; best-effort against the project root is a follow-up, flagged as a limitation until then.
- **Other asset references** — `<img src>`, `<a href>` page navigation, `<source>`, `srcset`,
  `@import` inside CSS, framework template syntax. Start with script + stylesheet.
- **Bundled/transpiled indirection** (a `<script src="dist/bundle.js">` that maps back to sources) —
  the edge points at the referenced file as written.
- **Inline `<script>`** — handled by the call-graph change (`5b38bad2`).

## Risk

**Low.** Additive: a new parser arm + a new `getFileType` case; the edge-building loop is untouched.
HTML files that reference nothing resolvable produce no edges. No new dependency.

## Application to OpenLore

- `import-parser.ts` — `getFileType` gains `'html'`; `parseFile` dispatches to `parseHtmlAssetImports`;
  the existing import-categorization loop routes relative hrefs into `localImports`.
- `dependency-graph.ts` — unchanged except the optional `kind` field on `DependencyEdge` if (b) is
  taken.
- Surfaces immediately through `get_file_dependencies`, `analyze_impact`, and the dependency diagram.
