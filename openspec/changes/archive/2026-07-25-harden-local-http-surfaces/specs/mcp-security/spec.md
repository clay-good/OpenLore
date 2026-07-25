# mcp-security spec delta

## ADDED Requirements

### Requirement: AllLocalHttpSurfacesShareTheGuard

Every HTTP surface OpenLore binds locally (the `serve` daemon, the `view` graph server, and any
future one) SHALL enforce the same request guard from one shared module: a Host-header allowlist
restricted to loopback forms with the bound port, an Origin check rejecting foreign browser
origins, and a constant-time token requirement for any non-loopback binding. An endpoint that
spends the user's money or executes an agent (e.g. the viewer's chat endpoint) SHALL require the
token even on loopback. No API route may be mounted outside the guard. Each surface SHALL install
graceful-shutdown handlers and a descriptor for stale-instance detection.

#### Scenario: DNS rebinding cannot reach the viewer's APIs

- **GIVEN** a browser request arriving at `127.0.0.1:<port>` with a non-loopback Host or Origin
  header
- **WHEN** any `/api/*` route of the view server receives it
- **THEN** the request is rejected with 403 before any handler logic runs

#### Scenario: The chat endpoint cannot be driven by a foreign page

- **GIVEN** a request to the viewer's `/api/chat` without the instance token
- **WHEN** the guard evaluates it
- **THEN** it is rejected with 401 even when it originates from loopback

#### Scenario: A new local surface cannot opt out silently

- **GIVEN** a future command that binds a local HTTP listener with an API route mounted outside
  the shared guard
- **WHEN** the guard-coverage test runs
- **THEN** the test fails naming the unguarded route
