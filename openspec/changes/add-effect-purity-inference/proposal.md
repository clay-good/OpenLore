# Effect and purity inference: what a function touches, compositional and sound

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). Compute a
> closed-vocabulary effect fact per function (`pure` | `mutates-params` | `module-state` | `io`
> | `unknown`) in the existing walk, close it transitively over resolved call edges, surface it
> on existing conclusions, and make effect claims verifiable with receipts. Prior art: bundler
> tree-shaking semantics define the deterministic purity vocabulary this borrows (`#__PURE__` /
> `#__NO_SIDE_EFFECTS__` annotation semantics); the borrow is the vocabulary, not any bundler's
> analysis or its annotation-trust model — today those annotations are hand-written and
> unverified, and this change is what can check them.

## The gap

- Every reasoning task about *safety of change* treats functions as opaque: `plan_parallel_work`
  hazards, "is this safe to memoize/reorder/call twice?", "can I move this call out of the
  loop?" — all depend on whether the function mutates shared state or performs I/O, and the
  substrate holds no such fact. Agents guess from names (`get…` is probably pure) — training
  priors, not evidence.
- Effect inference is the textbook compositional analysis: a function's direct effects are
  syntactically detectable (assignments to non-locals, param member-writes, known I/O call
  patterns), and its transitive effect is the join over resolved callees — the same
  summary-composition architecture the field's diff-time analyzers proved out, and the same
  shape as OpenLore's shipped reachability precompute.
- The ecosystem's existing purity signals are *declared*, not derived: `#__PURE__` annotations
  gate real dead-code elimination in production bundlers, yet nothing verifies them. A
  deterministic checker that flags a contradicted annotation is a governance finding waiting to
  exist.

## What changes

- **Per-function direct-effect facts in the existing walk** (TS/JS/Python first; other
  languages report no fact, never a guess): assignment to module/global bindings →
  `module-state`; writes through parameters → `mutates-params`; calls matching a closed
  I/O pattern table (fs/network/process/console) → `io`; none of these → locally pure.
- **Transitive closure over resolved call edges** (riding the shipped condensation/reachability
  machinery): a function's effect is the join of its direct effect and its resolved callees'
  effects. Any unresolved, external, or dynamic-boundary callee joins as `unknown` — the
  closure NEVER claims `pure` across an edge it cannot see. Soundness direction: `pure` is a
  proven claim; `unknown` is honest ignorance, not an accusation.
- **Surfaced, not a new tool:** an `effects` field on `orient`'s relevant functions,
  `get_function_skeleton`, and `blast_radius` symbols; a `verify_claim` kind `effect-free`
  (subject = symbol): `confirmed` only when the closure proves purity, `refuted` with the
  effect-introducing path as receipt (the chain of calls to the assignment/IO site), and
  `unverifiable` with the blocking boundary named when `unknown` dominates.
- **One registered advisory finding, `pure-annotation-contradicted`:** a `#__PURE__` /
  `@__NO_SIDE_EFFECTS__`-annotated call target whose closure-computed effect is provably not
  pure — evidence-backed (the effect path is the receipt), no threshold, advisory by default
  like every finding.
- **Deliberately NOT borrowed / NOT built:** alias/escape analysis (a param write through an
  alias is covered by the same disclosed-boundary class as the data-flow sibling); exception
  effects (owned by `analyze_error_propagation` — cross-referenced, not duplicated);
  auto-inserting or rewriting annotations; any hazard *reclassification* in
  `plan_parallel_work` (effects are surfaced as evidence beside hazards in this change;
  changing hazard semantics would be its own proposal); no LLM.

## Why this is in scope

Effects are a structural fact about the graph OpenLore already owns, computable by the same
walk + closure machinery that ships today, with the same sound-lower-bound honesty contract as
error propagation. They upgrade several existing conclusions at once (orientation, blast
radius, claim verification) and open the first evidence-backed check on a declaration the
JS ecosystem currently takes on faith.

## Impact

- Files: direct-effect extraction in the Pass-1 walk (closed I/O pattern table beside the env/
  logger tables), transitive closure at analyze (with incremental recompute on the watcher
  path), surfacing in orient/skeleton/blast-radius, `verify_claim` kind, one
  `FINDING_CODE_REGISTRY` entry; fixtures per effect class.
- Specs: `analyzer` — 1 ADDED requirement; `mcp-handlers` — 1 ADDED requirement.
- Tool surface: no new tool; additive fields; one new `verify_claim` kind; one advisory
  finding code.
- Risk: `unknown` dominating in dynamic codebases and reading as useless (mitigated: the
  boundary that causes `unknown` is named per symbol, making it actionable via the
  assumption-resolution lane); I/O pattern table gaps under-reporting `io` (mitigated: `pure`
  requires the closure to prove absence of all three effect classes over *resolved* edges only
  — a missed pattern can weaken `io` labeling but the unresolved-edge rule still guards
  `pure`); closure cost (mitigated: piggybacks the shipped reachability precompute and
  content-hash invalidation).
