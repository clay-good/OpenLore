# Model `when`, `try`, `do-while`, and null-safe operators in the Kotlin control-flow overlay

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

Kotlin control-flow graphs reflect the branches the code has.

## What is missing today

The Kotlin CFG entry maps `if`, `while`, `for`, and jumps (`cfg.ts:508-548`). Its `tryTypes` and
`switchTypes` are empty, with a comment that catch and finally are not modeled.

| Kotlin construct | Today |
|---|---|
| `when (x) { … }`, subject-less `when { … }` | straight-line code |
| `try { } catch (e: E) { } finally { }` | straight-line code |
| `do { } while (c)` | straight-line code |
| `a ?: b`, `a ?: return`, `a ?: throw X()` | no branch; an early exit is invisible |
| `a?.b()` | no branch |
| `x += 1`, `i++` | not definitions (`augAssignTypes`, `updateTypes` empty) |
| `val v = if (c) a else b` | the whole function gets **no CFG** (`cfg.ts:2125-2130`) |
| `return@label`, `break@label`, `continue@label` | not checked |

Java maps `do`, `try`, try-with-resources, and `switch`.

## What changes

- `when` is a multi-way branch. Each entry is an arm; several conditions on one entry
  (`1, 2 ->`) are one arm; `else` is the default; a `when` with no `else` has a fall-through exit.
- `try` gets the same region model Java has: the protected body, one handler per `catch`, and a
  `finally` block that every exit passes through.
- `do-while` is a loop whose body runs before the test.
- The Elvis operator is a two-way branch. When its right side is `return`, `throw`, `break`, or
  `continue`, that side is an exit edge.
- A safe call is a two-way branch that skips the call.
- Compound assignment and increment or decrement are definitions and uses.
- Expression-form `if`, `when`, and `try` are modeled wherever they appear, including as an
  initializer, an argument, or a function expression body. A function is never left without an
  overlay because one of them is in expression position.
- Labeled jumps go to their labeled target. `return@label` inside a lambda exits the lambda, not
  the enclosing function.
- Complexity is unchanged. No language counts its null-coalescing or optional-chaining operator
  today (`call-graph-complexity.ts:11-23`), so `?:` and `?.` stay uncounted for parity. The
  existing `when` arm counter must agree with the number of arms the overlay builds.

Fail-soft is unchanged: a construct the builder does not know yields no overlay for that function,
never a wrong one.

## Not in scope

- Coroutine suspension points as control-flow edges.
- Exhaustiveness of `when`.

## Impact

- `cfg.ts` (Kotlin entry and expression-position handling).
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: overlay shape changes for most Kotlin functions; the def-use and reaching-definition
  consumers are re-verified on the reference corpus.
