# Tasks: Kotlin UI and middleware inventories

## Implementation
- [x] Compose component extraction from `@Composable` functions; props, slots, children
      (children are the composables the body calls, narrowed to real components once every
      Kotlin file is read; the UI inventory has no call graph)
- [x] `@Preview` linkage; `compose` in the framework union
- [x] Ktor `install` / `intercept` / plugin definitions with plugin-name classification
- [x] Spring interceptors, filters, security filter chain, controller advice
- [x] JAX-RS provider filters
- [x] Unmodeled-framework receipt for both inventories

## Conformance
- [x] Fixture per framework row and for Compose props, slot, preview
- [x] Negative fixture: a function named `install` without the Ktor import is not middleware
- [x] Negative fixture: a project annotation named `Composable` without the import is ignored

## Verification
- [ ] A real Compose application and a real Ktor service: inventories reviewed in the PR
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinUiComponentsAndMiddlewareAreInventoried
