# Make the Kotlin class model match the source

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

Kotlin class listings contain only classes the project declares, interfaces are told apart from
base classes, and delegation and object expressions take part in dispatch.

## What is wrong today

| Kotlin source | Today |
|---|---|
| `fun String.slugify()`, `fun Application.module()` | A class named `String` / `Application` appears in the project class inventory |
| `class A : Base(), Iface` | Both go to `parentClasses`; `interfaces` is always empty (`call-graph.ts:3558-3582`) |
| `object Registry : UserRepository` | edge kind `extends`, although `UserRepository` is an interface |
| `class A(d: Iface) : Iface by d` | supertype not captured (`explicit_delegation`) |
| `val x = object : Listener { override fun on() {} }` | supertype not captured; `on` has no owner |
| `enum class Mode { A { override fun f() = 1 }; abstract fun f(): Int }` | entry bodies have no owner |
| `fun interface Op { fun run(): Int }` | parse error; `run` loses its owner (see `harden-kotlin-grammar-currency`) |
| `sealed interface Shape`, `data class`, `value class`, `annotation class`, `inner class`, `enum class` | class kind is not recorded |
| `companion object Named { fun f() }` | owner is `Named`, not the enclosing class |
| nested and local classes | owner name is the simple name, so two `Builder` classes collide |

## What changes

- **Extension receivers are not classes.** An extension function keeps its receiver type in a
  dedicated `receiverType` field. `className` is set only when the receiver is a class the project
  declares. No class record is created for a type the project does not declare.
- **Supertype kinds.** A supertype written with a constructor call is a superclass. A supertype
  that resolves to a project `interface` is an interface. A supertype that does not resolve is
  recorded as `unknown-kind` and takes part in dispatch as today.
- **Delegation** `: Iface by d` records `Iface` as an implemented interface and marks the class
  as `delegating`, so a missing override is not treated as an error by any consumer.
- **Object expressions and enum entries with bodies** are anonymous classes with a stable
  position-based name, their supertypes, and their members.
- **Class kind** is recorded from modifiers: `class`, `interface`, `fun interface`, `object`,
  `companion`, `enum`, `data`, `sealed`, `value`, `annotation`, `inner`.
- **Companion members** are owned by the enclosing class, named or not. The companion's own name
  is kept as an alias so `Outer.Named.f()` and `Outer.f()` both bind.
- **Nested classes** use a qualified owner (`Outer.Inner`).

Existing guards stay: ambiguity-skip, qualified-supertype-skip, the inferred-receiver requirement
for dispatch edges, and `CHA_FANOUT_CAP`.

## Not in scope

- Type parameters, variance, and `typealias` expansion to a class.

## Impact

- `call-graph.ts` (hierarchy facts, class records), `cha.ts`, `call-graph-types.ts`
  (`receiverType`, class kind), `docs/language-support.md` (the Kotlin row).
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: `className` of extension functions on non-project types changes from the receiver name to
  empty. Node ids must stay stable; consumers that group by `className` are checked in the PR.
