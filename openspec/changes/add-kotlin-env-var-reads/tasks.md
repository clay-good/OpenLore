# Tasks: Kotlin env var reads

## Implementation
- [x] Add `.kt` and `.kts` to the env extractor's source extensions
- [x] Read forms: `System.getenv("X")`, the `System.getenv()` map forms, dotenv-kotlin (import
      gated), Gradle `providers.environmentVariable` (`.gradle.kts` only)
- [x] Required-or-optional rules from the proposal table
- [x] `build-script` tag for `.gradle.kts` reads; dynamic-read count for non-literal names
- [x] Attribute reads to the enclosing function or initializer node
- [x] Update the `analyze_env_impact` hint and the Kotlin boundary text

## Conformance
- [x] One fixture per read form and per row of the required-or-optional table
- [x] Negative fixture: `map.get("X")` on an ordinary map is not a read
- [x] `analyze_env_impact` fixture: read site, affected callers, reaching test for a Kotlin var

## Verification
- [x] Reference corpus: `ACME_PORT` (optional) and `ACME_DATABASE_URL` (required), both in `Env`
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinEnvironmentVariableReadsAreExtracted
