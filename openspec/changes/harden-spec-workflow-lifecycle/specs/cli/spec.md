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

### Requirement: Generation Planning Remains Free And Preview Is Explicitly Paid

`openlore generate --dry-run` and its explicit `--plan` alias SHALL list the selected generation workflow without resolving, constructing, or calling a provider and without writing. `openlore generate --preview` SHALL run the selected workflow into isolated temporary output, perform no writes to project specs, mapping, configuration, manifest, backups, or analysis artifacts, display a normalized summary of candidate specification changes, and disclose that provider calls and cost occur.

#### Scenario: Paid preview generates candidate specifications
- **GIVEN** a configured generation provider and current analysis
- **WHEN** `openlore generate --preview` runs
- **THEN** candidate specifications are generated in isolation, the proposed diff is returned, and the project tree remains unchanged

#### Scenario: Dry run performs no provider call
- **GIVEN** a user only wants to inspect intended stages and domains
- **WHEN** `openlore generate --dry-run` or `openlore generate --plan` runs
- **THEN** it lists the planned work, performs no provider call, and writes nothing

#### Scenario: Preview preserves real write-mode semantics
- **GIVEN** current specs, configuration, and stage cache exist
- **WHEN** preview runs in replace, merge, skip, scoped, forced, or custom-output mode
- **THEN** its isolated candidate has the same result an applied run would produce, while symlinks and special files from the source trees are not copied or followed

#### Scenario: Preview is interrupted
- **GIVEN** a preview workspace contains provider logs or generated candidates
- **WHEN** the process receives SIGINT or SIGTERM
- **THEN** the workspace is registered with the shared shutdown cleanup and is removed before exit

### Requirement: Repository Configuration Cannot Select A Remote Credential Destination

A non-loopback OpenAI-compatible endpoint from repository configuration MUST be ignored. A remote compatibility endpoint MAY be used only when supplied through an operator-controlled command/API option or environment variable.

#### Scenario: A clone redirects the compatibility provider
- **GIVEN** repository configuration names a remote compatibility endpoint and the operator has an API key
- **WHEN** generation resolves its provider
- **THEN** no request or credential is sent to that endpoint unless the operator independently selected it

### Requirement: Domain Selection Uses One Canonical Identity

Planning and applied generation SHALL resolve case and punctuation through the same normalized domain identity, reject unknown names, and fail closed when distinct detected names collide after normalization.

#### Scenario: Display name contains spaces
- **GIVEN** analysis detects `User Accounts`
- **WHEN** a user selects `user-accounts`
- **THEN** planning and applied generation both select the same domain and write `specs/user-accounts/spec.md`
