# analyzer spec delta

## ADDED Requirements

### Requirement: RepositoryVocabularyIsMinedDeterministicallyFromTheRepository

The analyzer SHALL mine a repository vocabulary lexicon from material it already extracts —
identifiers, doc comments, literal keys, and file paths — containing abbreviation-to-expansion
links, term co-occurrence links, and conservative morphological variants.

Every mined entry SHALL be evidenced within the analyzed repository: an abbreviation link SHALL
require the short form to be a subsequence of the long form **and** the two to co-occur in a
binding position the analyzer already recognizes; a morphological variant SHALL be recorded only
when both forms are attested in the repository. A small, explicitly enumerated seed set of
universal programming abbreviations MAY be included and SHALL be declared in source. No entry
SHALL come from an external dictionary, a network request, or a language model.

The lexicon SHALL be byte-deterministic for a given repository state, SHALL be persisted next to
the keyword corpus sidecar with a version stamp, and SHALL be rebuilt rather than served when the
stamp does not match. Mining SHALL be fail-soft: an unreadable input, an unsupported language, or
a disabled setting SHALL yield an empty lexicon and SHALL NOT fail the analyze.

#### Scenario: An abbreviation is discovered from in-repo evidence

- **GIVEN** a repository declaring `cfg: Config` and a doc comment describing `cfg` as the
  configuration
- **WHEN** the repository is analyzed
- **THEN** the lexicon links `cfg` to `config`, and the link's evidence is the in-repo binding —
  not an external dictionary

#### Scenario: An unevidenced link is never invented

- **GIVEN** a repository in which the token `txn` appears but no long form co-occurs with it in a
  recognized binding position
- **WHEN** the repository is analyzed
- **THEN** no expansion is recorded for `txn`

#### Scenario: Mining is deterministic

- **GIVEN** the same repository analyzed twice
- **WHEN** the two lexicons are compared
- **THEN** they are byte-identical, including entry ordering

#### Scenario: A stale lexicon is never served

- **GIVEN** a persisted lexicon written under an older version stamp
- **WHEN** search loads it
- **THEN** it is ignored and rebuilt, and no query is expanded against a mismatched lexicon

### Requirement: VocabularyExpansionIsQuerySideBoundedAndDownWeighted

Vocabulary expansion SHALL be applied at query time only. The persisted keyword index SHALL NOT
be expanded, SHALL NOT grow, and SHALL NOT require a rebuild when expansion is enabled or
disabled.

Expansion terms SHALL be scored at a lower weight than the original query terms, such that a
document matching an original query term exactly SHALL NEVER be outranked solely by a document
matching an expansion term. The number of expansion terms per original query token SHALL be
bounded by a declared cap, and the applied expansion set SHALL be returned with the results.

Expansion SHALL be disableable by configuration, and with it disabled the ranking SHALL be
identical to the pre-change ranking.

#### Scenario: An exact identifier match still wins

- **GIVEN** a query containing an exact identifier present in the repository, and a lexicon that
  expands another of the query's tokens
- **WHEN** the search runs
- **THEN** the exact-identifier match ranks above every expansion-only match

#### Scenario: A natural-language task query reaches abbreviated code

- **GIVEN** a repository containing `PmtSvc.chargeCard` with a doc comment naming payments, and a
  lexicon mined from it
- **WHEN** the query "add a payment method" is searched in keyword mode
- **THEN** `PmtSvc.chargeCard` is among the ranked results, and the expansion terms that produced
  the match are returned with the results

#### Scenario: Disabling expansion restores today's ranking

- **GIVEN** expansion disabled by configuration
- **WHEN** a set of queries is run against an unchanged index
- **THEN** the ranking is identical to the ranking produced before this change, with no re-index
