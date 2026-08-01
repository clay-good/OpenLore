# drift spec delta

## ADDED Requirements

### Requirement: UncommittedChangesCarryRealLineCounts

When drift detection includes staged or working-tree changes in its changeset, the system SHALL
compute real addition/deletion line counts for those changes (via `git diff --cached --numstat`
and `git diff --numstat`, merged per path with the commit-range numstat) and SHALL derive issue
severity and issue messages from those real counts. A staged or working-tree change SHALL NOT be
silently assigned zero additions and deletions, and drift output SHALL NOT report "+0/-0 lines"
for a file whose diff is non-empty.

#### Scenario: A staged change crosses the severity threshold

- **GIVEN** a 40-line staged (uncommitted) change to a spec-mapped source file
- **WHEN** `openlore drift` runs with unstaged/staged changes included
- **THEN** the gap issue reports the real added/removed line counts
- **AND** its severity is computed from those counts (`warning` at > 5 changed lines), not `info`

#### Scenario: The pre-commit drift hook can block on the commit being made

- **GIVEN** the installed drift hook running `openlore drift --fail-on warning`
- **AND** a staged change large enough that its real line counts meet the warning threshold
- **WHEN** the hook runs at commit time
- **THEN** the drift check fails the threshold and the hook blocks, because severity saw the
  real counts of the very changes being committed

#### Scenario: Staged and working-tree edits to the same file merge

- **GIVEN** a file with both staged and unstaged modifications
- **WHEN** the changeset is built
- **THEN** the file's reported counts are the per-path merge of both diffs, never zero

### Requirement: ADRIdentityIsNormalizedAcrossDriftDetection

The system SHALL apply one canonical ADR id normalization to both sides of ADR drift detection —
the ids extracted from changed ADR files and the ids keyed in the ADR map — so that zero-padded
and unpadded forms of the same ADR ("ADR-23", "ADR-023", "ADR-0023") compare equal. Updating an
ADR file in the same changeset as code in one of its related domains SHALL suppress the
`adr-gap` issue for that ADR.

#### Scenario: Updating a zero-padded ADR alongside governed code suppresses adr-gap

- **GIVEN** `openspec/decisions/adr-0023-*.md` whose header reads `# ADR-0023: ...`
- **AND** a changeset containing both that ADR file and a code change in one of its related
  domains
- **WHEN** ADR drift detection runs
- **THEN** no `adr-gap` issue is reported for ADR-0023

#### Scenario: Code changed without the ADR still reports the gap

- **GIVEN** a code change in a domain related to an ADR that is not in the changeset
- **WHEN** ADR drift detection runs
- **THEN** the `adr-gap` issue is reported for that ADR, exactly as before

#### Scenario: Both halves are tested in one format

- **GIVEN** the unit tests for ADR extraction and adr-gap suppression
- **WHEN** they exercise the pipeline
- **THEN** the id format produced by extraction is the id format consumed by suppression, so a
  format mismatch between the halves cannot pass the suite
