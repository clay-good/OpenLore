# cli spec delta

## ADDED Requirements

### Requirement: DoctorsConfigVerdictIsSupportedByItsEvidence

`openlore doctor`'s configuration check SHALL report a passing verdict only when the configuration it
examined would actually be usable by the commands that read it. A configuration that causes a primary
command to fail SHALL NOT receive a passing verdict from `doctor`. The check's summary text SHALL
describe what it verified, and SHALL NOT claim coverage — such as "all keys known and well-typed" —
broader than the validation it performed.

#### Scenario: A config that crashes analyze does not pass doctor

- **GIVEN** a `.openlore/config.json` missing a section `openlore analyze` requires
- **WHEN** `openlore doctor` runs in that repository
- **THEN** its configuration check reports a finding naming the missing key and the remedy, and does
  not report a clean verdict

#### Scenario: A sound config still passes

- **GIVEN** a configuration written by `openlore init`
- **WHEN** `openlore doctor` runs
- **THEN** the configuration check passes and adds no findings

#### Scenario: The verdict text matches the coverage

- **GIVEN** a configuration containing a field the validator does not type-check
- **WHEN** `openlore doctor` reports the configuration check
- **THEN** its summary does not assert that every value was type-checked

### Requirement: DoctorAndTheCommandsAgreeAboutConfiguration

`doctor` and the commands that consume configuration SHALL derive their verdicts from the same
validator, so the two cannot disagree about the same file. A configuration rejected by a command
SHALL be reported as a finding by `doctor`, and one `doctor` passes SHALL be accepted by the
commands.

#### Scenario: Both surfaces reach the same conclusion

- **GIVEN** any `.openlore/config.json`
- **WHEN** `openlore doctor` and `openlore analyze` are both run against it
- **THEN** either both accept it, or `doctor` reports a finding describing why the command rejected it
