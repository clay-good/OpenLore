# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ChangedFunctionsReportProvenUnreleasedResourcePaths

For each resource acquired inside a function that the diff changed, `verify_change` and the
`after-tools` hook moment SHALL report an advisory `resource-unreleased-on-path` finding for every
path from the acquisition to a function exit that has no release and that the base commit did not
have, with the file, the branch or throw line, and the exit reached. Acquire, release, and
auto-release scope forms SHALL come from a closed per-language table.

#### Scenario: An added early return that skips the release is reported

- **WHEN** a change adds a conditional return between a handle's `open` and its `close`
- **THEN** `verify_change` and the `after-tools` receipt report `resource-unreleased-on-path` with
  the return line and the exit it reaches

#### Scenario: Scope-based release is silent

- **WHEN** the changed function acquires a resource inside `with`, `defer`, `using`, or
  `try/finally`, with a throw inside that scope
- **THEN** no finding is reported

#### Scenario: An open exception path names its exception

- **WHEN** a changed function calls something that can throw a typed exception between acquire and
  release
- **THEN** the finding names that exception type from the error-propagation analysis

### Requirement: ResourceFindingsNeverClaimSafety

The system SHALL report only paths it can prove lack a release. A resource that is returned,
stored outside the function, passed to an unresolved call, or paired outside the table SHALL be
counted as not assessed and SHALL NOT be reported as a leak. A function in an unsupported language
SHALL be counted as not assessed. No output SHALL state that a resource is correctly released.

#### Scenario: Ownership transfer is not a leak

- **WHEN** a changed function acquires a resource and returns it to its caller
- **THEN** no finding is reported and the not-assessed count increases by one

#### Scenario: Silence is not a safety claim

- **WHEN** a changed function yields no finding
- **THEN** the output does not say the resource is released or the function is safe
