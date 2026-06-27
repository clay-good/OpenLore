# analyzer spec delta

## ADDED Requirements

### Requirement: StableNestedFunctionIdentity

The call-graph builder SHALL give each NESTED function (a named function declared inside another
function or method — a `function` declaration or a name-bound `const f = …` whose span is strictly
contained within another function node) a unique, stable node id, so that two same-named nested
functions, or a nested function colliding with a same-named top-level function, are NOT collapsed into
one node at id aggregation.

- The disambiguating id SHALL be derived from the enclosing-scope chain (e.g. `file::A.m1/helper`),
  NOT from a byte offset or any value that changes when unrelated code shifts. The id SHALL be stable
  across edits to surrounding code, a body edit, and a file move, to the same degree top-level symbols
  are today.
- Only a function whose span is STRICTLY CONTAINED within another function node SHALL be re-keyed.
  Sibling collisions (non-contained nodes sharing an id) SHALL remain collapsed — they are an
  intentional, separately-specified behavior.
- Disambiguation SHALL occur before call edges are resolved, so an edge whose caller is a nested
  function carries that nested function's unique id (not the merged twin's).
- Two same-named functions nested in the SAME enclosing scope SHALL be disambiguated by a
  deterministic, document-order ordinal that is stable as long as the enclosing scope's preceding
  structure is unchanged.
- The `stableId` of a nested function SHALL be derived from its qualified identity and SHALL round-trip
  across a body edit and a file move, exactly as a top-level symbol's `stableId` does.
- Applies to every language whose extractor produces function nodes; an extractor that does not emit
  nested-function nodes is unaffected (a no-op).

#### Scenario: same-named nested functions get distinct nodes

- **GIVEN** a file with a top-level `function helper(){}` and two methods each containing their own
  nested `function helper(){}`
- **WHEN** the call graph is built
- **THEN** there are three distinct `helper` nodes with distinct ids, and each nested helper keeps its
  own outgoing edges (no merge)

#### Scenario: a nested function id is stable across an unrelated edit

- **GIVEN** a nested function whose id is assigned
- **WHEN** an unrelated line is inserted earlier in the file and the graph is rebuilt
- **THEN** the nested function's id (and `stableId`) are unchanged — it is not reported as
  removed-and-re-added by `structural_diff` / `change_impact_certificate`

#### Scenario: intentional sibling collapses are preserved

- **GIVEN** a re-assigned member (`obj.fn = function(){}; obj.fn = function(){}`) or a same-file
  container homonym (`namespace A { class Config { load } }` vs `namespace B { class Config { load } }`)
- **WHEN** the call graph is built
- **THEN** each still collapses to exactly one node (the contained-only rule does not touch siblings)
