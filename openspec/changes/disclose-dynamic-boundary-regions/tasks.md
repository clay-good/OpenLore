# Tasks — disclose-dynamic-boundary-regions

## Implementation

- [ ] `src/core/analyzer/dynamic-boundary.ts`: closed `DynamicBoundaryKind` vocabulary
      (`reflective-invoke` · `computed-member` · `code-eval` · `dynamic-import` ·
      `metaprogrammed-definition` · `container-resolution`) + per-language matcher tables
      (node types + callee names), exported as data so a completeness test can walk them
- [ ] Invoke the matcher from the existing Pass-1 walk (`call-graph-extract.ts` /
      `call-graph.ts`) — same tree, no second parse, mirroring the style-fingerprint tally
- [ ] Partition rule: a construct whose dispatch argument is a static literal is handed to the
      literal resolver (`resolve-literal-reflective-dispatch`) and recorded as NO site; every
      other match records a site. One matcher, two consumers, no double-count
- [ ] Attribute each site to its enclosing symbol via `findEnclosingFunction`; a construct
      outside any function records an explicit module-level marker
- [ ] Persist sites in a sidecar artifact next to `parse-health.json` (atomic write via the
      shared `atomicWriteFile`); load with the graph so no serving path adds a read
- [ ] Per-symbol `dynamicBoundaryAdjacent` lookup + per-region counts; surface repository totals
      in `openlore status`
- [ ] `mcp-handlers/reachability.ts`: dead-code candidate confidence downgrade with the site as
      the stated reason (never "not dead")
- [ ] `mcp-handlers/coverage-gaps.ts`: withhold `also-dead` when the symbol sits behind a
      boundary; keep the plain gap label
- [ ] `mcp-handlers/claim-verification.ts`: cap `dead` / `safe-to-change` at `unverifiable` when
      a boundary is in the subject's neighborhood; name the site in the receipt
- [ ] Shared in-scope disclosure helper (bounded, deduped by kind+file, truncation receipt) wired
      into `analyze_impact`, `blast_radius`, `select_tests`, `analyze_error_propagation`,
      `change_impact_certificate`
- [ ] Register `dynamic-boundary-in-conclusion-scope` in `FINDING_CODE_REGISTRY`
      (source-declared severity `info`, advisory by default)
- [ ] `get_language_support`: add a `dynamicBoundary` capability column derived from the live
      matcher tables, so an unsupported language reads as unsupported, not as "clean"

## Verification

- [ ] Per-language fixture tests: each `kind` matched in each supported language; each producing
      a site with the right enclosing symbol, file, and line
- [ ] Partition test: `send(:literal)` → edge, no site; `send(name)` → site, no edge; asserted
      over one fixture so the two paths cannot both fire or both miss
- [ ] Vocabulary-completeness test fails on a matcher emitting an undeclared `kind`
- [ ] No-second-parse guard: parse-count assertion over the Pass-1 walk is unchanged
- [ ] Byte-identical-graph test: enabling the matcher changes no node and no edge in the fixture
      corpus (sites are additive-only)
- [ ] Disclosure scoping test: a traversal over a clean subgraph in a repo with sites elsewhere
      discloses nothing; a traversal crossing a site discloses it
- [ ] Truncation-receipt test on an over-bound site set
- [ ] One-directional test: a boundary never promotes a symbol to live / tested / unsafe
- [ ] `verify_claim` test: `dead` next to a `reflective-invoke` site → `unverifiable`, receipt
      names the site
- [ ] Finding-registry test (existing all-codes-registered guard) covers the new code
- [ ] Analyze-twice determinism (existing byte-diff e2e) holds with sites written
- [ ] Full suite green; docs updated (`reachability-dead-code.md`, `language-support.md`)
