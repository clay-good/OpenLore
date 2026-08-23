# architecture spec delta

## ADDED Requirements

### Requirement: DecisionBoundConstraintsInheritDecisionLifecycle

An architectural decision MAY declare a versioned block of machine-checkable constraints drawn from
the system's existing declarative rule vocabulary. Each constraint SHALL carry a stable rule
identifier, a repository-relative path scope, and the fields its rule kind requires. This change
SHALL NOT introduce rule kinds of its own; it SHALL consume the vocabulary the rule engine already
defines.

A constraint's authority SHALL be its decision's authority. The system SHALL evaluate the
constraints of authoritative decisions only. Constraints belonging to a superseded, rejected,
withdrawn, or not-yet-authoritative decision SHALL NOT be evaluated and SHALL be reported as
retired, so that reversing a decision reverses its enforcement without any further edit.

Every violation SHALL be emitted in the unified governance-finding shape with a registered stable
code, and SHALL name the governing decision's identifier and title, the rule identifier, the source
path, the line where one is available, and the decision's recorded rationale. A violation SHALL NOT
be reported as an anonymous rule breach.

Evaluation SHALL be deterministic, local, and offline: it SHALL read repository bytes and the
stored structural graph only, and SHALL NOT make a model call, an embedding lookup, a network
request, or a semantic judgment about whether code honors a decision's intent. Decisions whose
intent cannot be reduced to a checkable repository property SHALL remain subject to human review.

Constraint violations SHALL default to the advisory enforcement class and SHALL become blocking
only through the operator's enforcement policy. A constraint block that is malformed, declares an
unsupported version, uses an unknown rule kind, or reuses a rule identifier SHALL itself be
reported as a finding rather than silently skipped.

#### Scenario: A violation cites the decision that governs it

- **GIVEN** an authoritative decision declaring a constraint over a source path
- **WHEN** a change violates that constraint
- **THEN** the finding names the decision identifier, its title, the rule identifier, the source
  path, and the decision's recorded rationale

#### Scenario: Superseding a decision retires its enforcement

- **GIVEN** an authoritative decision whose constraint is currently enforced
- **WHEN** that decision is superseded by another decision
- **THEN** the constraint is no longer evaluated
- **AND** it is reported as retired rather than disappearing without explanation

#### Scenario: A draft decision's constraint does not bind

- **GIVEN** a decision that has been recorded but is not yet authoritative
- **WHEN** enforcement runs
- **THEN** its constraints are not evaluated and no violation is emitted from them

#### Scenario: A malformed constraint block is reported, not ignored

- **GIVEN** a decision whose constraint block declares an unsupported version or a duplicate rule
  identifier
- **WHEN** the corpus is checked
- **THEN** a finding names the decision and the defect
- **AND** the block is not silently skipped

#### Scenario: No model participates in the verdict

- **GIVEN** any constraint evaluation
- **WHEN** the evaluation runs
- **THEN** no model call, embedding lookup, or network request occurs
- **AND** repeated runs over unchanged repository bytes produce byte-identical findings
