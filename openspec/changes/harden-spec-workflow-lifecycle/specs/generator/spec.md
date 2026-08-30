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

The system MUST NOT validate OpenSpec structure itself: the format is owned by the `openspec` CLI, and OpenLore SHALL NOT reimplement its rules in the agent-hosted workflows. The Generate and Repair composites SHALL therefore each disclose, on every page, that they validated nothing, and SHALL name the exact validation command as a follow-up on the terminal page. That command SHALL be scoped to specifications and run strictly, so an unrelated invalid change in flight cannot fail a valid baseline specification and a warning is not accepted as a pass. When the configured specification root is not the default, the follow-up SHALL disclose it, because the OpenSpec CLI resolves its own root and does not read OpenLore's configuration. This applies identically to both: a specification authored by Generate is no more self-validating than one edited by Repair. Neither skill SHALL restate the format's rules; a restated copy drifts from the tool it describes. Both workflows author a BASELINE corpus specification, not a change delta, so they SHALL take their shape from an existing specification — the one Repair edits, or a sibling in the same corpus for Generate — and SHALL use `openspec validate` as the judge of the result. They MUST NOT follow the CLI's change-artifact instructions for this purpose: those describe the change-local delta form, and writing its operation headers into a baseline specification corrupts what archive later merges. What the composite can observe about the CLI SHALL be reported as fact, never as a verdict: an OpenSpec package that resolves from neither the project nor OpenLore is `unresolved`, which is a disclosed unknown and MUST NOT be reported as the CLI being absent. A host that cannot run validation SHALL report the edited specification as NOT validated rather than as finalized.

#### Scenario: Agent-hosted generation updates observable coverage
- **GIVEN** an agent authors a specification from deterministic generation evidence and includes exact implementation anchors
- **WHEN** the skill completes validation and a later audit runs
- **THEN** the new links are derived from the edited spec whether or not a prior `mapping refresh` persisted the cache

#### Scenario: A spec the host could not validate is reported as unvalidated
- **GIVEN** a host authors or edits a specification from Generate or Repair evidence and the `openspec` CLI cannot run
- **WHEN** the host finalizes the workflow
- **THEN** the outcome states the specification is NOT validated, and no OpenLore-computed structural verdict is presented in its place

#### Scenario: A baseline spec is not shaped by delta instructions
- **GIVEN** a host authoring or repairing a baseline corpus specification while a change is in flight
- **WHEN** it needs the specification format
- **THEN** it takes the shape from an existing specification in the corpus and validates with `openspec validate`, and does not apply the change-artifact delta instructions

#### Scenario: Validation is named, never performed by OpenLore
- **GIVEN** any Generate or Repair page
- **WHEN** the receipt is built
- **THEN** the page discloses that OpenLore validated nothing, the terminal page carries the exact `openspec validate` follow-up, and an OpenSpec package resolving from neither scope is disclosed as unresolved rather than as absent

#### Scenario: Standalone generation uses the same link contract
- **GIVEN** standalone generation writes specifications
- **WHEN** it finalizes its output
- **THEN** its mapping artifact is derived from the written specs and current graph under the same link-state and provenance rules as agent-hosted generation

### Requirement: Generated Claims Remain Bound To Static Evidence

The standalone generator MUST NOT emit an operation whose proposed function cannot be resolved uniquely against the supplied signature evidence, and it MUST use the static route inventory's method and path as the canonical identity of every emitted endpoint. Supporting-only evidence MUST NOT become a selectable domain.

#### Scenario: A fabricated operation is quarantined
- **GIVEN** a generation response proposes an operation with no matching static function signature
- **WHEN** service results are reconciled
- **THEN** the unresolved operation is omitted rather than written as repository behavior

#### Scenario: A route spelling is canonicalized
- **GIVEN** a generated endpoint matches a static route after parameter and case normalization
- **WHEN** API results are reconciled
- **THEN** the emitted endpoint uses the exact method and path recorded by the static inventory

### Requirement: Generation Inputs And Caches Are Confined

Provider-selected source paths MUST resolve canonically inside the project, and persisted mapping output MUST use a confined atomic write that neither follows a mapping symlink nor leaves a torn artifact.

#### Scenario: A provider selects an escaping source path
- **GIVEN** a provider proposes a sibling-prefix traversal or an in-project symlink to an external file
- **WHEN** later stages resolve the proposed source
- **THEN** the file is excluded and none of its contents are sent in a later provider request

#### Scenario: Mapping path is a symlink
- **GIVEN** the mapping target or its analysis directory resolves outside the project
- **WHEN** mapping persistence runs
- **THEN** persistence fails closed without modifying the symlink target
