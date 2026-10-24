# Tasks: fix Kotlin package binding soundness

## Implementation
- [ ] Build the Kotlin package index from the parse tree: top-level functions (with extension
      receiver type), properties, classes, objects, enum classes, type aliases; no members
- [ ] Fix `enum class X` indexing (`X`, not `class`); honor backtick identifiers
- [ ] Refuse the package-function binding when the call site has a receiver
- [ ] Bind extension-function calls by imported or same-package name, unique binding only
- [ ] Parse `import a.b.*`, `import a.b.C as D`, top-level function/property imports, nested types
- [ ] Apply Kotlin precedence: explicit import > wildcard import > same package > default imports
- [ ] Add the default-import package list as one named constant; treat its names as external

## Conformance
- [ ] Fixture per row of the "wrong today" table; each asserts the corrected result
- [ ] Collision fixture: a member `get` and an unrelated `x.get()` in one package emit no edge
      between them
- [ ] Fixture: modified, generic, and extension top-level functions bind at `import` when imported

## Verification
- [ ] Before/after structural diff on the reference corpus and one real Kotlin repository: list
      every removed edge with the reason it was wrong; no correct edge lost
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinPackageBindingIsReceiverAwareAndDeclarationExact
