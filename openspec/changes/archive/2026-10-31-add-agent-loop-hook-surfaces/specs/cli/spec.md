# cli spec delta

## ADDED Requirements

### Requirement: LoopMomentsReceiveBudgetedReceipts

`openlore install` SHALL wire into a repository's Claude Code settings an `openlore hook <moment>`
command for the moments before an edit (`PreToolUse` on the edit tools), after an edit
(`PostToolUse` on the edit tools), and before stopping (`Stop`), and SHALL NOT wire them in the user
scope, where they would run in every repository. Each command SHALL read the harness payload, print
at most one receipt as the event's `additionalContext` within that moment's budget (keeping the most
severe items and counting the rest), print nothing when it has no new item, and not repeat a fact
already delivered under the same harness `session_id`. The before-edit moment SHALL NOT write the
target file. The after-edit moment SHALL record the edited file for the session ledger. Each moment
SHALL be turned off by `hooks.<moment>: false` in `.openlore/config.json`, and `openlore status`
SHALL list the wired moments.

#### Scenario: A generated file is named before the edit

- **GIVEN** a pending edit to a file whose header says it is generated from `order.proto`
- **WHEN** the before-edit hook runs on the edit tool's payload
- **THEN** it states the file is generated and names `order.proto`, and the file is unchanged

#### Scenario: An edit gets only new facts

- **GIVEN** an agent session where the after-edit hook already reported a skipped test
- **WHEN** the same file is edited again with nothing new
- **THEN** the hook prints nothing

#### Scenario: Nothing new prints nothing

- **GIVEN** an edit that produces no finding and no ledger fact
- **WHEN** the after-edit hook runs
- **THEN** it prints nothing and exits 0

### Requirement: LoopHooksAreAdvisoryUnlessPolicyBlocks

Every `openlore hook <moment>` command SHALL exit 0, and SHALL print nothing on timeout or error,
whatever the policy. Only when the repository's `enforcement.policy` names one or more finding codes
as blocking MAY the before-stop hook block, and its message SHALL list the blocking findings and
their next actions; it SHALL NOT block when the payload says a stop hook is already active. The hook
SHALL add no imperative of its own; receipt next actions SHALL be carried as labeled data. The
hook's standard output SHALL carry only the receipt.

#### Scenario: Stop does not block by default

- **GIVEN** no blocking codes in `enforcement.policy` and a session diff with a `test-disabled`
  finding
- **WHEN** the before-stop hook runs
- **THEN** it prints the receipt including the finding and does not block

#### Scenario: A team can make one finding blocking

- **GIVEN** `enforcement.policy` naming `test-disabled` as blocking
- **WHEN** the before-stop hook runs on the same diff
- **THEN** the hook blocks the stop and its message names the finding
