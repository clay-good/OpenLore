# analyzer spec delta

## ADDED Requirements

### Requirement: GeneratedMatrixDisclosesItsScope

The language-coverage matrix in the generated analysis digest (`CODEBASE.md`) SHALL disclose that
its rows are scoped to the analyzed repository's detected languages, and SHALL append a derived
statement of the registry's additionally-backed languages (computed as the full registry matrix
minus the detected set — never a hand-maintained list), directing the reader to
`get_language_support` for the complete matrix. A generated digest SHALL therefore never present a
repo-scoped absence as product-level non-support. The digest SHALL remain deterministic:
byte-stable for a fixed registry and repository.

#### Scenario: A repo without Java still surfaces Java's backing

- **GIVEN** a repository whose graph detects no Java, Rust, or Swift nodes
- **WHEN** the analysis digest is generated
- **THEN** the coverage table contains only detected languages, its header states the repo scoping
- **AND** the appended registry line names Java, Rust, and Swift (among others) as
  registry-backed, derived from `languageCoverageMatrix()` at generation time

#### Scenario: The disclosure line cannot drift from the registry

- **GIVEN** a language later added to or removed from the capability registry
- **WHEN** the digest is regenerated
- **THEN** the appended line reflects the change with no hand edit, because it is computed from
  the same registry the matrix derives from

### Requirement: LanguageDocsHaveOneCanonicalSource

The repository SHALL maintain exactly one canonical language-support document
(`docs/language-support.md`) carrying both the capability matrix and the per-language narrative
(extensions, grouping, caveats); any legacy language page SHALL be a redirect stub. Source
citations on the canonical page (which file authoritatively declares each capability's language
set) SHALL name the module where the constant is defined — e.g. `CROSS_SERVICE_HTTP_LANGUAGES` in
`http-capability.ts`, not its re-exporter. A parity check SHALL assert every `CALLGRAPH_LANGUAGES`
member has a per-language row on the canonical page, so the documentation can neither over-claim
(existing registry guards) nor under-claim (this check) the backed language set.

#### Scenario: A registry-backed language cannot be missing from the canonical page

- **GIVEN** a language present in `CALLGRAPH_LANGUAGES` (e.g. Rust)
- **WHEN** the docs↔registry parity check runs
- **THEN** it fails unless the canonical page carries a per-language row for that language

#### Scenario: A capability citation names the defining module

- **GIVEN** the canonical page's authoritative-source column
- **WHEN** a reader follows the cited file for `crossServiceHttp`
- **THEN** the citation resolves to the module defining the constant (`http-capability.ts`), not a
  re-exporting module
