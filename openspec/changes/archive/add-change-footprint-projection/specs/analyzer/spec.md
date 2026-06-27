# analyzer spec delta

## ADDED Requirements

### Requirement: ChangeFootprintProjection

The system SHALL compute, for a caller-supplied task descriptor, a deterministic **footprint**
consisting of three regions over the existing call graph plus a soft co-change annotation, reusing the
existing reachability and change-coupling primitives, with no new graph-schema element, no persisted
store, and no new MCP tool. A task descriptor is `{ id, seedSymbols?, seedFiles?, intent?, writeMode? }`
supplied by the caller (an agent or human) and is never invented by the system; at least one seed is
required. `writeMode` is `append` or `modify` (default `modify`), a caller-declared annotation that a
seed is a pure addition to a registration site rather than a change to existing code; the system SHALL
NOT infer it. The footprint regions SHALL be:

- a **write-set**: the seeds resolved to symbols and normalized to their enclosing symbol/type/file —
  a *declared* region, not a prediction of every edit — each carrying its declared `writeMode`;
- a **read-set**: the forward call closure (callees/dependencies) of the write-set, bounded by the
  existing call-distance scoping and with ambient symbols excluded;
- an **affected-set**: the backward reachability (callers) of the write-set, equivalent to the
  existing blast radius of the write-set, provided as informational output only and NOT used as an
  input to hazard classification; and
- **coupling-neighbors**: files that co-change with the write-set above the existing co-change support
  and confidence thresholds, carried as a separate advisory annotation, never merged into the static
  regions.

A footprint SHALL be a deterministic function of the graph state, the change-coupling store, and the
descriptor, byte-identical across re-evaluations of a fixed state. The write-set SHALL be reported as
advisory/declared and SHALL carry a known-unknowable disclosure that an agent may edit outside it.

#### Scenario: A seed expands to a three-region footprint

- **GIVEN** a task descriptor whose single seed is a function symbol
- **WHEN** its footprint is computed
- **THEN** the write-set contains that symbol normalized to its enclosing scope, the affected-set
  equals the blast radius (backward reachability) of the write-set, and the read-set equals the
  forward call closure of the write-set bounded by the call-distance scope

#### Scenario: The write-set is declared, not inferred

- **GIVEN** a task descriptor with explicit seeds
- **WHEN** its footprint is computed
- **THEN** the write-set contains only the declared seeds normalized to enclosing scope — no
  heuristic prediction of additional edit targets — and is flagged advisory with the disclosure that
  actual edits may fall outside it

#### Scenario: An unresolved seed yields an empty footprint with a note

- **GIVEN** a task descriptor whose seed names a symbol or file not present in the graph
- **WHEN** its footprint is computed
- **THEN** the footprint is empty and carries an explicit unresolved-seed note, and no region is
  fabricated

#### Scenario: Co-change coupling is a separate advisory annotation

- **GIVEN** a write-set whose file co-changes above the support and confidence thresholds with another
  file that has no static call relation to it
- **WHEN** the footprint is computed
- **THEN** that other file appears in coupling-neighbors as an advisory annotation and does not enter
  the static write/read/affected regions

### Requirement: PairwiseHazardClassification

The system SHALL provide a pure function that, given two footprints, returns the strongest data-hazard
between them using the classical hazard taxonomy, together with the witnessing symbol(s) and, for
ordering hazards, the direction. The classification SHALL be:

- **WAW** when the two write-sets intersect and at least one side touches a shared symbol in `modify`
  mode (a true conflict requiring mutual exclusion);
- **shared-append** when the two write-sets intersect but both sides touch every shared symbol in
  `append` mode (concurrent additions to a registration site that merge trivially — a low-risk
  advisory, NOT mutual exclusion);
- **RAW** when one footprint's write-set intersects the other's read-set, after ambient symbols are
  excluded (an ordering dependency: the reader runs after the writer or re-orients), with the
  direction recorded;
- **WAR / low-risk** when footprints overlap only in read sets or touch the same file in disjoint
  symbols (surfaced, non-serializing);
- **soft-coupling** when the write-sets share no static relation but the files co-change above
  threshold (advisory only); and
- **none** otherwise.

Precedence SHALL be WAW > RAW > shared-append > WAR > soft-coupling > none. The classifier SHALL be
deterministic and SHALL include the witnessing symbols so a consumer can explain the verdict.

#### Scenario: Shared written symbol classifies WAW

- **GIVEN** two footprints whose write-sets both contain the same symbol, at least one in `modify` mode
- **WHEN** the hazard between them is classified
- **THEN** the result is WAW and names the shared symbol as the witness

#### Scenario: Concurrent appends to a registration symbol classify shared-append, not WAW

- **GIVEN** two footprints whose only write-set overlap is a registration symbol (for example a
  dispatcher or a tool-registry array) that both declare in `append` mode
- **WHEN** the hazard between them is classified
- **THEN** the result is shared-append (a low-risk advisory), so the two tasks are not forced into
  different waves, and naming the shared registration symbol as the witness
- **AND** if either side declares that same symbol in `modify` mode, the result is WAW instead

#### Scenario: One task writes what another reads classifies RAW with direction

- **GIVEN** footprint A whose write-set contains a symbol that appears in footprint B's read-set, with
  no write-set intersection
- **WHEN** the hazard between them is classified
- **THEN** the result is RAW with direction "B after A" and names the witnessing symbol

#### Scenario: Same file, disjoint symbols classifies low-risk

- **GIVEN** two footprints that modify different symbols within the same file and share no read/write
  symbol overlap
- **WHEN** the hazard between them is classified
- **THEN** the result is WAR/low-risk rather than WAW, so the two tasks are not forced into different
  waves by file overlap alone

#### Scenario: Co-change without a static relation classifies soft-coupling

- **GIVEN** two footprints whose write-sets have no static call relation but whose files co-change
  above the support and confidence thresholds
- **WHEN** the hazard between them is classified
- **THEN** the result is soft-coupling (advisory), not a hard hazard class

### Requirement: AmbientSymbolExclusion

The system SHALL treat symbols whose fan-in exceeds a configurable percentile threshold as **ambient**
(ubiquitous infrastructure such as a logger, a directory validator, or core call-graph primitives) and
SHALL exclude ambient symbols from a footprint's read-set and from generating RAW ordering edges, so
that pervasive infrastructure dependencies — which carry no real ordering signal — do not serialize
otherwise-independent tasks or bloat read-sets toward the whole graph. A *write* to an ambient symbol
(which is rare) SHALL still be eligible to create hazards. The ambient threshold SHALL be deterministic
and documented.

#### Scenario: A shared ambient dependency does not create an ordering edge

- **GIVEN** two footprints whose read-sets both include a symbol whose fan-in is above the ambient
  threshold, with no non-ambient write/read overlap between them
- **WHEN** the hazard between them is classified
- **THEN** no RAW edge is created from that ambient symbol, and the two tasks remain independent

#### Scenario: Writing an ambient symbol still creates a hazard

- **GIVEN** footprint A whose write-set contains an ambient symbol that appears in footprint B's
  read-set
- **WHEN** the hazard between them is classified
- **THEN** a RAW edge (B after A) is created, because the ambient exclusion applies to read-set
  membership, not to a deliberate write of the symbol
