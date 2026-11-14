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


## Verification
- [x] Checker self-test: an injected monotone-refinement violation is detected with the correct
      edge/confidence class; a clean fixture passes (`soundness-calibration.test.ts`)
- [x] Finding-code test: the new code is registered, advisory by default, with source
      `callgraph-soundness`
- [x] Toggle test: `cha: false` synthesizes no `overrides` edges; default behaviour unchanged
- [x] Integration: `calibratePrecisionOrder` reports no violation on a clean re-export fixture
- [x] Typecheck green; no serving-path or payload-budget impact (no tool change)

## Spec
- [x] `analyzer` delta: PrecisionOrderConsistencyInvariant (monotone-refinement wording)


> Archived 2026-11-14. Unbuilt tasks were removed before archiving; they are listed in the
> "Not doing" table of `ROADMAP.md` with the commit to restore them from (`0dd75dbef`).
