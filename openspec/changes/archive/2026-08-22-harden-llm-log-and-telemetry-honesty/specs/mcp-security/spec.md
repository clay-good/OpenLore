# mcp-security spec delta

## ADDED Requirements

### Requirement: LlmLogPersistenceIsDisclosedRedactedAndBounded

OpenLore-owned CLI and API paths SHALL persist LLM request logs only when
`OPENLORE_LLM_LOGS=1`. When OpenLore persists an LLM request log to disk, it SHALL redact secrets on BOTH the
request and the response side using the shared redaction module, SHALL bound the logs with a
retention cap of six matching files or 300 MB, and SHALL write without overwriting a concurrent
log. An OpenLore-owned path that resolves outside the project root at the start of persistence
SHALL be rejected, and a retention failure SHALL NOT leave a newly published log beyond the
bound. Explicit `LLMService` consumers MAY opt in through the service option when they also supply
an explicit trusted `logDir` or a confinement `logRoot`. The gitignored status
of the log directory bounds exposure to local disk but SHALL NOT be treated as a substitute for
disclosure or redaction.

#### Scenario: A persisted response is redacted, and the persistence is disclosed

- **GIVEN** an LLM interaction whose response echoes source from the prompt
- **WHEN** the request log is written
- **THEN** secrets are redacted in the stored response as well as the request, the log
  respects the retention cap, and persistence required the explicit opt-in flag

#### Scenario: A repository symlink cannot redirect retention deletion

- **GIVEN** the project-local LLM log path resolves through a symlink outside the project root
- **WHEN** an OpenLore-owned CLI or API path attempts to save and prune logs
- **THEN** the operation fails before publishing or deleting any external file
