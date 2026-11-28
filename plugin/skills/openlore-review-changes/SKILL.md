---
name: openlore-review-changes
description: Review code changes using OpenLore risk, call, coverage, and cluster evidence without editing code. Use when asked for a change review, pre-PR safety check, or merge recommendation.
---

# openlore: Review Changes

Review a diff from structural evidence. Do not edit code in this skill.

## Step 1 — Scope

Confirm the repository and the base ref (default: `main`). Pass it as `baseRef`: without it,
`blast_radius` grades only uncommitted changes.

## Step 2 — What the diff reaches

Call `blast_radius` with `baseRef`. It returns the changed symbols with their caller count, risk
level, and layers crossed; each symbol's strongest test evidence (`asserts-on`, `exercises`,
`reaches`); the tests to run (`tests.files` lists the files); the decisions and memories anchored
to the changed code; and the specs that drifted.

Rank the changed symbols:

| Risk | Rule |
|------|------|
| High | Callers that cross a layer, or many callers, and no test that `asserts-on` it |
| Medium | Callers, with an asserting test |
| Low | No callers |

## Step 3 — Inspect each high-risk symbol

For each one, call `get_subgraph` with `direction: "both"` and `analyze_impact` (depth 2). State:

```
<symbol> (<file>):
  Callers outside the file: <count, files>
  Signature or contract changed: yes | no
  Strongest test evidence: asserts-on | exercises | reaches | none
  Verdict: safe | needs a direct test first | coordinate with callers
```

Check each claim you will make with `verify_claim` (for example kind `safe-to-change`, or `calls`).
Call `recall` for facts recorded about the symbol; a stale memory is not evidence.

## Step 4 — Report

- **Summary:** changed symbols, high-risk count, symbols with no asserting test.
- **Risk table** from Step 2, and the verdicts from Step 3.
- **Tests to run:** `tests.files` from `blast_radius`.
- **Recommendation:** safe to merge, merge after the named tests, or do not merge yet.

## Constraints

- Every risk statement names its proof: a caller, an edge, a test, or a `verify_claim` receipt.
- An unsupported language or a not-assessed result is reported as such, never as "safe".

## Close with one action per finding

- **Fix it** (or name the fix, since this skill does not edit), with the proof.
- **Record a decision** when the author accepted a risk on purpose:
  `openlore decisions record --title "<choice>" --rationale "<proof>" --files <paths>` where the
  CLI is installed; with the plugin alone, state the decision and its proof in your final message.
- **Raise it to the human** only when the evidence warrants it: a breaking change to a contract used
  outside the repository, overriding an accepted decision, an added secret, or a finding that
  cannot be settled from the evidence.
