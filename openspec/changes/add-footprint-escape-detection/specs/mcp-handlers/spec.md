# mcp-handlers spec delta

## ADDED Requirements

### Requirement: FootprintEscapeDetection

The system SHALL extend `structural_diff` to accept an optional caller-supplied declared write-footprint
and an optional list of peer footprints, and — when a declared footprint is supplied — compute the
**escape set**: the symbols and files the diff actually modified that lie outside the declared
write-set. When no declared footprint is supplied, `structural_diff` SHALL behave exactly as before
(the extension is additive and dormant). Each escaped item SHALL be classified as an out-of-scope
write (modified a symbol absent from the declared write-set), a read-set intrusion (modified a symbol
that was only in the declared read-set), or scope creep within a declared file. The system SHALL hold
no roster of agents, tasks, or in-flight footprints across calls; declared and peer footprints are
per-call inputs. The escape set SHALL be a deterministic function of the diff, the declared footprint,
and the supplied peer footprints, and the result SHALL carry a disclosure that detection is structural
and cannot catch a purely semantic conflict.

#### Scenario: A diff within its declared footprint reports no escape

- **GIVEN** a diff whose modified symbols are all contained in the supplied declared write-set
- **WHEN** `structural_diff` is called with that declared footprint
- **THEN** the escape set is empty

#### Scenario: An out-of-scope write is flagged

- **GIVEN** a diff that modifies a symbol absent from the declared write-set
- **WHEN** `structural_diff` is called with that declared footprint
- **THEN** the escape set contains that symbol classified as an out-of-scope write

#### Scenario: Modifying a read-only symbol is a read-set intrusion

- **GIVEN** a diff that modifies a symbol that appeared only in the declared read-set
- **WHEN** `structural_diff` is called with that declared footprint
- **THEN** the escape set contains that symbol classified as a read-set intrusion

#### Scenario: With no declared footprint, behavior is unchanged

- **GIVEN** a `structural_diff` call with no declared footprint supplied
- **WHEN** the diff is analyzed
- **THEN** the output is identical to the existing `structural_diff` output, with no escape set

### Requirement: EscapeOpensConflictRecomputation

When a declared footprint and peer footprints are supplied, the system SHALL recompute the conflicts
that an escape newly opens: for each escaped symbol, intersection with a peer footprint's write-set
SHALL be reported as a newly-opened write-write conflict naming the conflicting peer task, distinct
from any conflict the original plan already contained. This finding SHALL be advisory by default and
MAY be opted into a blocking class via the existing enforcement policy; enforcement and re-planning
are the responsibility of the caller, not the system.

#### Scenario: An escape that lands in a peer write-set opens a new conflict

- **GIVEN** a diff whose out-of-scope write modifies a symbol present in a supplied peer footprint's
  write-set
- **WHEN** `structural_diff` is called with the declared footprint and that peer footprint
- **THEN** a newly-opened write-write conflict is reported, naming the peer task and the shared symbol

#### Scenario: The escape finding is advisory unless opted into blocking

- **GIVEN** a newly-opened conflict reported by an escape check
- **WHEN** no enforcement policy opts the corresponding finding into a blocking class
- **THEN** the call returns the finding and blocks nothing

### Requirement: RegistryCollisionResolution

When two diffs both modify the same registration symbol (a dispatcher, a registry array, a preset
list), the system SHALL inspect the actual edits and SHALL report the collision as resolved-by-merge —
not a conflict — when both edits are disjoint additions (new branches or elements at non-overlapping
locations). The system SHALL report a real write-write conflict only when an edit modifies an existing
member of that symbol, or when two additions genuinely overlap. When a seed was declared with
`writeMode: append` at plan time but the actual diff modified existing code, the system SHALL flag the
mis-declared append. This requirement is the back-side verification of the plan-time shared-append
classification: the plan downgrades declared appends optimistically, and this check confirms or refutes
them against the realized diffs.

#### Scenario: Disjoint additions to one registry symbol resolve by merge

- **GIVEN** two diffs that each add a new, non-overlapping entry to the same tool-registry array or
  dispatcher
- **WHEN** the escape check compares them
- **THEN** the collision is reported as resolved-by-merge rather than a write-write conflict

#### Scenario: A modification of an existing member is a real conflict

- **GIVEN** two diffs touching the same registration symbol where at least one modifies an existing
  member rather than appending
- **WHEN** the escape check compares them
- **THEN** a real write-write conflict is reported, and if the modifying seed had been declared
  `append`, the mis-declared append is flagged
