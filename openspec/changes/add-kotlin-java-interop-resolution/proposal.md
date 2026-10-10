# Resolve calls between Kotlin and Java in a mixed project

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`. Depends on
> `fix-kotlin-package-binding-soundness` and `add-kotlin-callable-node-shapes`.
> Deterministic, no LLM, no new dependency.

## What you get

In a repository with both languages, a Java call to Kotlin code and a Kotlin call to Java code
become edges. Most Kotlin adoptions are mixed, so this decides whether the graph is usable there.

## What is missing today

Java and Kotlin share one import index for classes (`import-resolver-bridge.ts:291`), so
`import com.acme.UserService` resolves both ways. The forms that differ between the two languages
do not resolve, because the Kotlin compiler renames them for the JVM:

| Java source | Kotlin target | Today |
|---|---|---|
| `MainKt.report(1)` | top-level `fun report` in `Main.kt` | no class `MainKt` exists in the index |
| `StringUtil.slugify(s)` | extension `fun String.slugify()` in a file with `@file:JvmName("StringUtil")` | unresolved |
| `UserService.Companion.audit(x)`, `UserService.audit(x)` with `@JvmStatic` | companion member | unresolved |
| `Registry.INSTANCE.load(id)` | member of `object Registry` | unresolved |
| `svc.getCount()`, `box.setLabel(v)` | property accessor | unresolved |
| `new UserService(repo)` | Kotlin constructor | external, no constructor node |

And in the other direction, Kotlin `user.name` on a Java class is a call to `getName()` with no
call syntax.

## What changes

A **JVM-name view** of Kotlin declarations, derived from syntax only, is added to the shared JVM
index. Java call resolution consults it.

| Kotlin declaration | JVM-facing name Java uses |
|---|---|
| top-level function or property in `Foo.kt` | static member of class `FooKt`, or the `@file:JvmName` value |
| extension function | the same static member, receiver as first argument |
| companion member | `Owner.Companion.member`; also `Owner.member` when `@JvmStatic`, or `@JvmField` / `const` for properties |
| `object` member | `Obj.INSTANCE.member`; also `Obj.member` when `@JvmStatic` |
| property `val x` / `var x` | `getX()` / `setX(v)`; `isX()` when the name starts with `is`; the field itself when `@JvmField` |
| declaration with `@JvmName("n")` | `n` |
| function with `@JvmOverloads` | every overload arity binds to the one Kotlin function |
| class, constructor | unchanged |

Rules:

- Unique binding or fall-through, as everywhere on the import path. Two Kotlin files named
  `Util.kt` in one package give an ambiguous `UtilKt` and bind nothing.
- An edge from this view carries the existing `import` confidence when the Java file imports or
  shares the package of the facade class.
- **Kotlin to Java.** A Kotlin call `obj.method()` on a receiver whose declared type is a Java
  class in the repository binds through `add-kotlin-declared-type-receivers`. A Kotlin property-style
  access to a Java getter (`user.name`) has no call syntax; it is not an edge, and Java getters and
  setters of classes used from Kotlin are exempt from a confident dead-code verdict.
- `@JvmSynthetic` and `internal` declarations (name-mangled) are not in the view.

## Not in scope

- Kotlin calling Java through SAM conversion or platform-type inference.
- Other JVM languages (Scala, Groovy).

## Impact

- `import-resolver-bridge.ts` (JVM-name view), Java call resolution in `call-graph.ts`,
  `reachability.ts` (getter and setter exemption).
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: accessor names (`getX`) are common in Java. They bind only through a typed or imported
  receiver, never by name alone.
