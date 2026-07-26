# mcp-handlers spec delta

## ADDED Requirements

### Requirement: RetrievalModeGainsAValueWithoutChangingConditionedBehavior

Every retrieval surface — code search, spec search, and orientation — SHALL disclose the
retrieval mode that produced its results, and the closed mode vocabulary SHALL gain a
keyword-with-vocabulary value distinguishing plain keyword retrieval from keyword retrieval with
repository-vocabulary expansion.

The new value SHALL be **additive only** and SHALL NOT alter any behavior conditioned on plain
keyword mode. Specifically: the internal score-scale token SHALL remain the keyword value — the
score scale is unbounded lexical scoring, not rank-fused, in both keyword modes — and the
semantic-upgrade guidance SHALL be emitted in both. Every site conditioning on retrieval mode
SHALL test the keyword/scale **family** rather than string equality with the plain-keyword value,
and a test SHALL fail if a new mode value is added without updating those sites.

Only the expansion terms that made a **non-zero scoring contribution** to at least one returned
result SHALL be reported as having produced a match. Terms that were attempted but scored zero
SHALL NOT be presented as responsible; they MAY be reported separately as attempted. When
expansion is disabled or the lexicon is empty or unverified, the disclosed mode SHALL be plain
keyword and no expansion field SHALL be returned.

Expansion SHALL NOT be described as equivalent to or a replacement for semantic retrieval.

#### Scenario: Adding the vocabulary mode changes no conditioned behavior

- **GIVEN** a repository with a populated lexicon and expansion enabled
- **WHEN** code search, spec search, and orientation are called
- **THEN** each discloses the keyword-with-vocabulary mode, each still reports the unbounded
  lexical score scale, and each still emits the semantic-upgrade guidance verbatim

#### Scenario: Only terms that scored are reported as responsible

- **GIVEN** a query whose expansion set includes a term with no document-frequency entry
- **WHEN** results are returned
- **THEN** that term is not reported as having produced a match

#### Scenario: An empty lexicon reads as plain keyword

- **GIVEN** a repository whose lexicon is empty, unverified, or excluded from an imported bundle
- **WHEN** a search runs
- **THEN** the disclosed mode is plain keyword, no expansion field is present, and the
  semantic-upgrade hint is unchanged
