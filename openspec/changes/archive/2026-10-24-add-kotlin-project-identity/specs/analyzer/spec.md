# analyzer spec delta

## ADDED Requirements

### Requirement: JvmSourcePackagesAreNotSkippedAsBuildOutput

The file walker SHALL skip a directory named `build`, `out`, `bin`, or `target` only when it is at
the repository root or is a sibling of a build file, and SHALL NOT skip a directory of that name
below a source root. It SHALL skip a directory named `android` or `ios` only when the parent
directory holds a React Native or Flutter manifest. Every skipped directory SHALL appear in the skip
receipt with its reason. Gradle Kotlin build scripts SHALL be classified as build configuration:
indexed, excluded from domain inference, and excluded from production function statistics. Other
`.kts` files SHALL be treated as Kotlin source. `.kts` files SHALL be watched for changes and SHALL
count as graph source files.

#### Scenario: A package directory named android is analyzed

- **GIVEN** `src/main/kotlin/com/acme/android/Platform.kt` in a repository with no React Native or
  Flutter manifest
- **WHEN** the repository is analyzed
- **THEN** the file is walked and its functions are in the graph

#### Scenario: Gradle output is still skipped

- **GIVEN** a `build/` directory next to `build.gradle.kts` that contains generated `.kt` files
- **WHEN** the repository is analyzed
- **THEN** the directory is skipped and the skip receipt names it as build output

#### Scenario: A package directory named target is analyzed

- **GIVEN** `src/main/kotlin/com/acme/target/Aim.kt`
- **WHEN** the repository is analyzed
- **THEN** the file is walked

#### Scenario: A build script is not a domain

- **GIVEN** a repository with `build.gradle.kts` and `settings.gradle.kts`
- **WHEN** domains are inferred
- **THEN** no domain is derived from either file
- **AND** both files remain searchable

#### Scenario: A script edit is seen by the watcher

- **GIVEN** a running watcher and a change to a `.kts` script file
- **WHEN** the change is saved
- **THEN** the file is re-analyzed
