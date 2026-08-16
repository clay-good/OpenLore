# analyzer spec delta

## ADDED Requirements

### Requirement: AnalyzeReusesPassOneFacts

A call-graph build SHALL parse each newly extracted, grammar-backed source file at most once.
Tree-dependent class and dynamic-dispatch facts SHALL be collected as plain data while the Pass-1
tree is alive so they survive worker structured-clone and persistent fact-cache boundaries without
retaining parser trees. HTTP edge extraction SHALL consume the builder's resident content rather
than re-read the same paths.

Native tree-sitter queries SHALL be cached per worker/runtime, grammar identity, and query source.
WASM queries MAY remain parse-scoped when their runtime requires explicit disposal. Per-caller type
inference SHALL run once per function, not once per receiver call.

The extracted graph SHALL remain byte-identical to the prior multi-pass output, including class
relationships and synthesized-edge provenance.

#### Scenario: Later passes reuse Pass-1 work

- **GIVEN** a repository analyzed through the serial lane, worker lane, or warm Pass-1 fact cache
- **WHEN** class relationships, HTTP edges, and dynamic-dispatch edges are built
- **THEN** no newly extracted grammar-backed file is parsed more than once, no resident HTTP input
  is re-read, and the complete serialized graph matches the pre-optimization graph exactly
