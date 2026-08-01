# mcp-handlers spec delta

## ADDED Requirements

### Requirement: StructuralDiffReadsOldContentAtTheMergeBase

The system SHALL read a structural diff's OLD file content from the same git point its
changed-file list is scoped to: for the working-tree comparison, the merge-base of the resolved
base ref and HEAD; for an explicit two-ref comparison, the merge-base of the resolved base ref and
the head ref (with three-dot file-list semantics). When no common ancestor exists, the system
SHALL fall back to the resolved ref's tip, mirroring the file-list fallback. Every downstream
consumer of the old snapshot — signature changes, stale callers, and the realized write-footprint
used for footprint-escape detection — SHALL therefore attribute only branch-side edits to the
change, never drift the base branch accrued after the branch point. A snapshot whose graph build
fails SHALL be disclosed as a parse-failure boundary in the response, never silently compared as
an empty graph.

#### Scenario: An advanced base does not misattribute main-side edits

- **GIVEN** a branch whose base ref has advanced past the branch point
- **AND** a file changed on both the branch and the base since the branch point
- **WHEN** `structural_diff` runs the working-tree comparison
- **THEN** the delta contains only branch-side changes
- **AND** a function added on the base after the branch point is not reported as removed

#### Scenario: Footprint-escape findings rest on the branch's own writes

- **GIVEN** the same advanced-base repository and an opt-in `declaredFootprint`
- **WHEN** `structural_diff` computes the realized write-footprint
- **THEN** base-side edits produce no out-of-scope-write or removed-symbol escape
- **AND** no footprint-escape governance finding is emitted for them

#### Scenario: The explicit two-ref path uses merge-base semantics

- **GIVEN** `structural_diff` called with a `baseRef` whose tip is ahead of the `headRef` branch point
- **WHEN** the two-ref comparison runs
- **THEN** files changed only on the base side are excluded from the delta
- **AND** old content is read at the merge-base of the two refs

#### Scenario: A snapshot build crash is a disclosed boundary

- **GIVEN** a changed file whose snapshot graph build throws
- **WHEN** `structural_diff` returns
- **THEN** the response names the failed snapshot in its soundness caveats
- **AND** the delta is not presented as an authoritative all-added or all-removed comparison
