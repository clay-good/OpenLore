# Tasks — resolve-literal-reflective-dispatch

## Implementation

- [x] Matcher records literal dispatch tables as candidate facts in the Pass-1 walk (no second parse):
      stability by use, same-file declaration spans, JS property-key canonicalization, no table in a
      file that evaluates code
- [x] Literal-key table dispatches retained under a separate budget and listed after real sites
- [x] `literal-reflection.ts` resolver (Pass 7a): all-or-nothing for a variable key, `over-cap`,
      `unresolved-in-file-scope`, `unattributed-caller`; dedup against every accumulated pair
- [x] CHA exclusion set covers `literal-reflective` edges
- [x] Candidate→site discharge keyed on file + offset; bound constructs persisted as a `bound` list
- [x] Strict consumers (`find_dead_code`, `report_coverage_gaps`, `select_tests`, `analyze_impact`)
      fold the bound list back in as `synthesized-binding` sites
- [x] Tolerant reader: an unrecognised refusal keeps its file
- [x] Subset rebuild binds nothing; watcher re-derives recomputed caller files' boundary records
- [x] `literalReflection` capability derived from the matcher table (TS/JS)
- [x] `literalTargetOf` reads a literal only from a pure wrapper (no partial name from `"a_" + x`)
- [ ] ~~Container registration ↔ resolution~~ — re-scoped out (see proposal)
- [ ] ~~Self-typed receivers~~ — built, then removed after review (see proposal)
- [ ] ~~Python dict tables~~ — re-scoped out (see proposal)

## Verification

- [x] `literal-reflection.test.ts`: recovery, every refusal, instability cases, entry locality, key
      canonicalization, self receivers never binding, totality, identity, dedup, bound list, listing
      priority and exact totals, single-file lane, subset rebuild, strict fold, tolerant reader,
      strict dead code, rule-disabled additivity, file-order determinism, registry faithfulness
- [x] Related suites green: dynamic-boundary, edge-synthesis, disclosure, language-support ×2,
      capability conformance, CHA reachability, fact cache, doc-claim sync
- [x] Dogfood on four repositories: no non-synthesized edge change, byte-identical re-analysis, budgets
      and equivalence lanes green
- [ ] Watcher recompute re-derive has no dedicated integration test (covered by review, not a fixture)
