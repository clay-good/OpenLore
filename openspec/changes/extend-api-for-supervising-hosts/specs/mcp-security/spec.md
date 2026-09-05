## MODIFIED Requirements

### Requirement: ServeDescriptorValidatedAtEveryReader

Every code path that reads the daemon discovery descriptor (`.openlore/serve.json`) SHALL
validate it through one shared, dependency-light validator before using any field: the host
MUST be a loopback form, the port an integer in 1-65535, the pid a positive integer, and the
token absent or a string. A descriptor failing validation SHALL be treated exactly as an
absent descriptor — the reader returns null and the caller takes its existing no-daemon path
(spawn a fresh daemon or fall back to in-process dispatch) — with at most a debug-level
disclosure. No field of an unvalidated or invalid descriptor may ever become a fetch target,
a request header, or a signal target. This is the outbound counterpart of the inbound
local-HTTP guard (`AllLocalHttpSurfacesShareTheGuard`): the same untrusted-artifact threat
model, applied to what a local client trusts rather than what a local server accepts.

Readers outside the package are readers. A host that embeds OpenLore and discovers a daemon for
itself faces the identical threat and would otherwise carry a hand-copied validator that drifts
from this one — the same three-postures failure, one package boundary away. The package therefore
SHALL publish the descriptor contract — the validator, the descriptor and health types, the
protocol version, the base-URL builder, and the canonical-root normalizer — through a stable,
documented import path, so an embedding host can share the one validator instead of copying it.

That published path SHALL preserve the module's dependency-light contract: importing the
descriptor contract MUST NOT eagerly load the analyzer or any other heavyweight subsystem, because
a supervising host imports it into the process that serves every workspace, and the isolation it
maintains is the reason the validator was made dependency-light in the first place. A published
path that loads the analyzer defeats the property it exists to provide, and SHALL NOT be the
descriptor contract's home.

#### Scenario: A poisoned host is never fetched

- **GIVEN** a repository whose `.openlore/serve.json` names a non-loopback host (an internal
  address or attacker-controlled name)
- **WHEN** any reader — the serve CLI, the serve client used by the MCP server, the Pi
  extension, or an embedding host importing the published contract — resolves the descriptor
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

#### Scenario: An embedding host gets the validator, not a copy

- **GIVEN** a host process outside the package that must discover an OpenLore daemon
- **WHEN** it imports the published descriptor contract and resolves a descriptor
- **THEN** it applies exactly the checks every in-package reader applies, and a descriptor
  poisoned for any in-package reader is rejected identically for the host

#### Scenario: Importing the contract does not load the analyzer

- **GIVEN** a host that imports only the published descriptor contract
- **WHEN** the import resolves
- **THEN** the analyzer and its parsing and indexing dependencies are not loaded into that process
