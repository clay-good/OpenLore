# Delta: cli (hook-reliability)

## MODIFIED Requirements

### Requirement: LoopHooksAreAdvisoryUnlessPolicyBlocks

Every hook moment SHALL fail open. The moments are prompt submitted (`openlore orient --inject`)
and the `openlore hook <moment>` commands. Each SHALL exit 0, and SHALL print nothing on a timeout,
an error, a missing or unreadable `.openlore/`, a missing or unusable index, or an unreadable
payload, whatever the policy. A hook command that `openlore install` writes SHALL exit 0 with no
output when its runtime no longer exists. Only when the repository's `enforcement.policy` names one
or more finding codes as blocking MAY the before-stop hook block, and its message SHALL list the
blocking findings and their next actions; a finding that is blocking only by its source default
SHALL NOT block a stop, and the hook SHALL NOT block when the payload says a stop hook is already
active. The hook SHALL add no imperative of its own; receipt next actions SHALL be carried as
labeled data. The hook's standard output SHALL carry only the receipt. A test SHALL assert this
contract for every moment in `LOOP_MOMENTS`.

#### Scenario: Stop does not block by default

- **GIVEN** no blocking codes in `enforcement.policy` and a session diff with a `test-disabled`
  finding
- **WHEN** the before-stop hook runs
- **THEN** it shows the receipt including the finding to the user and does not block

#### Scenario: A team can make one finding blocking

- **GIVEN** `enforcement.policy` naming `test-disabled` as blocking
- **WHEN** the before-stop hook runs on the same diff
- **THEN** the hook blocks the stop and its message names the finding

#### Scenario: A finding the policy does not name does not block a stop

- **GIVEN** no `enforcement.policy` and a finding whose code the policy does not name
- **WHEN** the before-stop hook runs
- **THEN** it does not block

#### Scenario: A broken store is silent at every moment

- **GIVEN** a repository whose `.openlore/config.json` and index files are corrupt
- **WHEN** each of the four moments runs
- **THEN** each exits 0 and prints nothing

#### Scenario: A removed runtime is silent

- **GIVEN** a hook command written by `openlore install`, and the OpenLore install then deleted
- **WHEN** the harness runs the command
- **THEN** it exits 0 and prints nothing

### Requirement: OrientInjectMode

The system SHALL provide an `--inject` mode on the `openlore orient` command that emits an
injection-shaped orientation block for a single task. The task SHALL be taken from `--task` when
present, otherwise read from the command's stdin (the prompt payload a pre-turn agent hook supplies).
The emitted block SHALL reuse the lean orientation output (Spec 27), SHALL be bounded by a documented
token budget, SHALL be clearly attributed to OpenLore, and SHALL open with a one-line statement that
it is informational and may be ignored (the same facts-not-coercion posture as the Epistemic Lease,
decision `8e95746d`). The mode SHALL be deterministic with no LLM. The mode SHALL be the
prompt-submitted hook moment under its existing command name: it SHALL be turned off by
`hooks.prompt-submitted: false` as well as by `contextInjection.mode: "off"`, SHALL stop at that
moment's runtime limit, and SHALL be listed by `openlore status`. A missing graph, an empty match,
or an empty prompt SHALL degrade to a single pointer line and exit 0. A thrown error or a passed
runtime limit SHALL print nothing and exit 0. A hook that invokes the mode can never break the
user's turn.

> Implemented by `add-task-scoped-context-injection` (2026-06-22). `orient --inject` reuses
> `handleOrient(lean=true)`; stdin is parsed for a Claude Code `UserPromptSubmit` JSON payload
> (`.prompt`) or treated as raw text. stdout is kept clean (diagnostics → stderr) so only the block
> is injected. Default budget 600 tokens. Adds no MCP tool. Decisions: `27c4bb53`, `0fc964d3`.
> The prompt-submitted moment rules are added by `hook-reliability`.

#### Scenario: Inject emits a budgeted, ignorable block for a real task

- **GIVEN** an analyzed repository and a task supplied via `--task`
- **WHEN** `openlore orient --inject` runs
- **THEN** it emits a lean, OpenLore-attributed orientation block that opens with an
  informational/ignorable framing line and does not exceed the configured token budget

#### Scenario: Inject never breaks the turn

- **GIVEN** a repository with no analysis graph
- **WHEN** `openlore orient --inject` runs from a hook
- **THEN** it emits a single pointer line indicating OpenLore is available and exits 0, emitting no
  error to the harness

#### Scenario: An orientation error is silent

- **GIVEN** an analyzed repository where the orientation lookup throws
- **WHEN** `openlore orient --inject` runs from a hook
- **THEN** it prints nothing and exits 0

#### Scenario: The moment's own off switch works

- **GIVEN** `hooks.prompt-submitted: false` in `.openlore/config.json`
- **WHEN** `openlore orient --inject` runs
- **THEN** it prints nothing and exits 0, and `openlore status` marks the moment as off

### Requirement: AbsenceOfABriefingIsNeverAmbiguous

While injection is enabled, a briefing that a gate withheld SHALL be replaced by a pointer line
that states, in the agent-visible text, that the gate withheld it and why — at minimum
distinguishing "this turn was not classified as code work" from "nothing in the graph matched this
turn strongly" and from "no analysis index is available" — and SHALL name the manual call or
command that retrieves the structure on demand.

The agent SHALL never have to infer whether an absent briefing means "nothing relevant was found" or
"no lookup was performed". Emitting nothing SHALL be reserved for two cases. The first is an
operator who disabled the moment (`contextInjection.mode: "off"` or `hooks.prompt-submitted:
false`), which is a configured absence, not a gate decision. The second is a hook failure (a thrown
error or a passed runtime limit), which SHALL be counted in the hook health that `openlore status`
reports, so the absence is visible to the operator.

This requirement bounds the intent gate's failure mode: a misclassified code-work turn loses the
pre-computed briefing but never the knowledge that a briefing was skipped, nor the way to ask for
one.

#### Scenario: A misclassified turn still tells the agent what happened

- **GIVEN** a code-work turn the intent gate wrongly classifies as repository management
- **WHEN** the hook runs
- **THEN** the agent receives a pointer line stating the turn was not classified as code work and naming the manual orientation call

#### Scenario: Weak relevance is distinguishable from a skipped lookup

- **GIVEN** two turns, one withheld for weak relevance and one withheld by the intent gate
- **WHEN** each hook runs
- **THEN** the two pointer lines differ in their stated reason, so absence never reads the same for both causes

#### Scenario: An enabled install never emits silence

- **GIVEN** injection is enabled in any mode other than `off`
- **WHEN** the hook runs on the first turn of a session where a gate withheld the briefing for a
  given reason, or no index is available and no build can start
- **THEN** the output is non-empty and carries a stated reason
- **AND** a later turn in the same session withheld for the same reason emits nothing

#### Scenario: A running build says nothing to the agent

- **GIVEN** an index build or repair is running
- **WHEN** the hook runs
- **THEN** the agent's context gets no build or progress line

#### Scenario: A disabled install stays silent

- **GIVEN** `contextInjection.mode` is `off`
- **WHEN** the hook runs
- **THEN** nothing is emitted, and no pointer line implies a gate decision

#### Scenario: A failed hook is silent to the agent and counted for the operator

- **GIVEN** injection is enabled and the orientation lookup throws
- **WHEN** the hook runs
- **THEN** the agent receives nothing, and `openlore status` counts one error for the prompt-submitted moment

### Requirement: UninstallDisclosesWhatItKeeps

`openlore install --uninstall` SHALL end its summary by naming the paths it deliberately keeps
(the `.openlore/` data directory: index, decisions, memories; and each skill directory copied by
`openlore setup`) and the command to remove them. It SHALL NOT delete them.

#### Scenario: Uninstall names the kept data directory

- **GIVEN** a repository with an initialized `.openlore/` store
- **WHEN** `openlore install --uninstall` completes
- **THEN** the summary lists `.openlore/` as kept and shows how to delete it

#### Scenario: Uninstall names what it keeps

- **GIVEN** a repository with `.openlore/` and skills copied by `openlore setup`
- **WHEN** `openlore install --uninstall` completes
- **THEN** no hook entry calls OpenLore, and the summary lists `.openlore/` and the copied skills as
  kept, with the command to remove each

## ADDED Requirements

### Requirement: FindingsAreShownOncePerSessionAndTheirOutcomeIsCounted

Across all four hook moments, a finding SHALL be identified by its code, its subject, and a hash
of its proof, and SHALL be shown at most once per harness session to the agent and at most once to
the user. The session record SHALL keep one outcome for each shown finding (`fixed`, `decided`,
`open`, or `not-assessed`), SHALL stay in `.openlore/`, and SHALL NOT be sent anywhere.

#### Scenario: One finding, two moments, one statement

- **GIVEN** a session where the after-edit hook showed an unresolved import in `src/a.ts`
- **WHEN** the before-edit hook next runs on `src/a.ts` with the import unchanged
- **THEN** it does not show that finding again

#### Scenario: A changed proof is a new finding

- **GIVEN** a finding shown earlier in the session
- **WHEN** the cited source line changes and the check reports the finding again
- **THEN** the hook shows it again

#### Scenario: A line shift is not a new finding

- **GIVEN** a finding shown earlier in the session
- **WHEN** lines are added above it and the cited line's text is the same
- **THEN** the hook does not show it again

#### Scenario: A new session starts clean

- **GIVEN** a finding shown in one harness session
- **WHEN** a hook reports the same finding under a different `session_id`
- **THEN** the hook shows it

#### Scenario: Fixed is counted only when the check ran again

- **GIVEN** a shown finding, and an agent edit to its subject's file
- **WHEN** the same check runs on that file and does not report the finding
- **THEN** its outcome is `fixed`
- **AND** when the check instead fails or times out, the outcome stays `not-assessed`

#### Scenario: A decision that cites the finding counts as decided

- **GIVEN** a finding shown with the id `f:1a2b3c4d`
- **WHEN** a decision is recorded whose rationale contains `f:1a2b3c4d`
- **THEN** `openlore status` counts that finding as `decided`

#### Scenario: Still present at stop is open

- **GIVEN** a shown finding that the before-stop receipt still reports
- **WHEN** the session stops
- **THEN** its outcome is `open`

### Requirement: HookRunsAreBudgetedMeasuredAndReported

Each of the four hook moments SHALL have a documented p95 latency target, asserted by a test on a
fixture repository of fixed size, and a runtime limit past which the run stops, prints nothing,
exits 0, and is recorded as an overrun. Each run SHALL be recorded in `.openlore/` only, and
`openlore status` SHALL report hook health from those records in one line and in `--json`. The
records SHALL NOT be sent anywhere.

#### Scenario: A slow hook is stopped and counted

- **GIVEN** a before-edit run whose check takes longer than the moment's runtime limit
- **WHEN** the limit passes
- **THEN** the hook prints nothing and exits 0
- **AND** `openlore status` shows one more overrun for `before-edit`

#### Scenario: The budget test fails on a regression

- **GIVEN** the fixture repository and a change that adds 2 seconds to the before-edit handler
- **WHEN** the latency test runs
- **THEN** it fails and names the moment and the measured p95

#### Scenario: Status reports hook health

- **GIVEN** a repository where the four moments ran during the last 7 days
- **WHEN** `openlore status` runs
- **THEN** one line shows each moment's last run and p95, the errors and overruns, the findings
  shown, and how many were fixed, decided, open, and not assessed

#### Scenario: A record that cannot be written changes nothing

- **GIVEN** a `.openlore/` directory that is read-only
- **WHEN** a hook runs
- **THEN** its output and exit code are the same as with a writable directory

#### Scenario: No run recorded prints no health line

- **GIVEN** a repository where no hook has run
- **WHEN** `openlore status` runs
- **THEN** it prints no hook health line and exits 0

### Requirement: ManagedHooksStayCleanAcrossUpgradeAndUninstall

`openlore install` run again after an upgrade SHALL leave exactly one current OpenLore group for
each managed hook and none for a moment the installed version no longer has. `openlore install
--uninstall` SHALL leave no hook entry that calls OpenLore, SHALL leave the user's own hooks
byte-identical, and SHALL name what it keeps on purpose without deleting it (see
`UninstallDisclosesWhatItKeeps`). `openlore doctor`
SHALL report a wired hook command whose runtime file does not exist.

#### Scenario: Upgrade leaves no duplicate

- **GIVEN** a repository wired by an older OpenLore version
- **WHEN** the newer version runs `openlore install`
- **THEN** each managed hook has exactly one OpenLore group, and each group names the current command

#### Scenario: A retired moment is removed

- **GIVEN** a settings file with an OpenLore group for a moment the installed version does not have
- **WHEN** `openlore install` or `openlore install --uninstall` runs
- **THEN** that group is removed and the user's own hooks are unchanged

#### Scenario: Doctor finds a hook with no runtime

- **GIVEN** a wired hook command whose entry file was deleted
- **WHEN** `openlore doctor` runs
- **THEN** it reports the missing path and names `openlore install` as the fix

### Requirement: IndexProgressIsShownToTheUserNotTheAgent

While an index build or a background repair runs, OpenLore SHALL record its progress (phase, files
done, files total, start time) in a local file under `.openlore/`, and `openlore statusline` and
`openlore status` SHALL show it as a percentage with the file counts. When no build or repair
runs, they SHALL show their usual state and nothing more. Progress text SHALL NOT be added to the
agent's context. Where OpenLore's status line is not wired, the prompt-submitted moment MAY show
the user one line when a build starts and one when it is ready, through a channel the harness
shows to the user and not to the model; it SHALL show no other progress text.

#### Scenario: The status line shows a running build

- **GIVEN** a first index build that has parsed 1,310 of 2,900 files
- **WHEN** `openlore statusline` runs
- **THEN** it prints `OpenLore: indexing 45% (1,310/2,900 files)`

#### Scenario: A stale progress record is not a running build

- **GIVEN** a progress record whose process has exited
- **WHEN** `openlore statusline` runs
- **THEN** it prints the usual index state, not a percentage

#### Scenario: A user without OpenLore's status line hears twice

- **GIVEN** a Claude Code session where OpenLore's status line is not wired and no index exists
- **WHEN** the first prompt starts a build, and a later prompt arrives after it is ready
- **THEN** the user sees one start line and one ready line
- **AND** neither line is in the model's context, and no other prompt shows a progress line
