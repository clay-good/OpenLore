# Tasks — SFC script extraction

## Implementation — stage 1 (boundary disclosure, lands independently)
- [x] Analyze counts `.vue`/`.svelte`/`.astro` files and their `<script>` blocks; report
      "N files contain M script blocks not yet extracted" as an unextracted-script-container
      boundary
- [x] `get_language_support`: per-format record — recognized container, extraction unsupported —
      instead of the all-unsupported `'unknown'` row
- [x] `orient` and `doctor` surface the boundary when SFC files are present

## Implementation — stage 2 (extraction)
- [x] SFC blanking: generalize the html-script-extractor technique (offset-preserving blank,
      script islands verbatim at true offsets) to the three formats, dispatching
      `<script lang="ts">` to the TS extractor and untyped `<script>` to JS
- [x] Nodes/edges/signatures/CFG/style fingerprint ride the existing TS/JS lanes; node positions
      are line-true in the container file
- [x] Container extensions added to the canonical `detectLanguage` map (single source — extend
      `fix-language-detection-single-source`'s map, no third copy)
- [x] Boundary record narrows: extracted script bodies leave it; template expressions, Svelte
      `$:`, and framework macros remain disclosed as unanalyzed

## Conformance
- [x] Per-format fixtures: a `.vue`, `.svelte`, and `.astro` file each yield functions + a resolved
      call edge from their script block, with line-true positions
- [x] `lang="ts"` fixture parses as TypeScript; untyped as JavaScript
- [x] Coverage guard: a container format claimed extracted without a fixture fails the suite
- [x] Stage-1 fixture: an SFC-bearing repo's analyze/orient output carries the boundary counts

## Verification
- [x] Dogfood on a real Vue or Svelte repo: graph goes near-empty → populated; boundary counts
      match; before/after in the PR
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD ScriptContainerBoundaryIsDisclosed, SfcScriptBlocksAreExtracted
