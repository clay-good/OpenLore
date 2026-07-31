# architecture spec delta

## ADDED Requirements

### Requirement: TheTrustBoundaryForServedKnowledgeIsHumanReview

The system SHALL record that knowledge it serves becomes authoritative for a consuming agent
because a human reviewed and accepted it, not because the serving surface is read-only or
deterministic. Determinism guarantees that the same bytes are returned every time; it SHALL NOT be
presented as a guarantee that those bytes are benign.

The system's published security posture SHALL state plainly what the read-only serving guarantee
covers and what it does not, including that content which has not passed human review is outside
that guarantee.

The system SHALL NOT introduce a semantic verdict on served content — a content sanitizer, a
trustworthiness score, or a model-computed judgment of whether recorded knowledge should be
believed — into the serving path. Crossing that boundary SHALL require superseding this
requirement with a recorded decision rather than being introduced as an implementation detail.

#### Scenario: The posture is stated, not implied

- **GIVEN** a user reading the published security posture
- **WHEN** they look for what the read-only serving guarantee covers
- **THEN** it states that the guarantee protects the store and that human review is the trust
  boundary for the content served

#### Scenario: A sanitizer requires a superseding decision

- **GIVEN** a proposal to filter, rewrite, or score served content in the serving path
- **WHEN** it is reviewed
- **THEN** it is refused unless it supersedes this requirement through a recorded decision

#### Scenario: Determinism is not overclaimed

- **GIVEN** documentation describing the deterministic serving guarantee
- **WHEN** it is read
- **THEN** it does not present determinism as evidence that served content is safe
