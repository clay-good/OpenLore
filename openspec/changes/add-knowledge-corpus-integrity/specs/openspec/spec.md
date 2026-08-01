# openspec spec delta

## ADDED Requirements

### Requirement: CorpusEdgesAreDeclaredAndResolved

The governance corpus SHALL be validated as a typed graph. Every cross-artifact reference kind —
a requirement citing a decision, a decision superseding a decision, a change delta targeting a
spec domain, a memory citing a decision, and an artifact anchoring to a symbol or file — SHALL be
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

Resolution and graph-shape failures SHALL default to the blocking enforcement class; liveness and
anchor failures SHALL default to advisory. Every default SHALL remain overridable through the
operator's enforcement policy, and the pass SHALL introduce no finding that the policy cannot name.
The check SHALL be deterministic and offline: identical corpus bytes SHALL produce an identical,
ordered finding list, with no model, embedding, or network call in the path. Adding an artifact
type or reference kind without registering its edge SHALL fail a closure guard in CI.

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

- **GIVEN** an operator enforcement policy that downgrades a corpus finding code to advisory
- **WHEN** the enforcement gate runs
- **THEN** the finding is still reported and still annotates, but does not block
- **AND** the policy entry changes only that finding's class; it never creates or suppresses a
  finding the corpus did not produce

### Requirement: UndeclaredCorpusReferencesAreSuggestedNeverWritten

The system SHALL detect references in an artifact's prose to another corpus artifact — matched by
exact identifier or exact requirement name only — that are absent from that artifact's declared
edges, and SHALL report each as an advisory finding naming the source artifact, the matched target,
the token that matched, and the declared edge that would capture it.

The system SHALL NOT create, write, or modify any corpus edge automatically; a suggestion is
material for human review, never an applied change. Detection SHALL exclude self-references,
targets already declared as edges, fenced code blocks, and the declared-reference lines themselves,
and SHALL emit at most one finding per source-and-target pair. Matching SHALL NOT use titles,
fuzzy similarity, embeddings, or a model, so that identical corpus bytes yield byte-identical
findings. The advisory SHALL NOT change any exit code on its own.

#### Scenario: A prose mention becomes a suggestion

- **GIVEN** a change proposal whose body names a decision id that the proposal does not declare as
  a reference
- **WHEN** the detector runs
- **THEN** an advisory finding names the proposal, the decision, the matching token, and the edge
  that would capture it
- **AND** no file is modified

#### Scenario: A code fence is not a reference

- **GIVEN** an artifact whose fenced code block contains a string matching a decision identifier
- **WHEN** the detector runs
- **THEN** no finding is emitted for that occurrence

#### Scenario: The advisory never gates

- **GIVEN** a corpus whose only findings are undeclared-reference advisories
- **WHEN** the enforcement gate runs under the default policy
- **THEN** the gate reports the advisories and exits successfully
