# analyzer spec delta

## ADDED Requirements

### Requirement: StructurallyResolvableReflectiveTargetsBecomeEdges

The call-graph builder SHALL recover a call edge for a reflective dispatch construct whose target
is a **symbol reference the resolver can bind structurally**, in three families: a literal-keyed
dispatch table whose values are name-bound function references resolved in the table's own
lexical scope; a container registration paired with a resolution site carrying the same literal
token within the analyzed repository; and a literal-keyed member access on a receiver whose type
is statically recovered.

Resolution SHALL use a **strict-uniqueness** resolver: a target binds only when the internal
candidate set has exactly one member after any type narrowing. The same-file preference used by
handler resolution SHALL NOT be applied — a same-file candidate coexisting with other internal
candidates of the same name is ambiguous and SHALL be refused. Reusing the handler resolver as-is
is non-conforming.

Reflective invocation by **bare method name** — `getattr(o, "m")()`, `send(:m)`,
`call_user_func('f')`, `getMethod("m")` — SHALL NOT be recovered by name lookup, and no
name-and-arity fallback SHALL be applied. Such a construct SHALL be refused and disclosed. It MAY
be recovered only where the receiver's type is statically recovered and the method resolves
uniquely within that type's subtree.

A `calls`-kind edge SHALL be emitted only when the construct is **immediately invoked** at the
matched site. A construct that merely obtains a callable — bare `getattr`/`hasattr`, Ruby
`method(:m)`, an un-invoked PHP array callable, `setattr` — SHALL NOT produce a call edge.

Every recovered edge SHALL carry `confidence: 'synthesized'` and a `synthesizedBy` rule name
identifying literal reflection, SHALL be excluded wherever synthesized edges are already
excluded, and SHALL be removable through the existing directly-resolved-only mode. Recovery SHALL
NOT introduce a new confidence tier or a new tuning constant.

An emitted edge SHALL NOT duplicate an edge already present for the same caller→callee pair,
whether directly resolved or previously synthesized. The synthesis pass SHALL dedupe on
`(callerId, calleeId)` against the full accumulated edge set, and the class-hierarchy pass's
exclusion set SHALL be extended to cover literal-reflection callees, so one dispatch is never
emitted twice under two provenance labels.

The synthesized edge set SHALL be identical after a full analysis and after any sequence of
incremental rebuilds reaching the same tree state. A rule whose output depends on which files
were in a rebuild subset — in particular cross-file container pairing — SHALL compute over the
full file set or SHALL be omitted with its sites disclosed.

Language coverage SHALL be registered in the language-capability registry, derived from the live
rule tables, so a language with no rules is reported as unsupported rather than as containing no
reflection.

#### Scenario: A dispatch table wires its bound references

- **GIVEN** a module-level literal map of literal keys to named internal functions, indexed at a
  call site with a variable key
- **WHEN** the repository is analyzed
- **THEN** an edge is emitted to each bound function, subject to the per-site fan-out cap

#### Scenario: A same-file homonym does not make an ambiguous name unique

- **GIVEN** `getattr(o, "run")()` in a file that itself defines an unrelated `run`, while three
  other internal files also define `run`
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted — the same-file candidate does not disambiguate — and the site is
  disclosed as a boundary

#### Scenario: Obtaining a method reference is not a call

- **GIVEN** `m = obj.method(:refresh)` with no invocation at that site
- **WHEN** the repository is analyzed
- **THEN** no `calls` edge is emitted for that site

#### Scenario: One dispatch is not counted twice

- **GIVEN** a receiver call that both this change resolves and the class-hierarchy pass would
  emit an edge for, to the same callee
- **WHEN** the repository is analyzed
- **THEN** exactly one edge exists for that caller→callee pair

#### Scenario: Container pairing is stable under incremental rebuild

- **GIVEN** a container registration in one file and its resolution in another
- **WHEN** only the resolution site's file is rebuilt incrementally
- **THEN** the resulting synthesized edge set equals the set produced by a full analysis of the
  same tree state, or the affected site is disclosed as a boundary

#### Scenario: Disabling the rules restores today's graph

- **GIVEN** the fixture corpus analyzed with the literal-reflection rules disabled
- **WHEN** the graph is compared with the pre-change graph
- **THEN** it is byte-identical

### Requirement: ReflectionRefusalsArePartitionedByResolutionOutcome

The partition between a recovered edge and a disclosed dynamic-boundary site SHALL be determined
by the **resolution outcome**, not by the syntactic form of the target.

The shared reflective matcher SHALL record every recognized construct as a **candidate** during
extraction. After resolution, a candidate that produced exactly one edge SHALL be discharged, and
every candidate that did not SHALL be emitted as a dynamic-boundary site carrying its refusal
reason from a closed set: `non-literal`, `unresolved-external`, `ambiguous`, or `over-cap`. Site
emission SHALL therefore occur after resolution, not during the extraction walk.

No recognized construct SHALL yield both an edge and a site, and none SHALL yield neither.
Increasing resolution coverage SHALL shrink the disclosed boundary rather than remove the
disclosure.

The builder SHALL NOT perform string solving, constant propagation across variables or call
boundaries, concatenated-name reconstruction, or evaluation of generated code.

#### Scenario: A literal naming a non-internal target is still disclosed

- **GIVEN** `getattr(requests, "get")()` where the literal names no internal symbol
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted **and** a site of kind `reflective-invoke` with refusal reason
  `unresolved-external` is recorded

#### Scenario: An over-cap dispatch table is disclosed, not silently dropped

- **GIVEN** a literal dispatch table with more named functions than the fan-out cap
- **WHEN** the repository is analyzed
- **THEN** no edges are emitted **and** a site with refusal reason `over-cap` is recorded

#### Scenario: A concatenated target is never reconstructed

- **GIVEN** `getattr(o, "get_" + name)()`
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted, no partial name is inferred, and a site with refusal reason
  `non-literal` is recorded

#### Scenario: The partition is total

- **GIVEN** a fixture containing, for every recognized family, one instance per refusal reason
  plus one resolvable instance
- **WHEN** the repository is analyzed
- **THEN** each resolvable instance produced an edge and no site, and each other instance
  produced exactly one site carrying the correct refusal reason

## MODIFIED Requirements

### Requirement: SynthesizedDynamicDispatchEdges

The enumerated family list of the dynamic-dispatch synthesis pass gains literal reflective
dispatch, restricted to the structurally-resolvable families above. The existing additivity
guarantee — synthesis SHALL only add edges and SHALL NOT modify or remove any directly-resolved
edge — covers this change unchanged, and this delta does not restate it.

The Pass-1 ignore tables and the external-module set SHALL NOT be modified to accommodate this
change: the synthesis pass re-parses each candidate file and is not subject to them, so the
directly-resolved graph is unaffected.

#### Scenario: The directly-resolved graph is unchanged by the new family

- **GIVEN** a repository containing reflective constructs in every recognized family
- **WHEN** it is analyzed before and after this change
- **THEN** every non-synthesized edge is identical, and the reflective builtins remain ignored as
  ordinary calls
