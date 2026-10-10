# Tasks: Kotlin declared-type receivers

## Implementation
- [ ] Collect declared receiver-type facts from the Kotlin parse tree (table in the proposal)
- [ ] Peel `?` and parenthesized types; reduce generic types to the outer name
- [ ] Scope rules: local > parameter > class property; conflict refuses; `var` reassignment ends
      the fact at that point
- [ ] Implicit-`this` lookup for bare property receivers
- [ ] Add Kotlin to `RECEIVER_REGISTRY_LANGUAGES` with a Kotlin fact collector
- [ ] Add Kotlin to Strategy 1b for `Type.member()` on project classes, objects, companions
- [ ] Use declared return types of uniquely resolved project functions for `val x = f()`

## Conformance
- [ ] One fixture per fact row; each asserts the edge target and confidence
- [ ] Negative fixtures: conflicting declarations, shadowing local, reassigned `var`, smart cast,
      lambda `it`: no edge, boundary disclosed
- [ ] `language-support.test.ts`: Kotlin `receiverResolution` fixture produces an edge

## Verification
- [ ] Reference corpus: service-layer calls resolve; "reachable from test" rises from 1 of 39
- [ ] Real repository: report edges gained by confidence; hand-check a sample of 50
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinReceiversResolveThroughDeclaredTypes
