# Tasks: Kotlin UI and middleware inventories

## Implementation
- [ ] Compose component extraction from `@Composable` functions; props, slots, children
- [ ] `@Preview` linkage; `compose` in the framework union
- [ ] Ktor `install` / `intercept` / plugin definitions with plugin-name classification
- [ ] Spring interceptors, filters, security filter chain, controller advice
- [ ] JAX-RS provider filters
- [ ] Unmodeled-framework receipt for both inventories

## Conformance
- [ ] Fixture per framework row and for Compose props, slot, preview
- [ ] Negative fixture: a function named `install` without the Ktor import is not middleware
- [ ] Negative fixture: a project annotation named `Composable` without the import is ignored

## Verification
- [ ] A real Compose application and a real Ktor service: inventories reviewed in the PR
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinUiComponentsAndMiddlewareAreInventoried
