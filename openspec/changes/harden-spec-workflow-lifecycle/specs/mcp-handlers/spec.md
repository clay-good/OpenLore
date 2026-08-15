## ADDED Requirements

### Requirement: Unavailable Coverage Uses Unknown Values

Mapping-dependent coverage metrics SHALL be `null` whenever current deterministic links cannot establish them. The response SHALL carry `mappingCoverage.state = "unavailable"` and a stable reason such as `mapping-not-generated`, `incompatible-provenance`, `fingerprint-mismatch`, or `invalid-json`. Zero SHALL mean an observed count of zero, never unavailable evidence.

#### Scenario: Incompatible provenance does not look fully covered
- **GIVEN** an audit whose mapping cache has incompatible provenance and whose in-memory link derivation cannot establish coverage
- **WHEN** the audit response is produced
- **THEN** covered, uncovered, percentage, and orphan-requirement metrics are `null`, while mapping-independent metrics remain populated

#### Scenario: Available empty coverage remains numeric
- **GIVEN** a current deterministic link index that establishes zero covered functions
- **WHEN** the audit response is produced
- **THEN** its covered count and percentage are numeric zero and `mappingCoverage.state` is `available`

### Requirement: Transport-Safe Composite Pagination

Generate and Repair composites SHALL accept a bounded serialized-response budget in addition to item limits. The default budget SHALL fit every bundled MCP/Pi adapter without downstream clipping. Cursors SHALL be bound to workflow, domain, analysis generation, budget version, byte budget, logical evidence section, and offset.

A receipt MAY declare `complete` only after the final serialized envelope is within the effective byte budget and contains every required item. Any recoverable omitted evidence SHALL make the receipt `partial` and provide a continuation cursor. Pagination SHALL be able to continue within signatures, inventories, relationships, mapping observations, structural changes, and other logical sections; a single large file MUST NOT make the remainder unreachable.

#### Scenario: Host transport limit produces continuation
- **GIVEN** complete domain evidence would exceed the effective serialized byte budget
- **WHEN** the composite builds its first response
- **THEN** the response fits the budget, is `partial`, identifies omitted sections/counts, and returns a cursor that retrieves the next deterministic page

#### Scenario: Final page alone is complete
- **GIVEN** all earlier pages have been consumed and the remaining evidence fits the budget
- **WHEN** the final cursor is requested
- **THEN** the response fits the budget, contains the remaining evidence, and only that page declares completion of the continuation sequence

#### Scenario: Oversized individual evidence is recoverable
- **GIVEN** one file contributes more signatures, inventory entries, or relationships than one page can hold
- **WHEN** the composite paginates it
- **THEN** it continues inside the relevant logical section rather than silently dropping the section or declaring the workflow complete

### Requirement: Follow-Ups Are Executable

Every follow-up advertised by a composite SHALL either name an MCP tool callable in the active surface with valid prefilled arguments, reference a continuation of the same available composite, or provide a typed exact CLI command. A composite MUST NOT advertise an unavailable atomic tool and MUST NOT recommend an observation that merely repeats the same unavailable state.

#### Scenario: Default preset follow-up remains callable
- **GIVEN** a composite running under the default substrate preset omits recoverable evidence
- **WHEN** it emits a follow-up
- **THEN** the follow-up can be executed without changing presets, or it contains an exact CLI remediation instead of an unavailable tool name

#### Scenario: Unavailable mapping receives remediation
- **GIVEN** mapping coverage cannot be established
- **WHEN** Repair emits its receipt
- **THEN** it does not recommend rerunning the same audit and instead identifies deterministic mapping refresh or explicit-anchor repair as the remediation

### Requirement: Analysis Generation Coherence

Every composite and cached MCP read SHALL bind all consumed analysis artifacts to one analysis-generation identity. A server SHALL automatically reload when a newer committed generation becomes current. If a generation changes while a response is composed, the request SHALL retry against one generation or return a typed `analysis-changed` result; it MUST NOT combine old cached paths with a fresh preflight state.

#### Scenario: External analyze invalidates daemon cache
- **GIVEN** a daemon has cached one analysis generation and another process commits a newer generation
- **WHEN** `orient` or a spec composite is called
- **THEN** it reads the newer generation automatically and returns no paths solely present in the old generation

#### Scenario: Generation changes during composition
- **GIVEN** analysis commits a new generation while a multi-artifact composite is reading
- **WHEN** the composite validates its snapshot
- **THEN** it retries or returns `analysis-changed`, and never labels mixed-generation evidence fresh

### Requirement: Existing Spec Overlap Observation

Generation preparation SHALL compare the requested analyzed domain footprint with existing specification footprints and return bounded overlap observations for shared normalized files and exact symbols. The observation SHALL disclose its basis and completeness but MUST NOT decide whether the requested domain is a business domain, a technical layer, or a replacement for an existing spec.

#### Scenario: Technical candidate overlaps existing specs
- **GIVEN** a detected `components` domain shares analyzed files or symbols with existing `agent`, `theme`, and `artifact-rendering` specs
- **WHEN** generation preparation runs
- **THEN** it reports each deterministic overlap and leaves merge, rename, or new-domain interpretation to the host agent

#### Scenario: No overlap is an observed result
- **GIVEN** a candidate domain with a complete footprint comparison and no shared files or symbols
- **WHEN** generation preparation runs
- **THEN** it reports an available empty overlap set rather than omitting the observation
