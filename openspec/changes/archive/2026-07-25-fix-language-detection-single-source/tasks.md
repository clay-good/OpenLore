# Tasks — fix-language-detection-single-source

## Implementation
- [x] Establish the complete `detectLanguage` (Terraform/Bicep suffix handling + full extension
      map) as the single canonical source. Placed in a dependency-free `language-detection.ts` leaf
      re-exported by `language-support.ts` (NOT inline in the registry): the registry builds its
      capability matrix eagerly from `signature-extractor.ts`'s `SIGNATURE_LANGUAGES`, so the
      extractor cannot import the registry back without an eager module cycle — the leaf breaks it.
- [x] `signature-extractor.ts` imports + re-exports the canonical function (its importers —
      mcp-watcher, public-surface, structural-diff, impact-certificate, artifact-generator —
      unchanged, still resolving to the one definition)
- [x] Delete `EXT_TO_LANGUAGE` + local `detectLanguage` from `code-shaper.ts`; switch its detection
      consumers (`ast-chunker.ts`, `spec-pipeline.ts`, `http-route-parser.ts`, `view.ts`,
      `mcp-handlers/analysis.ts`) to the canonical leaf import
- [x] Sweep confirmed: no `detectLanguage` definition or extension→language detection map remains
      outside `language-detection.ts` (classify-yaml only mentions it in a comment; repository-mapper's
      `extToLang` is a human-facing language-BREAKDOWN display map, out of scope — see the guard's note)

## Verification
- [x] Completeness test: every `CODE_LANGUAGES` entry resolves from a representative extension
      through the canonical `detectLanguage`
- [x] Singularity guard test: source scan finds no second `detectLanguage` definition or
      `EXT_TO_LANGUAGE` map outside the canonical module (verified it fails on a planted decoy)
- [x] Fixture: the formerly-missed `.mts` / `.cts` extensions now take the AST-aware chunking path
      (import-block header on non-first chunks), not the generic fallback. NOTE: Kotlin/PHP/Elixir
      resolve correctly now, but the chunker only carries 7 tree-sitter parsers (ts/js/py/go/rust/
      ruby/java), so those still fall back honestly — chunker AST coverage is parser-bounded, not
      detection-bounded (extending it is a separate, disclosed follow-up)
- [x] Full suite green; chunking behavior unchanged for languages both maps already agreed on

## Spec
- [x] `analyzer` delta: ADD SingleSourceLanguageDetection (scenario 3 worded honestly to the
      parser-bounded reality)
