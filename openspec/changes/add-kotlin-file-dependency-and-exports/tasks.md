# Tasks: Kotlin file dependency and exports

## Implementation
- [x] `parseKotlinPackage`, `parseKotlinImports`, `parseKotlinExports`; add the `kotlin` file type
      to the shared extension dispatch
- [x] Shared JVM package index (package + top-level declarations) built once per analysis
- [x] Resolve Kotlin imports through the index; resolve Java imports of Kotlin types and Kotlin
      imports of Java types
- [x] Wildcard rule with the `wildcard-unresolved` receipt; ambiguity receipt
- [x] Export visibility rules, `internal` tag, export kinds, `@JvmName` aliases
- [x] `extractsExports` true for Kotlin; remove the unsupported-type parse error
- [x] Incremental path: `mcp-watcher.ts` re-derives Kotlin imports and exports on change (the
      index is rebuilt from the `jvm` facts stored on each dependency-graph node)

## Conformance
- [x] Fixture per row of the resolution table
- [x] Fixture: a file in `src/main/kotlin/misc/Util.kt` declaring `package com.acme.util` resolves
- [x] Fixture: Java imports Kotlin class; Kotlin imports Java class
- [x] Export fixture: public, internal, protected, private, `@JvmName`
- [x] Guard test: every consumer of the export inventory reports Kotlin as extracted

## Verification
- [x] Reference corpus: `Application.kt` has import edges to its four imported project files
- [ ] Real repository: before/after dependency edge counts and domain list in the PR
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinImportsResolveThroughTheDeclaredPackageIndex,
      KotlinExportsFollowDeclaredVisibility
