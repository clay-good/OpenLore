# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ErrorPropagationConclusionTool

The system SHALL expose error-propagation analysis through an opt-in MCP tool
(`analyze_error_propagation`) that returns, as a **conclusion**, the exceptions that can propagate out
of a single query function and which (if any) are caught within it — never a graph, a CFG, or a
source dump. The tool SHALL accept a `symbol` (the name, or `name::path`, of a function in the indexed
call graph) and an optional `maxDepth` bound on callee traversal.

The tool SHALL compute live from the already-persisted call graph (callee edges with call-site lines)
plus a re-read and tree-sitter parse of the source the reachable functions span. It SHALL NOT require
a new persisted artifact and SHALL NOT introduce a schema migration. It SHALL declare a complete input
schema and return a structured conclusion classified `conclusion` per the MCP quality requirements. It
SHALL NOT enter `MINIMAL_TOOLS`, the first-run default surface, or any curated preset; it lands only in
the full opt-in surface.

For a resolved, supported query symbol the tool SHALL return:

- **`escapes`** — the exception types that can propagate out of the query function to its callers.
  Each SHALL carry its type (or `<dynamic>` when the thrown value's static type is unknowable), its
  origin function/file/line, whether it is a direct throw or propagated from a callee, and the call
  path from the query to the origin.
- **`handledInternally`** — exception types thrown somewhere in the reachable subtree but caught
  within the query function's own body, each naming the catch site, so a caller can see what is
  already shielded.
- **`boundaries`** — the disclosures that make the result a sound lower bound (see below).

The tool SHALL be honest about what it does not know (soundness over coverage):

- a `symbol` not present in the index SHALL produce an explicit not-found result (with near-miss
  candidate names where available), never an empty result that reads as "throws nothing";
- an ambiguous `symbol` (matching more than one indexed function) SHALL report the ambiguity and the
  candidates rather than guessing one;
- a `symbol` whose language is not in the error-propagation support set SHALL return an explicit
  `unsupported` result naming the language, never an empty escape set;
- a `symbol` that is external or has no extractable body SHALL say so explicitly;
- a callee that cannot be analyzed (external, bodyless, unsupported language, or beyond the depth/size
  bound) SHALL be disclosed as a boundary and SHALL NOT be assumed exception-free;
- an intra-object call site (`this.`/`super.` in TS/JS, `self.`/`cls.` in Python) whose callee the call
  graph resolved to NO edge — neither a resolved method edge nor an `external::` edge — SHALL be
  disclosed (counted, with a sample, in `unresolvedSelfCalls` and a boundary) and SHALL NOT be silently
  assumed exception-free; a clean `escapes` set does not clear these paths;
- a bare re-raise / re-throw of a caught variable SHALL be surfaced as `<dynamic>`, never dropped;
- Python typed-`except` catch resolution SHALL match by exact type name (plus the catch-all forms),
  and the absence of subclass-hierarchy modeling SHALL be disclosed when a typed handler is present;
- when the depth or analyzed-function bound truncates the traversal, the truncation SHALL be
  disclosed.

#### Scenario: The tool returns escaping exceptions as a conclusion, not a graph

- **GIVEN** an analyzed repository and a `symbol` that throws (directly or via a callee)
- **WHEN** an agent calls `analyze_error_propagation` with that symbol
- **THEN** it receives the labeled `escapes` set (type, origin, direct-vs-propagated, path) and the
  `handledInternally` set, and receives no node-and-edge structure to traverse

#### Scenario: An exception caught at the query function is reported as handled, not escaping

- **GIVEN** a query function that wraps a throwing callee in a `try` whose handler catches it without
  re-throwing
- **WHEN** an agent calls `analyze_error_propagation` with that function
- **THEN** the caught exception appears in `handledInternally` (with its catch site) and NOT in
  `escapes`, because the caller is shielded

#### Scenario: An unsupported-language symbol is an explicit unsupported result, not "throws nothing"

- **GIVEN** a `symbol` whose language is not in the error-propagation support set (e.g. Go)
- **WHEN** an agent calls `analyze_error_propagation`
- **THEN** it receives an explicit `unsupported` result naming the language, not an empty `escapes`
  set that would read as a proof of exception-freedom

#### Scenario: An un-analyzable callee is disclosed, never assumed exception-free

- **GIVEN** a query function that calls an external or bodyless callee
- **WHEN** an agent calls `analyze_error_propagation`
- **THEN** that callee is named in `boundaries` as not analyzed, and the result does not silently
  claim the callee raises nothing

#### Scenario: An unresolved intra-object call site is disclosed, never assumed exception-free

- **GIVEN** a query function with a `this.method()` (or `self.method()`) call whose callee the call
  graph resolved to no edge at all (the call shape that gets neither a resolved nor an `external::`
  edge)
- **WHEN** an agent calls `analyze_error_propagation`
- **THEN** the result discloses that call site in `unresolvedSelfCalls` and a boundary, and does NOT
  return an empty `escapes` set that would read as a proof the method throws nothing
