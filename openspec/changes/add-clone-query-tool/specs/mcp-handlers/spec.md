# mcp-handlers spec delta

## ADDED Requirements

### Requirement: CloneQueryConclusionTool

The system SHALL expose the one-vs-all clone query through an opt-in MCP tool (`find_clones`) that
returns the **existing clones of a single query as a conclusion**, never a graph or a source dump. The
tool SHALL accept exactly one of two query forms: a `symbol` (the name, or `name::path`, of a function
already in the indexed call graph) or a `snippet` (a raw code string not necessarily in the index).
For a `symbol`, the tool SHALL extract the function's body from its persisted byte range; for a
`snippet`, it SHALL use the supplied text. It SHALL then return the ranked clone matches (each naming
file, function, optional class, line range, clone type, similarity, and source language), the
similarity floor in effect, and the number of functions compared against. Because the normalization is
language-agnostic, a match MAY be in a different language than the query (cross-language clones are out
of scope); the per-match `language` (and the query's own language, in symbol mode) SHALL be surfaced so
a consumer can distinguish a same-language reuse candidate from a cross-language coincidence.

The tool SHALL compute live from the already-persisted call graph and a re-read of the source it
spans — it SHALL NOT require a new persisted artifact and SHALL NOT introduce a schema migration. It
SHALL declare a complete input schema and return a structured conclusion, classified `conclusion` per
the MCP quality requirements. It SHALL NOT enter `MINIMAL_TOOLS`, the first-run default surface, or any
curated preset; it lands only in the full opt-in surface.

The tool SHALL be honest about what it does not know:

- a `symbol` not present in the index SHALL produce an explicit not-found result (with near-miss
  candidate names where available), never an empty match list that reads as "unique";
- an ambiguous `symbol` (matching more than one indexed function) SHALL report the ambiguity and the
  candidates rather than guessing one;
- a query below the evidence floor SHALL return a `belowThreshold` signal rather than an empty result;
- functions whose persisted byte ranges were derived from transformed source (HTML inline scripts)
  SHALL be excluded from comparison, and the exclusion SHALL be disclosed.

#### Scenario: The tool returns ranked matches, not a graph

- **GIVEN** an analyzed repository and a `symbol` that has clones
- **WHEN** an agent calls `find_clones` with that symbol
- **THEN** it receives a ranked list of the clone matches (file, function, line range, type,
  similarity) and the similarity floor in effect, and receives no node-and-edge structure to traverse

#### Scenario: Snippet mode answers the pre-write question

- **GIVEN** a code snippet the agent is about to add that closely matches an existing function
- **WHEN** an agent calls `find_clones` with that `snippet`
- **THEN** it receives the existing near-duplicate function(s) to reuse instead — an answer the
  whole-repo `get_duplicate_report` cannot give, because the snippet is not in the index

#### Scenario: A missing symbol is an explicit not-found, not "unique"

- **GIVEN** a `symbol` that does not resolve to any indexed function
- **WHEN** an agent calls `find_clones`
- **THEN** it receives an explicit not-found result (with candidate names where available), not an
  empty match list
