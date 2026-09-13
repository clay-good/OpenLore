# Test-selection safeguard tiers: always-select rules, flakiness disclosure, and a structural-confidence qualifier

> Status: BUILT (2026-09-12), with the flakiness history reader deferred — see *Scope as built*.
> Originally PROPOSED (2026-07-03, e2e audit pass 3). `select_tests` selects only by backward
> reachability from changed symbols — it can miss a test whose own file changed, gives a brand-new
> test no special standing, says nothing about historically flaky tests, and states its
> confidence boundary only at the response level. Industrial test-impact products (Develocity
> Predictive Test Selection, Datadog TIA) keep exactly these safeguards deterministic even where
> the core is ML. Add the deterministic tiers, each with a per-test reason receipt.

## The gap

`select_tests` (`src/core/services/mcp-handlers/test-impact.ts`) already git-diffs against a base
ref (`:114-126`) and walks the graph backward, ranking each selected test with a `confidence`
(`:54`, `:198`, `:209`) and a low-confidence sibling-file fallback (`:214`, `:255`). But:

- A test whose OWN file changed is selected only if reachability happens to reach it, and carries
  no "your test changed" labeling; a test file NEW since the base ref (no history at all) gets no
  standing either. Both are the canonical always-select overrides that Develocity's Predictive
  Test Selection hard-wires and Datadog TIA encodes as skip-rule safeguards
  (https://docs.gradle.com/develocity/2026.1/using-develocity/predictive-test-selection/ ,
  https://docs.datadoghq.com/tests/test_impact_analysis/how_it_works/) — deterministic even in
  ML products, because missing them is unrecoverable.
- Selected tests carry a `confidence` but no selection REASON — the receipt an agent needs to
  explain "why run this".
- Flakiness is invisible: a selected test that fails tells the agent nothing about whether the
  failure is signal.
- The response carries one `confidenceBoundary` computed from `edgeBasisWithinSet` over the
  impacted set (`:264-265`, `:290`) — but a selection resting on synthesized/heuristic edges is
  not distinguishable per test from one resting on direct resolution.

## What changes

1. **Always-select tiers, all git-derived and local.** Three tiers, unioned with reachability:
   (i) tests whose own file changed since the base ref, (ii) test files new since the base ref,
   (iii) tests reaching a changed symbol (the existing mechanism). Every selected test carries a
   `reason` receipt — "included: test file itself changed", "included: new test",
   "included: reaches changed symbol at depth N" — beside the existing `confidence` field. The
   changed-file set is already computed (`getChangedFiles`, `:123-126`); the tiers reuse it, no
   second diff.
2. **Rule-based flakiness disclosure (NOT auto-quarantine).** Where a local history source
   exists — JUnit XML artifacts, or `gh run` history via the established `gh` shell-out precedent
   (`interference-map.ts:592-621`, including its fail-soft `gh --version` probe, `:621`) —
   classify a test FLAKY iff runs at identical tree-hash inputs produced differing outcomes (the
   Develocity flaky-detection rule). Surface as a per-test disclosure ("historically flaky at
   identical inputs"), advisory only; when no history source exists, the absence is disclosed,
   never guessed. No quarantining, no ML, no retry policy.
3. **Per-selection structural-confidence qualifier.** Extend the existing `edgeBasisWithinSet`
   machinery (`:264-265`) from one response-level boundary to a per-test qualifier: a selection
   whose reaching path traverses synthesized/heuristic edges is labeled so, using only the
   existing edge-provenance labels — no new scoring constants, no blended score.

Cross-reference sibling: `add-coverage-map-test-selection` is the opt-in dynamic-trace PRECISION
layer (coverage-artifact ingestion, dual-set output); this change is the deterministic SAFETY
layer on the static side. Neither duplicates the other's mechanism: no coverage artifact is read
here, and the safeguard tiers apply regardless of whether a coverage artifact is supplied there.

## Scope as built

- **Built:** the three tiers (including untracked new test files via the hardened git helper), a
  per-test `reason` with `alsoIncludedBecause`, a per-test `structuralBasis` qualifier from the pair
  edge index, and a `flakiness: { assessed: false }` disclosure. A diff touching only test files now
  selects them instead of returning "no changed production functions".
- **Deferred:** the flakiness history reader. No local source in the repository records per-test
  outcomes against a tree hash — JUnit XML carries none, and `gh run` history is per-workflow, not
  per-test, without downloading artifacts over the network. Shipping the rule without a source would
  be a guess; the absence is disclosed instead.

## Why this is in scope

`select_tests` is a conclusion tool whose miss is expensive and silent — exactly where the
honesty contract wants receipts. Every addition is deterministic, local, and constant-free: git
facts, an identical-inputs outcome comparison, and labels the graph already stores. The prior art
shows these safeguards are the part even ML products refuse to learn.

## Impact

- Files: `src/core/services/mcp-handlers/test-impact.ts` (tiers, `reason`, per-test qualifier),
  a small history reader (JUnit XML / `gh run`, fail-soft) beside it; tests per tier.
- Specs: `mcp-handlers` — 2 ADDED requirements (AlwaysSelectTiersWithReasonReceipts,
  FlakinessAndStructuralConfidenceDisclosure).
- Tool surface: no new tool; `select_tests` output gains small per-test fields (`reason`, optional
  flaky/qualifier labels) — measure against the payload-budget ceiling in
  `src/cli/commands/mcp-presets.test.ts`.
- Risk: low. Tiers only ADD tests (safety direction — never de-select); flakiness reads history
  fail-soft with the `gh`-absent path already proven; per-test qualifiers reuse existing labels,
  so no ranking constant is introduced.
