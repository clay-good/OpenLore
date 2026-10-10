# Tasks: fix Kotlin package binding soundness

## Implementation
- [x] Build the Kotlin package index from package-level declarations only: functions (with
      extension receiver type), properties, classes, objects, enum classes, type aliases; no
      members. Built by `scanKotlinFile`, a linear text scanner over comment- and string-masked
      source, because the import bridge is synchronous and has no parse tree; a test checks it
      against the parse tree on every Kotlin fixture
- [x] Fix `enum class X` indexing (`X`, not `class`); honor backtick identifiers
- [x] Refuse the package-function binding when the call site has a receiver
- [x] Bind extension-function calls by imported or same-package name, unique binding only
- [x] Parse `import a.b.*`, `import a.b.C as D`, top-level function/property imports, nested types
- [x] Apply Kotlin precedence: explicit import > same package > wildcard import > default imports
      (the order the Kotlin language specification gives; the proposal text had wildcard and same
      package the other way round)
- [x] Add the default-import package list as one named constant; treat its names as external

## Conformance
- [x] Fixture per row of the "wrong today" table; each asserts the corrected result
- [x] Collision fixture: a member `get` and an unrelated `x.get()` in one package emit no edge
      between them
- [x] Fixture: modified, generic, and extension top-level functions bind at `import` when imported

## Verification
- [x] Before/after structural diff on the reference corpus: every removed edge is a ledger entry
      with its reason. One correct edge (`service.describe(...)` on a class property) had resolved
      only through the unsound path; `add-kotlin-declared-type-receivers` restores it
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD KotlinPackageBindingIsReceiverAwareAndDeclarationExact
