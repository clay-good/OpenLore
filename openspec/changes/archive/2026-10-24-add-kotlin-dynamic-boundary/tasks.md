# Tasks: Kotlin dynamic boundary

## Implementation
- [ ] Kotlin entry in `DYNAMIC_BOUNDARY_LANG_SPECS` (call node type, string literal type, import
      node type, `importStyle: 'jvm'`)
- [ ] Receiver-chain gate: class literal (`X::class`) and `.java` bridge
- [ ] Gated method tables for Java reflection, Kotlin reflection, Spring, Koin, Kodein, scripting,
      proxies
- [ ] Literal selector index for `getMethod`, `getDeclaredMethod`, `getBean`, `forName`
- [ ] Capability note: why `literalReflection` is not backed for Kotlin

## Conformance
- [ ] One fixture per row of the table
- [ ] False-site fixtures: OkHttp `newCall(...)`, `Callable.call()`, a map `get()`, `f.invoke()`
      on a function value: no site
- [ ] `language-support.test.ts`: Kotlin `dynamicBoundary` fixture yields a site
- [ ] Dead-code fixture: a function named by a reflective selector is qualified, not confident

## Verification
- [ ] Reference corpus: `UserService.reflect` records a `dynamic-import` and a `reflective-invoke`
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinDynamicBoundarySitesAreRecorded
