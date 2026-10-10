# Stop Kotlin calls binding to the wrong function at `import` confidence

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`. **Do this
> first**: it removes edges that are wrong today, and every later Kotlin change builds on the index
> it repairs. Deterministic, no LLM, no new dependency.

## What you get

Kotlin call edges labeled `import` become trustworthy, and imported top-level functions, extension
functions, and wildcard imports start to resolve.

## What is wrong today

Observed on the reference fixture (built CLI 3.3.0, see the index document):

| Source | Edge recorded today | Correct result |
|---|---|---|
| `this.service.create(name)` inside `UserController.create` | `UserController.create` → itself, `import` | `UserService.create` (or no edge) |
| `client.get("http://…")` where `client: HttpClient` | → `UserController.get`, `import` | external (Ktor client) |
| `get("/health") { … }` inside a Ktor `routing` block | → `UserController.get`, `name_only` | external (Ktor DSL) |
| `"name".slugify()` with `import com.acme.util.slugify` | `name_only` in one file, `external` in another | `import` in both |

Root cause, all in `src/core/analyzer/import-resolver-bridge.ts`:

- The Kotlin package index matches `^[ \t]*fun name(` (`:303`). It accepts **indented member
  functions** as if they were package-level, and it misses every top-level function that has a
  modifier, a type parameter, or an extension receiver (`private fun`, `suspend fun`, `fun <T> f(`,
  `fun String.slugify(`).
- Every symbol in the caller's own package is bound by bare name (`:340-345`), and the call site's
  receiver is not consulted. So a member-shaped call `x.get()` binds to any same-package member
  named `get`.
- `declaredTypes` indexes `enum class Color` under the name `class`.
- `import a.b.*` parses to the FQN `a.b.` and never binds. Kotlin default imports are not modeled.
- Top-level properties and type aliases are not indexed.

## What changes

1. **Index only what the package really declares.** The Kotlin package index is built from the
   parse tree (top-level `function_declaration`, `property_declaration`, `class_declaration`,
   `object_declaration`, `type_alias`), not from a line regex. Members stay out. Extension functions
   are indexed with their receiver type.
2. **A call with a receiver never binds through the package-function index.** A package-level
   function binds only a receiverless call. An extension function binds a receiver call only when
   the name is in scope by import or same package, and the binding is unique.
3. **Imports cover the full Kotlin form.** Plain, aliased (`as`), wildcard (`a.b.*`), top-level
   function, top-level property, extension function, and nested-type imports. Explicit imports win
   over wildcard imports, which win over same-package, as the language specifies.
4. **Default imports are known, not guessed.** Names from the Kotlin default-import packages
   (`kotlin.*`, `kotlin.annotation.*`, `kotlin.collections.*`, `kotlin.comparisons.*`, `kotlin.io.*`,
   `kotlin.ranges.*`, `kotlin.sequences.*`, `kotlin.text.*`, `java.lang.*`, `kotlin.jvm.*`) are
   external. A project symbol with the same simple name binds only when the file imports it or
   shares its package.
5. **Unique binding or fall-through** stays the rule. Nothing on this path guesses.

## Not in scope

- Typing the receiver (`service`, `client`): `add-kotlin-declared-type-receivers`.
- Constructor calls: `add-kotlin-callable-node-shapes`.
- The file-level import graph: `add-kotlin-file-dependency-and-exports`.

## Impact

- `import-resolver-bridge.ts` (Kotlin index + binder), `call-graph.ts` (receiver check before the
  package-function lookup), conformance fixtures.
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: some edges that resolve today will disappear. Each removed edge must be shown wrong in the
  PR's before/after structural diff.
