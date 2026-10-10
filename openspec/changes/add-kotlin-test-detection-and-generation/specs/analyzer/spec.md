# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinTestsAreDetectedByPathAndByContent

The analyzer SHALL classify a Kotlin file as a test file when it lies in a Gradle source set named
`test`, a source set whose name ends in `Test`, or `testFixtures`, or under a `test` or `tests`
directory, in addition to the existing file-name rules. A Kotlin file outside those paths SHALL be
classified as a test file when it imports a supported test framework and contains a function with a
test annotation or a class that extends a Kotest spec style. Each leaf test of a Kotest spec SHALL
be a test node named by its container names and its own name, and calls inside the leaf lambda
SHALL be attributed to that node; calls in setup lambdas SHALL be attributed to every test node of
the spec. A leaf with a non-literal name SHALL receive a position-based name. A Kotlin file that
imports a test framework that is not modeled SHALL be counted in a disclosed receipt.

#### Scenario: A multiplatform test source set is a test path

- **GIVEN** `src/commonTest/kotlin/com/acme/ClockChecks.kt`
- **WHEN** the file is classified
- **THEN** it is a test file

#### Scenario: A test annotation classifies a file by content

- **GIVEN** `src/main/kotlin/com/acme/Checks.kt` that imports `kotlin.test.Test` and declares a
  function annotated `@Test`
- **WHEN** the file is classified
- **THEN** it is a test file and that function is a test node

#### Scenario: A Kotest leaf is a test node

- **GIVEN** `class UserSpec : FunSpec({ context("create") { test("makes a slug") { svc.create("A B") } } })`
- **WHEN** the call graph is built
- **THEN** a test node named `create > makes a slug` exists and has an edge to `create`

#### Scenario: Test selection reaches a Kotest spec

- **GIVEN** a production function called only from a Kotest leaf
- **WHEN** tests are selected for a change to that function
- **THEN** the spec file is selected with a reason that names the reaching test

#### Scenario: An unmodeled test framework is disclosed

- **GIVEN** a Kotlin file that imports `org.spekframework.spek2`
- **WHEN** tests are detected
- **THEN** the unmodeled-test-framework receipt names Spek
