# cli spec delta

## ADDED Requirements

### Requirement: DecisionAutopilotMode

When `governance.autopilot` is enabled, the decisions gate SHALL auto-accept: decisions
reaching `verified` transition to a distinct `auto-approved` status (actor `autopilot`, with
timestamp and triggering commit) and are synced to specs in the background; the pre-commit
gate SHALL never block a commit — it emits a single advisory line naming the count of
auto-accepted decisions and the trail command, and exits 0. Infrastructure failure in
consolidation or sync SHALL degrade to a caveat and exit 0, never a block. With autopilot
disabled, gate behavior SHALL be unchanged from the blocking human-review flow.
`auto-approved` SHALL be a distinct status, never conflated with human `approved`, and
autopilot SHALL never transition a human-`rejected` decision.

#### Scenario: A commit sails through with a trail

- **GIVEN** `governance.autopilot: true` and two verified decisions pending
- **WHEN** the user runs `git commit`
- **THEN** the commit succeeds, both decisions become `auto-approved` and sync in the
  background, and stderr carries one advisory line pointing at `openlore decisions log`

#### Scenario: Autopilot cannot resurrect a rejection

- **GIVEN** a decision a human explicitly rejected
- **WHEN** any number of autopilot gate runs occur
- **THEN** the decision remains `rejected` and never re-enters specs

### Requirement: DecisionLedgerIsAppendOnly

Every decision status transition — in every mode — SHALL append one entry
`{ id, title, from, to, actor: human|autopilot|agent|sync, at, commit }` to an append-only ledger
(`.openlore/decisions/ledger.jsonl`). `openlore decisions log` SHALL render the ledger
newest-first with `--json` and `--since <ref>` filters. Ledger writes SHALL use the same
cross-process serialization as the decision store, and existing entries SHALL never be
rewritten or deleted.

#### Scenario: The trail answers "what did you accept for me?"

- **GIVEN** a week of autopilot commits
- **WHEN** the user runs `openlore decisions log --since main@{1.week.ago}`
- **THEN** every auto-accepted decision appears with actor `autopilot`, its commit, and its
  timestamp

### Requirement: AutoApprovedDecisionsAreReviewableAndReversible

`openlore decisions review` SHALL list every `auto-approved` decision not yet human-reviewed
and support bulk disposition: promote (transition to human `approved`) or reject. Rejecting
an auto-approved decision SHALL retire it from specs through the existing supersession
machinery — remaining queryable via `asOf` — never by deletion.

#### Scenario: Reverting a bad auto-acceptance

- **GIVEN** an auto-approved decision the user disagrees with
- **WHEN** they reject it in `openlore decisions review`
- **THEN** it leaves the authoritative spec surface, `recall`/`verify_claim` stop serving it
  as current, and `asOf` queries before the rejection still return it
