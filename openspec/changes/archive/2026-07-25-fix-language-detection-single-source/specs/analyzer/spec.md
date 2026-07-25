# analyzer spec delta

## ADDED Requirements

### Requirement: SingleSourceLanguageDetection

The system SHALL have exactly one canonical extension→language detection function, defined once in
the analyzer's dedicated detection module and exported (re-exported) from the language-support
registry as its public surface, and every analyzer component that maps a file path to a language
(signature extraction, AST-aware chunking, skeleton reduction, route parsing, and any future
consumer) SHALL resolve through it. A conformance test SHALL assert (a) every language in
`CODE_LANGUAGES` is resolvable from a representative extension through the single source, and (b) no
second language-detection definition or extension→language literal map exists outside the canonical
module, so a copy-paste fork fails CI rather than silently diverging. A file whose extension the
canonical map does not know SHALL resolve to an explicit `unknown` (an honest fallback), never to a
guessed language.

#### Scenario: Every claimed code language resolves through the single source

- **GIVEN** any language listed in `CODE_LANGUAGES`
- **WHEN** the conformance test resolves a representative file extension for that language through
  the canonical `detectLanguage`
- **THEN** the canonical function returns that language
- **AND** the test fails if `CODE_LANGUAGES` gains a language with no resolvable extension

#### Scenario: A second detection implementation fails CI

- **GIVEN** a source tree containing a `detectLanguage` definition or an extension→language
  literal detection map outside the canonical detection module
- **WHEN** the singularity guard test runs
- **THEN** the test fails, naming the offending file

#### Scenario: Detection divergence no longer forces a false generic-chunking fallback

- **GIVEN** a file whose extension a formerly-incomplete detection copy missed but the canonical map
  resolves — and for which the AST chunker has a parser (e.g. the `.mts` / `.cts` / `.jsx`
  extension variants of TypeScript/JavaScript)
- **WHEN** the AST chunker processes the file
- **THEN** the file is chunked with the language-aware AST strategy, not the generic-text fallback
  it previously received because detection returned `unknown`
- **AND** a file the canonical map detects but the chunker has no parser for continues to fall back
  honestly (the chunker's AST coverage is bounded by its available parsers, not by detection)

#### Scenario: An unknown extension degrades honestly

- **GIVEN** a file whose extension appears in no canonical mapping
- **WHEN** language detection runs
- **THEN** the result is `unknown` and consumers apply their disclosed generic fallback, never a
  guessed language
