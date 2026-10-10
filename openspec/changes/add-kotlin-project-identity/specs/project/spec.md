# project spec delta

## ADDED Requirements

### Requirement: KotlinIsADetectedProjectType

The system SHALL detect `kotlin` as a project type with the display name "Kotlin". A JVM build
SHALL be detected as Kotlin when a build file, version catalog, or Maven descriptor declares a
Kotlin compiler plugin and the repository contains Kotlin source files. Without plugin evidence, the
type SHALL be the JVM language with more source files, and a tie SHALL be Java. The configuration
schema SHALL accept `kotlin`. An existing configuration that records `java` for a Kotlin repository
SHALL remain valid and SHALL NOT be rewritten; the mismatch SHALL be reported as information. Every
language breakdown SHALL name `.kt` and `.kts` files "Kotlin". JVM frameworks SHALL be detected from
literal plugin identifiers and dependency coordinates in Gradle build files, version catalogs, and
Maven descriptors, each with its evidence.

#### Scenario: A Gradle Kotlin project is detected

- **GIVEN** a repository with `build.gradle.kts` that applies `kotlin("jvm")` and Kotlin files
  under `src/main/kotlin`
- **WHEN** the project type is detected
- **THEN** the type is `kotlin` and the display name is "Kotlin"

#### Scenario: A Java project with a Kotlin build script stays Java

- **GIVEN** a repository with `build.gradle.kts`, no Kotlin plugin, and only `.java` sources
- **WHEN** the project type is detected
- **THEN** the type is `java`

#### Scenario: The language breakdown names Kotlin

- **GIVEN** an analyzed repository with `.kt` and `.kts` files
- **WHEN** the summary is written
- **THEN** those files are listed under "Kotlin", not "KT" or "KTS"

#### Scenario: Frameworks are detected from the build file

- **GIVEN** a build file with `id("org.springframework.boot")` and a dependency on
  `io.ktor:ktor-server-core`
- **WHEN** frameworks are detected
- **THEN** Spring Boot and Ktor are reported with the lines that are their evidence

#### Scenario: An older configuration still loads

- **GIVEN** a configuration with `"projectType": "java"` in a repository now detected as Kotlin
- **WHEN** the configuration is read
- **THEN** it loads without error and is not modified
- **AND** the health check reports the mismatch as information
