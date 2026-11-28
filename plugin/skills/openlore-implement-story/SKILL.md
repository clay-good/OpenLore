---
name: openlore-implement-story
description: Implement a brownfield story with OpenLore orientation, risk checks, spec validation, tests, and drift detection. Use when asked to implement or continue a story in an existing codebase.
---

# openlore: Implement Story

Implement a story in existing code: find where it belongs, check what it touches, test it, and
check what the diff reaches.

## Step 1 — Read the story

Restate the outcome, the acceptance criteria, and the constraints in your own words. If the story
has a `## Risk Context` section (from `openlore-brainstorm`), read it first. If there is no
actionable request, ask one question before you start.

## Step 2 — Orient and weigh the risk

Call `orient` with the story. Keep the top functions, their `callPaths`, and the `specDomains`.
For each function you expect to change, call `analyze_impact` (depth 2). **If its `riskScore` is 70
or more, stop:** refactor that function first (the `openlore-plan-refactor` skill, where installed)
or make it a blocking task, and return to the story after.

| What you see | Do |
|--------------|----|
| Callers in many files or layers | Plan the change behind the current signature, or update every caller |
| A hub (very high fan-in) | Extend it; do not change its behavior for existing callers |

Call `verify_claim` with kind `tested` on each one: if it is not `confirmed`, write a
characterization test first. Call `recall` on those functions for facts recorded in earlier sessions.

## Step 3 — Check the written intent

When `specDomains` is not empty, read the requirements the story touches. If the story conflicts
with a requirement, stop and say so. If the repository has no specs, use the story and the tests
as the contract.

## Step 4 — Choose the insertion point

Call `suggest_insertion_points` with the story. Pick one and say why in one line. Then challenge
it before any code: name the callers that depend on it and the edge case the tests miss, check them
with `get_subgraph` or `find_path`, and apply any pattern in `.claude/antipatterns.md` if it exists.

## Step 5 — Implement

Make the smallest change that meets the acceptance criteria. Read a file with
`get_function_skeleton` first; open full bodies only where you edit.

## Step 6 — Test

Write tests for each acceptance criterion (see the `openlore-write-tests` skill). Each test asserts
on a real result.

## Step 7 — Check the diff

Call `blast_radius` on your diff. Run every file in its `tests.files`. Read each anchored decision
and memory it lists, and each spec it says drifted. Use `verify_claim` before you state a structural fact to the
user.

## Constraints

- No code before Step 4 is settled.
- Do not change behavior that existing callers rely on unless the story says so.

## Close with one action per finding

- **Fix it**, with a test or a `blast_radius` receipt as proof.
- **Record a decision** for each significant design choice:
  `openlore decisions record --title "<choice>" --rationale "<proof>" --files <paths>` where the
  CLI is installed; with the plugin alone, state the decision and its proof in your final message.
- **Raise it to the human** only when the evidence warrants it: a breaking change to a contract used
  outside the repository, overriding an accepted decision, an added secret, or a finding you cannot
  settle from the evidence.
