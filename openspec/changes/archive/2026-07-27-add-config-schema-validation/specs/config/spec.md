# config spec delta

## ADDED Requirements

### Requirement: ConfigUnknownKeysAreDisclosed

Reading `.openlore/config.json` SHALL validate the parsed object against a deterministic schema
derived from the `OpenLoreConfig` type, with a CI completeness test binding the validator to the
type so a new config field cannot ship unvalidated. An unknown key SHALL produce a warning naming
the key and, where a known key is within a small edit distance, a did-you-mean suggestion; a
type-mismatched value SHALL produce a warning naming the expected shape. Findings SHALL surface on
CLI config reads (deduplicated per process) and in `openlore doctor`. Validation SHALL never be a
hard failure: an unrecognized key — including one written by a newer OpenLore — is disclosed and
then ignored, so a newer config under an older openlore degrades gracefully rather than crashing.

#### Scenario: A typo'd key is disclosed, not silently dropped

- **GIVEN** a config containing `pancResponse` instead of `panicResponse`
- **WHEN** the config is read by a CLI command
- **THEN** a warning names `pancResponse` as unknown and suggests `panicResponse`
- **AND** behavior otherwise proceeds with defaults, as today

#### Scenario: A valid config stays silent

- **GIVEN** a config using only known keys with correctly-typed values
- **WHEN** the config is read
- **THEN** no validation warning is emitted and behavior is unchanged

#### Scenario: A newer config degrades gracefully

- **GIVEN** a config containing a key introduced by a newer OpenLore version
- **WHEN** an older openlore reads it
- **THEN** the key is disclosed as unknown (possibly from a newer version) and ignored; the read
  succeeds

#### Scenario: The validator cannot drift from the type

- **GIVEN** a field added to `OpenLoreConfig` with no corresponding validator entry
- **WHEN** CI runs the completeness test
- **THEN** the test fails, naming the unbound field

### Requirement: ConfigVersionIsChecked

The `version` stamp written into `.openlore/config.json` SHALL be read back and acted on: the
stamp SHALL be bumped whenever the config schema changes; a config with an older stamp SHALL be
deterministically migrated where a migration is defined and otherwise explicitly reported (naming
the writing version and the affected fields); a config with a newer stamp SHALL be disclosed as
newer and read with the graceful-degradation behavior. Version handling SHALL never hard-fail a
read.

#### Scenario: An older config is migrated or reported

- **GIVEN** a config whose version stamp predates a schema change
- **WHEN** the config is read
- **THEN** a defined migration is applied deterministically, or the skew is explicitly reported
  with the recovery guidance — never silently misread

#### Scenario: A newer stamp is disclosed

- **GIVEN** a config whose version stamp is newer than the running openlore knows
- **WHEN** the config is read
- **THEN** the skew is disclosed and unknown content is ignored gracefully; the read succeeds
