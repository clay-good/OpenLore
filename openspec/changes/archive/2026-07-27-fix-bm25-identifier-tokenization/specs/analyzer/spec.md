# analyzer spec delta

## ADDED Requirements

### Requirement: IdentifierAwareKeywordTokenization

The keyword (BM25) retrieval tokenizer SHALL segment compound identifiers — camelCase, PascalCase,
snake_case, and kebab-case — into their constituent sub-tokens AND retain the original compound
token, with the identical tokenizer applied at index time and query time through a single shared
implementation. Tokenization SHALL remain deterministic and introduce no new tuning constants; the
existing BM25 parameters are reused unchanged. The persisted text index SHALL carry a
tokenizer-version stamp, and a version mismatch SHALL trigger a rebuild rather than serving
mixed-token results, mirroring the established model-changed deferral discipline for embedding
vectors.

#### Scenario: A sub-word query finds a compound identifier

- **GIVEN** a keyword-mode index containing a function named `getUserById`
- **WHEN** the user searches for `user` (or `getUser`)
- **THEN** `getUserById` is returned as a match, because its sub-tokens were indexed

#### Scenario: Naming conventions are equivalent

- **GIVEN** functions named `getUserById`, `get_user_by_id`, and `get-user-by-id`
- **WHEN** the same sub-word query is issued against each
- **THEN** all three tokenize to the same sub-token set and match equivalently

#### Scenario: The exact compound still wins

- **GIVEN** the compound token is retained in the index
- **WHEN** the user queries the full identifier `getUserById`
- **THEN** the exact function ranks at least as well as under the previous tokenizer

#### Scenario: Tokenizer skew rebuilds, never mixes

- **GIVEN** a text index persisted under a previous tokenizer version
- **WHEN** a query or incremental update runs under the new tokenizer
- **THEN** the version mismatch is detected and the index is rebuilt (or the update deferred with
  disclosure), and results are never served from a mixed-token corpus
