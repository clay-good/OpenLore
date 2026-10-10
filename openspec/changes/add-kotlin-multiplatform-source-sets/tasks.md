# Tasks: Kotlin Multiplatform source sets

## Implementation
- [x] Record source set and derived platform per file and node
- [x] Capture `expect` and `actual` modifiers on functions, properties, classes, type aliases
- [x] Binding rule: `expect` is the unique target; `actual`s do not compete
- [x] `actualizes` relation; forward reachability and backward impact across it
- [x] Receipts for unmatched `expect` and unmatched `actual` (`multiplatform` on the call graph)
- [x] Dead-code and clone handling of platform variants (public surface: built with
      `add-kotlin-public-surface`)
- [x] Source-set directory names as domain-naming noise

## Conformance
- [x] Fixture: common caller reaches a JVM and an iOS `actual`
- [x] Fixture: a cross-file call to an `expect` function binds (no ambiguity refusal)
- [x] Fixture: `actual` not listed as dead; pair not listed as clones
- [x] Fixture: unmatched `actual` is in the receipt
- [x] Fixture: `actual typealias`

## Verification
- [x] Reference corpus: `Platform.jvm.kt::platformName` is reachable from `banner`
- [ ] A real Multiplatform repository: unresolved-call count before and after in the PR
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinExpectAndActualDeclarationsAreLinked
