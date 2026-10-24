# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinEnvironmentVariableReadsAreExtracted

The analyzer SHALL extract environment-variable reads from `.kt` and `.kts` files for the forms
`System.getenv("X")`, lookups on the `System.getenv()` map, dotenv-kotlin lookups in a file that
imports that library, and `providers.environmentVariable("X")` in a Gradle Kotlin build script. The
variable name SHALL be a string literal that matches the existing name rule; a non-literal name
SHALL be counted as a dynamic read and SHALL NOT be listed. A read site SHALL be reported as
optional when the same expression supplies a fallback value through the Elvis operator or a
default-taking lookup, and as required otherwise, including when the fallback throws or the value is
asserted non-null. A read in a Gradle build script SHALL be tagged as a build-script read. Each read
SHALL be attributed to its enclosing function or, outside any function, reported as module-level.
For a Kotlin repository, the environment-impact conclusion SHALL name Spring property placeholders,
Ktor configuration, Android build configuration, and system properties as out-of-scope
configuration reads.

#### Scenario: A lookup with a default is optional

- **GIVEN** `val port = System.getenv("APP_PORT") ?: "8080"` inside `fun main()`
- **WHEN** environment reads are extracted
- **THEN** `APP_PORT` has one read site in `main` that is not required

#### Scenario: A bare lookup is required

- **GIVEN** `val dbUrl = System.getenv("DATABASE_URL")`
- **WHEN** environment reads are extracted
- **THEN** `DATABASE_URL` has one required read site

#### Scenario: A throwing fallback is required

- **GIVEN** `System.getenv("TOKEN") ?: error("TOKEN is not set")`
- **WHEN** environment reads are extracted
- **THEN** the `TOKEN` read site is required

#### Scenario: The blast radius of a Kotlin variable is computed

- **GIVEN** an indexed Kotlin repository where `connect()` reads `DATABASE_URL` and `main()` calls
  `connect()`
- **WHEN** the environment impact of `DATABASE_URL` is requested
- **THEN** the result lists the read site, `main` as an affected function, and the reaching tests
- **AND** it does not answer that the variable is absent from the inventory

#### Scenario: A dynamic name is counted, not listed

- **GIVEN** `System.getenv(prefix + "_URL")`
- **WHEN** environment reads are extracted
- **THEN** no variable is listed for that site and the dynamic-read count is one
