# mcp-security spec delta

## ADDED Requirements

### Requirement: ServedContentIsUntrustedAndCarriesItsProvenance

Content the system serves into a consuming agent's context — anchored memories, decision text,
specification prose, commit and branch and pull-request titles, imported artifact metadata, and
source-derived strings — SHALL be treated as untrusted input. The read-only property of the serving
surface protects the store; it SHALL NOT be described as protecting the consuming agent.

Each served content field SHALL carry a provenance class stating where its bytes came from,
distinguishing at minimum: content from the human-reviewed corpus; content recorded locally without
review; content originating from another actor's in-flight work; content arriving through an
imported artifact; and content derived from repository source. The provenance class SHALL be a
factual statement of origin. The system SHALL NOT emit a trustworthiness score, safety rating, or
any computed judgment of whether content should be believed.

Content that has not passed human review SHALL NOT be presented as carrying the reviewed corpus's
authority.

The serving path SHALL NOT rewrite, strip, escape, neutralize, or otherwise alter recorded content.
Content SHALL be served exactly as recorded, with its provenance stated alongside it.

Where the system composes served content into a single text block a consuming agent reads as a
unit, the composed content SHALL be enclosed by a delimiter that the enclosed content cannot forge,
and the block SHALL state that the enclosed text is data rather than instructions. This framing
SHALL NOT modify the enclosed bytes.

#### Scenario: An unreviewed memory is served with its status

- **GIVEN** a memory recorded locally that has not passed a human review process
- **WHEN** it is returned to a consuming agent
- **THEN** it carries the locally-recorded-without-review provenance class
- **AND** it is not presented as carrying the reviewed corpus's authority

#### Scenario: Another actor's branch title is marked as foreign

- **GIVEN** a conclusion that incorporates a branch or pull-request title from another actor's
  in-flight work
- **WHEN** it is served
- **THEN** that field carries the other-actor provenance class

#### Scenario: Content is served as recorded

- **GIVEN** recorded content containing imperative language that reads as an instruction
- **WHEN** it is served
- **THEN** the returned bytes are identical to the recorded bytes
- **AND** no sanitizing, stripping, or escaping has been applied

#### Scenario: No trust score is emitted

- **GIVEN** any served content field
- **WHEN** its accompanying metadata is inspected
- **THEN** it contains a provenance class and no trustworthiness, safety, or confidence value

#### Scenario: A composed briefing frames its content as data

- **GIVEN** a composed context block assembled from served content
- **WHEN** it is emitted
- **THEN** the content is enclosed by a delimiter the content cannot forge
- **AND** the block states that the enclosed text is data
- **AND** the enclosed bytes are unchanged

### Requirement: InjectionShapedContentIsFlaggedForReviewNeverRewritten

The diagnostic surface SHALL flag corpus content whose shape resembles an instruction to a
consuming agent — an imperative override, an impersonation of a system, agent, or tool message, or
prose directing an agent away from a recorded decision — as an advisory finding for human review.

The check SHALL be deterministic, lexical, and offline, with no model call or network request. It
SHALL NOT modify, remove, or quarantine the flagged content, and it SHALL NOT block on its own.

Wherever the finding is reported, its limits SHALL be stated: the check is lexical, it will miss
phrasings it does not recognize, it may flag benign content, and it assists a human reviewer rather
than replacing one. The system SHALL NOT describe the check as a guarantee that served content is
safe.

#### Scenario: An injection-shaped artifact is surfaced to the reviewer

- **GIVEN** a corpus artifact containing an imperative override addressed to a reading agent
- **WHEN** the diagnostic runs
- **THEN** an advisory finding names the artifact and the matched shape
- **AND** the artifact is unchanged on disk

#### Scenario: The flag does not gate

- **GIVEN** a corpus whose only findings are injection-shape advisories
- **WHEN** the enforcement gate runs under the default policy
- **THEN** the gate does not fail

#### Scenario: The check states its own limits

- **GIVEN** an injection-shape finding presented to a user
- **WHEN** it is read
- **THEN** it states that the check is lexical, incomplete, and an aid to review rather than a
  guarantee
