# analyzer spec delta

## ADDED Requirements

### Requirement: JavaCallsResolveToKotlinDeclarationsThroughTheirJvmNames

The analyzer SHALL derive, from syntax alone, the JVM-facing names of Kotlin declarations and SHALL
use them to resolve calls written in Java. A top-level Kotlin function or property SHALL be
reachable as a static member of the file facade class, named after the file with a `Kt` suffix or by
a `@file:JvmName` annotation. A companion member SHALL be reachable through `Companion`, and
directly on the owner when annotated `@JvmStatic`. A member of an `object` SHALL be reachable
through `INSTANCE`, and directly when annotated `@JvmStatic`. A Kotlin property SHALL be reachable
through its getter and setter names. A `@JvmName` annotation SHALL replace the derived name, and a
`@JvmOverloads` function SHALL bind calls of every generated arity. A JVM-facing name that is not
unique SHALL bind nothing. An accessor name SHALL bind only through a typed or imported receiver and
never by name alone. Declarations that are `internal` or annotated `@JvmSynthetic` SHALL NOT be in
the view. A Kotlin property-style access to a Java accessor SHALL NOT be an edge, and such Java
accessors SHALL NOT receive a confident unreachable verdict.

#### Scenario: Java calls a Kotlin top-level function

- **GIVEN** `Main.kt` in package `com.acme` with `fun report(n: Int)`, and a Java file that calls
  `MainKt.report(1)`
- **WHEN** the call graph is built
- **THEN** the Java call has an edge to the Kotlin function `report`

#### Scenario: A file facade is renamed

- **GIVEN** a Kotlin file with `@file:JvmName("StringUtil")` that declares `fun String.slugify()`,
  and a Java call `StringUtil.slugify(s)`
- **WHEN** the call graph is built
- **THEN** the edge targets `slugify`

#### Scenario: Java calls a companion member

- **GIVEN** `class UserService { companion object { @JvmStatic fun audit(w: String) {} } }` and the
  Java calls `UserService.audit("x")` and `UserService.Companion.audit("x")`
- **WHEN** the call graph is built
- **THEN** both calls have an edge to the companion member `audit`

#### Scenario: Java calls a Kotlin property accessor

- **GIVEN** a Kotlin class `UserService` with `val count: Int get() = repo.size()` and a Java
  method with a parameter `UserService svc` that calls `svc.getCount()`
- **WHEN** the call graph is built
- **THEN** the edge targets the getter node of `count`

#### Scenario: An ambiguous facade binds nothing

- **GIVEN** two files named `Util.kt` in the same package, each declaring `fun helper()`, and a
  Java call `UtilKt.helper()`
- **WHEN** the call graph is built
- **THEN** no edge is emitted for that call

#### Scenario: An untyped accessor call does not bind by name

- **GIVEN** a Java call `x.getCount()` where the type of `x` is not known
- **WHEN** the call graph is built
- **THEN** no edge to a Kotlin property getter is emitted on this path
