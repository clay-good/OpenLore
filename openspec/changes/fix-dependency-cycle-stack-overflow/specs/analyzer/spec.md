# analyzer spec delta

## ADDED Requirements

### Requirement: CycleDetectionIsStackSafe

Detecting cycles in the dependency graph SHALL NOT recurse to a depth that scales with the
dependency-chain length. The walk SHALL use an explicit, heap-allocated stack, so a repository with
a long import or dependency chain cannot overflow the call stack and abort the analysis.

A recursive DFS makes its depth equal to the chain length; a chain of a few thousand files then
throws `RangeError: Maximum call stack size exceeded`. This walk runs in every analysis and is not
inside a per-file exception boundary, so its overflow is terminal for the whole repository — unlike
a per-file walk, whose overflow degrades only that file.

#### Scenario: A deep dependency chain is analyzed

- **GIVEN** a repository whose files form a dependency chain thousands of files deep
- **WHEN** the dependency graph's cycles are detected
- **THEN** the computation completes without a stack-overflow error, whether or not the chain
  closes into a cycle

### Requirement: IterativeCycleDetectionPreservesResults

The stack-safe cycle detection SHALL produce the same result as the recursive detection it replaced:
the same cycles, each with the same node order, in the same overall order, with the same
deduplication of rotations.

#### Scenario: Iterative and recursive detection agree

- **GIVEN** any directed graph
- **WHEN** cycles are detected iteratively and by the reference recursion
- **THEN** the two results are identical — same cycles, same order, same rotation-deduplication

### Requirement: StyleFingerprintWalkIsStackSafeAndDeterministic

Tallying a file's style fingerprint SHALL walk the parsed tree without recursion depth that scales
with the tree's nesting, so a deeply-nested but valid file cannot overflow the stack and lose its
style contribution. The walk SHALL be pre-order with children visited in source order, producing
counters identical to the recursive walk on every file.

A recursive walk overflowed on a deeply-nested file; the throw was swallowed by the caller, dropping
the file's whole style contribution silently. Because the stack limit is environment-dependent, the
same repository could then yield different style fingerprints on different machines — a violation of
the artifact's determinism.

#### Scenario: A deeply-nested file keeps its style deterministically

- **GIVEN** a valid file whose AST nests far deeper than the JS call stack allows
- **WHEN** its style fingerprint is tallied
- **THEN** the tally completes, the file's style is present rather than silently dropped, and its
  shallow idioms are counted — identically on any environment
