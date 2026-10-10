# Report Kotlin signatures and KDoc correctly

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

`orient`, `search_code`, skeletons, and generated specs show the real declaration and the author's
documentation for a Kotlin function.

## What is wrong today

| Kotlin source | Today |
|---|---|
| `/** Computes a thing. */ fun documented(x: Int): Int` | no docstring. The query-spec path never sets one (`call-graph.ts:2926-2934`); `extractDocstringBefore` has no Kotlin branch (`call-graph-extract.ts:71-74`) |
| `@GetMapping("/{id}") fun get(id: String): String = …` | signature stored as `@GetMapping("/` (cut at the first `{`) |
| `fun risky(): Int = runCatching { repo.size() }.getOrElse { … }` | signature stored as `fun risky(): Int = runCatching` (body leaks in) |
| `protected inline fun <reified T> load(): T` | missed by the signature extractor: its regex accepts six modifiers and no type parameters (`signature-extractor.ts:878-881`) |
| `enum class`, `value class`, `annotation class`, `typealias`, properties, constructors | no signature entry |
| stored signature | ends at `(`, so parameters and return type are missing |
| `let`, `run`, `apply`, `also`, `with`, `listOf`, `require`, `println` … | each call is an external leaf; only seven JVM names are filtered (`call-graph-builtins.ts:60-62`) |

Java has a dedicated declaration parser and Javadoc extraction.

## What changes

- **Signatures come from the parse tree.** The stored signature is the declaration from its first
  modifier or annotation to the end of the return type (or the parameter list when no return type
  is written). It never includes a body, for block or expression bodies. Annotations are kept, one
  space-normalized line each.
- **Structured fields.** Parameters (name, type, has-default, `vararg`), return type, type
  parameters, visibility (`public` by default, `internal`, `protected`, `private`), and modifiers
  (`suspend`, `inline`, `operator`, `infix`, `tailrec`, `override`, `open`, `abstract`, `expect`,
  `actual`, `external`).
- **Signature inventory** covers functions, constructors, properties, classes of every kind, and
  type aliases.
- **KDoc** immediately before a declaration is its docstring, after any annotations. The summary
  is the text before the first blank line or block tag; `@param`, `@return`, `@throws`,
  `@receiver`, `@property`, `@see`, `@sample` are kept as tags. A `//` line comment is not a
  docstring.
- **Standard-library call noise.** Scope functions and common standard-library calls from the
  default-import packages are filtered from external leaves through the existing ignore mechanism.
  The list is one named constant. A project function with the same name that is in scope still
  binds (see `fix-kotlin-package-binding-soundness`).

## Not in scope

- Rendering KDoc markup or resolving `[links]`.
- Inferring a return type that the author did not write.

## Impact

- `call-graph.ts` / Kotlin extractor, `call-graph-extract.ts`, `signature-extractor.ts`,
  `call-graph-builtins.ts`.
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: signature text changes for every Kotlin node, so content-derived caches for Kotlin files
  are invalidated once.
