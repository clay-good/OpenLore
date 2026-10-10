# Analyze exception flow in Kotlin

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`. Better with
> `add-kotlin-declared-type-receivers` and `add-kotlin-callable-node-shapes`, which give it more
> call edges to follow. Deterministic, no LLM, no new dependency.

## What you get

`analyze_error_propagation` answers for a Kotlin function: which exceptions can escape, which are
handled inside, and where the analysis stops.

## What is missing today

Kotlin is not in `ERROR_PROPAGATION_LANGUAGES` (`exception-flow.ts:37-44`). The tool returns
`unsupported: true` for a Kotlin symbol, and a Kotlin callee of a supported-language function is a
boundary. Java and C# are supported.

## What changes

Kotlin gets a language entry on the existing exception model. Kotlin has no checked exceptions, and
`throw` and `try` are expressions.

**Throw sites**

| Source | Recorded type | Kind |
|---|---|---|
| `throw IllegalArgumentException("x")` | `IllegalArgumentException` | explicit |
| `throw e` where `e` is the parameter of the enclosing `catch (e: T)` | `T` | rethrow |
| `throw` of any other expression | `<dynamic>` | explicit |
| `require(c)`, `requireNotNull(v)` | `IllegalArgumentException` | standard-library contract |
| `check(c)`, `checkNotNull(v)`, `error("m")` | `IllegalStateException` | standard-library contract |
| `TODO()` | `NotImplementedError` | standard-library contract |
| `@Throws(IOException::class)` on the function | `IOException` | declared |

A standard-library contract site is recorded only when no project function of that name is in
scope.

**Handlers**

- `try { } catch (e: T) { }` handles the exact name `T`. `Throwable` is catch-all. As for Java, a
  typed handler is an exact-name lower bound: no class hierarchy is used, and this is disclosed.
- `finally` adds the existing boundaries (abrupt finally; effects not modeled).
- `runCatching { }` and `.runCatching { }` handle everything thrown in the block, unless the same
  call chain ends in `getOrThrow()`.
- `use { }` adds the existing resource-cleanup boundary.

**Lambdas**

- A lambda passed to a function in a fixed list of standard-library inline functions (scope
  functions, `use`, `synchronized`, `repeat`, and the eager collection operations such as
  `forEach`, `map`, `filter`) is part of the enclosing function body.
- Any other lambda is a nested function. A throw inside it is not attributed to the enclosing
  function, and the count of such throws is a boundary.

**Boundaries always disclosed for Kotlin**

- Implicit runtime exceptions are not throw sites. The counts of `!!` assertions and unsafe `as`
  casts in the reachable set are reported.
- Coroutine cancellation and exceptions delivered through a `Job`, `Deferred`, or `Flow` are not
  modeled.
- An unresolved callee, an operator-convention call, and a property accessor are un-analyzed
  callees.

Kotlin is added to `ERROR_PROPAGATION_LANGUAGES` together with its fixtures. The result is a sound
lower bound, as for every other language.

## Not in scope

- Subclass matching of catch types; `Result`-typed returns as a value-shaped error model.

## Impact

- `exception-flow.ts` (Kotlin entry, standard-library contract table, inline-lambda list),
  `mcp-handlers/error-propagation.ts`, `cli/commands/error-propagation.ts` (supported list text).
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: the inline-lambda list decides attribution. It is one named constant with a test per entry.
