# mcp-security spec delta

## ADDED Requirements

### Requirement: WriteToolsAreUnreachableOutsideTheAdvertisedSurface

A tool that mutates persistent state (decision recording/approval, memory writes, and any future
mutating tool) SHALL be unreachable through `tools/call` on any preset that does not advertise
it. An operator's preset choice is a governance boundary: rejecting the call SHALL happen before
any persistent or process-lifecycle side effect, and the guard test SHALL assert both the
rejection and the absence of persisted state (no decision draft, no ledger entry, no memory note)
after an out-of-surface write attempt. A conflicting `openlore serve` launch SHALL refuse to reuse
a live daemon when its preset or token differs from the requested security settings. Every
descriptor consumer MUST require one authenticated health response that reports
`presetDispatchEnforced: true`, the expected repository root, the daemon PID, preset, tools, and
token posture before trusting daemon metadata. Shutdown SHALL use the authenticated daemon
endpoint rather than signaling descriptor PID data, and the daemon SHALL remove its own discovery
entry before acknowledging shutdown so later instances retain ownership of their descriptors.
An ambiguous daemon transport failure SHALL NOT automatically replay a non-idempotent tool
locally; OpenLore SHALL report that the outcome is unknown so the operator can inspect state.
MCP client
discovery MAY reuse a narrower daemon because the session enforces its own surface before
delegation and falls back locally for an authorized call rejected by the daemon.

#### Scenario: A write tool invoked on a read-only surface leaves no trace

- **GIVEN** a server started with the read-only `navigation` preset in a repository with an
  initialized `.openlore` store
- **WHEN** the client calls `tools/call record_decision` and `tools/call remember` with valid
  arguments
- **THEN** both calls return the membership tool error, and `.openlore/decisions/` and the memory
  store are byte-identical to their pre-call state

#### Scenario: Delegated calls are equally confined

- **GIVEN** the same preset with tool calls delegated to a shared serve daemon
- **WHEN** an out-of-surface write tool is called
- **THEN** the membership check is enforced with the same result as in-process dispatch

#### Scenario: Rejected calls do not keep a daemon alive

- **GIVEN** a narrow daemon approaching its idle-shutdown deadline
- **WHEN** a client repeatedly requests a registered tool outside the active preset
- **THEN** each request is rejected without resetting the idle timer

#### Scenario: Incompatible daemon reuse fails closed

- **GIVEN** a live full-surface daemon without a token
- **WHEN** an operator requests a navigation daemon protected by a token for the same repository
- **THEN** OpenLore refuses reuse, preserves the existing daemon unchanged, and instructs the
  operator to stop it before changing the security settings

#### Scenario: A legacy advisory daemon is not trusted

- **GIVEN** a live legacy daemon that reports a matching narrow preset and tool list but does not
  advertise enforced preset dispatch
- **WHEN** a new OpenLore process considers reusing it
- **THEN** reuse is refused because the legacy daemon may still dispatch hidden tools

#### Scenario: A descriptor cannot redirect trust across repositories

- **GIVEN** a valid descriptor copied from another repository or modified with a different token
- **WHEN** a client probes that descriptor
- **THEN** the client rejects the listener because authenticated health does not prove the
  expected repository root and token

#### Scenario: Shutdown does not trust descriptor PID data

- **GIVEN** an untrusted descriptor containing a valid loopback listener and arbitrary PID
- **WHEN** an operator runs `openlore serve --stop`
- **THEN** OpenLore only requests authenticated shutdown from a root-bound compatible daemon and
  never signals the descriptor PID

#### Scenario: An ambiguous write is not replayed

- **GIVEN** a non-idempotent write reaches the shared daemon
- **WHEN** the connection closes before the client receives a response
- **THEN** OpenLore reports an unknown outcome and does not dispatch the write again locally
