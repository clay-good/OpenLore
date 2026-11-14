## ADDED Requirements

### Requirement: SpecRootIsOptionalAndAdrFoldersAreConfigurable

`openspecPath` SHALL be an optional configuration key. A configuration without it SHALL validate
with no finding, and first run SHALL NOT write it unless an OpenSpec corpus was detected or the user
gave a path. A configuration that has it SHALL be read as before. The optional key `adrPaths` SHALL
name extra folders, inside the repository, that are read for decision records; OpenLore SHALL NOT
write to them.

#### Scenario: A config with no spec root is valid

- **GIVEN** a `.openlore/config.json` with no `openspecPath`
- **WHEN** the configuration is validated
- **THEN** no finding is produced for that key

#### Scenario: An existing config keeps working

- **GIVEN** a configuration written by an earlier version with `openspecPath: "./openspec"`
- **WHEN** it is read
- **THEN** the spec root resolves as it did before

#### Scenario: An ADR folder outside the repository is refused

- **GIVEN** `adrPaths: ["../other-repo/docs/adr"]`
- **WHEN** the configuration is validated
- **THEN** a finding names the key and the path, and that folder is not read
