# Tasks: Kotlin file dependency and exports

## Implementation
- [ ] `parseKotlinPackage`, `parseKotlinImports`, `parseKotlinExports`; add the `kotlin` file type
      to the shared extension dispatch
- [ ] Shared JVM package index (package + top-level declarations) built once per analysis
- [ ] Resolve Kotlin imports through the index; resolve Java imports of Kotlin types and Kotlin
      imports of Java types
- [ ] Wildcard rule with the `wildcard-unresolved` receipt; ambiguity receipt
- [ ] Export visibility rules, `internal` tag, export kinds, `@JvmName` aliases
- [ ] `extractsExports` true for Kotlin; remove the unsupported-type parse error
- [ ] Incremental path: `mcp-watcher.ts` re-derives Kotlin imports and exports on change

## Conformance
- [ ] Fixture per row of the resolution table
- [ ] Fixture: a file in `src/main/kotlin/misc/Util.kt` declaring `package com.acme.util` resolves
- [ ] Fixture: Java imports Kotlin class; Kotlin imports Java class
- [ ] Export fixture: public, internal, protected, private, `@JvmName`
- [ ] Guard test: every consumer of the export inventory reports Kotlin as extracted

## Verification
- [ ] Reference corpus: `Main.kt` has import edges to all four imported packages
- [ ] Real repository: before/after dependency edge counts and domain list in the PR
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinImportsResolveThroughTheDeclaredPackageIndex,
      KotlinExportsFollowDeclaredVisibility
