# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PublicSurfaceNeverReportsAnUnassessedLanguageAsComplete

When the public surface of a repository is requested and the repository contains source files in a
language whose surface membership is not extracted, the result SHALL name each such language with
its file count, and its confidence boundary SHALL NOT be complete. An empty surface SHALL be
reported as complete only when membership was extracted for every source language present.

#### Scenario: An unassessed language is named

- **GIVEN** a repository whose source files are all in a language without surface-membership
  extraction
- **WHEN** the public surface is requested with no base ref
- **THEN** the result names that language as unassessed with its file count
- **AND** the confidence boundary is not complete

#### Scenario: A fully assessed empty surface is complete

- **GIVEN** a repository whose only source language has membership extraction and which exports
  nothing
- **WHEN** the public surface is requested
- **THEN** the surface is empty and the confidence boundary is complete

### Requirement: KotlinPublicSurfaceMembershipAndCompatibility

The public-surface tool SHALL extract Kotlin surface membership from declared visibility: a
declaration with no visibility modifier or with `public` is in the surface; a `protected` member of
an inheritable class is in the surface; an `internal` declaration is in the surface only when
annotated `@PublishedApi`; a `private` declaration, a member of a non-public class, and a
declaration in a test source set are not. With a base ref, each changed Kotlin export SHALL be
classified with the existing rule codes where one applies: a removed or renamed declaration,
reduced visibility, an added parameter without a default, a removed default, a removed parameter,
and a parameter narrowed from nullable to non-null SHALL be breaking. A return type widened from
non-null to nullable, and a property added to a data class primary constructor, SHALL be breaking
under registered rule codes. A parameter widened to nullable and a parameter added with a default
SHALL be classified as source-compatible and JVM-binary-incompatible, reported as potentially
breaking under a registered rule code. A new enum entry or sealed subtype SHALL be potentially
breaking under a registered rule code. A return type narrowed from nullable to non-null SHALL be
non-breaking. Any other change SHALL be potentially breaking as unprovable, and the suggested
version bump SHALL be withheld whenever a potentially breaking change is present.

#### Scenario: Default visibility puts a declaration in the surface

- **GIVEN** a Kotlin file with `fun find(id: String): String?`, `internal fun hidden() = 1`, and
  `private fun warmUp() {}`
- **WHEN** the public surface is requested
- **THEN** the surface lists `find` and omits `hidden` and `warmUp`

#### Scenario: A published internal declaration is in the surface

- **GIVEN** `@PublishedApi internal fun impl() {}`
- **WHEN** the public surface is requested
- **THEN** the surface lists `impl`

#### Scenario: An added required parameter is breaking

- **GIVEN** a base revision with `fun find(id: String)` and a working tree with
  `fun find(id: String, strict: Boolean)`
- **WHEN** the surface is certified against the base
- **THEN** `find` is classified breaking with rule code `param-required-added`

#### Scenario: A defaulted parameter is binary-incompatible

- **GIVEN** a base revision with `fun find(id: String)` and a working tree with
  `fun find(id: String, strict: Boolean = false)`
- **WHEN** the surface is certified against the base
- **THEN** `find` is classified potentially breaking with rule code `jvm-binary-signature-changed`
- **AND** the suggested bump is withheld

#### Scenario: A new sealed subtype may break an exhaustive when

- **GIVEN** a public `sealed interface Shape` and a working tree that adds a new public subtype
- **WHEN** the surface is certified against the base
- **THEN** `Shape` carries a potentially breaking change with rule code `exhaustive-when-may-break`
