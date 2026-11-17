# Tasks: Kotlin entry-point roots

## Implementation
- [ ] Gradle adapter: literal `mainClass` forms; JVM facade name to file mapping, with
      `@file:JvmName`
- [ ] Android manifest adapter; relative-name resolution
- [ ] Ktor config adapter; `META-INF/services` adapter
- [ ] Runner entries for `gradle`, `./gradlew`, `java`, `kotlin`
- [ ] Annotation facts in the Kotlin extractor; import-gated root table as one constant
- [ ] `external-override` tier from the `override` modifier and repository hierarchy
- [ ] `main` forms, including `suspend` and `@JvmStatic`
- [ ] Receipts per root; `config-unresolved` count

## Conformance
- [ ] One fixture per adapter row and per annotation row
- [ ] Fixture: `override fun onCreate` in a class with no in-repository parent declaration is not
      confidently dead; an override of a repository interface is still judged normally
- [ ] Negative fixture: `@Service` from a project package (no Spring import) roots nothing
- [ ] `entry-point-adapters.test.ts` hardening cases (large file, unreadable file) for new inputs

## Verification
- [ ] Reference corpus: `Main.kt` is config-wired by `build.gradle.kts`; `UserController` is
      framework-annotated
- [ ] Real Android and Spring repositories: dead-code candidate counts before and after in the PR
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD JvmBuildAndManifestEntryPointAdapters,
      KotlinFrameworkAnnotatedAndExternalOverrideRoots
