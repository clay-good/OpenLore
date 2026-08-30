## ADDED Requirements

### Requirement: Unavailable Coverage Uses Unknown Values

Mapping-dependent coverage metrics in MCP and composite responses SHALL be `null` whenever current deterministic links cannot establish them. The response SHALL carry `mappingCoverage.state = "unavailable"` and a stable reason such as `mapping-not-generated`, `incompatible-provenance`, `fingerprint-mismatch`, or `invalid-json`. Zero in those agent-facing responses SHALL mean an observed count of zero, never unavailable evidence. The public v2 library API MAY retain its numeric summary for source compatibility only when `mappingCoverage` remains the authoritative availability signal.

#### Scenario: Incompatible provenance does not look fully covered
- **GIVEN** an audit whose mapping cache has incompatible provenance and whose in-memory link derivation cannot establish coverage
- **WHEN** the audit response is produced
- **THEN** covered, uncovered, percentage, and orphan-requirement metrics are `null`, while mapping-independent metrics remain populated

#### Scenario: Available empty coverage remains numeric
- **GIVEN** a current deterministic link index that establishes zero covered functions
- **WHEN** the audit response is produced
- **THEN** its covered count and percentage are numeric zero and `mappingCoverage.state` is `available`

### Requirement: Transport-Safe Composite Pagination

Generate and Repair composites SHALL accept a bounded serialized-response budget in addition to item limits. The default budget SHALL fit every bundled MCP/Pi adapter without downstream clipping. Cursors SHALL be bound to workflow, canonical domain, analysis generation, the complete stable evidence-stream identity, base-ref and item-limit shaping inputs, budget version, byte budget, logical evidence section, and offset.

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

#### Scenario: Mutable evidence changes between pages
- **GIVEN** a continuation cursor for a specification, mapping, or Git evidence stream
- **WHEN** any stream-shaping input changes before the next page
- **THEN** the cursor is rejected and the host is told to restart rather than receiving a mixed composition

### Requirement: Composite Repository Content Is Untrusted Data

Generate and Repair SHALL mark repository-derived evidence as untrusted data, SHALL NOT grant embedded directives instructional authority, and SHALL redact secrets before enforcing the final serialized response budget. A repository configuration MUST NOT disable redaction for these source-carrying composites.

#### Scenario: Repository evidence contains an instruction-shaped secret
- **GIVEN** source or specification evidence containing an embedded directive and credential-shaped text
- **WHEN** a composite response is produced
- **THEN** the directive remains labeled as untrusted data, the secret is redacted, and the final response remains within its byte budget

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

Generate and Repair SHALL require a generation marked `full`. A watcher-patched `incremental` generation MAY serve navigation tools, but MUST NOT seed specification authoring because its repository inventory can lag its patched context and dependency graph. The composites SHALL return `analysis-changed` with guidance to run a full analysis.

#### Scenario: Incremental evidence cannot author specifications
- **GIVEN** the watcher has published an incrementally patched analysis generation
- **WHEN** an agent requests Generate or Repair evidence
- **THEN** the composite returns `analysis-changed`, includes no repository evidence, and directs the agent to run a full analysis

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

### Requirement: Domains Without Behavior Are Disclosed, Not Specified

The Generate and Repair composites SHALL report, as a page-global observation, whether the resolved domain contains any symbol a requirement could describe. The no-behavior state SHALL be decided on POSITIVE evidence of prose — every file that defines the domain is documentation — and MUST NOT be inferred from the absence of extracted signatures, which a declarative or bootstrap-style domain also lacks. A documentation-only domain SHALL be disclosed as such together with the evidence behind it (symbol count, defining-file count, documentation-file count), and the terminal page SHALL carry a stop-and-ask follow-up rather than a verdict. The symbol count SHALL count symbols, not the files that carry them, and SHALL count DEFINING symbols only: a requirement anchors to the implementation, never to a test, so a domain whose only symbols live in an attached test file SHALL still be reported as having no behavior. Supporting symbols SHALL be disclosed alongside rather than folded into the count.

When no analyzed domain backs the request at all, the behavior state SHALL be `unavailable` with null counts, never a fabricated zero. The stop-and-ask follow-up SHALL then be emitted only on positive evidence of prose — every source file the specification cites is documentation — a cited path carrying an anchor (`README.md#Installation`) SHALL be classified by the file it names rather than the fragment, and the specification corpus's own files SHALL be excluded from that evidence using the CONFIGURED specification root rather than the default directory name, so a corpus-level specification such as `overview` or `architecture`, which owns no source by design and cites other specifications, SHALL remain repairable.

This is an observation, never a decision: the system MUST NOT declare such a domain illegitimate, and MUST NOT author or withhold a specification on its own. Canonical agent skills SHALL key their stop on the emitted follow-up rather than on the behavior state alone — a bare `unavailable` without that follow-up is not a stop — and SHALL then ask the human whether the domain should be specified at all. They MUST NOT paraphrase documentation into requirement statements.

- **Implementation**: `domainBehaviorOf::src/core/services/spec-workflow.ts`

#### Scenario: A behavior-free domain raises a stop, not a spec
- **GIVEN** a resolved domain every one of whose defining files is documentation
- **WHEN** Generate or Repair evidence is prepared
- **THEN** the page discloses the domain has no behavior with its supporting counts, and the terminal page carries a stop-and-ask follow-up

#### Scenario: A surviving prose-only spec whose domain is gone still raises the stop
- **GIVEN** a specification whose domain is no longer produced by the analysis and whose every cited source file is documentation
- **WHEN** Repair evidence is prepared for it
- **THEN** the behavior state is `unavailable` with null counts, and the terminal page carries the stop-and-ask follow-up

#### Scenario: A relocated specification root is honored
- **GIVEN** a repository whose configured specification root is not the default directory name
- **WHEN** a specification under it is loaded or its corpus files are excluded from prose evidence
- **THEN** the configured root is used, so the specification resolves and no corpus-level specification is misread as a prose-only orphan

#### Scenario: A corpus-level spec stays repairable
- **GIVEN** a specification that owns no analyzed domain and cites only other specifications
- **WHEN** Repair evidence is prepared for it
- **THEN** the behavior state is `unavailable` and no stop-and-ask follow-up is emitted

#### Scenario: A code domain without extracted signatures is behavior
- **GIVEN** a domain defined by source files that yield no extracted signatures
- **WHEN** Generate or Repair evidence is prepared
- **THEN** the domain is reported as behavioral and no stop-and-ask follow-up is emitted

#### Scenario: Test-only symbols do not count as behavior
- **GIVEN** a domain defined only by documentation whose attached test file carries symbols
- **WHEN** Generate or Repair evidence is prepared
- **THEN** the domain is reported as documentation-only, the supporting symbols are disclosed separately, and the stop-and-ask follow-up is emitted

#### Scenario: A domain with symbols raises no stop
- **GIVEN** a resolved domain whose evidence names at least one symbol
- **WHEN** Generate or Repair evidence is prepared
- **THEN** the domain is disclosed as behavioral and no stop-and-ask follow-up is emitted

