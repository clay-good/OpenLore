# cli spec delta

## ADDED Requirements

### Requirement: PushedEvidenceYieldIsMeasuredLocally

Each line a hook moment prints to the agent SHALL be recorded in the per-session record with its
moment, its kind from a closed list, and the files, symbols, and test paths it names, never its
text. A line SHALL be marked used when, later in the same session, the agent reads or edits a named
file, runs a command that holds a named test path, or calls an OpenLore tool on a named symbol.
The records SHALL NOT be sent anywhere.

#### Scenario: A followed line counts as used

- **GIVEN** a first-touch briefing that named caller file `src/api/routes.ts`
- **WHEN** the agent later reads `src/api/routes.ts` in the same session
- **THEN** that line is recorded as used

#### Scenario: No text is stored

- **WHEN** a pushed line is recorded
- **THEN** the record holds its moment, kind, and references, and none of its words

### Requirement: StatusReportsEvidenceYield

`openlore status` SHALL report, per moment and kind over the kept sessions, the lines pushed, the
lines used, and the share used, and SHALL name each kind pushed 20 times or more with no use. The
agent's hook output SHALL NOT change.

#### Scenario: An ignored kind is named

- **GIVEN** 25 pushed `catch-up-hub` lines in the kept sessions and none used
- **WHEN** `openlore status` runs
- **THEN** it names `catch-up-hub` as a candidate to cut or fix

#### Scenario: No records

- **GIVEN** a repository where no hook printed a line
- **WHEN** `openlore status` runs
- **THEN** it prints no yield line and exits 0
