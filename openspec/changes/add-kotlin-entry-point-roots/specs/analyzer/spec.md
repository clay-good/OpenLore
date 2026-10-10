# analyzer spec delta

## ADDED Requirements

### Requirement: JvmBuildAndManifestEntryPointAdapters

The framework entry-point adapters SHALL read Gradle build files, Android manifests, Ktor
application configuration, and `META-INF/services` provider files, and SHALL root the Kotlin code
they name with a receipt that states the file and key. A Gradle main-class name SHALL resolve to the
file whose JVM facade class has that name, honoring a `@file:JvmName` annotation, or to the `main`
function of the named class. An Android manifest component name SHALL resolve to its class,
including a relative name when the package or namespace is a literal. A Ktor module entry SHALL
resolve to its module function. A value that is not a literal SHALL root nothing and be counted as
unresolved. Continuous-integration run steps that invoke Gradle or a JVM launcher SHALL wire the
roots of that Gradle project. A config-wired root SHALL NOT be reported as tested.

#### Scenario: A Gradle main class roots the facade file

- **GIVEN** `build.gradle.kts` with `application { mainClass.set("com.acme.MainKt") }` and
  `src/main/kotlin/com/acme/Main.kt` declaring `package com.acme` and `fun main()`
- **WHEN** entry points are computed
- **THEN** `Main.kt` is a config-wired root with a receipt naming `build.gradle.kts` and
  `mainClass`

#### Scenario: A renamed facade is honored

- **GIVEN** `mainClass.set("com.acme.Launcher")` and a file with `@file:JvmName("Launcher")` in
  package `com.acme`
- **WHEN** entry points are computed
- **THEN** that file is the config-wired root

#### Scenario: A manifest activity is a root

- **GIVEN** `AndroidManifest.xml` with `package="com.acme"` and `<activity android:name=".MainActivity"/>`
- **WHEN** entry points are computed
- **THEN** class `com.acme.MainActivity` is a config-wired root

#### Scenario: A computed value roots nothing

- **GIVEN** `mainClass.set(providers.gradleProperty("main"))`
- **WHEN** entry points are computed
- **THEN** no root is created and the unresolved-config count is one

### Requirement: KotlinFrameworkAnnotatedAndExternalOverrideRoots

The analyzer SHALL treat a Kotlin declaration as started by a framework when it carries an
annotation from a fixed, import-gated table covering Spring stereotypes and callbacks, dependency
injection (`@Inject`, `@Provides`, `@Binds`, Hilt entry points), Compose previews, serializable
classes, and test lifecycle callbacks. Such a declaration SHALL be a root with the tier
`framework-annotated`. A member with the `override` modifier whose overridden declaration is not in
the repository SHALL have the tier `external-override` and SHALL NOT receive a confident
unreachable verdict. An annotation outside the table, or one whose gating package is not imported,
SHALL root nothing. Top-level, suspending, and `@JvmStatic` `main` functions SHALL be roots. Every
such root SHALL report its tier so a consumer can list rooted symbols that have no caller.

#### Scenario: A Spring service is not dead

- **GIVEN** a Kotlin class annotated `@Service` in a file that imports
  `org.springframework.stereotype.Service`, with a `@Scheduled` function that has no caller
- **WHEN** dead code is reported
- **THEN** neither the class constructor nor the scheduled function is a dead-code candidate
- **AND** both report the tier `framework-annotated`

#### Scenario: An override of a library type is not confidently dead

- **GIVEN** `class MainActivity : AppCompatActivity() { override fun onCreate(b: Bundle?) { } }`
  where `AppCompatActivity` is not declared in the repository
- **WHEN** dead code is reported
- **THEN** `onCreate` has the tier `external-override` and is not confidently unreachable

#### Scenario: An override of a repository interface is judged normally

- **GIVEN** an `override fun save` whose interface is declared in the repository and which has no
  caller and no caller of the interface member
- **WHEN** dead code is reported
- **THEN** `save` is a dead-code candidate under the ordinary rules

#### Scenario: A same-named project annotation roots nothing

- **GIVEN** a project annotation class named `Service` and a class annotated with it, with no
  Spring import
- **WHEN** entry points are computed
- **THEN** the class is not a framework-annotated root
