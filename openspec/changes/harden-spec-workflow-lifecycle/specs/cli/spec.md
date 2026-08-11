## ADDED Requirements

### Requirement: Deterministic Mapping Refresh Command

The CLI SHALL provide `openlore mapping refresh` to derive the current deterministic spec link index from existing specs and the committed analysis generation, persist it as `mapping.json`, and summarize linked, ambiguous, unmapped, and stale requirements. The command SHALL perform no LLM call and SHALL exit nonzero only for an unusable analysis/spec input or an explicitly requested strict ambiguity policy.

#### Scenario: Refresh replaces LLM-owned mapping
- **GIVEN** existing specs and a current analysis but a missing or incompatible mapping cache
- **WHEN** `openlore mapping refresh` runs
- **THEN** it writes a provenance-bound mapping cache and prints unresolved or ambiguous links without invoking a generation provider

#### Scenario: Strict refresh exposes ambiguity to automation
- **GIVEN** one or more ambiguous requirement anchors
- **WHEN** refresh runs with the strict ambiguity option
- **THEN** it still writes the honest index, reports every bounded ambiguity with continuation/export guidance, and exits nonzero

### Requirement: Analysis Ownership Is Actionable From CLI

CLI analysis and status output SHALL expose the repository-scoped owner PID, stage, elapsed duration, and heartbeat age when analysis is active. The analyze command SHALL offer a wait/attach option and MUST NOT start a second full analysis merely because the first was launched by another frontend.

#### Scenario: CLI sees analysis started by MCP
- **GIVEN** an MCP process owns an active full analysis
- **WHEN** a user runs the CLI analyze command
- **THEN** the CLI reports the shared owner and either exits or follows it when wait mode is selected

### Requirement: Generation Preview Produces A Real Diff

`openlore generate --dry-run` SHALL run the selected generation workflow into isolated temporary output, perform no writes to project specs, mapping, configuration, manifest, backups, or analysis artifacts, and display the candidate spec/config changes as a diff or structured preview. The CLI SHALL disclose that provider calls and cost still occur. A separate `--plan` option SHALL provide the previous cheap no-provider step listing.

#### Scenario: Dry run previews generated specifications
- **GIVEN** a configured generation provider and current analysis
- **WHEN** `openlore generate --dry-run` runs
- **THEN** candidate specifications are generated in isolation, the proposed diff is returned, and the project tree remains unchanged

#### Scenario: Plan mode performs no provider call
- **GIVEN** a user only wants to inspect intended stages and domains
- **WHEN** `openlore generate --plan` runs
- **THEN** it lists the planned work, performs no provider call, and writes nothing

