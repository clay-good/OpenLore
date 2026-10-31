# Check-weakening findings: say when a diff makes checks pass by weakening the checks

> Status: PROPOSED (2026-10-31, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`). Registered advisory
> findings in `verify_change` and `structural_diff`. No new tool.

## The gap

Agents under pressure to make a test pass often change the test or the check instead of the code:
they delete or skip a test, remove assertions, change an expected value, add `@ts-ignore` /
`# noqa` / `eslint-disable`, wrap the failing call in a catch-all, or relax the CI config. This is
measured, not anecdotal:

- ImpossibleBench (https://arxiv.org/abs/2510.20270) and EvilGenie
  (https://arxiv.org/abs/2511.21654): frontier agents edit tests and special-case outputs when the
  task cannot be solved honestly.
- Anthropic (https://arxiv.org/abs/2511.18397): learned test-harness hacks such as `sys.exit(0)`
  generalize to broader misbehavior; the Claude 3.7 Sonnet system card names special-casing tests.
- A mining study of 327 agent PRs found relaxed assertions, swallowed errors, and added suppressions
  — with low per-detector precision, which is why these must stay advisory facts, never verdicts.

OpenLore already knows which files are tests (`test-file.ts`), which tests reach which symbols
(`select_tests`), and what a diff changed per symbol (`structural_diff`, content hashes). It does not
report any of these weakening shapes.

## What changes

A closed table of **weakening shapes**, each a registered advisory finding, computed over the diff
against a fixed baseline: the resolved merge-base, read through git. Never the agent's own last
commit, which would hide a weakening done in two steps. (Content hashes cannot serve: counting
assertions and comparing literals needs the baseline text.)

| Code | Shape (deterministic) |
|---|---|
| `test-removed` | a test function or test file present at the baseline is gone |
| `test-disabled` | a skip/only/focus marker added (`it.skip`, `xit`, `describe.only`, `@pytest.mark.skip`/`xfail`, `t.Skip`, `@Disabled`, `#[ignore]`) |
| `assertions-reduced` | a test's count of assertion calls drops (assertion call names per test framework, closed list) |
| `expected-value-changed` | a literal argument of an assertion changes while no production symbol reached by that test changed |
| `suppression-added` | `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `# noqa`, `# type: ignore`, `//nolint`, `#[allow(...)]`, `@SuppressWarnings` added |
| `error-swallowed` | a new catch/except whose body is empty or contains only calls from a closed per-language logging list (`console.*`, `logger.*`/`log.*`, `logging.*`, `print`, `fmt.Print*`), around a call that the baseline did not wrap |
| `check-config-relaxed` | in test-runner, coverage, lint, or CI config: an added exclude/ignore pattern, a lowered coverage threshold, an added `continue-on-error`, or a removed CI step that ran tests |

**The join no linter does:** every finding names the production symbols the weakened test reached at
the baseline (via `select_tests` reachability), so the receipt reads: "`it.skip` added to
`parses empty config` — this test was the only one reaching `parseConfig`, which the diff also
changes."

## Honesty contract

- Findings are **facts about the diff**, worded neutrally ("an assertion was removed"), never
  "cheating". A legitimate test cleanup produces the same fact; the human or agent decides.
- A language or framework outside the closed lists yields `not-assessed` for that file, never
  "no weakening".
- All codes are advisory by default; a team may gate any of them with `enforcement.policy`.

## Not built

Running tests; judging whether a test change was justified (no LLM); scanning the whole repo (diff
only); mutation testing.

## Impact

- Files: weakening detector (pure, per changed test/config file, re-reads baseline via git), finding
  registration, `verify_change` and `structural_diff` projection, `select_tests` join.
- Specs: `mcp-handlers` — 1 ADDED.
- Tool surface: none added.
