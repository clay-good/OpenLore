# Tasks: Kotlin declared-type receivers

## Implementation
- [x] Collect declared receiver-type facts from the Kotlin parse tree (table in the proposal)
- [x] Peel `?` and parenthesized types; reduce generic types to the outer name
- [x] Scope rules: local > parameter > class property; conflict refuses; `var` reassignment ends
      the fact at that point
- [x] Implicit-`this` lookup for bare property receivers
- [x] Add Kotlin to `RECEIVER_REGISTRY_LANGUAGES` with a Kotlin fact collector
- [x] Add Kotlin to Strategy 1b for `Type.member()` on project classes, objects, companions
- [x] Use declared return types of uniquely resolved project functions for `val x = f()`

## Conformance
- [x] One fixture per fact row; each asserts the edge target and confidence
- [x] Negative fixtures: conflicting declarations, shadowing local, reassigned `var`, smart cast,
      lambda `it`: no edge, boundary disclosed
- [x] `language-support.test.ts`: Kotlin `receiverResolution` fixture produces an edge

## Verification
- [x] Reference corpus: service-layer calls resolve; "reachable from test" rises from 1 of 39
- [ ] Real repository: report edges gained by confidence; hand-check a sample of 50 (reported
      once for the whole change set, in the pull request)
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinReceiversResolveThroughDeclaredTypes
