# drift spec delta

## ADDED Requirements

### Requirement: ChangedFilePathsAreUnquoted

Changed-file detection SHALL return literal repo-relative paths for every changed file regardless
of filename encoding: the `git diff` invocations feeding it (`--name-status` and `--numstat`)
SHALL disable git path quoting so a non-ASCII filename is never rendered as a quoted
octal-escaped string. Downstream consumers of the changed-file set (drift detection, structural
diff, blast radius, impact certificates, diff-scoped test selection) MUST receive such files as
ordinary members of the set — a quietly smaller result presented as complete is a defect, not a
degraded mode.

#### Scenario: A changed non-ASCII file appears in the diff set

- **GIVEN** a branch that modifies `src/café.ts`
- **WHEN** changed-file detection runs against the base ref
- **THEN** the changed-file set contains `src/café.ts` (status and line stats attached), and
  drift/blast-radius consumers see the file — it is not dropped by a failed path join

#### Scenario: Rename records survive unquoted

- **GIVEN** a commit renaming `src/café.ts` to `src/cafe.ts`
- **WHEN** `--name-status` output is parsed
- **THEN** both old and new paths are literal and the rename is recorded with the correct pair
