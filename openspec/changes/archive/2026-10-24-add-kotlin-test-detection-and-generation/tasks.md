# Tasks: Kotlin test detection and generation

## Implementation
- [ ] Path rules: `test` / `*Test` / `testFixtures` source sets; `kt`, `kts` in the `tests?/` rule
- [ ] Content rules behind import gates; file-level test classification from content
- [ ] Kotest spec detection and one test node per leaf, with container-qualified names
- [ ] Attribute setup lambdas to the spec's test nodes
- [ ] `unmodeled-test-framework` receipt
- [ ] Framework detector: `kotest`, `junit-kotlin`, `junit`
- [ ] Kotlin JUnit 5 renderer and Kotest renderer; `.kt` extension and path
- [ ] Coverage title patterns for `@DisplayName`, backtick names, Kotest names
- [ ] Correct the `generate_tests` description and `docs/mcp-tools.md`

## Conformance
- [ ] Path fixture per source-set form; content fixture per framework row
- [ ] Kotest fixture per spec style: node names and attributed calls
- [ ] `select_tests` fixture: a change to a function called only from a Kotest leaf selects that
      spec file with a reason
- [ ] Renderer fixtures: generated Kotlin parses without error
- [ ] `test-file.test.ts` parity table updated

## Verification
- [ ] Reference corpus: the backtick test and a Kotest spec both reach `UserService.create`
- [ ] Real repository: list of files reclassified as tests in the PR
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinTestsAreDetectedByPathAndByContent
- [ ] `generator` delta: ADD GeneratedTestsUseTheProjectsJvmLanguage
