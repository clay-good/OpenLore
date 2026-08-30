# SFC script extraction: disclose, then index, the code inside .vue/.svelte/.astro

> Status: PROPOSED (2026-07-03, e2e audit). Widens the honest boundary around single-file
> components, then closes it: today a Vue/Svelte/Astro codebase yields a near-empty graph with no
> disclosure that its `<script>` blocks were never extracted. Stage 1 makes the boundary visible
> (honesty first); stage 2 lifts the script blocks into the existing TS/JS pipeline via the proven
> offset-preserving-blank technique from the HTML inline-script extractor. Deterministic, no LLM,
> no new dependency. Grounded in the north star (`overview/spec.md`, `c6d1ad07`) and the
> NoFalseCompleteness discipline.

## The gap

`.vue`/`.svelte`/`.astro` files are real application code whose logic lives in embedded
`<script>` blocks — and today they are invisible twice over:

1. **No extraction.** Neither `detectLanguage` maps them: `code-shaper.ts:134-155`
   (`EXT_TO_LANGUAGE`) and `signature-extractor.ts:40-72` both return `'unknown'` for the three
   extensions. Their script blocks never reach the call graph, CFG, signatures, or style
   fingerprint.
2. **No disclosure.** The files are *recognized* elsewhere — `repository-mapper.ts:607-608` maps
   `.vue`/`.svelte` for framework stats, `ui-component-extractor.ts:152-176` extracts component
   names/props from them — so a Vue repo *looks* analyzed (frameworks detected, UI components
   listed) while its functions and call edges are silently absent. Nothing in `orient`,
   `get_language_support`, or `doctor` says "this repo's primary container format is not
   extracted." A near-empty graph is indistinguishable from "there is genuinely little code here."

The machinery to fix this already exists: `html-script-extractor.ts` produces an
offset-preserving blank of an HTML file so the existing JS call-graph extractor parses only the
script islands at their true offsets (decision `5b38bad2`; wired via `artifact-generator.ts:1136`).
It is deliberately JS-only and HTML-only today (`:14`).

## What changes

**Stage 1 — the boundary is disclosed (lands first, independently).** Analysis counts SFC files
and their `<script>` blocks as an "unextracted script container" boundary:

- `analyze` reports "N .vue/.svelte/.astro files contain M script blocks not yet extracted";
- `get_language_support` returns an honest per-format record (recognized container, extraction
  unsupported) instead of the all-unsupported `'unknown'` record;
- `orient` and `doctor` surface the boundary when such files are present, so a quiet graph is
  interpretable.

**Stage 2 — extraction.** Lift `<script>` / `<script lang="ts">` bodies into the existing TS/JS
pipeline using the html-script-extractor precedent: an offset-preserving blank per SFC, parsed by
the existing extractors, so nodes carry true line numbers in the `.vue`/`.svelte`/`.astro` file.
Call edges, signatures, CFG, and style fingerprint ride the existing lanes with zero tool-side
changes. Per-format registry entries grow only with conformance fixtures (the coverage-guard
discipline from `add-language-capability-conformance`).

**Explicitly out of scope, disclosed in the boundary record:** template-expression calls
(`@click="save()"`), Svelte reactive statements (`$:`), and framework macro semantics
(`defineProps`, `$props`) — the script *body* is indexed; framework magic is named as unanalyzed,
never guessed.

**Siblings:** `fix-language-detection-single-source` (PROPOSED) — the canonical extension map it
proposes is where the three container extensions get their single mapping; this change extends
that map rather than adding a third copy. `add-parse-health-boundary-disclosure` (PROPOSED)
covers failed extraction *inside* supported languages; this change covers a recognized-but-
unextracted *container* format. The two boundary kinds are distinct and cross-referenced, not
merged.

## Why this is in scope

The substrate's core promise is that a quiet result is interpretable. For a Vue or Svelte codebase
— entire product categories — OpenLore currently breaks that promise silently. Stage 1 restores
honesty with a disclosure; stage 2 converts the disclosed gap into indexed structure using an
already-proven mechanism, making every navigation and conclusion tool work on SFC codebases
without any new tool surface.

## Impact

- New: an SFC script extractor (generalizing `html-script-extractor.ts`'s blanking to
  `.vue`/`.svelte`/`.astro`, including `lang="ts"` dispatch); boundary counting in analyze.
- Modified: the canonical `detectLanguage` map (container-aware), `language-support.ts` (container
  record), `orient`/`doctor` boundary surfacing, conformance fixtures per format.
- Specs: `analyzer` — 2 ADDED requirements (ScriptContainerBoundaryIsDisclosed,
  SfcScriptBlocksAreExtracted).
- Risk: offset math is the load-bearing part — the HTML extractor's tests are the template;
  fixtures must assert line-true positions. No MCP tool count change, so no payload-budget
  movement. Svelte/Vue compiler-grade semantics stay out of scope by design.
