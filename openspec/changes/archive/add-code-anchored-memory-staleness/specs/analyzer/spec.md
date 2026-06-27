# analyzer spec delta

## ADDED Requirements

### Requirement: StructuralMemoryAnchor

The system SHALL anchor a persisted memory to the code it describes by resolving each referenced
symbol to a concrete call-graph node and capturing a structural anchor of the form
`{ nodeId, symbolName, filePath, contentHash }`. `contentHash` SHALL be a hash of the exact source
span the analyzer already extracts for that node (the same span returned by `get_function_body`),
computed without normalization so it is reproducible. Anchor resolution SHALL be deterministic and
SHALL NOT use an LLM.

When a referenced symbol does not resolve to a call-graph node, the system SHALL record a file-level
anchor (`filePath` with no `nodeId`) and SHALL NOT guess a node — exact match only.

#### Scenario: Symbol reference resolves to a node anchor

- **GIVEN** a memory recorded against a function that exists in the call graph
- **WHEN** the anchor is resolved
- **THEN** the stored anchor contains the function's `nodeId`, `symbolName`, `filePath`, and the
  `contentHash` of its current source span

#### Scenario: Unresolved symbol falls back to a file-level anchor

- **GIVEN** a memory that names a symbol with no matching call-graph node
- **WHEN** the anchor is resolved
- **THEN** a file-level anchor (`filePath` only, no `nodeId`) is stored, the unresolved name is
  logged, and the write does not fail

#### Scenario: Content hash is reproducible

- **GIVEN** an unchanged function
- **WHEN** its `contentHash` is computed on two separate analysis runs
- **THEN** the two hashes are identical

### Requirement: DeterministicMemoryFreshness

The system SHALL compute a freshness verdict for each anchored memory against the current call graph,
using only boolean inputs (symbol existence and content-hash equality) with no tunable threshold and
no weighted or composite score. The verdict for a single anchor SHALL be exactly one of:

- **`fresh`** — the anchored symbol exists and its current `contentHash` equals the stored hash.
- **`drifted`** — the anchored symbol exists but its current `contentHash` differs from the stored hash.
- **`orphaned`** — the anchored symbol no longer exists in the graph.

When an anchored symbol is absent, the system SHALL consult the existing rename detection from
`structural_diff`; a confidently mapped rename SHALL be reported as `drifted` with the new location
rather than `orphaned`, reusing that detector and introducing no new heuristic. A memory with
multiple anchors SHALL take the worst verdict among them (`orphaned` worse than `drifted` worse than
`fresh`).

#### Scenario: Body edit yields drifted

- **GIVEN** a memory anchored to a function whose body is later modified
- **WHEN** freshness is computed
- **THEN** the verdict is `drifted`

#### Scenario: Deleted symbol yields orphaned

- **GIVEN** a memory anchored to a function that is later deleted
- **WHEN** freshness is computed
- **THEN** the verdict is `orphaned`

#### Scenario: Confident rename downgrades orphaned to drifted

- **GIVEN** a memory anchored to a function that is later renamed, and `structural_diff` confidently
  maps the old name to the new one
- **WHEN** freshness is computed
- **THEN** the verdict is `drifted` and the response reports the new location, not `orphaned`

#### Scenario: Untouched anchor stays fresh

- **GIVEN** a memory anchored to a function that is unchanged
- **WHEN** freshness is computed
- **THEN** the verdict is `fresh`

#### Scenario: Worst-of aggregation across anchors

- **GIVEN** a memory with one `fresh` anchor and one `orphaned` anchor
- **WHEN** the memory's overall verdict is computed
- **THEN** the overall verdict is `orphaned`

### Requirement: FileLevelFreshnessForLegacyMemory

The system SHALL compute a deterministic file-level freshness verdict for memories that carry only a
file-path anchor (no `nodeId`), based on file existence and whether the file's content hash changed
since the memory's `recordedAt`. The system MAY upgrade such a memory to a symbol-level anchor only by
resolving a symbol named verbatim in the memory to an exactly matching call-graph node; it SHALL NOT
infer anchors with an LLM, and an upgradable match SHALL leave the memory at file-level freshness.

#### Scenario: Legacy decision on a deleted file reports orphaned

- **GIVEN** a legacy decision whose only anchor is a file path, and that file is later deleted
- **WHEN** file-level freshness is computed
- **THEN** the verdict is `orphaned`

#### Scenario: Legacy decision upgraded only on exact symbol match

- **GIVEN** a legacy decision whose rationale names a symbol that exactly matches a call-graph node
- **WHEN** anchor upgrade is attempted
- **THEN** a symbol-level anchor is added deterministically; a decision naming no matching symbol
  stays at file-level freshness with no inferred anchor
