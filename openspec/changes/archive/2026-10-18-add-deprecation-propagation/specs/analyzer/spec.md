# analyzer spec delta

## ADDED Requirements

### Requirement: DeprecationMarkersAreExtractedInTheExistingWalk

The analyzer SHALL detect language-standard deprecation markers where it already reads each
declaration's doc comment or decorators — with no second parse of any file — and record the
marker's remaining text, bounded, as the function node's `deprecation` hint (empty when the marker
carries none). Detection SHALL match only the structural convention of each implemented language:
a JSDoc `@deprecated` tag at the start of a line of the `/** */` block immediately before a
TypeScript/JavaScript declaration (past `export`/modifier keywords and a `const name =` binding), a
`Deprecated:` paragraph in the comment immediately before a Go declaration, and a `deprecated`,
`warnings.deprecated`, or `typing_extensions.deprecated` decorator on a Python function — never a
substring of ordinary prose. The marker SHALL persist in the edge store. The implemented languages
SHALL be published as a `deprecationMarkers` capability derived from the extractor's own language
set, so a language without it claims no marker.

#### Scenario: A JSDoc deprecation is extracted with its hint

- **GIVEN** an exported TypeScript function whose leading doc comment contains
  `@deprecated use createClientV2 instead`
- **WHEN** the analyzer walks the file
- **THEN** the function node's `deprecation` is `use createClientV2 instead`

#### Scenario: Prose mentioning deprecation is not a marker

- **GIVEN** a Go function whose doc comment says "handles deprecated input formats", or has
  `Deprecated:` in the middle of a paragraph
- **WHEN** the analyzer walks the file
- **THEN** the function node has no `deprecation`

#### Scenario: The capability registry cannot over-claim

- **GIVEN** any language
- **WHEN** `get_language_support` reports capabilities
- **THEN** `deprecationMarkers` is claimed exactly when the extractor reads that language's marker
