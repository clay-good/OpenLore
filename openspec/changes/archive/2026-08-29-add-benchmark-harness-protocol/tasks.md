# Tasks — add-benchmark-harness-protocol

## Implementation
- [x] `bench/` harness: generalize the ADR-0023 scripts (`scripts/bench-preset-surface.ts`,
      `bench-preset-selection.ts`, `bench-preset-completion.ts`) from navigation-vs-substrate to
      arbitrary preset-A-vs-preset-B comparison; reuse `bench-agent.ts` (corpus, oracle,
      `--strict-mcp-config` isolation) and `src/bench/transcript-metrics.ts` unchanged
- [x] Distractor-aware corpus format: each task declares expected tool(s) + required plausible
      distractors present in the surface under test; corpus validation fails loudly on a task
      naming a tool id that no longer exists
- [x] Deterministic post-hoc trajectory metrics from logged runs: tool-selection accuracy, step
      count, token cost per task under a fixed agent config; NO LLM-as-judge anywhere in scoring
- [x] Containerized task pinning: a pinned image per corpus alongside the existing repo-SHA
      pinning; runs record image digest + SHA + agent config in the results artifact
- [x] `bench/PROTOCOL.md`: pre-registered decision rule (fixed before any run), both repo tiers,
      both models, results artifact checked in with the change, ADR cites the run; the
      DefaultSurfaceRevealsAllFaces run documented as the first conforming instance
- [x] Keep bench out of per-commit CI (manual/scheduled only); deterministic sub-benchmarks
      (surface arithmetic) remain runnable at $0 via `--dry-run`

## Verification
- [x] Dry-run of the generalized harness over `navigation` vs `substrate` reproduces the ADR-0023
      deterministic quantities (token economy, face coverage) from `bench-preset-surface.ts`
- [x] Corpus validation: a task with a stale tool id fails validation; a distractor absent from
      the surface under test is reported, not silently skipped
- [x] Metric determinism: the same logged transcript scores identically across runs and machines
- [x] Protocol completeness check: `PROTOCOL.md` names decision-rule pre-registration, tiers,
      models, artifact check-in, and the ADR citation step
- [x] `npm run test:run` unaffected (no per-commit bench); full suite green

## Spec
- [x] `mcp-quality` delta: ADD DefaultSurfaceDecisionsRideTheBenchmarkProtocol
- [x] `project` delta: ADD BenchmarkHarnessIsReproducibleAndDeterministicallyScored

## Coordination
- [x] `reconcile-substrate-write-face` (unmodified here): its benchmark-gated flip evaluation is
      the first intended client of the protocol once this ships
