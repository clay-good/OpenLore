# Spec Delta

## ADDED Requirements

### Requirement: AutopilotIsTheDefaultForAutoInitializedRepositories

When background auto-initialization creates a repository's configuration, it SHALL record
`governance.autopilot: true` in it, unless a blocking decisions gate is installed or the directory is
a linked worktree whose main checkout sets the key. An absent key SHALL keep meaning blocking review,
so a gate OpenLore cannot see (a CI-only gate, a hook manager, a fresh clone) never turns into
auto-accept. The resolved mode and its reason SHALL be reported wherever governance state is shown.

#### Scenario: A repository nobody configured runs on autopilot

- **GIVEN** a git repository that auto-init indexed, with no prior OpenLore configuration and no gate
- **WHEN** governance state is reported
- **THEN** the configuration carries `governance.autopilot: true`, and the mode is autopilot with the
  reason "governance.autopilot is true — set it to false to require review"

#### Scenario: An unset key never flips a gate it cannot see

- **GIVEN** a configuration with no `governance.autopilot` and no OpenLore hook in the checkout
- **WHEN** a decision is recorded
- **THEN** it stays a draft for review

### Requirement: AWorktreeFollowsTheMainCheckoutsGovernance

When a linked worktree's own configuration has no `governance.autopilot`, the main checkout's value
SHALL apply, and the reason SHALL name the main checkout. The commit gate lives in hooks that every
worktree shares, while the configuration is per checkout, so a worktree created after the user chose
a mode SHALL NOT silently get the opposite one. A worktree's own value SHALL still win.

#### Scenario: An agent worktree auto-accepts like its main checkout

- **GIVEN** a main checkout with `governance.autopilot: true` and the decisions gate installed
- **AND** a new linked worktree whose configuration has no `governance` block
- **WHEN** an agent records a decision there and commits
- **THEN** the decision is auto-accepted and the commit is not blocked

### Requirement: RecordedDecisionsAreAcceptedWithoutAGate

Under autopilot, a decision recorded with a title and rationale SHALL move directly to
`auto-approved` with actor `agent`, its timestamp and the HEAD commit. It SHALL be appended to the
ledger and synced to specs in the background, with no git hook and no LLM call. Only deterministic
checks SHALL gate it (anchored files exist; a superseded decision is live). A decision failing them
SHALL stay `draft` with the reason. A human rejection SHALL never be re-accepted.

#### Scenario: A recorded decision is accepted at once

- **GIVEN** an autopilot repository with no gate and no API key
- **WHEN** an agent runs `openlore decisions record --title … --rationale …`
- **THEN** the decision is `auto-approved`, a ledger entry with actor `agent` exists, and the spec
  sync runs in the background

### Requirement: GovernanceTraceIsVisibleWithoutAsking

`openlore status` SHALL report the governance mode, the auto-accepted and unreviewed counts, and
the newest ledger entries. The status line and Pi footer SHALL show the unreviewed count when it is
above zero. The session primer SHALL name decisions auto-accepted since the previous session in at
most one line. Each surface SHALL point to `openlore decisions review`.

#### Scenario: The user sees what was accepted

- **GIVEN** two decisions auto-accepted since the last session
- **WHEN** a new session starts and the user runs `openlore status`
- **THEN** the primer has one line naming both, the status line shows "2 to review", and `status`
  lists the ledger entries with the review command
