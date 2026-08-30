# architecture spec delta

## ADDED Requirements

### Requirement: ColdStartBuildRunsOffTheServerEventLoop

The cold-start index build SHALL run off the MCP server's event loop (a child process, as the
schema-rebuild path already does), and the server SHALL start its watcher without awaiting the
initial full scan, so first-run onboarding does not block the server or stall the first tool
call with synchronous analyzer work.

#### Scenario: Onboarding does not freeze the server

- **GIVEN** a first run on a large repo that triggers the cold-start build
- **WHEN** the MCP server bootstraps the index
- **THEN** the build runs in a separate process and the server remains responsive; the first
  tool call is not gated on the full scan completing
