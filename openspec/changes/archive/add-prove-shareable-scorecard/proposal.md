# Shareable prove scorecard: turn "does it pay for me?" into a one-command, persisted, shareable artifact

> Status: IMPLEMENTED (2026-06-22) — shipped on branch `feat/prove-shareable-scorecard`. All five "What
> changes" items and all six task sections are built and tested (36 new unit tests; e2e/dogfooded on
> this repo with no API key via `--estimate`). Decisions: `581a90bf` (stable JSON contract), `670b5f0b`
> (dated non-clobbering persistence under `.openlore/prove/`), `66feae62` (deterministic estimate arm).
>
> **One scoped correction during implementation (recorded in dogfooding):** the first `--estimate`
> model charged the WITH arm one confirming read *per task* while deduping the WITHOUT arm's reads
> across tasks — an asymmetry that produced a misleading "doesn't help" verdict on small neighbourhoods.
> The shipped model is symmetric: both arms dedup reads, and the WITH arm is `1 orient + min(answerFiles,
> maxConfirmReads)` because orient's value is returning the whole neighbourhood in one call. The estimate
> docstring also now states its scope limit plainly: it projects the orientation-task tax from the graph
> and **cannot** model whether the LLM already memorized the code — only the measured arm can.
>
> **Adversarial QA hardening (2026-06-22, decision `b67add6d`):** four parallel adversarial e2e passes
> (flag-fuzzing, JSON-contract, estimate-model, docs/injection) confirmed the estimate model and badge
> are correct/honest/injection-proof, and surfaced fixes now applied: (1) the JSON key `runsPerArm`
> actually reported tasks×runs, renamed `samplesPerArm` before the v1 contract ships; (2) non-numeric
> `--runs`/`--max-budget-usd` silently produced a degenerate all-zero scorecard (NaN) — now rejected
> with a clear error + exit 1; (3) `--json --markdown` silently dropped markdown — now mutually
> exclusive; (4) a hostile `--model` (backtick/newline) could corrupt the markdown line, and non-finite
> agent numbers could serialize as `null` — both sanitized/finite-guarded; (5) `gitShortSha` no longer
> leaks `git` stderr; (6) the persisted `raw` block is rounded. README + `docs/cli-reference.md` now
> surface the no-API-key `--estimate` path and the badge. +8 tests (44 in the prove suites; 4428 total).
>
> **Second adversarial round (2026-06-22):** a direct failure-injection probe (fake runner via the
> injectable `runProve` runner) found that a fully-failed *measured* run — every agent call throwing —
> emitted `ok:true` with a confident `verdict:"break-even"` and all-zero metrics, which a CI consumer
> reading the new `--json` contract would misread as a neutral result. Fixed: errored runs are now
> dropped from the medians (no $0/0-turn pollution) via the pure exported `summarizeArms`, and if either
> arm has no successful sample the run **fails loudly** (`ok:false` → exit 1) with an actionable message
> instead of a verdict over no data. +4 tests (48 in the prove suites). Documented in the prove section
> of `docs/AGENT-BENCHMARKS.md`.
>
> **Third adversarial round (2026-06-22, decision `dfe33d94`):** filesystem/path/concurrency + doc/spec
> drift sweep. Fixes: `saveScorecard` now writes atomically with `wx` (closing a TOCTOU race that
> silently overwrote a prior run under concurrency — the "never overwritten" guarantee is now real), and
> a save filesystem error (e.g. `.openlore/prove` is a file, permissions) degrades to a clear message +
> exit 1 instead of an unhandled stack-trace crash that discarded the computed scorecard. Docs brought
> in line with shipped behavior: a consumer-facing `--json` schema (keys/types/enums) added to
> `docs/AGENT-BENCHMARKS.md`; `README.md` test count reconciled; `docs/cli-reference.md` gained `prove`
> rows + a `### Prove Options` block; and the change's `specs/cli/spec.md` delta was corrected (the
> stale "per-task cells" claim removed — raw cells live only in the `--save` artifact, not the `--json`
> contract) and extended with the mutual-exclusion, NaN-rejection, and no-verdict-over-no-data
> requirements. +2 tests.
>
> Third of three changes that close the loss case in OpenLore's own agent benchmark (siblings:
> `add-task-scoped-context-injection`, `default-to-lean-tool-surface` — both still PROPOSED). Builds
> directly on the existing `openlore prove` command (Spec 25 Q2, `src/cli/commands/prove.ts`,
> `src/core/agent-eval/{tasks,measure,scorecard}.ts`). Adds output and persistence modes plus a new
> deterministic estimate arm to a shipped command; adds no new MCP tool.

## Why

OpenLore's entire value proposition rests on one honesty contract (README): *"Don't guess from our
repos — run `openlore prove` on yours."* The whole pitch is "measure it on YOUR codebase." That makes
`openlore prove` the most strategically important command in the product — it is simultaneously the
trust wedge (we publish losses; verify it yourself), the PMF-discovery instrument (which repos does
OpenLore actually help?), and the natural growth loop (a result worth sharing).

But the command as shipped under-delivers on that role in three concrete ways:

1. **The result is ephemeral.** `runProve` renders a scorecard to stdout and returns. Nothing is
   persisted, so there is no dated record, no before/after comparison across optimization phases, and
   nothing to attach to a PR or paste into a README. The honesty contract ("date-stamped and
   re-measured after each optimization phase") is asserted for the project's own scorecard but not
   made reproducible-and-keepable for a user's repo.

2. **There is no shareable form.** There is no machine-readable `--json`, no markdown block, and no
   badge. A user who runs `prove` and sees a −18% result has no first-class way to show it — which
   forfeits the strongest organic distribution OpenLore has: real users posting real, self-measured
   numbers.

3. **The agent arm is the only arm.** Real `prove` requires the `claude` CLI plus an API key (it
   shells out to an agent); without them the user only gets `--dry-run` synthetic numbers. There is
   no zero-cost, no-API **static estimate** of the orientation tax a repo carries (round-trips a
   from-scratch agent would spend vs. what the graph collapses), so the first-touch user who lacks an
   API key gets nothing real to act on.

This change makes `prove` deliver on the role the README already assigns it, without weakening the
honesty contract — every number stays one the benchmark actually produced, and the static estimate is
labeled as an estimate, never as a measured agent result.

## What changes

1. **Persisted, dated scorecards.** `openlore prove --save` writes the scorecard (and its raw
   per-arm/per-task metrics) to a dated file under `.openlore/prove/` so results are keepable,
   diffable across runs, and re-measurable after each optimization phase — making the project's stated
   honesty discipline ("date-stamped, re-measured") available on the user's own repo.

2. **Machine-readable output.** `openlore prove --json` emits the scorecard as documented, stable-keyed
   JSON (cost Δ, round-trips Δ, correctness, per-task cells, verdict, run metadata: model, runs, repo
   SHA, date, mode) so CI and external tooling can consume and gate on it.

3. **A shareable markdown + badge.** `openlore prove --markdown` emits a paste-ready scorecard block
   (the same shape as the README Value Scorecard), and the command surfaces a shields.io-style badge
   line a user can drop into their README. This turns a self-measured result into the organic
   distribution OpenLore currently leaves on the table.

4. **A zero-cost static estimate arm.** `openlore prove --estimate` (no `claude`, no API key) computes
   a deterministic, graph-derived *estimate* of the orientation tax a repo carries — e.g. for the same
   auto-derived tasks, the from-scratch discovery round-trips a navigator would spend versus the
   bounded set `orient` returns — and renders it in the scorecard with an unmistakable "estimate, not a
   measured agent run" label. This gives the API-key-less first-touch user a real, honest signal and a
   reason to run the agent arm later.

5. **Onboarding integration.** `openlore install` (or its summary) points the user at `openlore prove`
   as the next step, and the docs make `prove` the headline "does it pay for itself?" artifact rather
   than a buried benchmark utility.

## What does NOT change

- **The honesty contract holds, strengthened.** Every measured number still comes only from a real
  benchmark run; the static `--estimate` is labeled an estimate and never presented as a measured
  agent result; losses are shown next to wins exactly as today. (README honesty contract.)
- **The agent arm is unchanged.** WITH/WITHOUT isolation via `--strict-mcp-config`, the
  graph-derived task derivation (`deriveTasks`), correctness scoring (`scoreAnswer`), and
  summarization (`summarize` / `computeScorecard` / `renderScorecard`) are reused as-is.
- **No new MCP tool.** This is output/persistence/estimation modes on the existing `prove` CLI
  command. The MCP surface and every preset are unchanged.
- **No new network or service.** `--save` / `--json` / `--markdown` / `--estimate` are local; only the
  existing agent arm shells out to `claude`, exactly as today.
- **No LLM in the static arm.** `--estimate` is pure graph computation. The north star (`c6d1ad07`)
  holds; the agent arm's LLM use is unchanged and clearly delimited.

## Research basis

The "measure value on your own corpus, don't trust vendor benchmarks" stance is the established A/B /
holdout-evaluation discipline applied to a developer tool; persisting dated results is standard
longitudinal benchmarking (track the metric across versions, not a single snapshot); the badge/share
loop is the README-badge growth pattern that turned coverage/CI tools into self-distributing artifacts;
and the static `--estimate` arm is cost-model estimation — predicting work (here, navigation round-
trips) from a structural model rather than executing it — labeled distinctly from measurement so the
two are never conflated. The combination realizes the honesty contract OpenLore already publishes,
rather than introducing a new claim.

## Application to OpenLore

- **Persistence + JSON + markdown** wrap `computeScorecard` / `renderScorecard`
  (`src/core/agent-eval/scorecard.ts`): the scorecard object already exists; this change serializes it
  to stable JSON, a markdown block, and a dated file, and derives the badge fields from it.
- **The static estimate** reuses `loadGraphFacts` and `deriveTasks` (`prove.ts`,
  `src/core/agent-eval/tasks.ts`) — the same tasks the agent arm runs — and the EdgeStore call graph,
  with no agent runner.
- **Run metadata** (model, runs, mode, repo SHA, date) is stamped at command time (the workflow/script
  constraint on time is irrelevant here — this is the CLI, not a Workflow script).
- **Onboarding pointer** reuses the `openlore install` summary (`printSummary`, `src/cli/install/index.ts`).

## Relationship to the sibling changes

`add-task-scoped-context-injection` removes the per-task orient round-trip; `default-to-lean-tool-
surface` removes the per-session schema bytes. This change is how a user *sees* the result of those
two on their own repo — and how the project tracks, dated, that the loss case actually closed.
Independently shippable; this one converts the work into evidence and distribution.

## Out of scope

- **A hosted/aggregated leaderboard** of prove results across users. The artifact is local and
  user-owned; aggregating results is a separate product/privacy decision.
- **Auto-running prove in CI by default.** This adds `--json` so CI *can* gate on it; wiring a default
  CI job is the user's choice, not part of this change.
- **Changing the task-derivation or scoring algorithm.** `deriveTasks` / `scoreAnswer` are reused as-is;
  improving them is separate work.
- **Replacing the agent arm with the estimate.** The static estimate complements, never replaces, the
  measured agent run; it is explicitly labeled an estimate.
