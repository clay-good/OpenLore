# analyzer spec delta

## ADDED Requirements

### Requirement: GoErrorPropagationIsValueShaped

The error-propagation overlay SHALL support Go using Go's actual error model — returned error
values and panics, not exceptions. For a Go function, `escapes` SHALL comprise error values
returned to callers (directly or propagated from a callee's checked-and-returned error) and
`panic` sites not shielded by a `recover` in scope; `handledInternally` SHALL comprise callee
errors that are checked (`if err != nil`) and not returned, and panics recovered within the
function. The result SHALL be a sound lower bound: an error discarded via blank assignment
(`_ =`), an unanalyzable callee, and any resolution limit of the call graph SHALL be disclosed as
boundaries, never assumed error-free. The overlay SHALL NOT present Go results in
exception-semantics terms. `ERROR_PROPAGATION_LANGUAGES` SHALL grow only together with Go
conformance fixtures, per the existing coverage-guard discipline; Java/C# `throws`/`throw`
analysis MAY follow as a separate stage on the existing exception-shaped result.

#### Scenario: A returned error escapes; a checked-and-dropped error does not

- **GIVEN** a Go function that calls a callee returning `error`, checks `err != nil`, and returns
  the error in one branch while logging-and-continuing in another function's case
- **WHEN** `analyze_error_propagation` runs on each
- **THEN** the returning function reports the error value in `escapes` with its origin and path
- **AND** the checking-not-returning function reports it in `handledInternally`

#### Scenario: Panic and recover follow Go semantics

- **GIVEN** a Go function that calls `panic("x")`, and a caller that defers a `recover`
- **WHEN** the overlay analyzes both
- **THEN** the panicking function reports the panic in `escapes`, and the recovering caller
  reports it in `handledInternally`

#### Scenario: A swallowed error is a disclosed boundary, not a guess

- **GIVEN** a Go call whose error result is discarded with `_ =`
- **WHEN** the overlay analyzes the enclosing function
- **THEN** the discarded error is disclosed as a boundary (neither counted escaped nor silently
  dropped), keeping the result a sound lower bound

### Requirement: TypeInferenceCoversKotlinAndDart

The type-inference engine SHALL support Kotlin and Dart via the same signal shape as the existing
Java/C# inference: explicit local type annotations and constructor-call assignment (`val x: Foo`,
`val x = Foo()`, `final Foo x`, `var x = Foo()`) resolving a receiver to its class so method calls
dispatch to that class's methods. `TYPE_INFERENCE_LANGUAGES` SHALL grow only together with
conformance fixtures; non-member languages SHALL continue returning an empty inference.

#### Scenario: A Kotlin or Dart receiver resolves to its class

- **GIVEN** a Kotlin `val p = Parser()` (or Dart `final p = Parser()`) followed by `p.run()`
- **WHEN** the call graph is built
- **THEN** the `p.run()` edge resolves to `Parser.run` via the existing receiver-type strategy

#### Scenario: The set grows only with fixtures

- **GIVEN** Kotlin and Dart added to `TYPE_INFERENCE_LANGUAGES`
- **WHEN** the conformance suite runs
- **THEN** each has a fixture yielding a non-empty inference, and a member added without a fixture
  fails the suite

### Requirement: CfgOverlayCoversKotlinSwiftDartScala

The CFG overlay SHALL support Kotlin, Swift, Dart, and Scala via new `CfgLangSpec` entries in the
data-driven `SPEC_BY_LANGUAGE` table. A language whose grammar exposes positional control-flow
children or a sibling function body MAY provide a small adapter through the table's shared adapter
hooks; these hooks SHALL remain grammar-shape normalization, not language-specific CFG semantics.
Each added language SHALL ship a conformance fixture whose branchy function yields a structurally-valid CFG, and
`CFG_LANGUAGES` (derived from the table's keys) SHALL flip the registry's `cfgOverlay` cell
without hand edits.

#### Scenario: A branchy function in an added language yields a valid CFG

- **GIVEN** a Kotlin/Swift/Dart/Scala function with an if/else and a loop
- **WHEN** the CFG overlay is built
- **THEN** the CFG is structurally valid (entry, exit, branch and loop edges), and a table entry
  added without a fixture fails the coverage guard

### Requirement: HttpClientExtractionCoversPythonAndGo

Cross-service HTTP extraction SHALL cover the CLIENT side for Python (`requests`, `httpx`) and Go
(`net/http`), closing the disclosed asymmetry in which Python routes are extracted
(`HTTP_ROUTE_LANGUAGES`) but Python outbound calls are invisible. A Python or Go outbound call
site with a statically-known method and path SHALL match extracted routes into the existing
`http_endpoint` edge; a dynamically-built URL SHALL produce no edge (never a guessed match).
`HTTP_CLIENT_LANGUAGES` SHALL grow only together with fixtures.

#### Scenario: A Python outbound call reaches its route

- **GIVEN** a Python service calling `requests.get("http://svc/items")` and another service (any
  route-extracted language) registering `GET /items`
- **WHEN** the cross-service projection runs
- **THEN** an `http_endpoint` edge connects the client call site to the route handler

#### Scenario: A dynamic URL yields no guessed edge

- **GIVEN** a Go client call whose URL is assembled at runtime from variables
- **WHEN** the projection runs
- **THEN** no `http_endpoint` edge is emitted for that call site
