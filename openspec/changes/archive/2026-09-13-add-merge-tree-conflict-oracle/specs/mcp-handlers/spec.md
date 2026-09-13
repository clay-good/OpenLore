# mcp-handlers spec delta

## ADDED Requirements

### Requirement: InFlightConflictsCarryATextualMergeVerdict

`map_in_flight_conflicts` SHALL annotate each conflict pair between two in-flight changes with a
textual merge verdict from a read-only `git merge-tree` simulation between the two tip commits over
their merge base: `textual-conflict` (git will not auto-merge; the conflicted files are named),
`clean-automerge` (git merges the text; the hazard is behavioral only), or `not-assessed` with a
detail. The simulation SHALL NOT modify the work tree, index, HEAD, refs, or object store of the
analyzed repository, and SHALL NOT run a merge driver or lazy-fetch command that the analyzed
repository chooses. A path changed by both sides with a non-default `merge` attribute,
`merge.renormalize`, or a submodule conflict SHALL make the pair `not-assessed`. A pair SHALL be `not-assessed`, never `clean-automerge`, when the merge base is
missing or ambiguous, a tip commit is not present locally, one side is an agent task, the pair spans
repositories, or the per-call simulation cap or time budget is reached. The symbol-level hazard classes are
unchanged. The landing suggestion for a `textual-conflict` pair SHALL say so and SHALL NOT call the
pair safe to land in either order.

#### Scenario: A clean auto-merge is distinguished from a real conflict

- **GIVEN** two in-flight branches that both modify the same function but in disjoint parts
- **WHEN** `map_in_flight_conflicts` assesses them
- **THEN** the hazard is retained and annotated `clean-automerge`
- **AND** two branches editing the same lines are annotated `textual-conflict` with the file named

#### Scenario: An unassessable merge is never reported clean

- **GIVEN** a pair whose merge base is missing (a shallow clone) or whose PR head commit is not local
- **WHEN** the map is built
- **THEN** the pair's verdict is `not-assessed` with a detail naming the cause

#### Scenario: The simulation cannot run repository-chosen code or write objects

- **GIVEN** a repository whose attributes select a merge driver command
- **WHEN** the merge is simulated
- **THEN** the driver command does not run
- **AND** the repository's object store is unchanged
