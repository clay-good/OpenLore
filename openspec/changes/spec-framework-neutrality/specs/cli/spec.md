## ADDED Requirements

### Requirement: FirstRunCreatesNoSpecFolder

`openlore init`, `openlore install` and the background cold-start setup SHALL NOT create
`openspec/` or any other spec folder. A spec folder SHALL be created only by a command that writes
spec output there, such as `openlore generate`. First run MAY add `.openlore/` to `.gitignore`; that
edit SHALL be exactly one added line, SHALL be skipped when Git already ignores the folder, and
SHALL be named once in the first-run output.

#### Scenario: Install in a repository with no specs

- **GIVEN** a Git repository with no spec folder
- **WHEN** `openlore install` completes
- **THEN** no `openspec/` folder exists
- **AND** the only change to tracked or trackable files outside `.openlore/` and the agent wiring
  is one added `.gitignore` line, `.openlore/`, which the output names

#### Scenario: Generate creates the folder it writes

- **GIVEN** the same repository
- **WHEN** `openlore generate` writes specs
- **THEN** `openspec/specs/` is created by that command

#### Scenario: The folder is already ignored

- **GIVEN** a repository whose `.gitignore` already ignores `.openlore/`
- **WHEN** first run completes
- **THEN** `.gitignore` is not changed

## MODIFIED Requirements

### Requirement: FreshInstallEmptinessIsNotAWarning

When no spec source exists, first-run messages SHALL present it as the normal state ("no spec
source found") and SHALL NOT name `openlore generate` as a step.

#### Scenario: The spec-index skip note on a fresh install

- **GIVEN** a fresh `openlore install` in a repository with no spec source
- **WHEN** the index build reports the skipped spec index
- **THEN** the message is informational ("no spec source found") and does not name
  `openlore generate`

### Requirement: ChangeStatusIsComputedFromDocumentedEvidence

`openlore change-status` SHALL compute each open change's status from the documented evidence
signals — the `change: <name>` marker scan over `src/` (with file:line receipts) and the
per-requirement presence of the change's delta requirements in the target main spec (keyed by
requirement name within the target domain) — via a fixed verdict rule table (`built`,
`built-unmarked` with the verify-against-code caveat verbatim, `partially-built`, `unbuilt`,
`not-assessed` with the parse error). Every output SHALL state that the verdict reflects
evidence signals, not runtime correctness. `--table` SHALL emit only the open-changes table
body in the audit file's format to stdout, and tasks.md checkboxes SHALL appear only as a
display column, never as a verdict input. When the `openspec` validator cannot be run (the binary
is missing or not executable), the validation receipt SHALL say `not assessed` with the reason; it
SHALL NOT be reported as a failed validation and SHALL NOT lower the verdict.

#### Scenario: Synced-but-unmarked carries the caveat

- **GIVEN** a change whose delta requirements are all present in the main spec and whose name
  appears in no `src/` marker
- **WHEN** `change-status` runs on it
- **THEN** the verdict is `built-unmarked` with the per-requirement sync receipts and the
  verify-against-code caveat, and the evidence-not-correctness statement is present

#### Scenario: A malformed delta is not-assessed

- **GIVEN** a change whose spec delta fails to parse
- **WHEN** `change-status` runs
- **THEN** the verdict is `not-assessed` with the parse error — never `unbuilt`

#### Scenario: The openspec binary is missing

- **GIVEN** an open change and a `PATH` with no `openspec` binary
- **WHEN** `change-status` runs
- **THEN** the validation receipt is `not assessed` and names the missing CLI
- **AND** the verdict is the one the evidence signals give, and the change is not an archivable
  candidate
