# Tasks: Kotlin Multiplatform source sets

## Implementation
- [ ] Record source set and derived platform per file and node
- [ ] Capture `expect` and `actual` modifiers on functions, properties, classes, type aliases
- [ ] Binding rule: `expect` is the unique target; `actual`s do not compete
- [ ] `actualizes` relation; forward reachability and backward impact across it
- [ ] Receipts for unmatched `expect` and unmatched `actual`
- [ ] Dead-code, clone, and public-surface handling of platform variants
- [ ] Source-set directory names as domain-naming noise

## Conformance
- [ ] Fixture: common caller reaches a JVM and an iOS `actual`
- [ ] Fixture: a cross-file call to an `expect` function binds (no ambiguity refusal)
- [ ] Fixture: `actual` not listed as dead; pair not listed as clones
- [ ] Fixture: unmatched `actual` is in the receipt
- [ ] Fixture: `actual typealias`

## Verification
- [ ] Reference corpus: `Clock.jvm.kt::now` is reachable from `stamp`
- [ ] A real Multiplatform repository: unresolved-call count before and after in the PR
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinExpectAndActualDeclarationsAreLinked
