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
- Only a function whose span is STRICTLY CONTAINED within ANOTHER function node WITH A DIFFERENT ID
  SHALL be re-keyed. A same-id container is the SAME logical function matched twice (an `export
  function` / decorated-definition wrapper byte-containing its inner declaration) and SHALL remain
  collapsed. Sibling collisions (non-contained nodes sharing an id) SHALL likewise remain collapsed —
  both are intentional, separately-specified behavior.
- Disambiguation SHALL occur before call edges are resolved, so an edge whose caller is a nested
  function carries that nested function's unique id (not the merged twin's).
- A call to a same-named function with multiple same-file candidates SHALL resolve by lexical scope: a
  twin byte-NESTED within the caller's own span wins (the narrowest such, since an inner definition
  shadows an outer name), and a self-named candidate is a recursive call that binds to the CALLER
  itself — so a method's `validate()` reaches its OWN nested `validate` and a recursive nested
  `visit(){ … visit() … }` recurses rather than jumping to a sibling scope's twin. Absent a nested or
  recursive match the existing first-same-file fallback applies. (Without this, the now-distinct twins
  would misroute every incoming nested call to whichever twin sorts first.)
- Two same-named functions nested in the SAME enclosing scope SHALL be disambiguated by a
  deterministic, document-order ordinal that is stable as long as the enclosing scope's preceding
  structure is unchanged.
- The disambiguated PATH id SHALL be stable across edits to surrounding code (derived from the
  enclosing scope, not a byte offset), so a nested function is not reported removed-and-re-added by
  `structural_diff` / `change_impact_certificate` on an unrelated edit. The content-addressed
  `stableId` continues to derive from `className.name(signature)`; two nested twins therefore share a
  `stableId` — the existing homonym completeness limit, resolved only when unique (qualifying
  `stableId` by enclosing scope is a deferred refinement, not required here).
- A re-keyed nested function's per-node side tables — specifically the intraprocedural CFG overlay —
  SHALL follow the FINAL node id, not the pre-disambiguation bare id. The CFG overlay SHALL be
  collected during extraction keyed by a per-node-stable value (the function's start byte) and
  re-attached to the final id, so that (a) each of two same-named nested functions keeps its OWN CFG
  (no last-write-wins loss against the colliding bare id) and (b) no CFG is orphaned under an id that
  no node carries. CFG-dependent capabilities (def-use dataflow, `analyze_error_propagation`) SHALL
  therefore resolve a re-keyed nested function's overlay by its node id.
- Applies to every language whose extractor produces function nodes — the dedicated extractors
  (TypeScript/JavaScript, Python, Go, Rust, Ruby, Java, C++, Swift, Dart, Elixir) AND the shared
  query-spec extractor (C#, Kotlin, Scala, PHP, Lua, …). The query-spec extractor's extraction-time
  id-dedup (which collapses multi-clause definitions / overloads) SHALL NOT drop a genuinely nested
  twin before disambiguation: a colliding node byte-contained in a different-id function survives to be
  re-keyed, while a true same-scope overload still collapses to one node. An extractor that does not
  emit nested-function nodes is unaffected (a no-op).

#### Scenario: same-named nested functions get distinct nodes

- **GIVEN** a file with a top-level `function helper(){}` and two methods each containing their own
  nested `function helper(){}`
- **WHEN** the call graph is built
- **THEN** there are three distinct `helper` nodes with distinct ids, and each nested helper keeps its
  own outgoing edges (no merge)

#### Scenario: a nested function id is stable across an unrelated edit

- **GIVEN** a nested function whose id is assigned
- **WHEN** an unrelated line is inserted earlier in the file and the graph is rebuilt
- **THEN** the nested function's PATH id is unchanged — it is not reported as removed-and-re-added by
  `structural_diff` / `change_impact_certificate`

#### Scenario: intentional sibling collapses are preserved

- **GIVEN** a re-assigned member (`obj.fn = function(){}; obj.fn = function(){}`) or a same-file
  container homonym (`namespace A { class Config { load } }` vs `namespace B { class Config { load } }`)
- **WHEN** the call graph is built
- **THEN** each still collapses to exactly one node (the contained-only rule does not touch siblings)

#### Scenario: an export/decorated double-match is not split

- **GIVEN** an `export async function createOrder()` (matched twice — the export wrapper byte-contains
  the inner declaration, both with id `file::createOrder`)
- **WHEN** the call graph is built
- **THEN** there is exactly ONE `createOrder` node (the same-id container is not treated as nested)

#### Scenario: a query-spec language splits nested twins yet collapses overloads

- **GIVEN** a C# class with two methods each containing a nested local `void Validate(){}` (distinct
  bodies), and separately a class with two `Add` method overloads
- **WHEN** the call graph is built
- **THEN** the two nested `Validate`s become distinct nodes (`…Process/Validate`, `…Submit/Validate`)
  with their calls routed lexically, while the two `Add` overloads still collapse to one node

#### Scenario: an incoming nested call resolves by lexical scope

- **GIVEN** two methods `processA`/`processB` that each contain their own nested `validate`, plus a
  third method whose nested `visit` calls itself recursively
- **WHEN** the call graph is built
- **THEN** `processA`'s `validate()` edge targets `…processA/validate`, `processB`'s targets
  `…processB/validate` (no cross-scope misroute), and the recursive `visit` edge targets its own node

#### Scenario: a re-keyed nested function keeps its CFG overlay

- **GIVEN** two methods each with their own nested `function helper(){ … }`, each with a distinct
  control-flow body (so each has its own CFG overlay)
- **WHEN** the call graph is built and the two nested `helper`s are re-keyed to distinct ids
- **THEN** each re-keyed `helper` node has its OWN CFG entry under its final id, and there is no CFG
  keyed under the pre-disambiguation bare `file::helper` (no orphan, no last-write-wins loss)
