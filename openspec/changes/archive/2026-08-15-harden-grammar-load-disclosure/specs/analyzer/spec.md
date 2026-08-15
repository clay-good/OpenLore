# analyzer spec delta

## ADDED Requirements

### Requirement: CoreGrammarLoadFailureIsDisclosed

When a language grammar fails to load at analysis time — for any language, including the
core set — the analyzer SHALL disclose it as a distinct boundary ("language L grammar
unavailable — N files indexed for search but not graphed") and warn once, rather than
letting every file of that language fail silently through the per-file parse catch. Files
of the affected language SHALL still reach the search index. A grammar-version mismatch that
breaks query construction SHALL degrade to the same disclosed boundary.

#### Scenario: A missing primary-language grammar is visible, not silent

- **GIVEN** a repository whose primary language is TypeScript and whose
  `tree-sitter-typescript` optional dependency did not install
- **WHEN** `openlore analyze` runs
- **THEN** it warns once that the grammar is unavailable and records a language-level
  boundary; the resulting empty call graph for that language is disclosed, not presented as
  a complete graph, and the files remain searchable

### Requirement: CapabilityMatrixReflectsRuntimeGrammarAvailability

`get_language_support` SHALL report the runtime grammar status
(`loaded | unavailable | untried`) for each language alongside its static capability flags,
so a consumer can distinguish "callGraph unsupported for this language" from "callGraph
supported but the grammar did not load" from "no result because the language is genuinely
absent."

#### Scenario: The matrix does not claim a capability the install cannot deliver

- **GIVEN** a language whose grammar failed to load
- **WHEN** `get_language_support` reports that language
- **THEN** the callGraph capability is annotated `grammarStatus: unavailable`, not presented
  as an unqualified "supported"
