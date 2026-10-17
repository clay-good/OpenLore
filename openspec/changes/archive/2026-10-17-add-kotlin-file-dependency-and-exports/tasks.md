# Tasks: Kotlin file dependency and exports

## Implementation
- [x] `parseKotlinPackage`, `parseKotlinImports`, `parseKotlinExports`; add the `kotlin` file type
      to the shared extension dispatch
- [x] `kotlin-source.ts`: a linear scanner for the package, the imports, and the package-level
      declarations, over comment- and string-masked source
- [x] Shared JVM package index (package + package-level declarations) built once per analysis
- [x] Resolve Kotlin imports through the index; resolve Java imports of Kotlin types and Kotlin
      imports of Java types
- [x] Wildcard rule with the `wildcard-unresolved` receipt; ambiguity receipt
- [x] Export visibility rules, `internal` tag, export kinds
- [x] `extractsExports` true for Kotlin; remove the unsupported-type parse error
- [x] Incremental path: `mcp-watcher.ts` keeps the package index current

## Conformance
- [x] Test per row of the resolution table
- [x] Test: a file whose directory does not match its declared package resolves
- [x] Test: Java imports a Kotlin class; Kotlin imports a Java class
- [x] Export test: public, internal, private
- [x] Hostile-input budgets for the scanner and the parser

## Verification
- [x] Full unit suite green

## Spec
- [x] `analyzer` delta: ADD KotlinImportsResolveThroughTheDeclaredPackageIndex,
      KotlinExportsFollowDeclaredVisibility
