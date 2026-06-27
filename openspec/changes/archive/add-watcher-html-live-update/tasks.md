# Tasks — HTML live in watch mode

> Status: DRAFT (2026-06-20). Stacks on #173. One gate-widening + one blanking guard makes #170/#171/#172
> live for HTML in `mcp --watch`.

## 1. Watch HTML
- [x] `HTML_EXTENSIONS = /\.html?$/i`; chokidar `change` filter admits HTML alongside `SOURCE_EXTENSIONS`.
- [x] `handleBatch` candidate gate: allow HTML past the `detectLanguage === 'unknown'` skip.

## 2. Blanking guard (regression-critical)
- [x] `buildGraphSubset`: for `.html`/`.htm`, blank via `extractHtmlScripts` and parse as JavaScript;
      empty result when there is no inline JS. Exported for unit testing.

## 3. Free flow-through
- [x] Text-line index (#170): HTML now reaches `updateTextLines`; stale comment updated.
- [x] Asset edges (#172/#173): HTML reaches `updateDependencyGraph` → `parseHtmlAssetImports` → edges.

## 4. Tests
- [x] Unit: `buildGraphSubset` on HTML with inline `<script>` → inline nodes + edge anchored to the html
      file (regression guard against node-wipe); no-inline HTML → empty.
- [x] Watcher integration: editing an inline `<script src>` (`old.js` → `app.js`) → dependency-graph
      asset edge repatched with `assetKind: 'script'`.
- [x] Existing watcher unit + integration suites pass unchanged.

## 5. Out of scope (documented)
- [ ] `.vue` / `.svelte` watch.
- [ ] `.css` watch (text-line only; refreshes on full analyze).
- [ ] Deletions / new files in watch mode.
