# Detect Kotlin tests fully, and generate Kotlin tests for Kotlin projects

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic detection; generation keeps its existing LLM path. No new dependency.

## What you get

`select_tests` and `report_coverage_gaps` see every Kotlin test, including Kotest specs and tests
in multiplatform or Android source sets. `generate_tests` writes Kotlin, not Java, for a Kotlin
project.

## What is wrong today

**Detection** is path-only (`test-file.ts:45-47`): `*Test.kt`, `*Tests.kt`, `*IT.kt`, `*Spec.kt`,
and `src/test/**/*.kt`.

| Kotlin test | Today |
|---|---|
| `src/androidTest/…`, `src/commonTest/…`, `src/jvmTest/…`, `src/integrationTest/…`, `src/testFixtures/…` | production code unless the file name matches |
| `tests/…/*.kt` | production code (the generic `tests?/` rule has no `kt`, `:41`) |
| a `@Test` function in a file with another name | production code |
| `class UserSpec : FunSpec({ test("creates a slug") { … } })` | the test body is a lambda: no node, so its calls reach nothing |

**Generation.** A Gradle project maps to `junit`, whose extension is `.java`
(`types/test-generator.ts:30`). The renderer writes a Java class (`renderers/junit.ts:23-58`), and
the prompt says "JUnit 5 (Java)". The tool description and `docs/mcp-tools.md:281` say
"junit (Java/Kotlin)".

## What changes

**Path rules**

- Any Gradle source set whose name is `test` or ends in `Test`, and `testFixtures`:
  `src/<set>/**/*.kt`.
- `kt` and `kts` join the generic `tests?/` directory rule.

**Content rules** (import-gated, applied to files the path rules did not match)

| Framework | Gate | A test is |
|---|---|---|
| JUnit 4 / 5, kotlin.test, TestNG | `org.junit`, `kotlin.test`, `org.testng` | a function annotated `@Test`, `@ParameterizedTest`, `@RepeatedTest`, `@TestFactory`, `@TestTemplate` |
| Kotest | `io.kotest` | a class whose supertype is a Kotest spec style |

A file with at least one content-detected test is a test file.

**Kotest test nodes.** Each leaf test lambda in a spec is a test node, so its calls are attributed:

| Style | Leaf forms | Container forms |
|---|---|---|
| `FunSpec` | `test("n") { }` | `context("n") { }` |
| `StringSpec` | `"n" { }` | none |
| `ShouldSpec` | `should("n") { }` | `context("n") { }` |
| `DescribeSpec` | `it("n") { }` | `describe("n") { }`, `context("n") { }` |
| `BehaviorSpec` | `then("n") { }` | `given` / `` `when` `` / `and` |
| `FreeSpec` | `"n" { }` | `"n" - { }` |
| `WordSpec` | `"n" { }` | `"n" should { }`, `"n" when { }` |
| `FeatureSpec` | `scenario("n") { }` | `feature("n") { }` |
| `ExpectSpec` | `expect("n") { }` | `context("n") { }` |
| `AnnotationSpec` | `@Test` functions | none |

- The node name is the container names and the leaf name joined with ` > `. A non-literal name
  uses a position-based name.
- Setup lambdas (`beforeTest`, `beforeSpec`, `afterTest`, …) are attributed to every test node of
  the spec.
- Spek and other DSL frameworks are counted in an `unmodeled-test-framework` receipt.

**Generation.** The framework for a JVM project is chosen from the build files and sources:

| Evidence | Framework key | Output |
|---|---|---|
| `io.kotest` in the build files | `kotest` | `.kt`, `FunSpec` |
| Kotlin project (see `add-kotlin-project-identity`) | `junit-kotlin` | `.kt`, JUnit 5 class with `package`, backtick test names, `kotlin.test` or JUnit assertions as the project already uses |
| otherwise | `junit` | `.java`, unchanged |

The spec-coverage title patterns learn `@DisplayName("…")`, backtick function names, and Kotest
string names.

## Not in scope

- Running tests; coverage from a runtime tool.

## Impact

- `test-file.ts`, the Kotlin extractor (Kotest nodes), `test-generator/*` (two renderers, detector,
  prompt hint), `coverage-analyzer.ts`, `cli/commands/mcp.ts` and `docs/mcp-tools.md` (claim text).
- Specs: `analyzer`, 1 ADDED requirement; `generator`, 1 ADDED requirement.
- Risk: more files are classified as tests, so production function counts for Kotlin repositories
  drop. The PR lists the reclassified files for a real repository.
