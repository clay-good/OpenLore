# Dogfood: `find_clones` on the OpenLore repo (2026-06-26)

Ran the built CLI (`node dist/cli/index.js find-clones`) against OpenLore's own analyzed index
(6,489 call-graph nodes; 2,429 comparable functions). End-to-end, no API key, deterministic.

## Symbol mode — found more than the whole-repo report

```
$ openlore find-clones --symbol getPyParser
   query: symbol getPyParser::src/core/analyzer/call-graph.ts (lines 544-554)
   compared against 2429 functions · floor 0.7 · 10 matches (exact 0, structural 7, near 3)
     structural 1.00  getRustParser  …:568-578     near 0.73  getTSParser   …:532-542
     structural 1.00  getRubyParser  …:580-590     near 0.73  getPhpParser  …:604-614
     … (5 more structural)                          near 0.73  getScalaParser …:640-650
```

Two things to note:
- The query's own instance (`getPyParser`) is correctly excluded — only *other* clones are returned.
- It surfaced **3 near-clones** (`getTSParser`, `getPhpParser`, `getScalaParser`) that the whole-repo
  `get_duplicate_report` grouped separately/under a different representative. The one-vs-all O(n) query
  is the value: it ranks *everything similar to this one symbol*, not just the group it landed in.

## Snippet mode — the pre-write question the whole-repo report cannot answer

Pasted the verbatim body of `getRustParser` as a snippet (simulating "I'm about to write this"):

```
$ openlore find-clones --snippet "<getRustParser body>"
   query: snippet (11 lines)
   compared against 2430 functions · floor 0.7 · 5 matches (exact 1, structural 4, near 0)
     exact      1.00  getRustParser  …:568-578
     structural 1.00  getPyParser / getRubyParser / getJavaParser / getKotlinParser
```

It found the existing `getRustParser` (exact) plus the structural siblings — i.e. "this already exists,
reuse it." `get_duplicate_report` structurally cannot do this (the snippet is not indexed).

## Honesty paths (all verified)

- **not-found**: `--symbol getPyParserNope` → explicit "No indexed function matching …" + hint, never an
  empty "unique".
- **ambiguous**: `--symbol createTempDir` → "ambiguous — matches 17 functions. Pass name::path." with the
  candidate list.
- **below-threshold**: `--snippet 'const x = 1;'` → "too small to compare", not "no clones".
- **JSON**: conclusion shape only (query, similarityFloor, summary, ranked matches, note) — no graph dump.

## Bug found and fixed by dogfooding

The first run reported **"3129 HTML inline-script symbol(s) excluded from comparison"** — but this repo
has **zero** HTML nodes. The 3,129 were external/synthesized symbols with no extractable body
(`startIndex >= endIndex`), which the handler had conflated with the HTML exclusion in one subtraction
(`allNodes.length - comparableNodes.length`). That is exactly the kind of dishonest disclosure the north
star forbids. Fixed: `htmlExcluded` now counts **only** actual `.html`/`.htm` nodes; the bodyless
external/synthesized nodes are dropped silently (correctly — there is nothing to compare), and the HTML
note clause is emitted only when `htmlExcluded > 0`. Re-ran: the false HTML line is gone.

## Tests

`npx vitest run src examples` → **270 files, 5308 passed, 2 skipped**. New tests: 13 for the
`findClones` primitive + the handler (`duplicate-detector.test.ts`, `clone-query.test.ts`), plus the
full-surface-only preset guard and the bumped payload-budget ceiling (78k → 81k for the new schema).
