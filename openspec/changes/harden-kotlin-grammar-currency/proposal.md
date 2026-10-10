# Keep the Kotlin grammar current with the language, and measure it

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`. No LLM.
> May change one optional dependency after a recorded decision.

## What you get

Modern Kotlin syntax parses. Where it does not, the gap is listed by name, tested, and visible in
the documentation.

## What is wrong today

The Kotlin grammar is `tree-sitter-kotlin@0.3.8` (`package.json:215`), last published
2024-08-03. Probing it with one-line samples:

| Syntax | Kotlin version | Parses |
|---|---|---|
| `fun interface Op { fun run(): Int }` | 1.4 | **error** |
| `for (i in 0..<3)` | 1.9 | **error** |
| `when (x) { is Int if x > 0 -> … }` (guard) | 2.2 | **error** |
| `$$"a $$x"` (multi-dollar interpolation) | 2.2 | **error** |
| `context(l: Logger) fun f()` (context parameters) | 2.2 preview | **error** |
| explicit backing field | preview | **error** |
| `data object`, `value class`, `sealed interface`, definitely-non-null `T & Any`, context receivers | 1.5–1.9 | ok |

On an error, tree-sitter recovers and parse-health reports the file as degraded, which is honest.
But recovery loses structure: in the `fun interface` case the function `run` is extracted with no
owner. A file with a `fun interface` is ordinary Kotlin, so this is common.

A maintained grammar exists, `@tree-sitter-grammars/tree-sitter-kotlin` (1.1.0, published
2025-10-07, prebuilt for six platforms). Its node names differ (`import` / `qualified_identifier` /
`identifier` instead of `import_header` / `simple_identifier`), so adopting it means rewriting
every Kotlin query. A first probe under the current runtime was not conclusive, because the package
declares a different `tree-sitter` peer range. The choice needs a measured evaluation, not an
assumption.

## What changes

**1. A Kotlin syntax corpus.** A checked-in fixture set with one small file per language feature,
labeled with the Kotlin version that made it stable. A test parses each file and records `clean` or
`error`.

**2. A declared language level.** A single constant states the Kotlin language version OpenLore
supports. Every stable feature up to that level parses clean, or is in a known-gaps table. The test
fails when a feature is neither. A known gap that starts to parse clean also fails the test until
it is removed from the table, so the table cannot go stale.

**3. Known gaps degrade safely.** For each known gap, a test asserts the degraded behavior:
functions outside the error region are extracted with their correct owners, and the file is in
parse-health.

**4. The matrix is published.** `docs/language-support.md` gets a "Kotlin syntax coverage" table
generated from the corpus results, and a doc-sync guard keeps it equal to the test's data.

**5. Grammar selection is a recorded decision.** Before the dependency changes, a decision record
compares the candidates on the corpus pass rate, a parse-tree comparison on a real repository,
runtime ABI compatibility, prebuilt platform coverage, and the supply-chain criteria already used
for the Dart and Lua grammars (maintainers, provenance, release cadence). The target is that the
declared language level has no known gaps. If no candidate meets it, the gaps stay listed and the
decision says so.

## Not in scope

- Preview or experimental Kotlin features above the declared level; they are listed, not required.
- Writing or forking a grammar.

## Impact

- `src/core/analyzer/fixtures/kotlin-syntax/` (new corpus), a corpus test, `docs/language-support.md`,
  possibly `package.json` and every Kotlin query if the grammar changes.
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: a grammar swap touches every Kotlin extractor. It lands after the reference corpus exists
  (`add-kotlin-reference-corpus-conformance`), so the swap is checked by a before/after graph diff.
