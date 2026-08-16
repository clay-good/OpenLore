# cli spec delta

## ADDED Requirements

### Requirement: ServeTokenAtRestIsOwnerOnly

The serve daemon SHALL write its discovery descriptor (`.openlore/serve.json`), which can carry
the daemon auth token, with owner-only permissions (0o600, enforced by an explicit chmod after
write so the process umask cannot widen it). The token is the credential that separates "any
local process" from authorized callers; it SHALL never rest world-readable. This is the
write-side complement of `harden-serve-descriptor-trust`, which hardens reading an untrusted
descriptor.

#### Scenario: The descriptor is not world-readable

- **GIVEN** a daemon started with a token (flag or environment)
- **WHEN** `serve.json` is written
- **THEN** its file mode is 0o600 regardless of umask; on platforms without POSIX modes the
  limitation is disclosed, not silently ignored

### Requirement: ServeStartIsSingleInstanceUnderRace

Daemon startup SHALL hold an exclusive-create lockfile across the discover-probe → bind →
write-descriptor window, so two concurrent starts for one root (for example, two MCP clients
racing through `ensureServeDaemon`) resolve to exactly one daemon: the loser reuses the winner's
descriptor instead of binding a second port, running a second watcher on the same analysis
directory, or orphaning the first daemon by overwriting its descriptor. The lock reuses the
existing decisions-lock exclusive-create shape. A stale PID-bearing ownership lock SHALL be
reclaimed. A malformed lock or stranded namespace gate SHALL fail closed with bounded,
actionable manual-recovery guidance rather than wait forever or permit a second daemon.

#### Scenario: Two concurrent starts yield one daemon

- **GIVEN** two processes calling daemon startup for the same root at the same moment
- **WHEN** both run the single-instance check concurrently
- **THEN** exactly one binds and writes the descriptor; the other returns the winner's endpoint;
  exactly one watcher runs on the analysis directory

#### Scenario: A stale ownership lock is recovered safely

- **GIVEN** a starter that died after writing its PID-bearing ownership lock
- **WHEN** a later start finds the stale lockfile
- **THEN** the stale lock is detected and recovered (the decisions-lock discipline) and startup
  proceeds

#### Scenario: An ambiguous abandoned lock fails closed

- **GIVEN** a malformed ownership lock or stranded lock namespace gate
- **WHEN** a later starter cannot prove that automatic reclamation is safe
- **THEN** startup stops after a bounded wait and reports the exact operator cleanup condition
  without binding a second daemon

### Requirement: ServeLifecycleDiscoveryIsCoordinated

The daemon SHALL publish a validated `ready` descriptor only after its watcher, teardown, repair
host, and signal handlers are initialized. Teardown SHALL announce `draining` before acknowledging
shutdown, reject new tool work, and remove the descriptor only after rebuild, watcher, listener,
and cache cleanup. CLI stop SHALL retain the per-root lifecycle lock until that removal. Ordinary
MCP and Pi readers SHALL treat `draining` as unavailable. A later lifecycle owner MAY restore
`ready` only when an authenticated root/PID/token health proof says teardown never began.

#### Scenario: A replacement waits for teardown

- **GIVEN** a daemon that has announced `draining` while a rebuild or watcher is still active
- **WHEN** another client starts or discovers a daemon for the same root
- **THEN** it does not dispatch to the draining endpoint or bind a replacement until the old
  descriptor is removed after cleanup

#### Scenario: A stopper crashes before requesting shutdown

- **GIVEN** a verified healthy daemon whose descriptor was changed to `draining` but whose health
  response says teardown did not begin
- **WHEN** a later lifecycle owner acquires the root lock
- **THEN** it MAY restore `ready` and reuse or stop that exact authenticated daemon

### Requirement: ServeNetworkBindHasTrustedDiscovery

A network-visible serve bind SHALL require a token and SHALL use only wildcard `0.0.0.0` or `::`.
Its descriptor SHALL publish the corresponding loopback address, and every reader SHALL format
IPv6 loopback with URL brackets. Concrete non-loopback interface binds SHALL be rejected because
they cannot expose the same listener through the trusted loopback descriptor boundary.

#### Scenario: IPv6 wildcard discovery remains reusable

- **GIVEN** a token-protected daemon bound to `::`
- **WHEN** CLI, MCP, or Pi reads and probes its descriptor
- **THEN** discovery uses `http://[::1]:PORT` and reuses the authenticated daemon

### Requirement: ServeTeardownDrainsInFlightRebuilds

Daemon teardown SHALL await any in-flight forced rebuild before the process exits, with a bounded
wait whose expiry is disclosed rather than silent; and the idle self-shutdown reaper SHALL be
suppressed while a rebuild is in flight, so a daemon is never reaped or hard-exited mid-rebuild,
leaving a logically half-rebuilt store.

#### Scenario: SIGTERM during a rebuild exits cleanly

- **GIVEN** a daemon mid-way through a triggered `analyze --force`
- **WHEN** it receives SIGTERM
- **THEN** teardown waits for the rebuild to finish (or discloses that the bounded wait expired)
  before `process.exit`, and the store reconciles healthy afterward

#### Scenario: A long rebuild does not look idle

- **GIVEN** a daemon with no incoming requests whose rebuild outlasts the idle window
- **WHEN** the idle timer would fire
- **THEN** the reaper is suppressed until the rebuild completes, then idle accounting resumes
