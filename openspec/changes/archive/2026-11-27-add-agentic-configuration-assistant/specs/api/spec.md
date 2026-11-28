# Programmatic API specification delta

## ADDED Requirements

### Requirement: ConfigurationManagementIsDaemonIndependentAndDependencyLight

The package SHALL expose a versioned configuration-management API for inspection, preview,
authorized application, verification and revert through a dependency-light entry point.
Observational operations SHALL work without a generation provider, structural index or live
daemon and SHALL NOT import or start the analyzer as an inspection prerequisite. Host roots,
permissions and lifecycle callbacks SHALL be passed separately from repository evidence.

#### Scenario: An embedding host has no usable daemon
- **GIVEN** a host with only the installed OpenLore package and an incompatible or absent daemon
- **WHEN** it imports the configuration entry point and inspects its project
- **THEN** it receives configuration/runtime evidence without starting a daemon, analysis or LLM

#### Scenario: Inspection runs without host mutation permissions
- **GIVEN** a read-only host authorization for the selected repository
- **WHEN** the host requests inspection or preview
- **THEN** available evidence and a plan can be returned without mutating files or processes

### Requirement: ConfigurationOperationsReturnComparableTypedReceipts

The API SHALL return versioned reports, revision-bound plans and per-phase receipts that distinguish
blocked, stale, applied-pending-verification, partial, failed, verified and reverted results.
Operations SHALL honor cancellation and bounded work, avoid process exits and console output,
and not persist configuration during a read. Credentials and private authorization material SHALL
not appear in diagnostics, shareable plans or receipts.

#### Scenario: A caller cancels a bounded survey
- **GIVEN** an inspection with a caller cancellation signal
- **WHEN** cancellation occurs
- **THEN** work stops through the documented typed cancellation contract without config or runtime mutation

#### Scenario: Runtime activation fails after config publication
- **GIVEN** config publication succeeded but the host cannot restart its daemon
- **WHEN** application returns
- **THEN** the receipt separately reports the published revision and pending or failed runtime effect
- **AND** it neither claims verified success nor silently restores an earlier whole-file snapshot
