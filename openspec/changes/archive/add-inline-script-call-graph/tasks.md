# Tasks — Inline `<script>` JS as call-graph symbols

> Status: DRAFT (2026-06-20). Decision `5b38bad2` recorded before code. Offset-preserving blanking;
> reuses `extractTSGraph` unchanged. Orthogonal to the literal-text line index (`fd256fde`).

## 1. Script extraction + blanking
- [x] `extractHtmlScripts(content): string | null` in `html-script-extractor.ts` — same-length output,
      newlines preserved, script bodies verbatim, markup blanked; returns `null` when no inline JS.
- [x] Type filter via `isInlineJsScript`: keep `text/javascript`/`application/javascript`/`module`/
      ecmascript/no-type; skip `application/json`, `importmap`, external `src=`.
- [x] Returns `null` for no qualifying scripts so the caller skips cheaply.

## 2. Build-time wiring
- [x] `artifact-generator.ts`: after the `CALL_GRAPH_LANGS` gate, an `else if (/\.html?$/i)` branch runs
      `extractHtmlScripts` and pushes `{ path, content: blanked, language: 'JavaScript' }` when it yields JS.
- [x] Verified nodes carry `filePath` = the HTML path and correct 1-based `startLine` (integration test
      uses markup above the script: foo@4, bar@7).

## 3. Tests
- [x] Unit (`extractHtmlScripts` / `isInlineJsScript`): length invariance, newline preservation, markup
      blanked, single + multiple bodies retained, json/importmap/external excluded, whitespace-tolerant
      close tag.
- [x] Integration: `<script>` with `foo(){ bar() }` + `bar(){}` → two HTML-anchored nodes, `foo → bar`
      edge, correct line numbers.
- [~] `search_code` over the built index — covered transitively (vector index builds from nodes); not a
      dedicated test in this change.
- [x] Regression: `.html` with no inline JS returns `null` → contributes no nodes, no error.
- [~] Purity: guaranteed by construction (the new branch only fires for `.html`); not asserted via a
      diff test.

## 4. Docs
- [ ] Note `.html` inline-JS support in the analyzer spec / CODEBASE digest where language coverage is
      listed.
- [ ] Document the watch-mode limitation (inline-JS edits reconcile at next `analyze`) alongside the
      existing markup caveat.

## 5. Follow-ups (not this change)
- [ ] Widen `mcp-watcher` to live-update `.html` inline JS.
- [ ] `.vue` / `.svelte` `<script>` blocks via the same blanking helper.
