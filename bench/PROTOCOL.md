# Default-surface benchmark protocol

This protocol gates every change to the MCP preset used by bare `openlore mcp` and
`openlore install`. It compares arbitrary preset A and preset B. It does not use an
LLM-as-judge. The model is the subject of the measurement, never the scorer.

## Before a measured run

1. Pre-register the decision rule in `bench/rules/` and commit it before any paid run.
   A missed rule produces `HOLD`. A changed rule requires a new file and a fresh run.
2. Select a checked-in corpus. Every task must name expected tools and plausible
   distractors. The runner stops before agent calls when a tool id is stale or a
   required distractor is absent from either tested surface.
3. Use the corpus image at its exact `sha256` digest. The results artifact must record
   the image digest, every target repository SHA, and the fixed agent configuration.
4. Run both `small-familiar` and `large-unfamiliar` repository tiers with at least two models.

## Run and score

- Run `npm run bench:protocol -- --preset-a <current> --preset-b <candidate> --dry-run`
  first. This validates the complete pipeline and recomputes exact live `tools/list`
  standing cost and capability-family coverage at $0.
- Run the measured comparison as a manual or scheduled job inside the pinned container.
  Benchmarks never run in per-commit CI.
- Correctness uses the independent `expect.mustInclude` oracle in
  `scripts/bench-agent.tasks.ts`. Selection accuracy, tool-step count, and token cost
  are computed after the run from logged transcripts. Replaying one log must produce
  the same scores on every machine.

## Evidence and decision

Check the results artifact into `bench/results/` with the change. It must include the
pre-registered rule hash, presets, corpus id, image digest, repository SHAs, models,
raw-arm artifact paths, deterministic scores, and the rule verdict. The governing ADR
must cite that exact results artifact. A default-surface change without this evidence
must not merge.

ADR-0023's navigation-versus-substrate evaluation is the first promoted instance of
this protocol. Its consolidated evidence is
`bench/results/adr-0023-default-surface.json`, and its original independent corpus and
agent runner remain in `scripts/bench-agent.tasks.ts` and `scripts/bench-agent.ts`.
