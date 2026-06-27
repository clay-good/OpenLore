# mcp-handlers spec delta

## MODIFIED Requirements

### Requirement: DeterministicRecallRanking

`recall` SHALL rank relevant memories with a deterministic, documented scoring function that replaces
binary substring token-overlap. The function SHALL:

- **Weight matches by field**, in descending strength: resolved anchor `symbolName`, then tags, then
  anchor file path, then free-text content. A match in a stronger field SHALL contribute more than a
  match in a weaker field.
- **Be graded, not binary**: repeated matches of a query token contribute more than a single match.
- **Apply identifier-aware normalization** before matching: case-folding, splitting
  `camelCase` / `snake_case` / `kebab-case` identifiers into subtokens, and removing a small fixed
  stopword set. Normalization SHALL be a pure function with no external data and no network access.

The scoring weights and stopword set SHALL be fixed, documented constants — not learned, not tuned at
runtime, and not derived from usage. The ranker SHALL NOT call an LLM, an embedding model, or any
learned model.

The candidate set returned for a query SHALL be a superset of what binary substring-overlap would
return: this requirement adds matches and reorders them, and SHALL NOT cause a memory that matches
under substring-overlap to stop matching for the same query.

#### Scenario: A field-weighted match outranks an incidental one

- **GIVEN** memory M1 whose anchor `symbolName` matches a query token, and memory M2 that matches the
  same token only in free-text content
- **WHEN** `recall` ranks them
- **THEN** M1 ranks above M2

#### Scenario: Identifier normalization closes a phrasing miss

- **GIVEN** a memory whose content contains `writeThrough`
- **WHEN** `recall` is invoked with a task containing the token `write`
- **THEN** the memory is a ranked candidate (it is not dropped for lack of an exact substring)

#### Scenario: Ranking never bypasses the freshness invariant

- **GIVEN** a high-scoring memory whose freshness verdict is `orphaned`
- **WHEN** `recall` produces its response
- **THEN** the memory is excluded from the authoritative set regardless of its relevance score
  (the `AuthoritativeRecallInvariant` runs after ranking)

### Requirement: ExactAnchorBoost

When a normalized query token exactly matches a memory's resolved anchor `symbolName`, `recall` SHALL
apply a strong deterministic relevance boost to that memory. This reflects that OpenLore knows the
memory is *about* that exact symbol — a structural relevance signal a lexical-only ranker lacks. The
boost SHALL reuse the anchor `symbolName` already resolved at record time and SHALL require no new
analysis at recall.

#### Scenario: A memory about the named symbol surfaces first

- **GIVEN** memory M anchored to symbol `validateDirectory` and several memories that merely mention it
  in prose
- **WHEN** `recall` is invoked with a task naming `validateDirectory`
- **THEN** M ranks above the prose-only mentions

## ADDED Requirements

### Requirement: TransparentRankingReason

`recall` SHALL be able to report, per returned memory, a deterministic explanation of its rank — the
fields that matched and any boost applied — consistent with the project's "labeled signals, not a
blended black-box number" discipline. The explanation SHALL be derived from the same scoring inputs
and SHALL NOT be a post-hoc rationalization or an LLM-generated description.

#### Scenario: The agent can see why a memory ranked

- **WHEN** `recall` returns a memory
- **THEN** the response can carry, for that memory, which fields matched and whether the exact-anchor
  boost applied
