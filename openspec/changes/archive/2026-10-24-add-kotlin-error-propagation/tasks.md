# Tasks: Kotlin error propagation

## Implementation
- [ ] Kotlin entry: throw (`jump_expression`), `try_expression`, `catch_block`, `finally_block`,
      call and constructor-call node types, nested-function types
- [ ] Rethrow typing from the enclosing catch parameter; `<dynamic>` otherwise
- [ ] Standard-library contract throw sites, suppressed when a project function shadows the name
- [ ] `@Throws` as declared throw sites
- [ ] `runCatching` as a catch-all region; `getOrThrow()` exception
- [ ] Inline-lambda list (one constant); nested-lambda throw boundary count
- [ ] `use` cleanup boundary; `!!` and unsafe-cast counts; coroutine boundary text
- [ ] Add Kotlin to `ERROR_PROPAGATION_LANGUAGES`; update the supported-language text

## Conformance
- [ ] One fixture per throw-site row and per handler bullet
- [ ] Fixture: throw inside `forEach { }` escapes; throw inside a stored lambda is a boundary
- [ ] Fixture: a Java caller of a Kotlin callee no longer reports an unsupported-language boundary
- [ ] `language-support.test.ts`: Kotlin `errorPropagation` fixture yields a throw site

## Verification
- [ ] Reference corpus: `UserService.find` handles `IllegalStateException`, lets
      `IllegalArgumentException` (from `require`) escape, and reports the `finally` boundary
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinExceptionFlowIsExtractedAsASoundLowerBound
