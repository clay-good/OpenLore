## ADDED Requirements

### Requirement: PiDaemonSpawnAuthorityIsOverridable

The Pi extension SHALL support an explicit opt-out that makes it **discover and use** an existing
daemon but never spawn one. The opt-out SHALL be reachable through the extension's normal
configuration surface — an environment variable and a configuration key — and SHALL apply to the
extension's default daemon-acquisition path, not only to an internal seam a caller can override.

Spawning is the correct default when nothing else manages a daemon. When a supervising host already
runs one daemon per working tree — with its own restart bound, retained diagnostics, and a handle
released at shutdown — an extension-initiated spawn produces a second, unsupervised process that can
outlive the session and silently defeats the host's stop-retrying policy. With the opt-out set, the
extension SHALL treat "no healthy daemon discovered" exactly as it treats a daemon connection
failure today: a bounded, honest, retryable outcome that names the absent daemon as the cause, never
a silent spawn and never a misleading remediation.

#### Scenario: A supervised daemon is used, never duplicated

- **GIVEN** a host that already supervises a healthy daemon for the working tree, with the spawn
  opt-out set
- **WHEN** the Pi extension needs the daemon for a tool call
- **THEN** it discovers and uses the supervised daemon, and starts no process of its own

#### Scenario: No daemon means an honest failure, not a spawn

- **GIVEN** the spawn opt-out is set and no healthy daemon is discoverable for the working tree
- **WHEN** the Pi extension needs the daemon
- **THEN** it reports a bounded, retryable daemon-connection failure naming the absent daemon, and
  no daemon process is launched

#### Scenario: The default is unchanged

- **GIVEN** the spawn opt-out is not set
- **WHEN** the Pi extension finds no healthy daemon
- **THEN** it launches one exactly as it does today, with its existing bounded failure handling
