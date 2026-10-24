# Call-graph soundness calibration: measure the honesty claims instead of asserting them

> Status: PROPOSED (2026-07-03, e2e audit pass 3). OpenLore's conclusions lean on asserted
> honesty — "sound lower bound", disclosed boundaries — but nothing measures whether the
> resolution ladder actually behaves that way. Two offline/CI mechanisms make the honesty
> MEASURED: a ground-truth-free precision-order consistency check over the existing
> edge-confidence tiers, and an execution-witnessed recall calibration against a public
> benchmark. Nothing enters the hot path; the numbers become citable receipts.

## The gap

The substrate's copy says "sound lower bound" and "disclosed boundaries" in a dozen places, and
every edge already carries provenance — the `EdgeConfidence` ladder
(`src/core/analyzer/call-graph-types.ts:15-25`: `name_only`, `same_file`, `import`, `re_export`,
`type_inference`, `self_cls`, `synthesized`, `external`, …; `re_export` added by PR #205,
class-hierarchy dispatch as `overrides` edges). But no mechanism ever checks that the ladder is
internally consistent, and no measured recall number exists for any tier — the honesty is
asserted, not calibrated. Recent research shows both gaps are closable without ground truth or
runtime in the product:

- Zhong, Wold & Windmann, "Detecting Call Graph Unsoundness without Ground Truth" (arXiv
  2604.00885, Apr 2026 — https://arxiv.org/abs/2604.00885): a strictly more precise analysis
  configuration must never ADD call edges relative to a more conservative one; any violation is
  mechanically-detected unsoundness, no ground truth needed. Their study found real frameworks
  break this invariant routinely — exactly the failure OpenLore currently could not see in itself.
- TraceEval (arXiv 2605.11006 — https://arxiv.org/html/2605.11006): ~10.5k real-world programs
  whose call edges are mechanically witnessed by execution. Its Python and JavaScript suites map
  onto OpenLore's extractors (its third suite is Java, which OpenLore does not extract; there is
  no TypeScript suite — partial coverage, disclosed).

## What changes

1. **Precision-order consistency self-check (CI/dogfood, ground-truth-free).** An invariant
   checker that runs the existing builder under progressively more conservative resolution
   configurations (e.g. with type-inference/CHA/re-export resolution disabled stepwise) and
   asserts the monotone-refinement invariant (reframed 2026-10-24 — the paper's "more precise
   adds no edge" form is for pointer analyses where precision shrinks edges; OpenLore's ladder
   grows resolved edges, so the meaningful check is the other direction): the full build never
   DROPS a resolution a conservative (mechanism-off) build made (a refining mechanism may only
   refine or add), and the over-approximating CHA pass only ADDS `overrides` edges, leaving every
   non-`overrides` edge unchanged. Runs over the OpenLore self-index plus the existing fixture
   repos. Violations are emitted as a registered governance finding — a new
   `callgraph-precision-order-violation` code in `FINDING_CODE_REGISTRY`
   (`src/core/services/mcp-handlers/enforcement-policy.ts:81`), default class advisory per the
   registry's rule (`:71-76`) — naming the edge, its confidence class, and the repo. Deterministic,
   local, zero new constants.
2. **Execution-witnessed recall calibration (dev-only harness).** An offline harness that maps
   OpenLore's extracted edges onto TraceEval's edge format and publishes MEASURED recall per
   edge-confidence class ("`import`-resolved edges recover X% of execution-witnessed edges"),
   for the Python and JavaScript suites. Results land as a committed doc (with the benchmark
   commit hash) cited from `docs/language-support.md` and the honesty copy — calibrated, not
   asserted. Carried caveat, stated wherever the number is: an execution-covered graph is a
   recall floor, not a soundness proof — the benchmark witnesses edges that ran, not all edges
   that exist. The harness stays OUT of the shipped package (dev tooling, not a dependency).

## Why this is in scope

The north star (c6d1ad07) is a deterministic structural substrate whose value is that agents can
trust its conclusions; a trust claim nobody measures is exactly the "asserted, never verified"
shape the honesty contract forbids in tool output. Both mechanisms are offline, deterministic,
local, and constant-free; neither touches serving latency, adds a tool, or introduces a learned
model. The precision-order check is the cheapest possible unsoundness detector — it needs nothing
OpenLore does not already store (edge provenance).

## Impact

- Files: a checker under `src/core/analyzer/` (or `scripts/`) driving the existing
  `CallGraphBuilder` with resolution mechanisms toggled; finding registration in
  `enforcement-policy.ts` (`FINDING_CODE_REGISTRY`, `:81`); dev-only benchmark harness +
  committed results doc; a CI job for the invariant check.
- Specs: `analyzer` — 2 ADDED requirements (PrecisionOrderConsistencyInvariant,
  ExecutionWitnessedRecallCalibration).
- Tool surface: unchanged — no new MCP tool, no payload impact. The new finding code is
  advisory-by-default; blocking only via an operator's `enforcement.policy`.
- Risk: low. The invariant check may surface real pre-existing unsoundness (that is its job —
  findings are advisory, fixes are separate changes); benchmark mapping is lossy at language
  edges and is disclosed as partial coverage, never extrapolated to unmeasured tiers or languages.
