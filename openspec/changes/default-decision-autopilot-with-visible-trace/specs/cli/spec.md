# Spec Delta

## ADDED Requirements

### Requirement: AutopilotIsTheDefaultForAutoInitializedRepositories

In a repository whose OpenLore setup came from background auto-initialization, an absent
`governance.autopilot` SHALL mean autopilot is on. In a repository where an explicit install wired a
blocking gate, an absent key SHALL keep meaning blocking review. `governance.autopilot: false` SHALL
always turn autopilot off. The resolved mode and the reason for it SHALL be reported wherever
governance state is shown.

#### Scenario: A repository nobody configured runs on autopilot

- **GIVEN** a repository indexed by auto-init, with no `governance` block
- **WHEN** governance state is reported
- **THEN** the mode is autopilot, with the reason "auto-initialized; set governance.autopilot:
  false to require review"

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
