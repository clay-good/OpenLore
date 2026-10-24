# Verification feedback loop: one actionable receipt from the checks we already have

> Status: PROPOSED (2026-10-24, roadmap direction ADR-0035). A new `verify_change` conclusion +
> `openlore verify-change` CLI that runs OpenLore's existing deterministic checks over a diff and
> returns ONE ordered, actionable receipt — what broke, who's affected, which tests to run — so an
> agent (or a human) gets external feedback at the moment it can still act on it. Trend evidence:
> verification, not generation, is the 2026 bottleneck, and the recurring finding is that agents
> cannot self-correct without external feedback — "an agent can only achieve what it receives
> feedback on"
> (https://futurumgroup.com/insights/why-ai-coding-agents-need-an-independent-review-layer-trust-not-output-is-the-bottleneck/,
> https://arxiv.org/pdf/2608.13867).

## The gap

OpenLore already computes every piece of deterministic feedback a change needs — `blast_radius`
(who's affected), `select_tests` (what to re-run), `check_spec_drift` (what diverged from spec),
`certify_public_surface` (what breaks consumers), `structural_diff` (`deprecatedCalls`,
footprint escapes). But they are **pull tools**: an agent benefits only if it thinks to call each
one, in the right order, and then assemble the answer itself. `openlore enforce` gates a commit on
registered findings, but it is a pass/fail wall, not a single *actionable* "here is what to fix and
what to re-run next" receipt an agent can consume and correct against. The research is consistent
that this missing external-feedback step is exactly why agents fail to self-correct: belief
strengthens while the artifact gets less safe, and the agent's own confidence is not a signal. The
substrate has the signal; it just never hands it back in one actionable shape.

## What changes

A new `verify_change` conclusion tool (opt-in `verify` preset) + `openlore verify-change [--base
<ref>] [--staged] [--json]` CLI and a pre-landing gate hook:

- **Input**: the working-tree or `--staged` diff against a base resolved through the shared
  `resolveBaseRefDisclosed` discipline (a bad base is fatal for a verification, per the CLI
  conclusion-honesty rule).
- **Composition, not new analysis**: run the existing conclusions over the diff's changed and
  reachable symbols and fold them into ONE receipt — per item: the symbol/file, the check that
  produced it, a severity, and the single next action ("re-run `select_tests` set X", "a public
  export narrowed — consumers A, B", "requirement R drifted", "new call into deprecated `foo`").
- **Ordered and budgeted**: items are severity-ranked (breaking surface change and spec drift
  above advisory deprecations), truncated with a disclosed count, never a raw dump — the same
  whole-response budgeting discipline `orient` uses.
- **Stable schema**: the receipt is a documented, versioned shape so a harness or hook can consume
  it mechanically (the Claude Code / Pi gate, a CI step, an agent's own correction turn).
- **Advisory by default**; a consumer gates on it through `enforcement.policy` on the finding
  codes the composed checks already register. No new finding codes are invented.

Deliberately NOT borrowed: no LLM judgment of the diff, no auto-fix, and no running of the tests —
`verify_change` *names* the tests to run and the breaks to fix; the harness runs and fixes. It is
the grader, not the author.

## Why this is in scope

Pure composition of shipped, deterministic conclusions into one conclusion-shaped receipt — no new
graph analysis, no LLM, local. It closes the "pull-only feedback" gap the trust research names as
the missing self-correction ingredient, and it is the loop every other verification conclusion
plugs into. It cross-references its siblings rather than replacing them (`NoRedundantConclusions`):
each component tool still answers its own question; `verify_change` only assembles their answers
for one diff into one next-action list.

## Impact

- New: `verify_change` handler composing `blast_radius` / `select_tests` / `check_spec_drift` /
  `certify_public_surface` / `structural_diff`; a versioned receipt schema; `openlore verify-change`
  CLI + an opt-in gate hook. Registered in `TOOL_CAPABILITY_FAMILY` (`change` — it reasons about a
  diff, like its sibling `blast_radius`; the `verify` label is the opt-in preset it ships in, not
  its capability family), classified
  `conclusion` in `tool-contract.ts`, cross-referencing each composed sibling; tools/list payload
  budget re-asserted or consciously bumped.
- Specs: `mcp-handlers` — 1 ADDED requirement.
- Risk: cost of running several conclusions at once (mitigated: scope is the diff's reachable set,
  not the repo; hash-keyed Pass-1 memo means re-parse touches only changed files). Receipt bloat
  (mitigated: severity-ranked, budgeted, truncation disclosed). No new behavior in the composed
  tools — a regression there surfaces in their own suites.
