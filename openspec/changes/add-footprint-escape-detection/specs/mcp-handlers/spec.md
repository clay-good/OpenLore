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

When this change's diff modifies a registration symbol (a dispatcher, a registry array, a preset list)
that a peer task also declares it will write, the system SHALL inspect **this diff's actual edit** to
that symbol and SHALL report the collision as resolved-by-merge — not a conflict — when this diff's
edit is a pure addition (a new branch or element, no existing line of the symbol changed or removed)
**and** the peer declared `writeMode: append`. The system SHALL report a real write-write conflict
when this diff modifies an existing member of the symbol, or when the peer declared `writeMode: modify`
(the additions are not known to merge). When a seed was declared `writeMode: append` at plan time but
this diff actually modified existing code, the system SHALL flag the mis-declared append.

Because the system is stateless and holds no peer diff — only the peer's *declared* footprint (per the
parallel-work contract) — a single call inspects the **one** realized diff it is given and trusts the
peer's declared append. Genuine non-overlap of *two* realized diffs is therefore established by running
the check once per diff (the harness re-invokes it for each side); the output SHALL carry a disclosure
stating that a resolved-by-merge verdict confirms only the side whose diff it sees. This requirement is
the back-side verification of the plan-time shared-append classification: the plan downgrades declared
appends optimistically, and this check confirms or refutes them against the realized diff.

#### Scenario: This diff's disjoint addition to a declared-append registry symbol resolves by merge

- **GIVEN** this diff adds a new, non-overlapping entry to a registration symbol that a peer declared
  it will `append`
- **WHEN** the escape check runs
- **THEN** the collision is reported as resolved-by-merge rather than a write-write conflict, and the
  disclosure notes that the peer's append is trusted from its declaration

#### Scenario: A modification of an existing member is a real conflict

- **GIVEN** this diff modifies an existing member of a registration symbol (rather than only appending)
  that a peer also declares it will write
- **WHEN** the escape check runs
- **THEN** a real write-write conflict is reported, and if the modifying seed had been declared
  `append`, the mis-declared append is flagged
