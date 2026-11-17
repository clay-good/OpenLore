# Tasks: Kotlin grammar currency

## Implementation
- [ ] Syntax corpus: one file per feature, labeled with its stable Kotlin version
- [ ] Constant for the declared Kotlin language level
- [ ] Known-gaps table (feature, reason, degraded behavior)
- [ ] Corpus test: clean-or-listed; stale known-gap entry fails
- [ ] Degradation test per known gap: surrounding declarations and owners intact; parse-health entry
- [ ] Generate the "Kotlin syntax coverage" table; add it to the doc-sync guard
- [ ] Decision record comparing grammar candidates on the stated criteria
- [ ] If a grammar is adopted: port every Kotlin query; pin per the existing grammar pin policy

## Conformance
- [ ] Corpus test and degradation tests in the default test lane
- [ ] `grammar-optional-deps.test.ts` updated for any dependency change
- [ ] Parse-budget test still holds for the Kotlin grammar in use

## Verification
- [ ] Before/after graph diff on the reference corpus and one real repository for a grammar change
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinSyntaxCoverageIsMeasuredAgainstADeclaredLanguageLevel
