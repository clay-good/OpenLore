# generator spec delta

## ADDED Requirements

### Requirement: GeneratedTestsUseTheProjectsJvmLanguage

Test generation for a JVM project SHALL choose its framework from the project's build files and
sources. A project whose build files declare Kotest SHALL receive Kotest specs in Kotlin. Any other
Kotlin project SHALL receive JUnit 5 tests in Kotlin, with a `package` declaration and a `.kt` file
path. A Java project SHALL receive Java JUnit tests as before. Generated Kotlin SHALL parse without
error. Tool descriptions and documentation SHALL state the language each framework key produces.

#### Scenario: A Kotlin project gets Kotlin tests

- **GIVEN** a Gradle project with the Kotlin JVM plugin and no Kotest dependency
- **WHEN** tests are generated for a requirement
- **THEN** the output file has the `.kt` extension and contains a Kotlin class with a `@Test`
  function
- **AND** no `.java` test file is written

#### Scenario: A Kotest project gets specs

- **GIVEN** a Kotlin project whose build files declare `io.kotest`
- **WHEN** tests are generated
- **THEN** the output is a Kotest spec class in a `.kt` file

#### Scenario: A Java project is unchanged

- **GIVEN** a Maven project with no Kotlin sources or plugin
- **WHEN** tests are generated
- **THEN** the output is a Java JUnit class in a `.java` file
