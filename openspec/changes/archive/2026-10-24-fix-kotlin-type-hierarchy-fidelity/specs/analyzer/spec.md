# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinClassModelMatchesDeclaredTypes

The analyzer SHALL record a Kotlin class only for a type the repository declares. An extension
function SHALL carry its receiver type in a dedicated field and SHALL NOT cause a class record for a
receiver type the repository does not declare. Supertypes SHALL be classified as superclass (written
with a constructor invocation), interface (resolving to a project interface), or unknown kind.
Interface delegation (`: Iface by d`) SHALL record the interface and mark the class as delegating.
Object expressions and enum entries that have a body SHALL be recorded as anonymous classes with a
stable position-based name, their supertypes, and their members. The class kind (class, interface,
functional interface, object, companion, enum, data, sealed, value, annotation, inner) SHALL be
recorded. Members of a companion object SHALL be owned by the enclosing class whether or not the
companion is named. A nested class SHALL be identified by its qualified name. Existing dispatch
guards (ambiguity skip, qualified-supertype skip, inferred-receiver requirement, fan-out cap) SHALL
continue to apply.

#### Scenario: An extension receiver is not a project class

- **GIVEN** `fun String.slugify(): String` in a repository that does not declare `String`
- **WHEN** the call graph is built
- **THEN** the class inventory has no class named `String`
- **AND** the function node records `String` as its receiver type

#### Scenario: Interfaces and superclasses are told apart

- **GIVEN** `class A : Base(), Iface` where `Iface` is a project interface
- **WHEN** hierarchy facts are extracted
- **THEN** `Base` is the superclass and `Iface` is an implemented interface

#### Scenario: Delegation records the interface

- **GIVEN** `class Cached(d: Repo) : Repo by d`
- **WHEN** hierarchy facts are extracted
- **THEN** `Cached` implements `Repo` and is marked delegating

#### Scenario: An object expression takes part in dispatch

- **GIVEN** `val l = object : Listener { override fun on() {} }` and a call `x.on()` whose receiver
  is typed `Listener`
- **WHEN** the call graph is built
- **THEN** the anonymous class is a subtype of `Listener` and its `on` is a dispatch target

#### Scenario: A named companion member belongs to the enclosing class

- **GIVEN** `class Outer { companion object Named { fun make() = Outer() } }`
- **WHEN** the call graph is built
- **THEN** `make` is owned by `Outer`
- **AND** both `Outer.make()` and `Outer.Named.make()` bind to it

#### Scenario: Nested classes with the same simple name do not collide

- **GIVEN** `class Request { class Builder }` and `class Response { class Builder }`
- **WHEN** the call graph is built
- **THEN** two class records exist, `Request.Builder` and `Response.Builder`
