# mcp-security spec delta

## ADDED Requirements

### Requirement: WriteToolsAreUnreachableOutsideTheAdvertisedSurface

A tool that mutates persistent state (decision recording/approval, memory writes, and any future
mutating tool) SHALL be unreachable through `tools/call` on any preset that does not advertise
it. An operator's preset choice is a governance boundary: rejecting the call SHALL happen before
any side effect, and the guard test SHALL assert both the rejection and the absence of persisted
state (no decision draft, no ledger entry, no memory note) after an out-of-surface write attempt.

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
