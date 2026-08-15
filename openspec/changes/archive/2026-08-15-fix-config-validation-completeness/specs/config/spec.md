# config spec delta

## ADDED Requirements

### Requirement: RequiredConfigSectionsAreValidatedAsRequired

The configuration schema SHALL distinguish a section that is absent from one that is present and
malformed, and SHALL report a missing required section as a finding naming the key and the remedy. A
section the schema marks required SHALL be one the code may dereference; a section the code tolerates
being absent SHALL NOT be marked required. The two SHALL be kept in agreement by a check that fails
when they drift, so "required by the schema" and "dereferenced unconditionally by the code" cannot
diverge silently.

#### Scenario: An empty config is diagnosed, not blessed

- **GIVEN** a `.openlore/config.json` containing `{}`
- **WHEN** the configuration is validated
- **THEN** a finding names each missing required section and how to restore it

#### Scenario: An optional section may be absent without a finding

- **GIVEN** a config omitting a section the code reads defensively
- **WHEN** the configuration is validated
- **THEN** no finding is produced for that section

#### Scenario: Schema and code cannot drift

- **GIVEN** a section marked required in the schema
- **WHEN** the drift check runs
- **THEN** it passes only while the code dereferences that section unconditionally, and fails if
  either side changes without the other

### Requirement: DeclaredFieldsAreTypeCheckedOrNotClaimed

Every field the schema declares SHALL be type-checked against its declared type. A field the
validator does not check SHALL NOT be counted toward any claim that the configuration is well-typed.
A validation summary SHALL describe only what was actually verified.

#### Scenario: A wrong scalar type is reported

- **GIVEN** a config setting a numeric field to a string, such as `analysis.maxFiles: "lots"`
- **WHEN** the configuration is validated
- **THEN** a finding names the key, the declared type, and the type received

#### Scenario: Unchecked fields are not counted as verified

- **GIVEN** a schema containing a field the validator cannot check
- **WHEN** the configuration is validated and reported
- **THEN** the report does not describe that field as verified

### Requirement: ConfigReadsFailWithAttributableErrors

A read of configuration that encounters a missing or malformed section SHALL produce an error
attributing the failure to the configuration file and the offending key, with a remedy. A raw
runtime `TypeError` naming an internal property SHALL NOT be the user-visible failure for a
configuration problem.

#### Scenario: A missing section produces an attributable error

- **GIVEN** a config missing the section a command requires
- **WHEN** that command runs
- **THEN** the error names `.openlore/config.json`, the missing key, and the remedy
- **AND** the message contains no internal property-access text such as `Cannot read properties of undefined`
