# Default-surface benchmark protocol

This protocol gates every change to the MCP preset used by bare `openlore mcp` and
`openlore install`. It compares arbitrary preset A and preset B. It does not use an
LLM-as-judge. The model is the subject of the measurement, never the scorer.

## Before a measured run

1. Pre-register the decision rule in `bench/rules/` and commit it before any paid run.
   A missed rule produces `HOLD`. A changed rule requires a new file and a fresh run.
2. Select a checked-in selection corpus. Every task must name expected tools and plausible
   distractors. The runner stops before agent calls when a tool id is stale or a
   required distractor is absent from either tested surface. Completion uses the separately
   identified independent-oracle corpus in `scripts/bench-agent.tasks.ts`; the artifact records
   both corpus ids rather than presenting them as one input.
3. Run the live command from the host. The runner builds `bench/Dockerfile`, whose base image is
   the corpus image at its exact `sha256` digest, then invokes the internal runner by the built
   image id. Direct host execution is not a conforming live run. The results artifact records
   the base digest, container-definition hash, runtime image id, every target repository SHA, and the fixed
   agent configuration. Provide non-interactive Claude credentials through a supported
   environment variable such as `ANTHROPIC_API_KEY`; credentials are never written to artifacts.
4. Run both `small-familiar` and `large-unfamiliar` repository tiers with at least two models.

## Run and score

- Run `npm run bench:protocol -- --preset-a <current> --preset-b <candidate> --dry-run`
  first. This validates the complete pipeline and recomputes exact live `tools/list`
  standing cost and capability-family coverage at $0.
- Run the measured comparison as a manual or scheduled job; the host-side launcher creates the
  checked-in container environment and refuses a Dockerfile/base-image mismatch.
  Benchmarks never run in per-commit CI.
- Correctness uses the independent `expect.mustInclude` oracle in
  `scripts/bench-agent.tasks.ts`. Selection accuracy, tool-step count, and token cost
  are computed after the run from logged transcripts. Replaying one log must produce
  the same scores on every machine.

## Evidence and decision

Check the results artifact into `bench/results/` with the change. It must include the
pre-registered rule hash, presets, both corpus ids, container identities, repository SHAs, models,
raw-arm artifact paths, deterministic scores, and the rule verdict. The governing ADR
must cite that exact results artifact. A default-surface change without this evidence
must not merge.

ADR-0023's navigation-versus-substrate evaluation is the legacy precursor to this protocol.
Its retrospective summary is `bench/results/adr-0023-default-surface.json`; it is explicitly
nonconforming because its decision rule was not committed before that historical run and raw
trajectories were not retained. The next proposed default-surface change must supply the first
conforming artifact rather than treating ADR-0023's summary as one.
