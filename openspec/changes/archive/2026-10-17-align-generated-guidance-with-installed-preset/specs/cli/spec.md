## ADDED Requirements

### Requirement: InstallRegeneratesGuidanceOnPresetChange

`openlore install` SHALL pass the effective wired preset to guidance generation, and SHALL rewrite the managed guidance block whenever that preset differs from the one the existing block was written for. The install summary SHALL name the preset the guidance now assumes.

Content outside the managed block SHALL remain untouched.

#### Scenario: Reinstalling with a wider preset updates the guidance

- **GIVEN** a repository whose guidance was generated for the default preset
- **WHEN** `openlore install --preset full` is run
- **THEN** the managed block is rewritten for the full surface and the summary names it

#### Scenario: Reinstalling with the same preset is idempotent

- **GIVEN** a repository already installed with a given preset
- **WHEN** install runs again with that preset
- **THEN** the managed block is unchanged

#### Scenario: Unmanaged content is preserved

- **GIVEN** an agent configuration file with hand-written sections around the managed block
- **WHEN** the block is rewritten for a new preset
- **THEN** only the managed block changes
