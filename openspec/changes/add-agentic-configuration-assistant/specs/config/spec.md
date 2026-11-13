# Configuration specification delta

## ADDED Requirements

### Requirement: FileSelectionLanesAreIndependentAndBackwardCompatible

Optional file-selection policy SHALL distinguish structural indexing, live watching and embedding.
An omitted lane SHALL retain existing behavior, and absence of the new policy SHALL preserve
existing configuration semantics. Embedding selection SHALL be a subset of the authorized index
corpus. An indexing exception SHALL NOT implicitly open live watching or embedding. A changed
non-watched input SHALL NOT continue to be represented as proven fresh.

#### Scenario: Existing configs keep their selection behavior
- **GIVEN** a supported config without file-selection lane policies
- **WHEN** it is read by the new runtime
- **THEN** existing include/exclude, ignore, embedding and source-count behavior remains unchanged

#### Scenario: An analysis-only exception stays out of other lanes
- **GIVEN** an authorized generated-source exception included for indexing but excluded from watching and embedding
- **WHEN** lane consumers resolve the path
- **THEN** only indexing admits it and later freshness reporting accounts for its non-watched status

#### Scenario: A policy attempts to embed an excluded source
- **GIVEN** a path excluded from the authorized index corpus
- **WHEN** a candidate policy requests embeddings for that path
- **THEN** validation rejects the conflicting policy without reading it through a separate embedding path

### Requirement: AssistantPoliciesPreserveExplicitChoicesAndBoundaries

Policy resolution SHALL apply host confinement, protected exclusions and existing trust boundaries
before repository rules. It SHALL retain effective config-layer precedence, existing explicit
operator choices and inherited opt-outs. Assistant-owned rules SHALL NOT silently override
user-maintained legacy or lane settings. Acceptance reasons SHALL be retained, but repository
ownership or approval metadata SHALL NOT be treated as a capability grant.

#### Scenario: A suggested include crosses a protected boundary
- **GIVEN** a host-protected excluded subtree
- **WHEN** the assistant proposes a rule including it
- **THEN** the rule is blocked in every lane and no repository-written approval field bypasses protection

#### Scenario: A plan conflicts with an existing exclusion
- **GIVEN** an explicit user-maintained exclusion
- **WHEN** a recommendation would admit matching files
- **THEN** the conflict and affected scope are surfaced for an authorized decision rather than silently replacing that exclusion

#### Scenario: A nested negation cannot reopen a pruned parent for watching
- **GIVEN** a watch-excluded directory containing a nested file re-inclusion rule
- **WHEN** watch policy is resolved
- **THEN** the parent remains pruned before descendant watches are allocated

### Requirement: AssistantConfigWritesPreserveLayersAndRecoverability

Configuration publication SHALL preserve unknown fields, raw-layer ownership and explicit config
paths. It SHALL not serialize merged user defaults or credentials into a project file, replace
malformed config with defaults, or edit unrelated Git/host settings. It SHALL use confined,
serialized, crash-recoverable publication with versioned schema validation and expected revisions.
Unsupported policy semantics SHALL be refused rather than silently ignored as effective.

#### Scenario: A project plan inherits user-wide embedding settings
- **GIVEN** credentials and embedding settings supplied by a user-wide layer
- **WHEN** a project watch policy is published
- **THEN** only the authorized project fields change and inherited settings are not copied into the file

#### Scenario: A host selected an explicit config path
- **GIVEN** a trusted host selected a config file other than the default project location
- **WHEN** a preview and apply target that configuration
- **THEN** the actual target is disclosed and the default config file is not edited as a substitute

#### Scenario: Publication is interrupted
- **GIVEN** a configuration operation with a durable recovery journal
- **WHEN** publication is interrupted and later retried
- **THEN** recovery precedes revision checking and no runtime effect is blindly replayed

#### Scenario: An old runtime cannot implement lane semantics
- **GIVEN** a selected runtime that lacks the proposed policy version
- **WHEN** the assistant previews application
- **THEN** it reports unsupported capability instead of claiming those policies will be enforced
