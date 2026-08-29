# Promote backed-language visibility: the generated matrix discloses its scope, the docs get one canonical page

> Status: PROPOSED (2026-07-03, e2e audit). Raises a working claim's *visibility*, not its truth:
> Rust, Swift, and Java are fully registry-backed and conformance-verified, yet a reader of the
> published surfaces can conclude they are unsupported. The registry is honest; the artifacts that
> present it under-claim. Docs-and-digest work only — no extractor changes, no LLM. Grounded in the
> honesty contract (an under-claim misleads exactly like an over-claim) and the guarded-claims
> discipline.

## The gap

**1. The generated matrix is repo-scoped and does not say so.** The `CODEBASE.md` language-coverage
table is built from the analyzed repo's *detected* languages only
(`codebase-digest.ts:122-125` — `detected` = languages of the graph's non-external nodes), then
presented under the heading "What OpenLore extracts per detected language" with no statement that
undetected languages are simply absent rows. Rust, Swift, and Java are registry-backed —
`CALLGRAPH_LANGUAGES` (`call-graph.ts:2118`), `SIGNATURE_LANGUAGES` (`signature-extractor.ts:857`),
Rust/Java also CFG (`cfg.ts:481`) and typeInference (`type-inference-engine.ts:27`), Java also
crossServiceHttp routes (`http-capability.ts:17`) — yet OpenLore's own `.openlore/analysis/CODEBASE.md`
has no Java, Rust, Swift, or JavaScript row. A reader treating the table as the capability
contract (the natural reading — it is the matrix agents absorb at session start via CLAUDE.md)
under-counts the product. The registry API already supports the fix: `languageCoverageMatrix()`
with no argument returns every known language (`language-support.ts:175-179`).

**2. Two parallel language docs diverge.** `docs/languages.md` (per-language narrative, 84 lines)
and `docs/language-support.md` (capability matrix + add-a-language checklist, 108 lines) overlap:
per-language rows for Rust and Swift exist only in `languages.md` (`:22`, `:26`);
`language-support.md` never mentions Rust at all. And `language-support.md:22` cites the wrong
source file for the crossServiceHttp constant — `CROSS_SERVICE_HTTP_LANGUAGES` lives in
`http-capability.ts` (`:26`, a dependency-free leaf module created precisely so the registry need
not import the parser), not `http-route-parser.ts` (which merely re-exports it). Same wrong
citation at `:89`. A stale source citation in the page that teaches "authoritative source" is the
exact drift class the derived-registry discipline exists to prevent.

## What changes

1. **Scope disclosure in the generated digest.** The language-coverage section header states the
   table is scoped to this repo's detected languages, and appends one derived line listing the
   registry's additionally-backed languages (computed as `languageCoverageMatrix()` minus the
   detected set — never hand-listed): "Registry additionally backs: Java, JavaScript, Rust, Swift,
   … — query `get_language_support` for the full matrix." The generated artifact can then never
   under-claim, whatever repo it describes.
2. **One canonical language page.** Merge the per-language narrative (extension table, grouping
   notes, per-language caveats) into `docs/language-support.md`; reduce `docs/languages.md` to a
   short redirect stub so inbound links keep working. Fix the `http-route-parser.ts` →
   `http-capability.ts` citations (`language-support.md:22`, `:89`) during the merge.
3. **Claim-surface parity check.** Conformance fixtures already cover Rust/Swift/Java; the merged
   page's per-language rows are audited against `CALLGRAPH_LANGUAGES` so every registry-backed
   language has a row (the docs-side mirror of the registry's no-over-claim guard: no under-claim
   either), guarded by a test alongside the existing docs-index canonical-pages check
   (`docs-index.test.ts:49`).

## Why this is in scope

The north star sells grounded structural context; the honesty contract cuts both ways. A verified
capability invisible in every published artifact is a claim the substrate has earned but does not
make — and an agent reading CODEBASE.md as the contract will wrongly route around "unsupported"
languages. Guarded-claims discipline (every stated coverage claim derived from code or CI-checked)
is existing doctrine; this applies it to the two surfaces that drifted.

## Impact

- `src/core/analyzer/codebase-digest.ts` (scope note + derived registry line),
  `docs/language-support.md` (merged canonical page, fixed citations), `docs/languages.md`
  (redirect stub), a docs↔registry parity test.
- Specs: `analyzer` — 2 ADDED requirements (GeneratedMatrixDisclosesItsScope,
  LanguageDocsHaveOneCanonicalSource).
- Risk: none functional (generated-text and docs only). CODEBASE.md consumers see one added
  disclosure line; the digest stays deterministic and byte-stable for a given registry + repo.
