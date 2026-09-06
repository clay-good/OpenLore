# Tasks — disclose-dynamic-boundary-regions

## Implementation

- [x] `src/core/analyzer/dynamic-boundary.ts`: closed `DynamicBoundaryKind` vocabulary
      (`reflective-invoke` · `computed-member` · `code-eval` · `dynamic-import` ·
      `metaprogrammed-definition` · `container-resolution`) + per-language matcher tables
      (node types + callee names), exported as data so a completeness test can walk them
- [x] Invoke the matcher from the existing Pass-1 walk (`call-graph-extract.ts` /
      `call-graph.ts`) — same already-parsed tree, no second parse. NOTE: extraction is
      tree-sitter Query-driven (`TS_CALL_QUERY`), and `computed-member` /
      `metaprogrammed-definition` / `dynamic-import` are NOT reachable from it — add a capture,
      never alter an existing call query (that would change edges). Measure the traversal cost;
      the style fingerprint runs its OWN whole-tree walk, so it is not a free-ride precedent
- [x] Partition rule keyed on RESOLUTION OUTCOME, not argument form: every recognized construct
      is a candidate; a candidate the sibling resolves to exactly one internal symbol is
      retracted, and every other candidate — literal-but-unresolved, ambiguous, over-cap —
      persists as a site with its refusal reason. One matcher, two consumers, no silent hole
- [x] Attribute each site to its enclosing symbol via `findEnclosingFunction`; a construct
      outside any function records an explicit module-level marker
- [x] Persist sites in a sidecar artifact next to `parse-health.json` (atomic write via the
      shared `atomicWriteFile`); deterministic order (file, line, kind); absent when empty, and
      read at most once per conclusion invocation
- [x] Adjacency lookup + rollup counts — built at FILE granularity (`buildQualifier`) rather than
      as a per-symbol `dynamicBoundaryAdjacent` flag: that is the granularity the negative-verdict
      rules consume, and a per-symbol flag would have been a second index nothing reads. Per-kind
      and per-language counts ride the artifact. No `openlore status` surface — that command is not
      on `main`; PR #224 never landed
- [x] Sites join the Pass-1 memoized fact set: extend `FileExtractResult` + `SerializedFacts` +
      serialize/deserialize and BUMP `FACT_FORMAT_VERSION`, else every cache hit reports zero
      sites — a false "clean" disclosure
- [x] Watcher lane for the sidecar (mirroring `updateParseHealth`): re-derive on change, drop on
      delete, create/remove the artifact at the zero-boundary transitions
- [x] Redact credentials + neutralize terminal control sequences + truncate evidence BEFORE
      persistence (evidence is untrusted repo text that reaches artifacts, MCP responses, CLI)
- [x] Two-phase partition: Pass-1 records candidates; finalize the sidecar AFTER the Pass-2d
      synthesis pass (`call-graph.ts:4577-4597`) retracts the resolved ones
- [x] Ground `container-resolution` in a DI import/decorator/declared API — NOT a bare callee
      name (`.get(` alone matches 666 non-test call sites in this repo)
- [x] MCP ↔ Pi parity (CLAUDE.md): SKIPPED, deliberately. The guard covers tool NAMES and INPUT
      schemas, not response fields, and the daemon result is forwarded verbatim to the model
      (`extension.ts` `JSON.stringify(result)`), so the new crossing reaches Pi with no mirroring.
      No tool, preset, or input changed, and `extension.test.ts` passes unchanged in both directions
- [x] `mcp-handlers/reachability.ts`: dead-code candidate confidence downgrade with the site as
      the stated reason (never "not dead")
- [x] `mcp-handlers/coverage-gaps.ts`: withhold `also-dead` when the symbol sits behind a
      boundary; keep the plain gap label
- [x] `mcp-handlers/claim-verification.ts`: cap `dead` / `safe-to-change` at `unverifiable` when
      a boundary is in the subject's neighborhood; name the site in the receipt
- [x] Shared in-scope disclosure helper (bounded, deduped by kind+file, truncation receipt) wired
      into `analyze_impact`, `blast_radius`, `select_tests`, `analyze_error_propagation`,
      `change_impact_certificate`
- [x] Register `dynamic-boundary-in-conclusion-scope` in `FINDING_CODE_REGISTRY`
      (source-declared severity `info`, advisory by default)
- [x] `get_language_support`: add a `dynamicBoundary` capability column derived from the live
      matcher tables, so an unsupported language reads as unsupported, not as "clean"

## Verification

- [x] Per-language fixture tests: each `kind` matched in each supported language; each producing
      a site with the right enclosing symbol, file, and line
- [x] Partition test: `send(:literal)` → edge, no site; `send(name)` → site, no edge; asserted
      over one fixture so the two paths cannot both fire or both miss
- [x] Vocabulary-completeness test fails on a matcher emitting an undeclared `kind`
- [x] No-second-parse guard: parse-count assertion over the Pass-1 walk is unchanged
- [x] Byte-identical-graph test: enabling the matcher changes no node and no edge in the fixture
      corpus (sites are additive-only)
- [x] Disclosure scoping test: a traversal over a clean subgraph in a repo with sites elsewhere
      discloses nothing; a traversal crossing a site discloses it
- [x] Truncation-receipt test on an over-bound site set
- [x] One-directional test: a boundary never promotes a symbol to live / tested / unsafe
- [x] `verify_claim` test: `dead` next to a `reflective-invoke` site → `unverifiable`, receipt
      names the site
- [x] Extend the ENUMERATED finding-code test (no generic all-codes guard exists) — and register
      with `defaultClass: 'advisory'`, which `enforcement-policy.test.ts:57-61` asserts for every
      code; the `info` severity rides the emitted finding, not the registry entry
- [x] Density-budget test: sites per thousand lines within the declared ceiling on each language
      fixture; a matcher over the ceiling fails rather than ships. The SELF-INDEX figure is measured
      by running `openlore analyze` rather than asserted in the suite (a full analyze is too slow
      for a unit test): the matcher's first version recorded 37 sites here, two dogfooding fixes
      took it to 2, and both survivors are genuine dispatch tables
- [x] Fact-cache test: a fully-cached re-analyze reports identical sites (never zero)
- [x] Watcher test: a newly-added `eval` is disclosed without a full re-analyze; removing it
      clears the disclosure
- [x] Evidence-safety test: an API-key-shaped literal and an ANSI sequence survive neither into
      the artifact nor into CLI output
- [x] Analyze-twice determinism (existing byte-diff e2e) holds with sites written
- [x] Full suite green; docs updated (`reachability-dead-code.md`, `language-support.md`)
