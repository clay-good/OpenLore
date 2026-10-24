# Tasks: widen Kotlin control-flow overlay

## Implementation
- [ ] `when_expression` as a multi-way branch (subject and subject-less forms)
- [ ] `try_expression` with `catch_block` and `finally_block` regions
- [ ] `do_while_statement` as a post-test loop
- [ ] Elvis as a branch with exit-edge detection; safe call as a skip branch
- [ ] Compound assignment and increment/decrement in the def-use overlay
- [ ] Expression-position `if`/`when`/`try`; remove the whole-function refusal
- [ ] Labeled `return@`, `break@`, `continue@`
- [ ] Parity test: the complexity `when` arm count equals the overlay arm count

## Conformance
- [ ] One CFG fixture per construct with asserted block and edge counts
- [ ] Fixture: `val v = if (c) a else b` yields an overlay with one branch
- [ ] Fixture: `x ?: return` yields an exit edge
- [ ] Fail-soft fixture: an unknown node type yields no overlay, not a partial one

## Verification
- [ ] Reference corpus: share of Kotlin functions with an overlay, before and after
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinControlFlowOverlayCoversBranchingExpressions
