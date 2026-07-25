# mcp-security spec delta

## ADDED Requirements

### Requirement: ServeDescriptorValidatedAtEveryReader

Every code path that reads the daemon discovery descriptor (`.openlore/serve.json`) SHALL
validate it through one shared, dependency-light validator before using any field: the host
MUST be a loopback form, the port an integer in 1-65535, the pid a positive integer, and the
token absent or a string. A descriptor failing validation SHALL be treated exactly as an
absent descriptor — the reader returns null and the caller takes its existing no-daemon path
(spawn a fresh daemon or fall back to in-process dispatch) — with at most a debug-level
disclosure. No field of an unvalidated or invalid descriptor may ever become a fetch target,
a request header, or a signal target. This is the outbound counterpart of the inbound
local-HTTP guard (change `harden-local-http-surfaces`): the same untrusted-artifact threat
model, applied to what a local client trusts rather than what a local server accepts.

#### Scenario: A poisoned host is never fetched

- **GIVEN** a repository whose `.openlore/serve.json` names a non-loopback host (an internal
  address or attacker-controlled name)
- **WHEN** any reader — the serve CLI, the serve client used by the MCP server, or the Pi
  extension — resolves the descriptor
- **THEN** validation fails, no request is issued to the named host, and the caller proceeds
  as if no descriptor existed

#### Scenario: An invalid descriptor degrades, never redirects

- **GIVEN** a descriptor with an out-of-range port, a non-integer pid, or a non-string token
- **WHEN** the MCP server's tool dispatch attempts daemon delegation
- **THEN** the descriptor is treated as absent and the tool call is served by a freshly
  spawned daemon or in-process dispatch — attacker-authored tool results can never enter the
  agent's context through the descriptor

#### Scenario: A new reader cannot opt out silently

- **GIVEN** a future code path that reads `.openlore/serve.json` without the shared validator
- **WHEN** the descriptor-reader coverage test runs
- **THEN** the test fails naming the unguarded reader
