# Tasks: Kotlin and Java interop resolution

## Implementation
- [ ] JVM-name view: file facade classes, `@file:JvmName`, `@JvmName`, `@JvmStatic`, `@JvmField`,
      `const`, `INSTANCE`, `Companion`, accessor names, `@JvmOverloads`
- [ ] Add the view to the shared JVM index; ambiguity refusal for duplicate facade names
- [ ] Java call resolution through the view at `import` confidence
- [ ] Exclude `@JvmSynthetic` and `internal` declarations
- [ ] Dead-code exemption for Java accessors of classes referenced from Kotlin

## Conformance
- [ ] One fixture per row of both tables, each with a Java caller and a Kotlin target
- [ ] Ambiguity fixture: two `Util.kt` in one package bind nothing
- [ ] Negative fixture: an unrelated Java `getCount()` call does not bind to a Kotlin property

## Verification
- [ ] A real mixed repository: cross-language edge count before and after, with a hand-checked
      sample, in the PR
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD JavaCallsResolveToKotlinDeclarationsThroughTheirJvmNames
