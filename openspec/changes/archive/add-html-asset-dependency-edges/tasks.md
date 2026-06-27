# Tasks — HTML asset-dependency edges

> Status: DRAFT (2026-06-20). Decision `b555b680` recorded before code. File→file dependency edges
> (`<script src>`, `<link rel=stylesheet href>`); reuses `buildEdges` + `resolveImport`.

## 1. HTML asset parser
- [x] `parseHtmlAssetImports(content): ImportInfo[]` in `import-parser.ts` — one entry per
      `<script src=…>` and `<link rel="stylesheet" href=…>`.
- [x] `normalizeAssetHref` excludes absolute URLs (`http(s)://`, `//`), `data:`/`mailto:`/`tel:`/
      `javascript:`, `#` anchors, empty, and root-absolute `/…` (out of scope); strips `?`/`#`.
- [x] Kept refs: `isRelative: true`, `isPackage: false`, bare `app.js` → `./app.js`, `importedNames: []`,
      `assetKind` set.
- [x] `<link>` filtered to `rel=stylesheet` (case/quote tolerant); `preload`/`icon`/`manifest` excluded.

## 2. Dispatch wiring
- [x] `getFileType`: `.html`/`.htm` → `'html'`.
- [x] `ImportExportParser.parseFile`: `html` arm calls `parseHtmlAssetImports`; existing categorization
      routes relative hrefs into `localImports`.

## 3. Edge kind
- [x] Added `assetKind?: 'script' | 'stylesheet'` to `DependencyEdge` (additive; absent = code import),
      carried from `ImportInfo.assetKind` in `buildEdges`.

## 4. Tests
- [x] Unit (`parseHtmlAssetImports`, 6): script src + stylesheet link, external/data/anchor/root-absolute
      excluded, `rel=preload/icon/manifest` excluded, bare-href normalization, query/fragment strip,
      quote style + attribute order, line numbers.
- [x] Integration (`DependencyGraphBuilder.build`, 2): `index.html → app.js` + `→ style.css` edges with
      `assetKind`, raised stylesheet in-degree; CDN-only page → no edges.
- [~] E2E via `runAnalysis` — covered transitively by the integration test on the real builder; a
      dedicated `analyze_impact`/`get_file_dependencies` e2e can be added if desired.
- [x] Regression: CDN-only page produces no edges; non-HTML output unaffected (additive branch).

## 5. Docs
- [ ] Note HTML asset edges in the analyzer/dependency spec and the relevant tool descriptions
      (`get_file_dependencies`, `analyze_impact`).

## 6. Follow-ups (not this change)
- [ ] Root-absolute / web-root href resolution (configurable web root).
- [ ] `<img>`, `<a href>`, `<source>`/`srcset`, CSS `@import`, framework template asset refs.
