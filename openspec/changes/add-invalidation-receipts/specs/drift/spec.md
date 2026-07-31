# drift spec delta

## ADDED Requirements

### Requirement: InvalidationCarriesACommitReceipt

When staleness detection concludes that a memory or decision is no longer fresh, the system SHALL
record — once and immutably — the invalidating commit and a cause from the closed set
`anchor-content-changed`, `symbol-deleted`, `superseded-by <id>`, `claim-refuted`. The commit
SHALL be identified deterministically as the first commit within the observed
last-fresh-to-first-stale window whose change to the anchored span breaks the anchor's content
hash; when the commit cannot be identified (unreachable history, shallow clone), the receipt
SHALL record `unknown` with the reason, never a guessed identifier. Read surfaces SHALL attach
the receipt to non-fresh results, and as-of queries SHALL report closed validity intervals whose
endpoints are both evidenced. Receipts SHALL NOT change which facts are considered stale — they
evidence the existing verdicts.

#### Scenario: An orphaned memory names its killer

- **GIVEN** a memory anchored to a symbol deleted in commit C
- **WHEN** staleness detection runs and the memory is recalled
- **THEN** it is served as orphaned with the receipt `symbol-deleted` at commit C

#### Scenario: Unresolvable history is disclosed, not guessed

- **GIVEN** an invalidation whose observation window falls outside the available git history
- **WHEN** the receipt is written
- **THEN** it records cause with commit `unknown` and the reason, and no fabricated SHA appears

#### Scenario: As-of history reports closed intervals

- **GIVEN** a memory valid from commit A and invalidated at commit C
- **WHEN** an as-of query is made at a ref between A and C, and another after C
- **THEN** the first serves the memory as valid and the second reports the interval closed at C
  with its cause

#### Scenario: Receipts are write-once

- **GIVEN** a memory carrying an invalidation receipt
- **WHEN** later analyzes or watcher passes run
- **THEN** the receipt is unchanged
