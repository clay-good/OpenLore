# analyzer spec delta

## ADDED Requirements

### Requirement: IncrementalBudgetIsSpentInSignificanceOrder

When an incremental update's reverse-dependency closure exceeds the work budget, the update SHALL
spend the budget on the highest-structural-significance candidates first, rather than in
enumeration order. Significance SHALL be derived from the classifiers the system already
computes — fan-in, and the existing hub / chokepoint / orchestrator labels — with a stable
tie-break on file path, so the ordering is total and deterministic. No new significance metric,
weighting, or tuning constant SHALL be introduced.

The convergence contract SHALL be unchanged: the same budget is consumed, the un-recomputed
remainder is still marked explicitly stale, and no region is left divergent and unmarked.
Prioritization SHALL change which files fall inside the budget, never whether staleness is
disclosed.

#### Scenario: A hub is recomputed before leaves

- **GIVEN** a save whose closure contains one high-fan-in hub and more leaf callers than the
  budget allows
- **WHEN** the incremental update runs
- **THEN** the hub is among the recomputed files and the stale remainder is drawn from the leaves

#### Scenario: Ordering is deterministic

- **GIVEN** the same over-budget closure processed twice
- **WHEN** the two updates are compared
- **THEN** the recomputed set and the stale set are identical, including for candidates with
  equal significance

#### Scenario: The contract is untouched

- **GIVEN** an over-budget closure
- **WHEN** the incremental update completes
- **THEN** the number of recomputed files still respects the budget, every un-recomputed file is
  marked stale, and freshness verdicts over the stale region remain non-authoritative

### Requirement: StaleRegionsReportTheirStructuralComposition

A reported stale region SHALL describe its structural composition, not only its file count: the
number of hub and chokepoint symbols it contains and the highest-significance symbol within it.
The composition SHALL be surfaced wherever the stale region is reported — the incremental update
summary, the substrate's status surface, and the freshness disclosure — using the same
significance vocabulary the change-significance briefing already establishes.

The urgency of the scheduled background reconciliation MAY be selected from that composition, and
SHALL remain debounced, coalesced, and at-most-once. A region containing no high-significance
symbols SHALL NOT trigger more frequent rebuilds than it does today.

A composition report SHALL NOT alter the staleness verdict itself: a low-significance stale region
is still stale and is still non-authoritative.

#### Scenario: The summary names what went stale

- **GIVEN** an over-budget update that leaves 12 files stale, 2 of which contain hub symbols
- **WHEN** the update is reported
- **THEN** the report states the count, the hub count, and the highest-significance symbol in the
  region

#### Scenario: A low-significance region does not increase rebuild pressure

- **GIVEN** a stale region containing only leaf symbols
- **WHEN** the background reconciliation is scheduled
- **THEN** it is coalesced under the existing window and fires no more often than before this
  change

#### Scenario: Composition never softens the verdict

- **GIVEN** a memory anchored to a symbol in a stale region of only low-significance files
- **WHEN** its freshness is evaluated
- **THEN** the verdict is still non-authoritative, and the composition appears as context rather
  than as a reason to treat the memory as fresh
