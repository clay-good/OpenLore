# HTML live in watch mode

> Status: IMPLEMENTED (2026-06-20, commit `1737ad8` "feat(watcher): make HTML live in watch mode"). (Status corrected 2026-06-25 — was stale DRAFT.) **Stacks on `feat/watch-incremental-dependency-graph` (#173)** — uses its
> `updateDependencyGraph`. Closes the shared watch-mode gap for all three HTML features at once.

## Why

Three merged features index HTML — literal-text lines (#170), inline-`<script>` call-graph nodes
(#171), and `<script src>`/`<link>` asset edges (#172) — but **none refreshed in `mcp --watch`**. The
watcher reacts only to `SOURCE_EXTENSIONS` (and skips `detectLanguage === 'unknown'`), and HTML is
neither. So after a full `analyze`, editing an `.html` left its text lines, inline-script nodes, and
asset edges stale until the next full analyze.

## What changes

1. **Watch HTML.** The chokidar `change` filter and the `handleBatch` candidate gate now admit
   `.html`/`.htm` alongside `SOURCE_EXTENSIONS`.

2. **Blank HTML in `buildGraphSubset` (required, not optional).** Once HTML enters the call-graph loop,
   the atomic swap deletes-then-inserts the file's nodes. If `buildGraphSubset` returned empty for HTML,
   every edit would **delete** the page's inline-script nodes a full analyze produced. So
   `buildGraphSubset` blanks the HTML (offset-preserving, reusing `extractHtmlScripts`) and parses it as
   JavaScript — the inline-script nodes refresh in place. An HTML file with no inline JS returns empty
   (nothing to churn).

3. **Text lines + asset edges fall out for free.** With HTML in `changedFiles`, the existing
   `updateTextLines` (#170) refreshes its lines, and `updateDependencyGraph` (#173) re-parses it via
   `parseHtmlAssetImports` (#172) and patches the `<script src>` / `<link rel=stylesheet>` edges.

One gate-widening + one blanking guard makes all three HTML features live in watch mode.

## What does NOT change

- **No LLM.** Reuses the deterministic extractors. North star holds.
- **Source-file behavior is unchanged** — HTML takes a dedicated path; `SOURCE_EXTENSIONS` files flow
  exactly as before.
- **`buildGraphSubset` for non-HTML is unchanged** (the blanking branch only fires for `.html`/`.htm`
  that `detectLanguage` reports as `unknown`).

## Scope boundaries

- **`.vue` / `.svelte`** single-file components are not watched (same as full analyze — separate
  follow-up).
- **`.css` edits** are not watched: CSS has no inline JS and no outgoing asset edges; its only index
  presence is text lines, which still refresh on full analyze. (Could be added to the text-line lane
  later if wanted.)
- **Deletions / new files** are not reconciled in watch mode — consistent with every other watcher lane.
- **Global dependency-graph metrics** stay deferred to full analyze (per #173).

## Risk

**Low–medium.** The watcher is invariant-sensitive, so the one real hazard — HTML entering the
call-graph loop and wiping inline-script nodes — is closed by the `buildGraphSubset` blanking and locked
by a unit test. Everything else is additive: HTML flows through the same lanes source files already use.
