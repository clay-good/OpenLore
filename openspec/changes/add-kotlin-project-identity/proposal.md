# Identify a Kotlin project as Kotlin, and walk all of its source

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

`openlore init` and the analysis summary say "Kotlin". Framework detection names Spring Boot, Ktor,
Android, and Compose. Source packages named `android`, `ios`, `build`, `target`, `out`, or `bin`
are analyzed. Gradle build scripts stop appearing as a business domain.

## What is wrong today

Observed on the reference fixture:

| Area | Today |
|---|---|
| Project type | `init` prints "Project type: Java"; config stores `"projectType": "java"`. `ProjectType` has no `kotlin` (`types/index.ts:6`); `build.gradle.kts` maps to `java` (`project-detector.ts:37-39`) |
| Language breakdown | `SUMMARY.md` lists `KT 85%` and `KTS 8%`: `extToLang` has `.java` but no `.kt` (`repository-mapper.ts:625-667`) |
| Frameworks | `frameworks: 0` for a Spring and Ktor project; detectors read `package.json` |
| Skipped source | `src/main/kotlin/com/acme/android/` and `…/target/` are skipped: `SKIP_DIRECTORIES` matches a directory name at any depth (`file-walker.ts:116-131`, `:705`). JVM package paths use these names often |
| Domains | `build.gradle.kts` becomes the domain `build-gradle` |
| `.kts` | not watched (`mcp-watcher.ts:296`); missing from `GRAPH_SOURCE_EXTS` (`confidence-boundary.ts:31-35`) |

## What changes

**Project type.** `kotlin` is a project type with display name "Kotlin". Detection order for a JVM
build:

1. A Kotlin Gradle plugin (`kotlin("jvm")`, `kotlin("multiplatform")`, `kotlin("android")`,
   `id("org.jetbrains.kotlin.…")`, `org.jetbrains.kotlin.*` in a `plugins` block or version
   catalog) or the `kotlin-maven-plugin` in `pom.xml`, **and** Kotlin source files exist → `kotlin`.
2. No plugin evidence: the JVM language with more source files; a tie is `java`.

The config schema accepts `kotlin`. A config that says `java` for a Kotlin repository stays valid
and is not rewritten; `doctor` reports the mismatch as information.

**Language names.** `.kt` and `.kts` are "Kotlin" in every breakdown, from the single canonical
language map.

**Frameworks** are detected from literal plugin ids and dependency coordinates in
`build.gradle(.kts)`, `pom.xml`, and `gradle/libs.versions.toml`: Spring Boot, Ktor (server,
client), Android, Jetpack Compose, Kotlin Multiplatform, Micronaut, Quarkus, Exposed, Room, Koin,
Hilt, Kotest. Each carries its evidence line.

**Skipped directories.** A build-output or platform directory name is skipped only where it can be
one:

- `build`, `out`, `bin`, `target`: skipped when the directory is a sibling of a build file or at
  the repository root, not when it is below a source root (`src/<set>/<language>/…`).
- `android`, `ios`: skipped only when a React Native or Flutter manifest (`package.json` with
  `react-native`, or `pubspec.yaml`) is in the parent directory. Otherwise they are walked.
- Every skip stays in the skip receipt with its reason.

**Build scripts.** `*.gradle.kts` and `settings.gradle.kts` are classified as build configuration:
they are indexed and searchable, they are not domain entities, and they do not count toward
production function statistics. Other `.kts` files are scripts and count as source. `.kts` is
watched and is a graph source extension.

## Not in scope

- Multiplatform source sets and `expect` / `actual` (`add-kotlin-multiplatform-source-sets`).
- Gradle module graphs beyond the existing `settings.gradle` member detection.

## Impact

- `types/index.ts`, `project-detector.ts`, `repository-mapper.ts`, `config-schema.ts`,
  `file-walker.ts`, `domain-naming.ts`, `mcp-watcher.ts`, `confidence-boundary.ts`.
- Specs: `project`, 1 ADDED requirement; `analyzer`, 1 ADDED requirement.
- Risk: the skip-rule change walks more files in every JVM repository. A real `build/` output
  directory must still be skipped; the fixtures cover both.
