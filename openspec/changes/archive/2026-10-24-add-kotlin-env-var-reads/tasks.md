# Tasks: Kotlin env var reads

## Implementation
- [ ] Add `.kt` and `.kts` to the env extractor's source extensions
- [ ] Read forms: `System.getenv("X")`, the `System.getenv()` map forms, dotenv-kotlin (import
      gated), Gradle `providers.environmentVariable` (`.gradle.kts` only)
- [ ] Required-or-optional rules from the proposal table
- [ ] `build-script` tag for `.gradle.kts` reads; dynamic-read count for non-literal names
- [ ] Attribute reads to the enclosing function or initializer node
- [ ] Update the `analyze_env_impact` hint and the Kotlin boundary text

## Conformance
- [ ] One fixture per read form and per row of the required-or-optional table
- [ ] Negative fixture: `map.get("X")` on an ordinary map is not a read
- [ ] `analyze_env_impact` fixture: read site, affected callers, reaching test for a Kotlin var

## Verification
- [ ] Reference corpus: `APP_PORT` (optional) and `DATABASE_URL` (required), both in `main`
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinEnvironmentVariableReadsAreExtracted
