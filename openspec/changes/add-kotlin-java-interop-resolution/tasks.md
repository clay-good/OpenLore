# Tasks: Kotlin and Java interop resolution

## Implementation
- [x] JVM-name view: file facade classes, `@file:JvmName`, `@JvmName`, `@JvmStatic`, `@JvmField`,
      `const`, `INSTANCE`, `Companion`, accessor names, `@JvmOverloads`
- [x] Add the view to the shared JVM index; ambiguity refusal for duplicate facade names
- [x] Java call resolution through the view at `import` confidence
- [x] Exclude `@JvmSynthetic` and `internal` declarations
- [x] Dead-code exemption for Java accessors of classes referenced from Kotlin

## Conformance
- [x] One fixture per row of both tables, each with a Java caller and a Kotlin target
- [x] Ambiguity fixture: two `Util.kt` in one package bind nothing
- [x] Negative fixture: an unrelated Java `getCount()` call does not bind to a Kotlin property

## Verification
- [ ] A real mixed repository: cross-language edge count before and after, with a hand-checked
      sample, in the PR
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD JavaCallsResolveToKotlinDeclarationsThroughTheirJvmNames
