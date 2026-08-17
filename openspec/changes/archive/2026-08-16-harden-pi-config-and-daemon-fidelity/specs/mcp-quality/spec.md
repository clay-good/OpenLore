# mcp-quality spec delta

## ADDED Requirements

### Requirement: PiConfigWizardPreservesUnknownKeys

The Pi extension's configuration wizard SHALL preserve every top-level key in
`.openlore/config.json` it does not itself manage (`enforcement`, `impactCertificate`,
`specStore`, `contextInjection`, and any future block) when it writes the file, and SHALL
preserve unmanaged sibling keys within a block it partially edits. When the provider changes,
the wizard SHALL clear provider-coupled managed fields (model, compatibility URL, and TLS override)
rather than carrying an incompatible value to the new provider. The wizard SHALL auto-open only
when the config file is absent, not merely because a field it expects is missing, and SHALL refuse
to overwrite an existing malformed or non-object config.

#### Scenario: A governance policy survives a wizard save

- **GIVEN** a repo whose config carries `enforcement.policy` and `contextInjection.mode: off`
- **WHEN** a user changes the embedding URL in the Pi wizard and saves
- **THEN** the enforcement policy and injection setting are retained unchanged

#### Scenario: A provider-less config does not trigger onboarding

- **GIVEN** an existing config with governance settings but no `generation.provider`
- **WHEN** a Pi session starts
- **THEN** the wizard does not auto-open and the existing file remains unchanged

#### Scenario: A provider change preserves only compatible siblings

- **GIVEN** a generation block with a provider-coupled model and an unknown timeout setting
- **WHEN** the user selects a different provider
- **THEN** the timeout setting is retained and the old provider's model is removed

#### Scenario: Malformed config is never clobbered

- **GIVEN** an existing `.openlore/config.json` containing malformed JSON
- **WHEN** the user explicitly opens the Pi configuration command
- **THEN** Pi reports that repair is required and leaves the file byte-for-byte unchanged

### Requirement: PiDaemonFailuresAreBoundedAndHonest

The Pi extension SHALL bound the best-effort context-injection orient call with a timeout and
degrade to its pointer-line fallback on expiry, so daemon discovery plus orient share one bounded
first-turn deadline. The extension SHALL launch the package's own CLI with the current Node runtime,
without PATH lookup or a shell, and SHALL distinguish launch failure, startup preparation failure,
early exit, draining, and health timeout rather than uniformly advising the user to run
`openlore analyze`. Draining and health-timeout outcomes SHALL remain immediately retryable. A daemon
that becomes reachable after session start SHALL have its keepalive armed so it is not reaped
mid-session.

#### Scenario: An upgrade rebuild does not hang the first prompt

- **GIVEN** a schema-version bump that makes the daemon rebuild on first request
- **WHEN** the extension injects context before the first turn
- **THEN** the orient call times out to the pointer-line fallback and the turn proceeds

#### Scenario: A packaged daemon exits before health

- **GIVEN** the packaged daemon process launches and exits with a non-zero code before publishing health
- **WHEN** a tool call needs the daemon
- **THEN** Pi reports the early exit code and the serve-log remediation, not a misleading
  "run openlore analyze"

#### Scenario: A late daemon is retried promptly

- **GIVEN** daemon startup crosses the first-turn health deadline but becomes healthy immediately after it
- **WHEN** the next Pi tool call retries
- **THEN** Pi re-probes immediately instead of serving a cached failure for 30 seconds

### Requirement: PiInjectedContextIsBoundedAndCurrent

The Pi extension SHALL build before-agent context from the current event's `cwd` and `mode`, not
state captured at session start. Its specification index SHALL contain at most 50 sorted domain
entries and SHALL disclose the number of omitted domains when the repository contains more.

#### Scenario: The active root changes after session start

- **GIVEN** a session started in repository A and a before-agent event for repository B
- **WHEN** Pi builds injected context
- **THEN** the digest, specs, and mode behavior come from repository B

#### Scenario: A large specification corpus is bounded

- **GIVEN** a repository with 53 specification domains
- **WHEN** Pi builds the specification index
- **THEN** it emits the first 50 names in sorted order and an explicit "3 more domains" receipt
