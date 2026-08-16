# Tasks — harden-daemon-lifecycle

## Implementation
- [x] Descriptor secret at rest: reuse the owner-only descriptor writer, including explicit
      chmod after write so umask or a pre-existing file cannot widen token access
- [x] Start/stop lock: hold the shared advisory lock across discover → bind → ready-descriptor;
      publish `draining` before teardown and retain serialization until the descriptor is removed,
      so startup, stop, signal drain, and replacement cannot overlap writers
- [x] Drain on teardown: track in-flight rebuild promises and await them with a bounded,
      disclosed timeout before listener/cache/descriptor release and process exit
- [x] Idle-reaper suppression: rebuild start/finish gates the idle timer so a rebuild in flight
      never counts as idle
- [x] Root confinement: reject a request whose canonical directory is not the exact served root,
      with an error naming the served root and the per-root daemon remedy; drop schemaResetByDir's
      multi-directory generality and release the root cache/EdgeStore on teardown
- [x] Telemetry path hygiene: centrally relativize absolute paths (project root → relative,
      home → `~`) in error/module fields before emit; require the exact opt-in value `1` and
      document that telemetry remains local-only

## Verification
- [x] Test: serve.json mode is 0o600 after start (skip on Windows with disclosure)
- [x] Race test: two real concurrent CLI processes on one root → exactly one bound daemon, one watcher,
      one descriptor; the loser returns the winner's endpoint
- [x] Drain test: SIGTERM during a triggered rebuild → teardown awaits completion (or discloses
      the bounded-wait expiry); EdgeStore reconciles healthy afterward
- [x] Idle test: a rebuild longer than the idle window does not get reaped mid-rebuild
- [x] Confinement test: request for a foreign directory → 4xx naming the served root; served-root
      requests remain valid; the populated root context/EdgeStore is evicted and closed on teardown
- [x] Telemetry test: a tool_error whose message embeds an absolute path lands relativized in the
      telemetry file
- [x] Full unit/integration suite green (`npm run test:run`: 7,735 passed, 2 skipped) and
      E2E suite green (`npm run test:e2e`: 185 passed)

## Spec
- [x] `cli` delta: ADD ServeTokenAtRestIsOwnerOnly, ServeStartIsSingleInstanceUnderRace,
      ServeLifecycleDiscoveryIsCoordinated, ServeNetworkBindHasTrustedDiscovery, and
      ServeTeardownDrainsInFlightRebuilds
- [x] `mcp-handlers` delta: ADD DaemonServesOnlyItsServedRoot
