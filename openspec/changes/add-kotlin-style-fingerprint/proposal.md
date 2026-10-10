# Measure the Kotlin style fingerprint

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

`get_style_fingerprint` and the `regionStyle` summary in `orient` describe how a Kotlin codebase
writes code, so an agent's edit matches it.

## What is missing today

`STYLE_LANG_SPECS` has TypeScript, JavaScript, Python, and Go (`style-fingerprint.ts:121-148`). On
a Kotlin repository the tool answers "No style fingerprint found … supported languages: TypeScript,
JavaScript, Python, Go".

## What changes

A Kotlin entry on the existing closed idiom set. No new idiom key, no score, no lint judgment.

| Idiom key | Kotlin measurement | Choices |
|---|---|---|
| `functionForm` | body form of named functions | expression body (`= expr`) or block body |
| `binding` | local and member property declarations | `val` or `var` |
| `conditionalForm` | `if` and `when` | used as a value (expression position) or as a statement |
| `stringForm` | string building | template (`"$a"`, `"${a.b}"`) or `+` concatenation with a string literal operand |
| `functionNaming` | case of named functions | camelCase, PascalCase, snake_case, other |

Rules:

- `asyncForm` is not listed for Kotlin. The choice between `suspend` functions and callback or
  future styles is an architecture decision, not a local idiom, and no syntactic count separates
  them reliably. As for Go, an idiom that is not listed is not reported.
- Nothing is `enforced`: the Kotlin compiler does not tie any of these choices to semantics.
- For `functionForm`, a function is counted only when both forms were possible: `abstract`,
  `external`, `expect`, and interface functions without a body are skipped.
- For `functionNaming`, backtick-named functions and functions in test files are skipped, so test
  sentences do not dominate the signal.
- The existing evidence floor (`STYLE_EVIDENCE_FLOOR`) and the `below_floor` null apply unchanged.
- `.kts` Gradle build scripts are excluded from the tally; other `.kts` scripts count.
- Counters are collected during the existing AST walk. No second parse.

## Not in scope

- Kotlin-specific idioms that have no key in the closed set (null handling with `?.` / `?:` versus
  `!!`, scope-function use, named arguments). Adding a key is a separate change for all languages.

## Impact

- `style-fingerprint.ts` (Kotlin entry and walker branches), the error text that lists supported
  languages.
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: low; additive and descriptive.
