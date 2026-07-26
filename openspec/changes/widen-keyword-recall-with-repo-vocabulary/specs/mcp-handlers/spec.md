# mcp-handlers spec delta

## ADDED Requirements

### Requirement: RetrievalModeAndExpansionAreDisclosedPerResult

Every retrieval surface — code search, spec search, and orientation — SHALL disclose the
retrieval mode that produced its results, drawn from a closed vocabulary that distinguishes plain
keyword retrieval from keyword retrieval with repository-vocabulary expansion, and both from
local- and remote-semantic retrieval.

When expansion contributed to a result set, the applied expansion terms SHALL be returned with
the results so a surprising match is explainable. When expansion is disabled or the lexicon is
empty, the disclosed mode SHALL be plain keyword and no expansion field SHALL be returned.

The existing guidance pointing users to the optional semantic upgrade SHALL remain, and expansion
SHALL NOT be described as equivalent to or a replacement for semantic retrieval.

#### Scenario: The served mode names expansion

- **GIVEN** a repository with a mined lexicon and expansion enabled
- **WHEN** `search_code` is called in keyword mode
- **THEN** the response discloses the keyword-with-vocabulary mode and returns the expansion terms
  applied

#### Scenario: An empty lexicon reads as plain keyword

- **GIVEN** a repository whose lexicon is empty because mining found no evidenced entries
- **WHEN** a search runs
- **THEN** the disclosed mode is plain keyword, no expansion field is present, and the semantic
  upgrade hint is unchanged
