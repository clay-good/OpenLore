# cli spec delta

## ADDED Requirements

### Requirement: ReviewCorpusCommandContract

The CLI SHALL expose a corpus-review command that compares the governance corpus at a base
reference against a head reference and reports the intent findings and verdict. Both references
SHALL accept either a git revision or a directory path, and the working tree SHALL be the default
head. The command SHALL support a human-readable mode and a machine-readable JSON mode carrying the
same findings and verdict.

The command SHALL exit successfully when the verdict is no-review-needed and when review is
recommended but no finding is classified blocking under the active enforcement policy; it SHALL
exit 1 when at least one finding is blocking. Operational or configuration failures SHALL exit 2.
A base reference that git cannot resolve SHALL be disclosed as an operational resolution failure
and SHALL NOT be silently replaced by a different reference — the same base-reference honesty the
other between-revisions commands follow.

All machine-readable output SHALL be written to standard output and all diagnostics to standard
error, so the JSON mode is pipeable. The command SHALL be deterministic: repeated runs against the
same two states produce byte-identical output, with no timestamps in the compared payload.

#### Scenario: The command reports findings and a verdict

- **GIVEN** a branch whose corpus weakened a requirement relative to its base
- **WHEN** the corpus-review command runs against that base
- **THEN** it prints each finding with the artifact, the finding code, and the reason
- **AND** it prints the verdict with the reasons that produced it

#### Scenario: Advisory findings do not fail the command

- **GIVEN** a corpus change whose findings are all advisory under the active policy
- **WHEN** the command runs
- **THEN** the findings are reported and the command exits successfully

#### Scenario: An unresolvable base reference is disclosed

- **GIVEN** a base reference git cannot resolve
- **WHEN** the command runs
- **THEN** the failure to resolve is stated explicitly
- **AND** the command does not quietly review against a different reference

#### Scenario: JSON output is pipeable

- **GIVEN** the command invoked in its machine-readable mode
- **WHEN** its standard output is captured
- **THEN** the captured bytes parse as the documented payload with no diagnostic text mixed in
