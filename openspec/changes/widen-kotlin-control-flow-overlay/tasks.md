# Tasks: widen Kotlin control-flow overlay

## Implementation
- [x] `when_expression` as a multi-way branch (subject and subject-less forms)
- [x] `try_expression` with `catch_block` and `finally_block` regions
- [x] `do_while_statement` as a post-test loop
- [x] Elvis as a branch with exit-edge detection; safe call as a skip branch
- [x] Compound assignment and increment/decrement in the def-use overlay
- [x] Expression-position `if`/`when`/`try`; remove the whole-function refusal
- [x] Labeled `return@`, `break@`, `continue@`
- [x] Parity test: the complexity `when` arm count equals the overlay arm count

## Conformance
- [x] One CFG fixture per construct with asserted block and edge counts
- [x] Fixture: `val v = if (c) a else b` yields an overlay with one branch
- [x] Fixture: `x ?: return` yields an exit edge
- [x] Fail-soft fixture: an unknown node type yields no overlay, not a partial one

## Verification
- [x] Reference corpus: share of Kotlin functions with an overlay, before and after
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinControlFlowOverlayCoversBranchingExpressions
