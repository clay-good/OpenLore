# ADR-0035: Keep tree-sitter-kotlin 0.3.8 and normalize three stable constructs before parsing

## Status

accepted

**Domains**: analyzer

## Context

Issue #546 asks for total Kotlin support. The pinned grammar, `tree-sitter-kotlin` 0.3.8 (2024-08),
reports a syntax error on four constructs that are stable at the declared language level, Kotlin
2.2: `fun interface`, the `..<` range operator, guard conditions in `when`, and multi-dollar string
interpolation. The change `harden-kotlin-grammar-currency` requires a recorded comparison of the
candidates before the grammar dependency changes.

Candidates, measured on 2026-10-10 against the syntax corpus (`fixtures/kotlin-syntax/`, 26 files)
and the reference project (`fixtures/kotlin-reference/`, 19 Kotlin files), 45 files in total:

| Criterion | `tree-sitter-kotlin` 0.3.8 (pinned) | `@tree-sitter-grammars/tree-sitter-kotlin` 1.1.0 |
|---|---|---|
| Files with a syntax error | 4 of 45 | 8 of 45 |
| Corpus features that fail | `fun interface`, `..<`, `when` guards, multi-dollar strings | `when` guards, multi-dollar strings, and six files that are clean today (classes, soft keywords, delegation, object expressions, sealed and value classes, underscore type argument) |
| Parse-tree shape | the shape every Kotlin query in `call-graph.ts` is written for | a different rule set; every Kotlin query, the control-flow overlay, and the type-event collector must be rewritten |
| Runtime compatibility | loads under the pinned `tree-sitter` 0.25.1 | loads under `tree-sitter` 0.25.1 (declares peer `^0.22.4`) |
| Platform coverage | builds from source at install (no prebuilt binaries) | prebuilt for darwin, linux, and win32 on x64 and arm64, plus a WASM build |
| Supply chain | one maintainer (fwcd); last release 2024-08 | the `tree-sitter-grammars` organization, the same publisher as the pinned Lua grammar; last release 2025-10 |

The candidate is better on platform coverage and release cadence. It is worse on the criterion
that decides correctness: it fails more of the corpus, including constructs that are in ordinary
Kotlin code (one-line class bodies with members, `by` delegation, object expressions).

## Decision

The analyzer SHALL keep `tree-sitter-kotlin` 0.3.8 as the Kotlin grammar. Before a Kotlin file is
parsed, the analyzer SHALL apply a length-preserving normalization (`normalizeKotlinForParse`) that
rewrites `fun interface` to `interface`, `..<` to `..`, and a multi-dollar string prefix to spaces,
in code only and never inside a comment or a string. Guard conditions in `when` SHALL stay a listed
known gap: the file is reported by parse-health and its other declarations are still extracted.

## Consequences

Three of the four stable constructs parse clean with no dependency change, and every node offset
still indexes the original source. One known gap remains at the declared level. The syntax corpus
test fails when that gap parses clean, so the table cannot go stale, and it is the before/after
measure for the next grammar comparison. A functional interface is parsed as an ordinary interface;
its functional-interface kind is read from the source text by the class model, not from the tree.
The comparison is repeated when either grammar publishes a release.

> Recorded for change harden-kotlin-grammar-currency on 2026-10-10
