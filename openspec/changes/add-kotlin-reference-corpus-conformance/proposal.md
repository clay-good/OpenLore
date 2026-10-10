# A Kotlin reference project that proves each capability, change by change

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`. **Land this
> with the first change**: it is the test oracle for all the others. No LLM, no new dependency.

## What you get

One place that says, with a passing test, what OpenLore does for Kotlin. "Total Kotlin support"
becomes a checked list, not a claim.

## What is missing today

- The only Kotlin fixture is one file (`src/core/analyzer/fixtures/kotlin/App.kt`). Capability
  tests assert that the extractor produces *something* for Kotlin; they do not assert that the
  result is right for realistic code.
- The defects found for issue #546 (wrong `import` edges, missed constructor and injected-property
  calls, empty routes, schema, env, and import graph) were found by analyzing a small realistic
  project by hand. No test would have caught them.
- The live-data harness has no Kotlin repository
  (`mcp-handlers/live-data/fixture-repos.ts:125`, a TODO).

## What changes

**1. A reference project** under `src/core/analyzer/fixtures/kotlin-reference/`: a small,
realistic Gradle Kotlin project. It contains the shapes each change in this set targets: a Spring
controller, a Ktor module and client, a service with constructor injection, a repository interface
with two implementations, a JPA entity and an Exposed table, extension and infix functions, a
companion object, `init` blocks and accessors, callable references, `try` / `when` / Elvis control
flow, environment reads, reflection, a JUnit test and a Kotest spec, a multiplatform
`expect` / `actual` pair, and a Gradle Kotlin build script.

**2. An expectations ledger.** One checked-in data file lists every expected fact about the
project (a node, an edge with its confidence, a route, a schema, a root, an escape, and each
*absent* wrong edge). Each entry has a state:

| State | Meaning | Test behavior |
|---|---|---|
| `asserted` | OpenLore does this | must hold |
| `known-gap` | not yet; names the change that will fix it | must **not** hold; if it starts to hold, the test fails until the entry is promoted |

The ledger starts with today's behavior. Each later change promotes its entries in the same pull
request. A promoted entry can never silently regress, and a gap can never silently close without
the ledger saying so.

**3. A capability target for Kotlin.** A test asserts the Kotlin row of the language-support
registry against a declared target. When the set is complete, the target is every capability
except `iacProjection` (not a general-purpose-language capability) and `literalReflection`
(deliberately unbacked, see `add-kotlin-dynamic-boundary`). Until then, the target lists the
capabilities still missing, by change name.

**4. Real repositories.** The live-data harness gains pinned Kotlin repositories: one Spring Boot
service, one Ktor service, one Android application, and one Multiplatform library. They are not a
CI gate (as today); each Kotlin pull request reports its before/after counts from them.

**5. Documentation.** `docs/language-support.md` gets a Kotlin section generated from the ledger:
what is supported, what is a known gap, and what is out of scope with the reason. The doc-claim
sync guard covers it. The README language line links to it.

**6. Closing the issue.** Issue #546 is closed when the ledger has no `known-gap` entry and the
capability target has no missing capability.

## Not in scope

- Compiling or running the reference project. It is parsed, not built, so it needs no JDK or
  Gradle in CI.

## Impact

- New fixture project and ledger, one conformance test, `fixture-repos.ts`, documentation.
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: the ledger is the contract, so a wrong expectation becomes a wrong requirement. Every
  expectation is derived from Kotlin language rules, not from current output.
