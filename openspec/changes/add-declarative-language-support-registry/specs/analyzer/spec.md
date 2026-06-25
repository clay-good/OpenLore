# analyzer spec delta

## ADDED Requirements

### Requirement: DeclarativeLanguageSupportRegistry

The system SHALL maintain a single declarative **language-support registry** keyed by language that is
the source of truth for which analysis capabilities OpenLore provides for that language and the data
the generic extractors consume to provide them. Each record SHALL declare a fixed, closed set of
capability flags — at least `signatures`, `callGraph`, `imports`, `cfgOverlay`, `typeInference`,
`styleFingerprint`, and (for infrastructure DSLs) `iacProjection` — where a capability is either backed
by data (supported) or absent (not claimed). The registry SHALL represent every currently-supported
language faithfully: its declared capabilities SHALL match what the extractors actually produce for
that language. This change SHALL NOT alter extraction output for any currently-supported language and
SHALL NOT add a parsing dependency; it consolidates and exposes existing per-language knowledge behind
one declarative seam.

#### Scenario: A language's declared capabilities match its actual extraction

- **GIVEN** a language currently supported by OpenLore
- **WHEN** the registry record for that language is compared against what the extractors produce on a
  fixture in that language
- **THEN** every capability the record declares is one the extractors actually produce, and every
  capability the extractors produce is declared — the matrix neither over- nor under-claims

#### Scenario: Adding a language is a data row plus fixtures

- **GIVEN** a new language whose grammar OpenLore can parse
- **WHEN** support is added by declaring its node-type arrays and capability flags in the registry and
  supplying fixtures
- **THEN** the generic extractors and the coverage report pick it up without new per-language
  orchestration code for the capabilities those extractors already implement

### Requirement: UniformFailSoftForUnsupportedCapabilities

For any language with no registry record, or whose record does not back a given capability, the system
SHALL yield nothing for that capability rather than an error, a guess, or an unsound result — the
fail-soft behavior the CFG overlay already practices SHALL be the uniform contract across every
capability. An unsupported capability is a silent absence, never a failure.

#### Scenario: An unspecced capability yields nothing, not an error

- **GIVEN** a language whose registry record does not back the CFG overlay (or any other capability)
- **WHEN** the repository is analyzed
- **THEN** no overlay (or other unsupported artifact) is produced for that language, analysis completes
  successfully, and the language's supported capabilities are unaffected

### Requirement: ObservableLanguageCoverageMatrix

The system SHALL derive a deterministic coverage matrix (language × capability) from the registry and
make it observable: as a generated section of the analysis artifact, and through an opt-in MCP
conclusion tool (`get_language_support`) that returns, for the repository's detected languages or a
named language, the set of supported capabilities. The matrix SHALL let a consumer distinguish "this
capability is unsupported for language L" from "this capability is supported but returned no results,"
so a quiet tool result is interpretable. The tool SHALL declare full input and structured output
schemas and SHALL NOT enter the minimal or first-run tool surface.

#### Scenario: Coverage is queryable and honest

- **GIVEN** a repository containing a language for which call extraction is supported but type
  inference is not
- **WHEN** an agent queries language support
- **THEN** the result reports `callGraph` supported and `typeInference` unsupported for that language,
  so an empty type-inference result is read as "unsupported," not "nothing found"

#### Scenario: The coverage matrix is deterministic

- **GIVEN** a fixed registry
- **WHEN** the coverage matrix is derived twice
- **THEN** the two matrices are byte-identical
