---
name: openlore-debug
description: Debug with OpenLore structural context, an explicit root-cause hypothesis, and RED/GREEN verification. Use when a bug, failure, or regression needs diagnosis and repair.
---

# openlore: Debug

Form an explicit hypothesis from structure before you read code. Do not browse files speculatively.

## Step 1 — Reproduce

Get the steps, the expected behavior, and the observed behavior. Run the repro, or a failing test,
and keep its output. If it does not reproduce, say so: a fix without a repro is a guess.

## Step 2 — Orient on the symptom

Call `orient` with a one-line summary of the symptom. Keep the top 3-5 functions, their
`callPaths`, and the `specDomains` that own them. If the repro is a request or event flow, call
`find_path` from the entry point to each candidate: the path is a graph fact, not a guess.

If the repository has written intent (`specDomains` is not empty), read the requirement the
behavior breaks. It defines what "correct" means.

## Step 3 — State the hypothesis

For the top two candidates, call `analyze_impact` (depth 2) and `recall` to see callers and any
known facts. Then write one falsifiable sentence before you open a file:

> Hypothesis: `applyRetry` does not reset `attempts` after a success, because `send` calls it
> before the counter is cleared.

It names a function, a mechanism, and a condition that reading the code can refute.

## Step 4 — Verify it

Call `get_function_skeleton` on the file, then read only the function you named.

| Result | Next |
|--------|------|
| Confirmed | Step 5 |
| Refuted | A new hypothesis from Step 3; after three, ask the user for more context |
| The cause is in a caller | `analyze_impact` one level up, then a new hypothesis |

## Step 5 — RED, then GREEN

Write a test that fails for the confirmed reason (RED). Make the smallest fix that turns it green.
Do not change code outside the scope you confirmed without orienting on the new scope.

## Step 6 — Check the blast radius

Call `blast_radius` on your diff. Run every file in its `tests.files`, not only yours. Use
`verify_claim` before you tell the user a structural fact (kind `safe-to-change` for "nothing else
depends on this").

## Step 7 — Record the invariant

State the invariant the bug broke in one sentence ("`applyRetry` must reset `attempts` after a
success"). If a spec owns the code, add it under `### Known Invariants` in that spec. If the bug is a pattern
that can recur elsewhere (ordering, caller contract, external state), append it to
`.claude/antipatterns.md` as `## AP-NNN — <name>`, with the rule and how to detect it.

## Constraints

- No source reading before the hypothesis. A hypothesis is required even when the cause looks obvious.
- No fix without a failing test, unless the user accepts that the fix is unverified.

## Close with one action per finding

- **Fix it**, with the failing test as proof.
- **Record a decision** when you chose one fix over another:
  `openlore decisions record --title "<choice>" --rationale "<proof>" --files <paths>` where the
  CLI is installed; with the plugin alone, state the decision and its proof in your final message.
- **Raise it to the human** in your final message only when the evidence warrants it: a breaking
  change to a contract used outside the repository, overriding an accepted decision, an added
  secret, or a finding you cannot settle from the evidence.
