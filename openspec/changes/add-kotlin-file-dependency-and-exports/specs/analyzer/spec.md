# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinImportsResolveThroughTheDeclaredPackageIndex

The analyzer SHALL parse the `package` declaration and the plain, aliased, and wildcard imports of a
Kotlin file, and SHALL resolve each import to repository files through an index built from the
declared package and top-level declarations of every Kotlin and Java file. Resolution SHALL NOT
depend on the directory path matching the package name. An import of a type, a top-level function,
a top-level property, a nested type, or an object member SHALL resolve to the file that declares the
top-level owner. A wildcard import SHALL create an edge only to a file of that package that declares
a name the importing file uses; otherwise it SHALL create no edge and be counted as unresolved. An
imported name declared in more than one file SHALL create no edge and be counted as ambiguous.
Imports from the Kotlin default-import packages and from JDK or Kotlin standard-library packages
SHALL be marked built-in. Java files SHALL resolve imports of Kotlin declarations, and Kotlin files
imports of Java declarations, through the same index.

#### Scenario: A Kotlin import becomes a dependency edge

- **GIVEN** `Main.kt` with `import com.acme.service.UserService` and a file that declares
  `class UserService` in package `com.acme.service`
- **WHEN** the dependency graph is built
- **THEN** an import edge joins the two files with `UserService` in its imported names
- **AND** the edge is not marked as call-derived

#### Scenario: The package does not match the directory

- **GIVEN** `src/main/kotlin/misc/Util.kt` that declares `package com.acme.util` and
  `fun slugify(s: String)`, and another file with `import com.acme.util.slugify`
- **WHEN** the dependency graph is built
- **THEN** the import resolves to `src/main/kotlin/misc/Util.kt`

#### Scenario: A top-level function import resolves

- **GIVEN** `import com.acme.util.slugify` where `slugify` is a top-level extension function
- **WHEN** imports are resolved
- **THEN** the edge targets the file that declares `slugify`

#### Scenario: Java and Kotlin resolve each other

- **GIVEN** a Java file with `import com.acme.repo.UserRepository;` where `UserRepository` is
  declared in a `.kt` file
- **WHEN** the dependency graph is built
- **THEN** the Java file has an import edge to the Kotlin file

#### Scenario: An undecidable wildcard creates no edge

- **GIVEN** `import com.acme.repo.*` in a file that uses no name declared in that package
- **WHEN** imports are resolved
- **THEN** no edge is created for that import and the unresolved-wildcard count is one

### Requirement: KotlinExportsFollowDeclaredVisibility

The analyzer SHALL report the exports of a Kotlin file as its top-level declarations, and the
members of its exported classes, whose visibility is `public` (the default when no modifier is
written) or `protected`. A declaration marked `internal` SHALL be reported with an `internal` tag.
A `private` declaration SHALL NOT be reported. Each export SHALL carry its kind and, when a
`@JvmName` or `@file:JvmName` annotation renames it, the JVM-facing name as an alias. The export
inventory SHALL report Kotlin as an extracted language, and a Kotlin file SHALL NOT carry an
unsupported-file-type parse error.

#### Scenario: Default visibility is public

- **GIVEN** a Kotlin file with `fun a()`, `internal fun b()`, and `private fun c()`
- **WHEN** exports are extracted
- **THEN** `a` is exported, `b` is exported with the `internal` tag, and `c` is not exported

#### Scenario: Export kinds are recorded

- **GIVEN** `data class User(val id: Long)`, `object Registry`, `typealias Handler = (Int) -> Unit`,
  and `val MAX = 10`
- **WHEN** exports are extracted
- **THEN** four exports exist with kinds data class, object, type alias, and property

#### Scenario: A consumer can tell extracted from unsupported

- **GIVEN** a Kotlin file that declares no public symbol named `foo`
- **WHEN** a spec link asks whether the file exports `foo`
- **THEN** the answer is that the file does not export it, not that the language is not extracted
