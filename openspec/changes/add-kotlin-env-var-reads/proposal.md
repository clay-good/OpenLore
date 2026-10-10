# Find environment-variable reads in Kotlin

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

`get_env_vars` lists the variables a Kotlin service reads, and `analyze_env_impact` gives the blast
radius of removing or renaming one.

## What is missing today

The env extractor scans TypeScript, JavaScript, Python, Go, and Ruby (`env-extractor.ts:90-150`).
The reference fixture reads `APP_PORT` and `DATABASE_URL` with `System.getenv`; the inventory is
empty, and `analyze_env_impact` answers "No environment variable DATABASE_URL in the inventory",
which reads as "unused". Its hint text names the five supported languages and not Kotlin.

## What changes

**Read forms** (the name must be a string literal that matches the existing `[A-Z_][A-Z0-9_]*`
rule):

| Form | Example |
|---|---|
| JDK lookup | `System.getenv("X")` |
| JDK map | `System.getenv()["X"]`, `System.getenv().get("X")`, `.getValue("X")`, `.getOrDefault("X", d)`, `.getOrElse("X") { d }` |
| dotenv-kotlin (gated on `io.github.cdimascio.dotenv`) | `dotenv["X"]`, `dotenv.get("X")`, `dotenv.get("X", d)` |
| Gradle Kotlin DSL (`.gradle.kts` only) | `providers.environmentVariable("X")` |

`.kt` and `.kts` files are scanned. A read in a `.gradle.kts` file is tagged `build-script`.

**Required or optional.** A read site is `required` unless the same expression supplies a fallback:

| Expression | Result |
|---|---|
| `System.getenv("X") ?: "8080"` | optional |
| `getOrDefault("X", d)`, `getOrElse("X") { d }`, `dotenv.get("X", d)` | optional |
| `System.getenv("X")!!`, `requireNotNull(System.getenv("X"))`, `checkNotNull(...)` | required |
| `System.getenv("X") ?: error("…")`, `?: throw …` | required |
| `System.getenv("X")` with no fallback in the expression | required |

**Enclosing function.** A read inside a function is attributed to it. A read in a property
initializer, `init` block, companion object, or top-level property is attributed to the node that
`add-kotlin-callable-node-shapes` creates for that body; until that change lands it is reported as
module-level, as other languages report it.

**Disclosure.** These are out of scope and named in the `boundaries` of `analyze_env_impact` for a
Kotlin repository: Spring property placeholders (`@Value("\${app.port}")`,
`@ConfigurationProperties`), Ktor `environment.config`, Android `BuildConfig`, and
`System.getProperty`. They are configuration keys, not environment variables, and the existing
config-key boundary covers them.

## Not in scope

- Java. `System.getenv` has the same call form, but Java fallback idioms (`Optional`, ternary) need
  their own required-or-optional rules. The read patterns are written JVM-wide so Java can adopt
  them later.
- Non-literal names (`System.getenv(prefix + "_URL")`): counted as a dynamic read, not listed.

## Impact

- `env-extractor.ts`, `mcp-handlers/env-impact.ts` (hint text and boundaries),
  `bounded-file-scan.ts`.
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: low; additive.
