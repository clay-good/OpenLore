# Tasks — disclose-dynamic-boundary-regions

## Implementation

- [ ] `src/core/analyzer/dynamic-boundary.ts`: closed `DynamicBoundaryKind` vocabulary
      (`reflective-invoke` · `computed-member` · `code-eval` · `dynamic-import` ·
      `metaprogrammed-definition` · `container-resolution`) + per-language matcher tables
      (node types + callee names), exported as data so a completeness test can walk them
- [ ] Invoke the matcher from the existing Pass-1 walk (`call-graph-extract.ts` /
      `call-graph.ts`) — same already-parsed tree, no second parse. NOTE: extraction is
      tree-sitter Query-driven (`TS_CALL_QUERY`), and `computed-member` /
      `metaprogrammed-definition` / `dynamic-import` are NOT reachable from it — add a capture,
      never alter an existing call query (that would change edges). Measure the traversal cost;
      the style fingerprint runs its OWN whole-tree walk, so it is not a free-ride precedent
- [ ] Partition rule keyed on RESOLUTION OUTCOME, not argument form: every recognized construct
      is a candidate; a candidate the sibling resolves to exactly one internal symbol is
      retracted, and every other candidate — literal-but-unresolved, ambiguous, over-cap —
      persists as a site with its refusal reason. One matcher, two consumers, no silent hole
- [ ] Attribute each site to its enclosing symbol via `findEnclosingFunction`; a construct
      outside any function records an explicit module-level marker
- [ ] Persist sites in a sidecar artifact next to `parse-health.json` (atomic write via the
      shared `atomicWriteFile`); deterministic order (file, line, kind); absent when empty, and
      read at most once per conclusion invocation
- [ ] Per-symbol `dynamicBoundaryAdjacent` lookup + per-region counts (no `openlore status`
      surface — that command is not on `main`; PR #224 never landed)
- [ ] Sites join the Pass-1 memoized fact set: extend `FileExtractResult` + `SerializedFacts` +
      serialize/deserialize and BUMP `FACT_FORMAT_VERSION`, else every cache hit reports zero
      sites — a false "clean" disclosure
- [ ] Watcher lane for the sidecar (mirroring `updateParseHealth`): re-derive on change, drop on
      delete, create/remove the artifact at the zero-boundary transitions
- [ ] Redact credentials + neutralize terminal control sequences + truncate evidence BEFORE
      persistence (evidence is untrusted repo text that reaches artifacts, MCP responses, CLI)
- [ ] Two-phase partition: Pass-1 records candidates; finalize the sidecar AFTER the Pass-2d
      synthesis pass (`call-graph.ts:4577-4597`) retracts the resolved ones
- [ ] Ground `container-resolution` in a DI import/decorator/declared API — NOT a bare callee
      name (`.get(` alone matches 666 non-test call sites in this repo)
- [ ] MCP ↔ Pi parity (CLAUDE.md): mirror the new crossing in `src/pi/extension.ts` or record the
      skip and its reason; `src/pi/extension.test.ts` guards both directions
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
- [ ] Extend the ENUMERATED finding-code test (no generic all-codes guard exists) — and register
      with `defaultClass: 'advisory'`, which `enforcement-policy.test.ts:57-61` asserts for every
      code; the `info` severity rides the emitted finding, not the registry entry
- [ ] Density-budget test: sites per thousand lines within the declared ceiling on the self-index
      and each language fixture; a matcher over the ceiling fails rather than ships
- [ ] Fact-cache test: a fully-cached re-analyze reports identical sites (never zero)
- [ ] Watcher test: a newly-added `eval` is disclosed without a full re-analyze; removing it
      clears the disclosure
- [ ] Evidence-safety test: an API-key-shaped literal and an ANSI sequence survive neither into
      the artifact nor into CLI output
- [ ] Analyze-twice determinism (existing byte-diff e2e) holds with sites written
- [ ] Full suite green; docs updated (`reachability-dead-code.md`, `language-support.md`)
