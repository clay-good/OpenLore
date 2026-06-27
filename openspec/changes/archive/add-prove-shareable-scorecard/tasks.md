# Tasks — Shareable prove scorecard

> Status: IMPLEMENTED (2026-06-22) on branch `feat/prove-shareable-scorecard`. All six sections built
> and tested. Decisions recorded before code: `581a90bf` (stable JSON contract), `670b5f0b` (dated
> persistence), `66feae62` (estimate cost model). No new MCP tool — `tool-contract.ts` unaffected.
> Serialization/markdown/badge live in `src/core/agent-eval/scorecard.ts`; the estimate arm in the new
> `src/core/agent-eval/estimate.ts`; flags + persistence in `src/cli/commands/prove.ts`
> (+ `prove.test.ts`). 36 new unit tests; e2e/dogfooded on this repo with no API key.

## 1. Scorecard serialization (JSON)
- [x] Add a stable, documented serialization of the scorecard object (`computeScorecard` output) with
      keys for cost Δ, round-trips Δ, correctness, verdict, and run metadata (model, runs, mode, repo
      SHA, ISO date). → `serializeScorecard` + `SerializedScorecard` in `scorecard.ts` (schemaVersion 1).
      Per-arm raw cells/metrics ride along in the `--save` payload's `raw` block, not the JSON contract.
- [x] Add `openlore prove --json` emitting exactly that object to stdout (logger chrome suppressed in
      machine mode so stdout stays pure JSON).
- [x] Test: `--json` parses, carries exactly the documented key set (asserted so it cannot drift), and
      round-trips through `JSON.parse(JSON.stringify())` unchanged.

## 2. Persisted, dated scorecards
- [x] Add `openlore prove --save` writing the serialized scorecard + raw per-arm metrics to a dated file
      under `.openlore/prove/prove-<YYYY-MM-DD>.json` (new `OPENLORE_PROVE_REL_PATH` constant).
- [x] Stamp the date at command time (CLI). Same-day repeats get a numeric suffix (`-2`, `-3`, …) so a
      prior run is never clobbered; different days get different files.
- [x] Test: `--save` writes a parseable dated file matching `--json` plus `raw`; same-day repeats add
      suffixes; different days separate. (`src/cli/commands/prove.test.ts`.)

## 3. Shareable markdown + badge
- [x] Add `openlore prove --markdown` emitting a paste-ready block matching the README Value Scorecard
      shape (`renderScorecardMarkdown`), wins and losses both shown.
- [x] Surface a shields.io badge derived from the round-trips Δ + honest verdict color
      (`scorecardBadgeUrl`/`scorecardBadgeMarkdown`); non-measured modes are labeled in the badge.
- [x] Test: `--markdown` contains the headline deltas + honest verdict; badge is well-formed; a loss
      case renders the loss (no cherry-picking); estimate mode shows the estimate banner.

## 4. Static, zero-cost estimate arm
- [x] Add `openlore prove --estimate`: a deterministic, no-agent, no-API projection of the orientation
      tax — N searches + distinct answer-bearing files (WITHOUT) vs one orient + a bounded confirm
      (WITH) — computed from `loadGraphFacts` + `deriveTasks` + the EdgeStore. → `estimate.ts`, no runner.
- [x] Render with an unmistakable "ESTIMATE — not a measured agent run" label across human/json/markdown;
      it is the path that works with no `claude` and no API key (the claudeAvailable gate is skipped).
- [x] Test: deterministic for a fixed graph; WITH is cheaper + fewer round-trips; correctness held equal;
      caps answer-files so a mega-hub can't skew it; returns null on no tasks.
- [x] Correction (dogfood): symmetric read-dedup model — see proposal header. The WITH arm is
      `1 + min(answerFiles, maxConfirmReads)`, not `1 + nTasks`.

## 5. Onboarding integration
- [x] Point the user at `openlore prove --estimate` (no API key) as the next step from the
      `openlore install` summary (`printSummary`, `src/cli/install/index.ts`).
- [x] Make `prove` the headline "does it pay for itself?" artifact in `docs/AGENT-BENCHMARKS.md`.

## 6. Docs
- [x] Document `--json` (with the stable key schema), `--save`, `--markdown`/badge, and `--estimate`
      (and its labeling + scope limit) in `docs/AGENT-BENCHMARKS.md`, reinforcing the honesty contract
      (measured numbers only; estimate clearly labeled; losses shown next to wins).
- [x] Surface the no-API-key `--estimate` path + badge in `README.md`; add `prove` rows + a
      `### Prove Options` block to `docs/cli-reference.md`; add a consumer-facing `--json` schema
      (keys/types/enums) to `docs/AGENT-BENCHMARKS.md`.

## 7. Adversarial QA hardening (three rounds — what shipped beyond the original plan)
- [x] **Round 1** (4 parallel agents: flag-fuzz / JSON-contract / estimate-model / docs-injection):
      rejected non-numeric `--runs`/`--max-budget-usd` (`parseNumericFlag`); made `--json`/`--markdown`
      mutually exclusive; renamed the contract key `runsPerArm → samplesPerArm` (= tasks × runs) before
      v1 ships; sanitized `--model` in markdown + finite-guarded `money()`/`parseAgentJson`; silenced
      `gitShortSha` stderr; rounded the persisted `raw` block.
- [x] **Round 2** (failure injection via the injectable `runProve` runner): errored runs dropped from
      the medians via the pure exported `summarizeArms`; a measured arm with no successful sample now
      fails (exit 1) instead of emitting a verdict over no data.
- [x] **Round 3** (filesystem/path/concurrency + spec/doc drift): `saveScorecard` now writes atomically
      with `wx` (closes the TOCTOU non-clobber race — no silent overwrite under concurrency) and the
      command degrades a save filesystem error to a clear message + exit 1 (no stack-trace crash when
      `.openlore/prove` is a file); the change spec delta + docs were brought in line with shipped
      behavior. Tests: 13 prove-command + 35 agent-eval = 48 in the prove suites.
