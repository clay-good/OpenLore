# analyzer spec delta

## ADDED Requirements

### Requirement: DynamicBoundarySitesAreExtractedAndPersisted

During the Pass-1 extraction walk, the analyzer SHALL record every source construct that performs
dispatch the call-graph resolver cannot follow — a **dynamic-boundary site** — as a persisted
fact, without attempting to resolve it. Each site SHALL carry its file path, line, the enclosing
symbol (or an explicit module-level marker when the construct sits outside any function), a
`kind` from the closed vocabulary, and the matched evidence text. Sites SHALL be persisted in a
sidecar artifact alongside the existing per-file disclosure artifacts, SHALL NOT introduce a node
or edge into the call graph, and SHALL be loaded with the graph so no serving path performs an
extra read. Extraction SHALL add no second parse of any file.

A symbol containing at least one site SHALL be queryable as dynamic-boundary-adjacent, and the
per-repository and per-region site counts SHALL be reported by the substrate's status surface.

Extraction SHALL be fail-soft and false-negative-biased: an unrecognized construct, an
unsupported language, or a failed match SHALL record nothing and SHALL NOT fail the analyze.

#### Scenario: A reflective invocation is recorded, not resolved

- **GIVEN** a Python function containing `getattr(handler, action)()` where `action` is a
  parameter
- **WHEN** the repository is analyzed
- **THEN** a site of kind `reflective-invoke` is recorded against the enclosing function with its
  file and line, and the call graph contains no new edge for that call site

#### Scenario: The site survives to the serving path without a second read

- **GIVEN** an analyzed repository with recorded dynamic-boundary sites
- **WHEN** a conclusion tool loads the graph
- **THEN** the sites for the loaded region are available without an additional artifact read,
  and a repository with zero sites adds no measurable load cost

#### Scenario: Extraction never breaks an analyze

- **GIVEN** a file in a language with no dynamic-boundary matcher, or a file whose grammar failed
  to load
- **WHEN** the repository is analyzed
- **THEN** no sites are recorded for that file, the analyze completes normally, and the absence
  is attributable to the language's declared capability rather than presented as "no dynamic
  dispatch here"

### Requirement: DynamicBoundaryVocabularyIsClosedAndPartitioned

The `kind` of a dynamic-boundary site SHALL be drawn from a closed, source-declared vocabulary —
`reflective-invoke`, `computed-member`, `code-eval`, `dynamic-import`,
`metaprogrammed-definition`, `container-resolution` — declared in one module and covered by a
test that fails when a matcher emits a kind outside it. The vocabulary SHALL be extended only by
an explicit source change, never inferred at runtime.

A construct whose dispatch target is recoverable from a static literal SHALL NOT be recorded as a
dynamic-boundary site; it belongs to literal reflective resolution and is represented as a
provenance-labeled call edge. The two treatments SHALL partition the same matched construct set:
every matched construct SHALL yield either a resolved edge or a site, never both and never
neither.

#### Scenario: A literal-argument reflective call is not a boundary

- **GIVEN** `obj.send(:process)` with a literal method name, and `obj.send(name)` with a variable
- **WHEN** the repository is analyzed
- **THEN** the literal call yields a resolved, provenance-labeled edge and no site; the variable
  call yields a site of kind `reflective-invoke` and no edge

#### Scenario: The vocabulary cannot drift

- **GIVEN** a matcher that emits a `kind` string not present in the declared vocabulary
- **WHEN** the test suite runs
- **THEN** the vocabulary-completeness test fails
