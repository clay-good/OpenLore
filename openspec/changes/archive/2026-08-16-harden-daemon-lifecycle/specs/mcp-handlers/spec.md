# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DaemonServesOnlyItsServedRoot

The HTTP daemon SHALL confine tool requests to the root it was started for: a request whose
resolved directory is not the served root is rejected with an error naming the served root and
the remedy (start a daemon for that root), before any context is parsed or store handle opened.
Consequently the daemon's per-directory caches (parsed context, open EdgeStore handles,
schema-reset flags) hold entries only for the served root and cannot be grown without bound by
client-supplied directories. Confinement is chosen over an eviction policy because clients
discover a daemon through that root's descriptor — cross-root requests indicate misuse or probing
— and because it removes both the resource-growth and the trust hazard with no new tuning
constant. The in-process (non-daemon) MCP server path is unchanged. Telemetry emitted by handlers
SHALL relativize absolute filesystem paths in error/module fields (project-relative, or `~` for
home) — telemetry remains opt-in and is never transmitted off the machine.

#### Scenario: A foreign directory is rejected, not cached

- **GIVEN** a daemon serving root `R` and a local client naming directory `Q` outside `R`
- **WHEN** the request is handled
- **THEN** it is rejected with an error naming `R` and how to serve `Q`, and no context cache
  entry or store handle for `Q` is created

#### Scenario: The daemon's memory does not grow with hostile directory churn

- **GIVEN** a long-lived daemon receiving requests naming many distinct existing directories
- **WHEN** the requests are processed
- **THEN** the context cache and open-handle count remain bounded to the served root

#### Scenario: Telemetry error fields carry no absolute paths

- **GIVEN** a tool error whose message embeds an absolute path under the user's home
- **WHEN** the telemetry event is written
- **THEN** the recorded field is relativized (project-relative or `~`-prefixed), and credentials
  redaction continues to apply
