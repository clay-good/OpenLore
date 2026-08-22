# cli spec delta

## ADDED Requirements

### Requirement: DriftHookDistinguishesFailureFromDrift

The drift CLI SHALL exit with distinct codes for "drift found" and "the check could not run"
(missing configuration, missing specs, not a git repository, or an internal error), and the
installed pre-commit drift hook SHALL branch on that code: drift blocks with the drift message;
a could-not-check outcome SHALL be reported honestly as an infrastructure failure with its
reason, SHALL NOT block the commit (blocking on infrastructure failure is never implied), and
SHALL NOT be labeled as detected drift. The hook SHALL prefer a repo-local `openlore` binary
when one is present, and any fallback to a published version SHALL be disclosed in the hook
itself.

#### Scenario: A missing config is not "drift"

- **GIVEN** the installed drift hook in a repo with no openlore configuration
- **WHEN** a commit is made
- **THEN** the hook reports that drift could not be checked and why
- **AND** the commit proceeds, and no "Spec drift detected!" message is printed

#### Scenario: Real drift still blocks with the drift message

- **GIVEN** staged changes producing drift at or above the hook's threshold
- **WHEN** a commit is made
- **THEN** the CLI exits with the drift-found code and the hook blocks with the drift message,
  exactly as before

#### Scenario: The failure branch does not swallow evidence

- **GIVEN** the drift CLI throwing an internal error under the hook
- **WHEN** the hook reports the could-not-check outcome
- **THEN** the underlying error reason is visible in the hook output, not discarded

### Requirement: DriftSummariesRenderEveryIssueKind

Every drift summary surface — the CLI summary block, the pre-commit hook's embedded summary, and
the issue-kind labels — SHALL render every issue kind the detector can count, including the
memory-staleness kinds (`memoryDrifted`, `memoryOrphaned`). A run SHALL never print a
"no issues" summary while exiting non-zero for detected drift.

#### Scenario: A memory-only drift run is summarized truthfully

- **GIVEN** a drift run whose only issues are memory-staleness kinds
- **WHEN** the summary is printed
- **THEN** the summary lists the memory-kind counts
- **AND** "No issues found" is not printed alongside a "Drift detected" exit

#### Scenario: The hook summary matches the CLI summary's reach

- **GIVEN** the installed hook rendering its embedded issue summary
- **WHEN** memory-staleness issues are present in the JSON it parses
- **THEN** those counts appear in the hook's summary line like any other kind
