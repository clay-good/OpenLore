## ADDED Requirements

### Requirement: Deterministic Spec Link Index

The system SHALL derive requirement-to-code links from existing specification anchors and the current analyzed graph without an LLM call, vector similarity, or name-similarity inference. Each requirement link SHALL be classified as `linked`, `ambiguous`, `unmapped`, or `stale`, and only an exact, unique symbol anchor SHALL establish function coverage. File-only anchors MAY establish a domain footprint but MUST NOT be promoted to function coverage.

The persisted mapping artifact SHALL be a rebuildable cache whose provenance binds both the analysis generation and the specification-content digest. An absent, legacy, or stale cache MUST NOT prevent an in-memory deterministic derivation.

#### Scenario: Exact symbol anchor establishes coverage
- **GIVEN** an existing requirement cites a normalized source path and an exact symbol that exists uniquely in the current graph
- **WHEN** the spec link index is derived
- **THEN** the requirement is `linked`, the symbol is covered, and the evidence records the explicit anchor

#### Scenario: File-only reference does not invent function coverage
- **GIVEN** a requirement cites a source file but no exact symbol
- **WHEN** the spec link index is derived
- **THEN** the file contributes to the domain footprint, but no function is marked covered solely from that file reference

#### Scenario: Ambiguous and missing anchors remain honest
- **GIVEN** an anchor resolves to multiple current symbols or to a symbol that no longer exists
- **WHEN** the index is derived
- **THEN** the link is respectively `ambiguous` or `stale`, candidate evidence is disclosed, and no candidate is selected by semantic or name similarity

#### Scenario: Stale cache is rebuilt in memory
- **GIVEN** `mapping.json` is absent or its analysis/spec provenance does not match current inputs
- **WHEN** audit or Repair requests mapping-dependent evidence
- **THEN** the system derives the current link index in memory and reports any unresolved links instead of requiring standalone LLM generation

### Requirement: Agent And Standalone Spec Finalization Parity

The standalone generator and agent-hosted Generate/Repair workflows SHALL leave specifications eligible for the same deterministic link-index derivation. Canonical agent skills SHALL validate edited specs and refresh the persisted mapping cache when the local CLI is available; correctness of subsequent audit and Repair MUST NOT depend on that cache refresh having occurred.

#### Scenario: Agent-hosted generation updates observable coverage
- **GIVEN** an agent authors a specification from deterministic generation evidence and includes exact implementation anchors
- **WHEN** the skill completes validation and a later audit runs
- **THEN** the new links are derived from the edited spec whether or not a prior `mapping refresh` persisted the cache

#### Scenario: Standalone generation uses the same link contract
- **GIVEN** standalone generation writes specifications
- **WHEN** it finalizes its output
- **THEN** its mapping artifact is derived from the written specs and current graph under the same link-state and provenance rules as agent-hosted generation

