# cli spec delta

## ADDED Requirements

### Requirement: FirstRunCTAsAreGatedOnTheirPreconditions

A call-to-action printed by install or analyze SHALL NOT advertise a command whose precondition
is already known to fail against the state just built. When the precondition fails, the CTA SHALL
be omitted or replaced by a factual statement of why it does not apply to this repository.

#### Scenario: The prove pointer is not printed for a graph that cannot support it

- **GIVEN** `openlore install` on a repository whose just-built call graph has no function with
  two or more callers
- **WHEN** the install epilogue is printed
- **THEN** it does not advertise `openlore prove --estimate` as-is; it either omits the pointer
  or states that the repo is below prove's measured-projection threshold, with the measured value

### Requirement: PreconditionRefusalsCarryAReceipt

A command that refuses to run because a structural precondition fails SHALL name the measured
value and the required threshold, and SHALL suggest only applicable next actions.

#### Scenario: Prove explains its refusal

- **GIVEN** a repository where 0 functions have ≥ 2 callers
- **WHEN** `openlore prove --estimate` runs
- **THEN** the message states the measured count, the required count, and that nothing is wrong
  with the installation

### Requirement: FreshInstallEmptinessIsNotAWarning

When an expected-empty state was created by the current install/init flow (an empty
`openspec/specs` directory), subsequent first-run messages SHALL present it as the normal state
with an optional next step — including any secondary precondition of that step (LLM provider for
`generate`) — not as a warning about a directory the user made.

#### Scenario: The spec-index skip note on a fresh install

- **GIVEN** a fresh `openlore install` that created `openspec/specs`
- **WHEN** the index build reports the skipped spec index
- **THEN** the message is informational ("no specs yet"), names `openlore generate` as optional,
  and mentions that generation needs an LLM provider

### Requirement: UninstallDisclosesWhatItKeeps

`openlore install --uninstall` SHALL end its summary by naming the paths it deliberately keeps
(the `.openlore/` data directory: index, decisions, memories) and the command to remove them.

#### Scenario: Uninstall names the kept data directory

- **GIVEN** a repository with an initialized `.openlore/` store
- **WHEN** `openlore install --uninstall` completes
- **THEN** the summary lists `.openlore/` as kept and shows how to delete it
