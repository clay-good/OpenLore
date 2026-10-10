# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinControlFlowOverlayCoversBranchingExpressions

The Kotlin control-flow overlay SHALL model `when` as a multi-way branch with one arm per entry and
a fall-through exit when there is no `else`, `try` with a handler region per `catch` and a
`finally` region on every exit, `do-while` as a post-test loop, the Elvis operator as a two-way
branch whose right side is an exit edge when it is a jump, and a safe call as a two-way branch that
skips the call. Compound assignments and increment or decrement expressions SHALL be recorded as
definitions and uses. `if`, `when`, and `try` SHALL be modeled in expression position, and a
function SHALL NOT be left without an overlay because one of them appears as an initializer,
argument, or expression body. Labeled jumps SHALL target their label, and a labeled return inside a
lambda SHALL exit the lambda only. The number of `when` arms counted by Kotlin complexity SHALL
equal the number of arms in the overlay. A construct the builder does not recognize SHALL yield no overlay for that function.

#### Scenario: A when expression branches

- **GIVEN** a Kotlin function whose body is `when (x) { 1, 2 -> a(); 3 -> b(); else -> c() }`
- **WHEN** the overlay is built
- **THEN** the graph has one multi-way branch with three arms

#### Scenario: A try expression has handler and finally regions

- **GIVEN** `return try { load() } catch (e: IllegalStateException) { null } finally { audit() }`
- **WHEN** the overlay is built
- **THEN** the protected body, one handler, and a finally block exist
- **AND** every exit path passes through the finally block

#### Scenario: An Elvis jump is an exit

- **GIVEN** `val u = find(id) ?: return null`
- **WHEN** the overlay is built
- **THEN** the right side of the Elvis operator is an edge to the function exit

#### Scenario: An expression-position if still produces an overlay

- **GIVEN** a function that contains `val v = if (c) a() else b()`
- **WHEN** the overlay is built
- **THEN** the function has an overlay with one two-way branch

#### Scenario: A labeled return leaves only the lambda

- **GIVEN** `items.forEach { if (it.bad) return@forEach; use(it) }`
- **WHEN** the overlay is built
- **THEN** the labeled return targets the end of the lambda, not the function exit

#### Scenario: Complexity and overlay agree on when arms

- **GIVEN** a function with a `when` that has three non-default arms and an `else`
- **WHEN** complexity and the overlay are computed
- **THEN** complexity counts three arms and the overlay has three non-default arms
