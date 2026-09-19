# Spec Delta

## ADDED Requirements

### Requirement: PiStatusReportsFunctionalReadiness

In a Pi session with a UI, the Pi extension SHALL show one footer status entry under the key
`openlore`. The status SHALL come only from facts OpenLore already computes: the index readiness
from the published health read (`absent`, `building`, `degraded`, `ready`), and the outcome of the
extension's last daemon resolution (connecting, usable, incompatible, spawn-disabled, unavailable).
The status SHALL NOT report ready unless the index is ready and the last daemon resolution gave a
usable daemon. The status SHALL report a stopped watcher only when the daemon reports it stopped. An
unknown watcher state SHALL NOT be shown as stopped. Each non-ready state SHALL name its condition
(for example, no index, analysis running, index degraded, daemon incompatible, daemon spawning
disabled), and it SHALL NOT use a generic failure label.

#### Scenario: Ready repository with a usable daemon

- **GIVEN** a repository whose index is ready and a Pi session whose daemon resolution gave a usable daemon
- **WHEN** the extension updates its status
- **THEN** the `openlore` status reports ready

#### Scenario: No index yet

- **GIVEN** a repository with no analysis index
- **WHEN** a Pi session with a UI starts
- **THEN** the `openlore` status reports that no index exists, and it does not report ready

#### Scenario: Analysis in progress

- **GIVEN** an analysis that owns the repository and no usable index
- **WHEN** the extension updates its status
- **THEN** the `openlore` status reports that analysis is running

#### Scenario: Index ready but daemon unusable

- **GIVEN** a ready index and a daemon resolution that is incompatible, spawn-disabled, or failed
- **WHEN** the extension updates its status
- **THEN** the `openlore` status names that daemon condition, and it does not report ready

#### Scenario: Watcher state unknown

- **GIVEN** a ready index and a daemon that does not report its watcher state
- **WHEN** the extension updates its status
- **THEN** the `openlore` status does not mention a stopped watcher

### Requirement: PiStatusFollowsTheSessionLifecycle

The Pi extension SHALL set the `openlore` status only through the context of the event that it is
handling. It SHALL NOT use a context captured from an earlier event. It SHALL show a connecting
state while the session-start daemon resolution runs. It SHALL update the status when that
resolution ends, after each agent run, and after the configuration wizard's analysis ends. It SHALL
clear the status when the session shuts down. In a session without a UI (print or JSON mode), the
extension SHALL NOT set a status. A status update that fails SHALL NOT fail the session event, the
agent run, or a tool call.

#### Scenario: Session start shows connecting, then the outcome

- **GIVEN** a Pi session with a UI in a repository with a ready index
- **WHEN** the session starts and the daemon resolution completes
- **THEN** the `openlore` status first reports connecting and then reports the resolved state

#### Scenario: Status refreshes after an agent run

- **GIVEN** a session whose status reports that analysis is running
- **WHEN** the analysis completes and an agent run ends
- **THEN** the `openlore` status reports the new readiness

#### Scenario: Headless sessions get no status

- **GIVEN** a Pi session in print or JSON mode
- **WHEN** the session starts and an agent run ends
- **THEN** the extension does not set any status

#### Scenario: Shutdown clears the status

- **GIVEN** a session with an `openlore` status
- **WHEN** the session shuts down
- **THEN** the extension clears the `openlore` status

#### Scenario: A failing status read does not break the turn

- **GIVEN** a health read that throws
- **WHEN** the extension updates its status after an agent run
- **THEN** the agent run completes normally, and the status reports that readiness is unknown
