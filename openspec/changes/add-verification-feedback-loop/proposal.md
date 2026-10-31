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

## Addendum (2026-10-31): check a proposed patch before it is written

Source: `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`. Today `verify_change` grades only a diff that is
already on disk. An agent that wants to know "what does this edit break?" must write the file first,
then call the tool, then undo the edit if it was wrong — a broken intermediate state that a parallel
agent, a watcher, or a hook can observe. The research notes call this a speculative "simulate the
impact" step; we fold it into `verify_change` instead of adding a sibling tool, because the receipt
it returns is the same conclusion (`NoRedundantConclusions`).

- **New optional input `patch`**: a unified diff (text) over files in the working tree. The tool
  applies it **in memory** to the current file contents, never to disk, and grades the result as if
  it were the working-tree diff.
- **Mechanism**: `CallGraphBuilder` already builds from an in-memory file list (`certify_merge`
  does this for each git ref). Here the list is the working tree with the patched files replaced,
  and the build goes through the on-disk hash-keyed Pass-1 fact cache, so unchanged files are cache
  hits and only patched files are re-parsed. (`graphAtRef` itself reads every file at a git ref with a
  fresh cache, so it is the pattern, not the function, that is reused.) Nothing is persisted.
- **Same receipt, plus a `speculative: true` marker** and the list of patched files. Every composed
  check runs over the overlay, so the contract verdicts and parity from
  `add-service-contract-certification` are included once that change ships.
- **Honesty**: a hunk that does not apply cleanly is fatal to the verification (the reason names the
  file and hunk) — never a partial grade. A patch may create new files inside the analyzed
  corpus's include patterns. A patch touching paths outside them, or exceeding the patched-file cap,
  is refused with the reason. Index staleness relative to
  the working tree is disclosed as today.
- **Not built**: applying the patch, a persistent "branch" of the index, multi-step speculative
  sessions. The agent writes the file itself when it is satisfied.

## Addendum (2026-10-31): the receipt is the one place every diff check lands

Source: `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`. Several new changes add finding families
that are facts about a diff. Rather than one tool each, they all land in this receipt (and so in the
before-stop and after-tools hook receipts of `add-agent-loop-hook-surfaces`):

| Family | Change |
|---|---|
| contract breaks and parity | `add-service-contract-certification` |
| check weakening | `add-check-weakening-findings` |
| phantom references | `add-phantom-reference-findings` |
| generated-file edits | `add-generated-file-guard` |
| IaC sites still setting a renamed env key | `add-iac-code-binding` (via `blast_radius`) |

Two more come from code that already exists and need no new change:

- **Architecture rules, new violations only.** `check_architecture` (`architecture.ts`) already
  evaluates author-declared rules over the dependency graph. The receipt includes only violations
  whose import or call edge the diff adds, so a repo with existing violations is not flooded and the
  rules can be tightened over time.
- **Secrets on added lines.** The existing credential patterns (`secret-redaction.ts`) run over the
  diff's added lines only; a match is a `secret-added` finding (registered, advisory) naming the file,
  line, and pattern class, never the value. This is a safety net, not a scanner: gitleaks and
  trufflehog stay the real tools.

Each family ships with its own change; this addendum only fixes where they appear.

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
- Specs: `mcp-handlers` — 3 ADDED requirements (receipt; speculative patch input; diff-scoped architecture + secret findings).
- Risk: cost of running several conclusions at once (mitigated: scope is the diff's reachable set,
  not the repo; hash-keyed Pass-1 memo means re-parse touches only changed files). Receipt bloat
  (mitigated: severity-ranked, budgeted, truncation disclosed). No new behavior in the composed
  tools — a regression there surfaces in their own suites.
