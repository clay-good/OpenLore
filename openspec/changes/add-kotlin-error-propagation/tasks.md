# Tasks: Kotlin error propagation

## Implementation
- [x] Kotlin entry: throw (`jump_expression`), `try_expression`, `catch_block`, `finally_block`,
      call and constructor-call node types, nested-function types
- [x] Rethrow typing from the enclosing catch parameter; `<dynamic>` otherwise
- [x] Standard-library contract throw sites, suppressed when a project function shadows the name
- [x] `@Throws` as declared throw sites
- [x] `runCatching` as a catch-all region; `getOrThrow()` exception
- [x] Inline-lambda list (one constant); nested-lambda throw boundary count
- [x] `use` cleanup boundary; `!!` and unsafe-cast counts; coroutine boundary text
- [x] Add Kotlin to `ERROR_PROPAGATION_LANGUAGES`; update the supported-language text

## Conformance
- [x] One fixture per throw-site row and per handler bullet
- [x] Fixture: throw inside `forEach { }` escapes; throw inside a stored lambda is a boundary
- [x] Fixture: a Java caller of a Kotlin callee no longer reports an unsupported-language boundary
- [x] `language-support.test.ts`: Kotlin `errorPropagation` fixture yields a throw site

## Verification
- [x] Reference corpus: `UserService.describe` handles `UserNotFound`; `UserNotFound` escapes
      `UserService.require`; `runCatching` handles in `safeDescribe`; `IllegalStateException`
      (from `error(...)`) escapes `Env.databaseUrl`
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinExceptionFlowIsExtractedAsASoundLowerBound
