# Tasks — add-callgraph-soundness-calibration

> Invariant reframed to **monotone refinement** (decision 2026-10-24): the paper's "more precise
> adds no edge" form is for pointer analyses where precision shrinks edges; OpenLore's ladder
> grows resolved edges, so the meaningful, non-vacuous check is that the full build never *drops*
> a resolution a conservative (mechanism-off) build made, and that CHA stays additive. See the
> `analyzer` spec delta.

## Part 1 — precision-order consistency (built in this PR)
- [x] Configuration toggles on the existing builder for the invariant runs (`typeInference` /
      `reExport` / `cha`, each default on = unchanged production behaviour) —
      `CallGraphResolutionToggles` in `call-graph.ts`, threaded into the resolution strategies
- [x] Invariant checker (`soundness-calibration.ts`): monotone-refinement comparison — the full
      build must not drop an internal resolution a mechanism-off build made; CHA must only add
      `overrides` edges. Pure comparators exported for testing; report edge, confidence class, repo
- [x] Register `callgraph-precision-order-violation` in `FINDING_CODE_REGISTRY`
      (enforcement-policy.ts) with defaultClass 'advisory' and a description; emit violations in
      the unified `GovernanceFinding` shape
- [ ] CI job: run the checker over the OpenLore self-index + existing fixture repos (the exported
      `calibratePrecisionOrder` is ready; wiring the dogfood job + triaging any pre-existing
      findings is the remaining Part-1 step)

## Part 2 — execution-witnessed recall calibration (deferred to a follow-up PR)
- [ ] Dev-only TraceEval harness (kept out of the shipped package): map extracted edges onto the
      benchmark edge format for the Python and JavaScript suites; compute recall per
      edge-confidence class
- [ ] Committed results doc with the benchmark commit hash; cite it from
      docs/language-support.md and the honesty copy, with the recall-floor caveat inline

## Verification
- [x] Checker self-test: an injected monotone-refinement violation is detected with the correct
      edge/confidence class; a clean fixture passes (`soundness-calibration.test.ts`)
- [x] Finding-code test: the new code is registered, advisory by default, with source
      `callgraph-soundness`
- [x] Toggle test: `cha: false` synthesizes no `overrides` edges; default behaviour unchanged
- [x] Integration: `calibratePrecisionOrder` reports no violation on a clean re-export fixture
- [ ] Harness determinism (Part 2): two runs over the same benchmark commit produce identical
      recall numbers
- [ ] Package audit (Part 2): the harness and benchmark data are absent from the published artifact
- [ ] Docs state partial coverage + recall-floor caveat (Part 2)
- [x] Typecheck green; no serving-path or payload-budget impact (no tool change)

## Spec
- [x] `analyzer` delta: PrecisionOrderConsistencyInvariant (monotone-refinement wording)
- [ ] `analyzer` delta: ExecutionWitnessedRecallCalibration (Part 2) — spec written, not yet built;
      change stays open until Part 2 ships, then archive
