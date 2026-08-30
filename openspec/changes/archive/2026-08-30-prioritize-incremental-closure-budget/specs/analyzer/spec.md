# analyzer spec delta

## ADDED Requirements

### Requirement: IncrementalBudgetIsSpentInSignificanceOrderWithinEachPhase

When a changed file's reverse-dependency closure exceeds the per-file work budget, the update
SHALL spend the budget on the highest-structural-significance candidates first rather than in
enumeration order.

**The closure is discovered in two phases** — the changed file's direct callers, then the prior
non-callers whose previously-external or name-only call sites a newly-added symbol should now
bind — and the second phase is not enumerable until the first has been built. Significance
ordering SHALL therefore be applied **within each phase**, over that phase's fully-enumerated
candidate set, and SHALL NOT be applied across phases. The budget split between phases SHALL be
exactly what it is today: phase one consumes up to the budget, phase two the remainder. Ordering
SHALL NOT change how many files either phase recomputes — only which files those are.

**Significance is a strict lexicographic order over a fixed tuple:** descending fan-in, then
descending fan-out, then ascending file path. The shipped hub / orchestrator / chokepoint labels
are used for *reporting* the composition, never as an independent tie-break level — each is a
monotone function of fan-in or fan-out, so a label can never break a tie those counters did not
already break. No new significance metric, weighting, or tuning constant SHALL be introduced;
where a threshold is needed for reporting, the existing thresholds SHALL be reused from a single
exported location rather than re-declared.

**Candidates are files, not symbols.** A file's fan-in SHALL be the maximum fan-in over its
internal non-test nodes and its fan-out the fan-out of that same node; a file with no internal
nodes SHALL rank last. The aggregation SHALL be stated explicitly so the order is reproducible
from the node table alone. If an existing file-level significance ranking is reused instead, the
spec SHALL name it; a second divergent file-ranking rule SHALL NOT be introduced.

**The signal is read only from facts already resident** on the incremental path — the internal
node table the update already loads to seed cross-file resolution — and SHALL NOT require a git
query, an artifact load, or a per-candidate store query.

**The signal's staleness SHALL be disclosed.** It is drawn from the graph being updated: an
incremental rebuild recomputes a file's fan-in over the re-parsed subset only and does not
re-derive hub membership, so a recently-edited file's recorded fan-in is a **lower bound**.
Prioritization is therefore a best-effort ordering over a possibly-stale signal, never a
correctness claim, and SHALL NOT be reported as evidence that the recomputed set is the true
dirty set. Where the signal is unavailable or degenerate, the update SHALL fall back to the
stable path order and say so.

**Ordering never prunes.** Significance SHALL be used only to order candidates for budget
consumption under an over-budget condition. It SHALL NOT remove a file from the closure, SHALL
NOT exempt a low-significance file from being marked stale, and SHALL have no effect whatsoever
when the closure fits within the budget.

**No candidate class is starved indefinitely.** Test functions carry near-zero fan-in by
construction, so a pure fan-in order would place every test-file candidate last in every
over-budget closure — systematically starving the test→production edges that backward-reachability
conclusions depend on. Test-file candidates SHALL be ranked within their own class and guaranteed
a bounded share of the budget, or the resulting degradation of test-reachability conclusions SHALL
be explicitly disclosed as a known consequence.

#### Scenario: A hub is recomputed before leaves

- **GIVEN** a save whose phase-one closure contains one high-fan-in hub and more leaf callers than
  the budget allows
- **WHEN** the incremental update runs
- **THEN** the hub is among the recomputed files and the stale remainder is drawn from the leaves

#### Scenario: Ordering is deterministic

- **GIVEN** the same over-budget closure processed twice
- **WHEN** the two updates are compared
- **THEN** the recomputed and stale sets are identical, including for candidates with equal
  fan-in and fan-out

#### Scenario: Under budget, ordering is a no-op

- **GIVEN** a closure that fits entirely within the budget
- **WHEN** the update runs
- **THEN** every candidate is recomputed, the stale set is empty, and the result is identical to
  the result before this change

#### Scenario: Test callers are not systematically starved

- **GIVEN** an over-budget closure containing both production and test-file callers
- **WHEN** repeated over-budget updates run against the same file
- **THEN** test-file callers are not indefinitely excluded from every budget, and any
  reachability degradation is disclosed

#### Scenario: The contract is untouched

- **GIVEN** an over-budget closure
- **WHEN** the update completes
- **THEN** the recomputed count still respects the budget, every un-recomputed file is marked
  stale, and freshness verdicts over the stale region remain non-authoritative

### Requirement: StaleRegionsReportTheirStructuralComposition

A reported stale region SHALL describe its structural composition — the number of hub and
chokepoint symbols it contains and the highest-significance symbol within it — not only its file
count. The composition SHALL be computed and persisted with the stale marking, and SHALL be
surfaced wherever a stale region is **already** reported: the incremental update's summary and
the per-anchor stale-region marker on freshness verdicts. This requirement constrains the *shape*
of the report, not the number of surfaces; it SHALL NOT be read as mandating a new command or a
new tool.

**Rebuild urgency SHALL be monotone.** The urgency of the scheduled background reconciliation MAY
be selected from the composition, subject to a monotonicity constraint: while a reconciliation is
pending, a later trigger SHALL NOT **shorten** an already-armed window. The effective window of a
coalesced burst SHALL be the longest window any pending trigger selected, so a settle period
chosen to let a bulk VCS operation land is never pre-empted — shortening it would fire a rebuild
into a half-applied pull and produce two full re-analyzes where one sufficed. Composition MAY only
lengthen the window for a region with no high-significance symbols; the shortest permissible
window SHALL remain the current fixed debounce. Reconciliation SHALL remain debounced, coalesced,
and at-most-one-in-flight.

A composition report names symbols and paths drawn from the analyzed repository. Every rendering
SHALL pass that repository-derived text through the shared terminal-control-sequence
neutralization before it reaches a terminal — on the watcher's own output path as well as the
shared CLI sinks — so an analyzed repository cannot forge or overwrite OpenLore's output through
a stale-region report.

A composition report SHALL NOT alter the staleness verdict: a low-significance stale region is
still stale and still non-authoritative.

#### Scenario: The summary names what went stale

- **GIVEN** an over-budget update leaving 12 files stale, 2 containing hub symbols
- **WHEN** the update is reported
- **THEN** the report states the count, the hub count, and the highest-significance symbol

#### Scenario: A later trigger never shortens an armed window

- **GIVEN** a pending reconciliation armed with the bulk-operation settle window, and a
  hub-containing stale region triggering shortly after
- **WHEN** the triggers coalesce
- **THEN** the effective window is the longer of the two, and exactly one rebuild runs

#### Scenario: A hostile symbol name cannot forge the report

- **GIVEN** a stale region containing a symbol whose name embeds terminal control sequences
- **WHEN** the composition is rendered
- **THEN** the sequences are neutralized and the report's own text is not overwritten

#### Scenario: Composition never softens the verdict

- **GIVEN** a memory anchored to a symbol in a stale region of only low-significance files
- **WHEN** its freshness is evaluated
- **THEN** the verdict is still non-authoritative, and the composition appears as context
