# Certify the public API surface of Kotlin code

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`. Depends on
> `add-kotlin-file-dependency-and-exports` and `fix-kotlin-signature-and-kdoc-fidelity`.
> Deterministic, no LLM, no new dependency.

## What you get

`certify_public_surface` lists what a Kotlin library exports and tells you when a diff breaks its
consumers. It also stops reporting an empty surface as complete.

## What is wrong today

On the reference fixture, the tool returns `surface: []`, `total: 0`, and
`confidenceBoundary: { complete: true }`. That is a false "this repository exports nothing".
`exportedNames` returns an empty set for every language except TypeScript, JavaScript, and Python
(`mcp-handlers/public-surface.ts:197-226`), and the soundness note says other languages are
"surface membership only", which is not what happens. Signature classification covers the same
three languages (`analyzer/public-surface.ts:123`). The manifest fallback lists every Kotlin
top-level function, `private` and `internal` included (`public-symbols.ts:161-167`).

## What changes

**1. An unassessed language is never "complete" (all languages).** In surface mode, when the
repository has source files in a language whose surface membership is not extracted, the result
names those languages and their file counts, and the confidence boundary is not complete.

**2. Kotlin surface membership.**

| Declaration | In the surface |
|---|---|
| top-level or member, no modifier or `public` | yes |
| `protected` member of an `open`, `abstract`, or `sealed` class | yes |
| `internal` | no, unless annotated `@PublishedApi` |
| `private`; member of a non-public class; local declaration | no |
| declaration in a test source set | no |

Members are listed as `Owner.member`. A `@JvmName` rename is listed as an alias.

**3. Kotlin signature classification.** Kotlin parameters are always typed, so most changes can be
proven:

| Change | Verdict | Rule code |
|---|---|---|
| declaration removed | breaking | `export-removed` |
| declaration renamed (identity continuity) | breaking | `export-renamed` |
| visibility reduced to `internal` or `private` | breaking | `export-visibility-reduced` |
| parameter added without a default | breaking | `param-required-added` |
| default value removed from a parameter | breaking | `param-became-required` |
| parameter removed | breaking | `param-removed` |
| parameter type changed from nullable to non-null | breaking | `param-type-narrowed` |
| return type changed from non-null to nullable | breaking | `return-nullability-widened` (new) |
| property added to a `data class` primary constructor | breaking | `data-class-shape-changed` (new) |
| parameter type changed from non-null to nullable | potentially-breaking | `jvm-binary-signature-changed` (new) |
| parameter added with a default value | potentially-breaking | `jvm-binary-signature-changed` (new) |
| new entry in an `enum` or new subtype of a `sealed` type | potentially-breaking | `exhaustive-when-may-break` (new) |
| return type changed from nullable to non-null | non-breaking | none |
| declaration added | non-breaking | `export-added` |
| anything else (reordered parameters, other type changes, `open` removed, `var` to `val`) | potentially-breaking | `signature-unprovable` |

Two Kotlin facts drive the new codes. A change can be source-compatible but binary-incompatible,
because the JVM method descriptor changes; consumers that are not recompiled fail at link time. So
`jvm-binary-signature-changed` is `potentially-breaking`, and the suggested bump is withheld, as
for every unproven change. A new enum entry or sealed subtype breaks a consumer's exhaustive
`when`.

The four new codes are registered in `FINDING_CODE_REGISTRY`, advisory by default.

**4. Manifest.** The public-symbol detector uses the Kotlin export inventory, so `private` and
`internal` functions leave the list and classes and members enter it.

## Not in scope

- Explicit API mode as a requirement; `@Deprecated` levels; `@RequiresOptIn` markers (listed in the
  surface with a tag, not classified).
- Java surface membership. Item 1 makes its absence visible.

## Impact

- `mcp-handlers/public-surface.ts`, `analyzer/public-surface.ts`, `enforcement-policy.ts` (four
  codes), `cli/manifest/detect/public-symbols.ts`.
- Specs: `mcp-handlers`, 2 ADDED requirements.
- Risk: item 1 changes the answer for every non-TS/JS/Python repository from "complete, empty" to
  "not assessed". That is the intended correction.
