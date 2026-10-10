# Tasks: Kotlin grammar currency

## Implementation
- [x] Syntax corpus: one file per feature, labeled with its stable Kotlin version
- [x] Constant for the declared Kotlin language level
- [x] Known-gaps table (feature, reason, degraded behavior)
- [x] Corpus test: clean-or-listed; stale known-gap entry fails
- [x] Degradation test per known gap: surrounding declarations and owners intact; parse-health entry
- [x] Generate the "Kotlin syntax coverage" table; add it to the doc-sync guard
- [x] Decision record comparing grammar candidates on the stated criteria
- [x] If a grammar is adopted: port every Kotlin query; pin per the existing grammar pin policy

## Conformance
- [x] Corpus test and degradation tests in the default test lane
- [x] `grammar-optional-deps.test.ts` updated for any dependency change
- [x] Parse-budget test still holds for the Kotlin grammar in use

## Verification
- [x] Before/after graph diff on the reference corpus and one real repository for a grammar change
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinSyntaxCoverageIsMeasuredAgainstADeclaredLanguageLevel
