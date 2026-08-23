# A checked-in benchmark protocol for default-surface decisions

> Status: PROPOSED (2026-07-08, e2e audit fifth pass — fifth research sweep). Prior art:
> MCP-Atlas distractor-tool methodology (https://arxiv.org/pdf/2602.00933), LiveMCPBench
> (https://arxiv.org/pdf/2508.01780), MCPBench deterministic post-hoc metrics
> (https://github.com/modelscope/MCPBench), terminal-bench-style containerized task pinning.

## The gap

The audit set's own governing rule — "no default-surface tool additions without the ADR-0023
benchmark process" — names a process that exists only as the artifacts of one decision. The
DefaultSurfaceRevealsAllFaces gate that flipped `navigation`→`substrate` (ADR-0023, PR #218) IS
checked in: `scripts/bench-preset-surface.ts` (deterministic token economy + face coverage),
`scripts/bench-preset-selection.ts` (first-tool selection accuracy), and
`scripts/bench-preset-completion.ts` (end-to-end completion driving `scripts/bench-agent.ts`'s
pinned-repo/oracle machinery, with a pre-registered decision rule). But it is one decision's
tooling, not a protocol: the pieces are wired to the navigation-vs-substrate question, there is
no **distractor-tool methodology** (MCP-Atlas and LiveMCPBench both show selection accuracy is
meaningless without plausible distractors in the surface), task environments are pinned by repo
SHA but not by container, and nothing documents what the NEXT default-surface change must run.
That next change is already filed: `reconcile-substrate-write-face`'s "benchmark-gated flip
later" (cross-ref — not modified here) has no reusable gate to ride.

## What changes

**Not a user-facing feature, not a tool — process machinery.** Doctrine-clean because the LLM is
the SUBJECT under measurement, never in the computation: every score is deterministic post-hoc
extraction from logged runs.

1. **A `bench/` harness generalizing the ADR-0023 scripts** from "navigation vs substrate" to
   "preset A vs preset B" (the existing scripts become the first conforming instance —
   promotion, not rewrite; `bench-agent.ts`'s corpus/oracle/isolation and
   `src/bench/transcript-metrics.ts`'s deterministic transcript extraction are reused as-is):
   - **Distractor-aware task corpus:** each task declares its expected tool AND the plausible
     distractors that must be present in the surface under test (the MCP-Atlas/LiveMCPBench
     pattern) — exactly what preset-size decisions need to be repeatable.
   - **Deterministic trajectory metrics, post-hoc from logged runs:** tool-selection accuracy,
     step counts, token cost per task under a fixed agent config (the MCPBench pattern;
     `transcript-metrics.ts` already computes the re-read economy this way). **Explicitly
     rejected: LLM-as-judge** — MCP-Atlas itself moved away from it; scoring stays independent
     oracles (`expect.mustInclude`) + counted trajectory facts.
   - **Containerized task pinning** (terminal-bench style): repo SHA pinning exists in
     `bench-agent.ts`; add a pinned container image per corpus so runs compare across machines
     and months.
2. **A protocol document** (`bench/PROTOCOL.md`) every future default-surface change must ride:
   pre-register the decision rule before any run (the `bench-preset-completion.ts` precedent —
   its rule constants are pre-registered experiment parameters, not product tuning constants);
   run both repo tiers and both models; check the results artifact in with the change; the ADR
   cites the run. `reconcile-substrate-write-face`'s eventual flip evaluation is the first
   intended client.

## Why this is in scope

The default surface is the product's front door, and ADR-0022→ADR-0023 shows it will be
re-litigated as the tool count grows. A rule that says "benchmark it" without reproducible
machinery decays into assertion — the exact failure the honesty contract exists to prevent,
applied to the project's own decisions.

## Impact

- New: `bench/` (task corpora with distractor declarations, container pinning, comparison
  runner, `PROTOCOL.md`); the three `bench-preset-*` scripts promoted/aliased into it;
  `.github/workflows/ci.yml` untouched by default — bench runs are manual/scheduled, never
  per-commit (CI today runs only `npm run test:run`, `ci.yml:53`; that stays true).
- Tool surface: **no tool-count change, no runtime surface, no payload-budget impact.**
- Specs: `mcp-quality` — 1 ADDED (DefaultSurfaceDecisionsRideTheBenchmarkProtocol); `project` —
  1 ADDED (BenchmarkHarnessIsReproducibleAndDeterministicallyScored).
- Risk: corpus rot as tools evolve (mitigated: tasks name tools by id; a corpus referencing a
  removed tool fails validation loudly); cost of live runs (mitigated: `--dry-run` validates the
  pipeline at $0, the `bench-agent.ts` precedent, and deterministic sub-benchmarks run free).

## Standing-cost input now available

`bound-standing-context-cost` measured the cost half of future preset comparisons with the
versioned offline `utf8-bytes-div-4-v1` regression unit. Its first exact-wire baselines are
`navigation` 3,533, `substrate` 5,131, and `full` 24,140 estimated tokens; the generalized harness SHALL read
the live measurement rather than copying these point-in-time values into scoring code.
