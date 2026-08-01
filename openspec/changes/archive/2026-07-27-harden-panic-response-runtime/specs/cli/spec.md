# cli spec delta

## ADDED Requirements

### Requirement: PanicBlockingNeverBlocksItsOwnRecovery

When the opt-in `experimental_blocking` mode emits a block decision, the PreToolUse hook SHALL
parse the pending tool name from the hook payload and SHALL NOT block the recovery actions its own
message prescribes (orient and the designated read-only recovery tools). If the payload's tool name
cannot be determined, a bounded auto-deescalation — derived from the existing decay constants, not
a new tuning value — SHALL guarantee the block lifts without human config edits. Blocking remains
opt-in, carries `advisory: true`, and the hook continues to exit 0 in every case.

#### Scenario: The prescribed recovery call is allowed through at L4

- **GIVEN** panic level 4 in `experimental_blocking` mode
- **WHEN** the PreToolUse hook receives a payload whose tool is orient (or a designated read-only
  recovery tool)
- **THEN** the hook does not emit a block decision for that call, so the agent can execute the
  recovery its block message demanded

#### Scenario: An arbitrary tool is still blocked at L4

- **GIVEN** panic level 4 in `experimental_blocking` mode
- **WHEN** the hook receives a payload for a non-recovery tool
- **THEN** the block decision is emitted with `advisory: true`, exit code 0, as today

#### Scenario: An unparseable payload cannot trap the agent

- **GIVEN** panic level 4 and a hook payload from which no tool name can be parsed
- **WHEN** tool calls continue to arrive
- **THEN** the bounded auto-deescalation lifts the block within its disclosed window, with no
  human config edit required

### Requirement: WatcherSingletonIsAtomic

The background watcher's one-per-directory singleton SHALL be enforced with an atomic
create-exclusive claim on the PID file (the claim fails if the file exists), not a check-then-write
sequence, so two concurrent launches can never both proceed. Liveness of an existing claim SHALL
NOT be inferred from PID signal-0 aliveness alone: the PID file SHALL carry a staleness heuristic
(process start time or heartbeat) disclosed in the file, so a recycled PID does not suppress a
legitimate watcher indefinitely. A stale claim SHALL be replaceable without manual cleanup.

#### Scenario: Concurrent launches yield exactly one watcher

- **GIVEN** no watcher running for a directory
- **WHEN** two watcher processes start simultaneously
- **THEN** exactly one wins the atomic PID-file claim and runs; the other exits

#### Scenario: A recycled PID does not suppress a new watcher

- **GIVEN** a PID file whose PID now belongs to an unrelated process and whose staleness heuristic
  marks the claim stale
- **WHEN** a new watcher starts
- **THEN** the stale claim is replaced and the new watcher runs

### Requirement: InterventionalModeRequiresValidationAcknowledgement

Activating an interventional panic mode (`advisory` or `experimental_blocking`) via setup SHALL
consult the stored accuracy-gate verdict. The gate SHALL define a `CLEARED` verdict, emitted when
and only when every gate criterion is met — the gate itself never auto-activates anything. When the
verdict is not CLEARED, setup SHALL require an explicit acknowledgement flag (e.g.
`--acknowledge-unvalidated`) to proceed, stating which criteria are unmet — a disclosed, sayable
override, never a silent refusal or a silent activation. The false-positive measure SHALL be
presented as a resolved-by-decay proxy (an upper bound), never as a true false-positive rate, and
the validator SHALL read rotated telemetry files so the gate's minimum-episode floor is reachable
under telemetry rotation.

#### Scenario: Activation without a cleared gate requires acknowledgement

- **GIVEN** a project whose panic accuracy gate has not emitted CLEARED
- **WHEN** the user runs `setup --panic experimental_blocking` without the acknowledgement flag
- **THEN** setup declines to activate, lists the unmet criteria, and names the override flag
- **AND** with the flag, activation proceeds and the override is recorded/disclosed

#### Scenario: CLEARED is emitted only on full criteria

- **GIVEN** telemetry meeting the episode floor, FP-proxy target, and follow-through target
- **WHEN** the validation gate is computed
- **THEN** the verdict is CLEARED
- **AND** with any criterion unmet the verdict remains INSUFFICIENT_DATA or REVIEW_REQUIRED

#### Scenario: Rotated telemetry still counts

- **GIVEN** panic telemetry that has rotated the live file into numbered archives
- **WHEN** the validator computes the gate
- **THEN** episodes from rotated files are included, so long-running observation is not discarded
