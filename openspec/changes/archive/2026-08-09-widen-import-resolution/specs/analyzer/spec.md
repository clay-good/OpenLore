# analyzer spec delta

## ADDED Requirements

### Requirement: ImportPreciseResolutionBeyondTsJsPython

The analyzer SHALL extend import-precise cross-file call resolution (edges carrying `import`
confidence via a per-file name-binding map) beyond TypeScript/JavaScript/Python, in staged
increments ordered by collision pressure: Go (package-qualified calls and same-package sibling
resolution from `package` clauses), then Java/Kotlin/C# (import/using + package/namespace
declarations forming a per-file FQN→file map), then PHP (`use` + `namespace`). Each wired language
SHALL bind through the new map only when the binding is unique, falling through to the existing
resolution ladder otherwise — resolution never guesses on the new path and never degrades below
today's behavior. `IMPORT_RESOLUTION_LANGUAGES` (the authoritative source of the registry's
`imports` capability) SHALL grow only with a wired, conformance-fixtured stage. Ruby SHALL remain
outside the import-precise set with the deferral rationale disclosed in the source (no static name
imports; `require`/autoload/open classes bind at runtime), rather than receiving a guessed map.

#### Scenario: A Go package-qualified call resolves import-precise

- **GIVEN** a Go file importing package `util` and calling `util.Parse()`, with `Parse` defined in
  a file whose `package` clause is `util`
- **WHEN** the call graph is built
- **THEN** the edge binds to that definition with `import` confidence, not `name_only`
- **AND** a bare call to a function defined in another file of the caller's own package also binds
  import-precise via package-sibling resolution

#### Scenario: An FQN-mapped language moves off name_only

- **GIVEN** a Java, Kotlin, or C# file importing `com.acme.Parser` and calling `Parser.run()`
- **WHEN** the call graph is built
- **THEN** the edge binds via the per-file FQN→file map at `import` confidence
- **AND** two same-named classes in different packages do not collide: the import binding selects
  the declared one

#### Scenario: A name the map cannot bind falls through unchanged

- **GIVEN** a call in a wired language whose callee name is absent from the file's import/package map
- **WHEN** the call graph is built
- **THEN** resolution falls through to the existing ladder (same strategy and confidence as before
  this change), and the new path emits no guessed edge

#### Scenario: The conformance provenance assertion flips per stage

- **GIVEN** a language newly added to `IMPORT_RESOLUTION_LANGUAGES`
- **WHEN** the conformance suite resolves that language's cross-file fixture
- **THEN** the asserted provenance is `import` (updated from `name_only`), and a language added to
  the set without a cross-file import fixture fails the suite

#### Scenario: Ruby's deferral is disclosed, not silent

- **GIVEN** the import-precise language set after all stages land
- **WHEN** a reader consults `IMPORT_RESOLUTION_LANGUAGES` or the language-support registry
- **THEN** Ruby is absent with the recorded rationale (runtime binding — no static name imports),
  and Ruby cross-file calls continue to resolve by the existing ladder with `name_only` provenance
