## MODIFIED Requirements

### Requirement: CorpusEdgesAreDeclaredAndResolved

The governance corpus SHALL be validated as a typed graph. Every cross-artifact reference kind —
a requirement or proposal citing a decision or requirement, a decision superseding a decision, a
change delta targeting a spec domain, a memory citing a decision, and an artifact anchoring to a symbol or file — SHALL be
declared in a single source-declared edge registry stating that edge's source artifact type,
target range, directionality, whether it may form a cycle, and whether a live source may reference
a retired target.

The system SHALL emit a finding, in the unified `GovernanceFinding` shape with a registered stable
code, for each reference that fails its declared semantics: a target that resolves to nothing, a
target that resolves ambiguously, a self-reference, two artifacts resolving to the same identifier,
an edge kind the source type does not declare, a target of the wrong type for the edge, a live
source referencing a retired target, a cycle in an acyclic edge, and an anchor whose target no
longer exists. Each finding SHALL name the source artifact, the edge kind, the reference exactly as
written, and the reason it failed.

Every corpus finding SHALL default to the advisory enforcement class. Resolution and graph-shape
failures SHALL keep the severity `error`, so they stay visible as errors without blocking. Every
default SHALL remain overridable through the operator's enforcement policy, which is the only way
a corpus finding blocks, and the pass SHALL introduce no finding that the policy cannot name.
The check SHALL be deterministic and offline: identical corpus bytes SHALL produce an identical,
ordered finding list, with no model, embedding, or network call in the path. Adding an artifact
type or reference kind without registering its edge SHALL fail a closure guard in CI.

A change delta that targets a capability declared under its proposal's `New Capabilities` section
SHALL resolve to that prospective domain; it SHALL NOT be misreported as orphaned merely because
the main corpus does not contain the new domain before archival. An unreadable or malformed corpus
source SHALL make the assessment unavailable rather than being treated as an empty artifact set.

#### Scenario: A requirement citing a superseded decision is reported

- **GIVEN** a live spec requirement carrying a recorded-decision reference
- **AND** that decision has since been superseded in the decision store
- **WHEN** the corpus integrity pass runs
- **THEN** a `corpus-target-retired` finding names the requirement, the decision id as written, and
  the superseding decision to cite instead

#### Scenario: A supersession cycle is refused, not averaged

- **GIVEN** decisions whose `supersedes` references form a cycle
- **WHEN** the corpus integrity pass runs
- **THEN** a `corpus-supersession-cycle` finding names every artifact in the cycle
- **AND** the system does not present any decision in that cycle as authoritative

#### Scenario: A change delta naming a nonexistent spec domain is reported

- **GIVEN** an open change whose delta directory names a spec domain that is not in the corpus
- **WHEN** the corpus integrity pass runs
- **THEN** a `corpus-reference-unresolved` finding names the change, the delta path, and the
  unresolved domain

#### Scenario: A declared new capability is a valid delta target

- **GIVEN** a proposal declaring a capability under `New Capabilities`
- **AND** a delta directory targeting that capability
- **WHEN** the corpus integrity pass runs before archival creates the main spec domain
- **THEN** the delta target resolves without an unresolved-reference finding

#### Scenario: Duplicate identity is detected before it is trusted

- **GIVEN** two requirements in one spec domain resolving to the same requirement name
- **WHEN** the corpus integrity pass runs
- **THEN** a `corpus-duplicate-identifier` finding names both artifacts
- **AND** every reference to that name is additionally reported as `corpus-reference-ambiguous`

#### Scenario: The edge registry cannot drift open

- **GIVEN** a newly added cross-artifact reference kind with no entry in the edge registry
- **WHEN** the closure guard runs in CI
- **THEN** the build fails until the edge declares its source type, range, directionality, cycle
  rule, and liveness rule

#### Scenario: Findings are governable, never self-invented

- **GIVEN** an operator enforcement policy that sets a corpus finding code to blocking
- **WHEN** the enforcement gate runs
- **THEN** the finding blocks, and every corpus finding the policy does not name is still reported
  and still annotates, but does not block
- **AND** the policy entry changes only that finding's class; it never creates or suppresses a
  finding the corpus did not produce

#### Scenario: A graph error does not block without a policy

- **GIVEN** a repository with no enforcement policy and a decision supersession cycle
- **WHEN** the enforcement gate runs
- **THEN** the `corpus-supersession-cycle` finding is reported with severity `error` and class
  advisory, and the gate does not fail
