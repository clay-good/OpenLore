# Tasks: Kotlin dynamic boundary

## Implementation
- [x] Kotlin entry in `DYNAMIC_BOUNDARY_LANG_SPECS` (call node type, string literal type, import
      node type, `importStyle: 'jvm'`)
- [x] Receiver-chain gate: class literal (`X::class`) and `.java` bridge
- [x] Gated method tables for Java reflection, Kotlin reflection, Spring, Koin, Kodein, scripting,
      proxies
- [x] Literal selector index for `getMethod`, `getDeclaredMethod`, `getBean`, `forName`; a string
      with an interpolation is not a literal selector
- [x] Operator-dispatch count (owed by `add-kotlin-callable-node-shapes`): expressions that could
      call a declared `operator fun`, per file, under `operatorDispatch` in `dynamic-boundary.json`.
      A count, not a site kind: the site vocabulary is unchanged
- [x] Capability note: why `literalReflection` is not backed for Kotlin

## Conformance
- [x] One fixture per row of the table
- [x] False-site fixtures: OkHttp `newCall(...)`, `Callable.call()`, a map `get()`, `f.invoke()`
      on a function value: no site
- [x] `language-support.test.ts`: Kotlin `dynamicBoundary` fixture yields a site
- [x] Dead-code fixture: a function named by a reflective selector is qualified, not confident

## Verification
- [x] Reference corpus: `plugin/Reflect.kt` records a `dynamic-import` and a `reflective-invoke`
      (the reflective calls of the corpus are in that file, not in `UserService`)
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinDynamicBoundarySitesAreRecorded
