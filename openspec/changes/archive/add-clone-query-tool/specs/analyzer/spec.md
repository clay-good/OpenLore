# analyzer spec delta

## ADDED Requirements

### Requirement: OneVsAllCloneQuery

The system SHALL provide a deterministic **one-vs-all clone query** over the existing near-clone
detector: given a single query body (the source of one function, or a raw snippet) and the indexed
call graph plus the source it spans, it SHALL return the existing functions that are clones of the
query, classified by the same clone taxonomy the whole-repo detector uses — `exact` (Type 1, identical
after whitespace/comment normalization), `structural` (Type 2, identical shape after identifier
renaming), and `near` (Type 3, Jaccard similarity on token n-grams at or above the similarity floor).

The query SHALL reuse the existing detector's normalization, shingling, Jaccard, and evidence
thresholds (`MIN_LINES`, `MIN_TOKENS`, `NEAR_THRESHOLD`) — it SHALL NOT introduce a new similarity
algorithm, a new clone type, or a new tuning constant. The caller MAY override the *near* similarity
floor for a single query (clamped to a valid range), and the floor in effect SHALL be reported. The
query SHALL be `O(n)` in the number of indexed functions (one query compared against each), so it
SHALL be able to compute near-clones of the query even on repositories large enough that the
whole-repo `O(n²)` near pass declines to run.

The query SHALL be a deterministic function of the indexed state and the query — byte-identical across
re-evaluations of a fixed repository state and query. Its match ordering SHALL be a total order whose
tie-break (file path, then start line, then end line, then function name) fully disambiguates any two
distinct matches, so the result never depends on input iteration order. It SHALL NOT call an LLM and
SHALL NOT require any new persisted artifact.

#### Scenario: Exact, structural, and near clones of a function are returned ranked

- **GIVEN** an indexed repository containing a function identical to the query after normalization,
  another with the same shape but renamed identifiers, and a third with high token overlap
- **WHEN** the clone query runs for that query body
- **THEN** it returns all three, classified `exact`, `structural`, and `near` respectively, ordered
  `exact` → `structural` → `near` and then by similarity descending, each carrying its file, function
  name, optional class, line range, clone type, similarity, and source language

#### Scenario: A below-threshold query is reported, not silently empty

- **GIVEN** a query smaller than the evidence floor (`< MIN_LINES` lines or `< MIN_TOKENS` normalized
  tokens)
- **WHEN** the clone query runs
- **THEN** it returns a `belowThreshold` signal and performs no comparison, rather than an empty match
  list that would read as "this code is unique"

#### Scenario: The query never matches itself

- **GIVEN** a query that is the body of a function already in the index
- **WHEN** the clone query runs in symbol mode
- **THEN** the function's own instance is excluded from the matches, so only other clones are returned

#### Scenario: Re-evaluation is byte-identical

- **GIVEN** a fixed repository state and a fixed query
- **WHEN** the clone query is evaluated twice
- **THEN** the two results are byte-identical, including match order
