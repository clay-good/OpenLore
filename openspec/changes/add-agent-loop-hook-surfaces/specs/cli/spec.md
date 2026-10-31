# cli spec delta

## ADDED Requirements

### Requirement: LoopMomentsReceiveBudgetedReceipts

`openlore install` SHALL wire, for each supported harness and only on events that can inject
context, an `openlore hook <moment>` command for the moments before an edit, after a batch of tool
calls, after compaction, before stopping, and at sub-agent start; the team-task-created moment SHALL
be wired only when a coordination finding code is blocking. Each command SHALL read the harness
payload, print at most one receipt within that moment's token cap (keeping the highest severity
items and counting the rest), print nothing when it has no new item, and not repeat a fact already
delivered under the same harness `session_id`. The before-edit moment SHALL grade the pending edit
in memory and SHALL NOT write any file. Each moment SHALL be individually disabled by
`hooks.<moment>: false` in `.openlore/config.json`, and `openlore status` SHALL list the wired
moments.

#### Scenario: An edit batch gets only new facts

- **GIVEN** an agent session where the after-tools hook already reported an unresolved import
- **WHEN** a later edit batch leaves that import unchanged and edits a generated file
- **THEN** the hook output names the generated-file edit and does not repeat the import finding

#### Scenario: Nothing new prints nothing

- **GIVEN** an edit batch that produces no finding and no ledger fact
- **WHEN** the after-tools hook runs
- **THEN** it prints nothing and exits 0

#### Scenario: An invented import is stated before the write

- **GIVEN** a pending edit whose new text imports `formatDate` from `packages/utils`, which does not
  export it
- **WHEN** the before-edit hook runs on the edit tool's payload
- **THEN** it prints the unresolved-symbol fact, and the target file is unchanged by the hook

#### Scenario: Compaction gets the handoff briefing

- **GIVEN** a Claude Code session that is compacted
- **WHEN** the `SessionStart` hook with the `compact` matcher fires
- **THEN** the hook prints the handoff briefing for the in-flight change

### Requirement: LoopHooksAreAdvisoryUnlessPolicyBlocks

Every `openlore hook <moment>` command SHALL exit 0 by default, and SHALL always exit 0 and print
nothing on timeout or error, whatever the policy. Only when the repository's `enforcement.policy`
names one or more finding codes as blocking MAY a hook on an event that supports blocking (`Stop`,
`TaskCompleted`, `TaskCreated`) block, and its message SHALL list the blocking findings and their
next actions. The hook SHALL add no imperative of its own; receipt `nextAction` fields SHALL be
carried as labeled data.

#### Scenario: Stop does not block by default

- **GIVEN** no blocking codes in `enforcement.policy` and a session diff with a `test-disabled`
  finding
- **WHEN** the before-stop hook runs
- **THEN** it prints the receipt including the finding and exits 0

#### Scenario: A team can make one finding blocking

- **GIVEN** `enforcement.policy` naming `test-disabled` as blocking
- **WHEN** the before-stop hook runs on the same diff
- **THEN** the hook blocks the stop and its message names the test and the symbol it reached
