# analyzer spec delta

## ADDED Requirements

### Requirement: StructurallyResolvableReflectiveTargetsBecomeEdges

The call-graph builder SHALL recover a call edge for a reflective dispatch construct whose target
is a **symbol reference the resolver can bind structurally**, in two families: a literal-keyed
dispatch table — a module-private (not exported) JavaScript/TypeScript `const` object of literal
keys to names, each name bound by a function declared once at module level in the same file, and
the table name used nowhere in the file except its declaration, a type query, and as the receiver of
an immediately invoked subscript — indexed at a call site; and a literal-keyed member access
on a receiver whose type is statically recovered, which is the enclosing class for a self-like
receiver (`this["m"]()`, `getattr(self, "m")()`, Ruby `send(:m)`), resolved over the methods a
receiver of that class or any subclass can reach — the class's own or else its nearest ancestor's
definition, plus every subclass override — only when every class involved has at most one resolved
parent, the class name is declared once in its file (and, in Ruby, in one file), and the construct
sits in the lexical instance context of that class: not in a static or singleton method, a nested
non-arrow function, an object literal, a module, or a block evaluated against another receiver.

A Python module-level dict SHALL NOT be treated as a table: its attributes can be rebound or mutated
through any importer, which no single-file read can rule out.

A rebuild that supplies only part of the repository's nodes SHALL bind nothing, leaving every
candidate a disclosed site, because a subclass override or homonym in an unbuilt file is invisible.

A table SHALL bind all of its entries or none; a table whose distinct bound names exceed the
existing synthesis fan-out cap SHALL bind none.

DI-container resolution SHALL NOT be recovered. A resolution call returns an instance rather than
invoking a registered callable, so under the call-form rule below it yields no call edge; the
dispatch through the instance needs the registered type, and registration syntax is
library-specific. Such a construct SHALL remain a disclosed site.

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
were in a rebuild subset SHALL compute over the full file set or SHALL be omitted with its sites
disclosed; the single-file lane resolves nothing and discloses every candidate.

Language coverage SHALL be registered in the language-capability registry, derived from the live
rule tables, so a language with no rules is reported as unsupported rather than as containing no
reflection.

This family extends the dynamic-dispatch synthesis pass (`SynthesizedDynamicDispatchEdges`) under
its existing additivity guarantee: it SHALL only add edges and SHALL NOT modify or remove a
directly-resolved edge. The Pass-1 ignore tables and the external-module set SHALL NOT be modified to
accommodate it; the resolver reads the recorded candidates and is not subject to them.

#### Scenario: The directly-resolved graph is unchanged by the new family

- **GIVEN** a repository containing reflective constructs in every recovered family
- **WHEN** it is analyzed with and without the literal-reflection rules
- **THEN** every edge not labeled `literal-reflective` is identical, and the reflective builtins
  remain ignored as ordinary calls

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

#### Scenario: A single-file rebuild discloses rather than resolves

- **GIVEN** a literal dispatch table and its dispatch site in one file
- **WHEN** only that file's dynamic-boundary record is re-derived by the single-file lane
- **THEN** the site is disclosed with refusal reason `unresolved-in-file-scope`, and a full analysis
  of the same tree state produces the same synthesized edge set regardless of file order

#### Scenario: A table that can change at runtime is not a table

- **GIVEN** a dispatch table declared with `let`, shadowed by a parameter of the same name, assigned
  into, or passed to `Object.assign`
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted and the dispatch site is disclosed with refusal reason
  `no-static-target`

#### Scenario: Disabling the rules adds nothing else

- **GIVEN** the fixture corpus analyzed with and without the literal-reflection rules
- **WHEN** the two graphs are compared
- **THEN** their nodes and every edge not labeled `literal-reflective` are identical

#### Scenario: A table value bound by an import is not guessed

- **GIVEN** `import { createUser } from 'lib'` and a table `{ create: createUser }`, while another file
  declares its own `createUser`
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted and the site's refusal reason is `unresolved-in-file-scope`

#### Scenario: Strict traversal keeps the qualification

- **GIVEN** a symbol reached only through a `literal-reflective` edge
- **WHEN** dead code is computed with directly-resolved edges only
- **THEN** the symbol is not reported as high-confidence dead

### Requirement: ReflectionRefusalsArePartitionedByResolutionOutcome

The partition between a recovered edge and a disclosed dynamic-boundary site SHALL be determined
by the **resolution outcome**, not by the syntactic form of the target.

The shared reflective matcher SHALL record every recognized construct as a **candidate** during
extraction. After resolution, a candidate whose target bound SHALL be discharged, and
every candidate that did not SHALL be emitted as a dynamic-boundary site carrying its refusal
reason from the closed dynamic-boundary refusal vocabulary: `no-static-target`,
`unresolved-external`, `resolvable-but-unbound`, `ambiguous-target`, `unresolved-in-file-scope`, or
`over-cap`. A resolver refusal (`over-cap`, or an ambiguous table entry) SHALL take precedence over a
refusal derived from a repository-wide name count.

A candidate SHALL be discharged by its own identity (its file and byte offset), never by a caller
and a target name, so binding one construct cannot retract another in the same caller. Site
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

#### Scenario: One bound construct does not retract another

- **GIVEN** `getattr(self, "run")()` and `getattr(other, "run")()` in one method, where the first
  binds through the enclosing class and `run` is also defined elsewhere
- **WHEN** the repository is analyzed
- **THEN** the first yields an edge and no site, and the second yields a site with refusal reason
  `ambiguous-target`

#### Scenario: A concatenated target is never reconstructed

- **GIVEN** `getattr(o, "get_" + name)()`
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted, no partial name is inferred, and a site with refusal reason
  `no-static-target` is recorded

#### Scenario: The partition is total

- **GIVEN** a fixture containing, for every recognized family, one instance per refusal reason
  plus one resolvable instance
- **WHEN** the repository is analyzed
- **THEN** each resolvable instance produced an edge and no site, and each other instance
  produced exactly one site carrying the correct refusal reason

## MODIFIED Requirements

### Requirement: DynamicBoundaryVocabularyIsClosedAndGroundedInSyntax

The `kind` of a site SHALL be drawn from a closed, source-declared vocabulary —
`reflective-invoke`, `computed-member`, `code-eval`, `dynamic-import`,
`metaprogrammed-definition`, `container-resolution` — covered by a test that fails when a matcher
emits a kind outside it.

A matcher SHALL be grounded in a construct's **syntactic form or a declared framework binding,
never in a bare callee name**. In particular, a `container-resolution` site SHALL be recorded only
where the receiver is bound to an identified dependency-injection container — an import from a
declared DI package, a declared decorator or annotation, or a resolution API named in the
source-declared framework table. A call to a method merely *named* `get`, `resolve`, or `make`
SHALL NOT be recorded.

The vocabulary SHALL carry a measured **density budget**: on the substrate's own repository and
on each language fixture, recorded sites SHALL NOT exceed a declared per-thousand-lines ceiling,
and a matcher that exceeds it SHALL fail the test suite rather than ship.

The refusal reason SHALL likewise be drawn from a closed, source-declared vocabulary, and SHALL
never state something the analyzer did not establish: `no-static-target` (the selector is computed
at runtime), `unresolved-external` (a literal selector naming no symbol in the index),
`resolvable-but-unbound` (a literal selector naming exactly one symbol the resolver did not bind —
its own reason, because folding it into `unresolved-external` would assert that a symbol plainly
present resolves to nothing), `ambiguous-target` (naming more than one),
`unresolved-in-file-scope` (a record derived from a single file, which has no repository-wide
symbol table and therefore SHALL NOT claim a repository-wide absence it never checked, and a table
entry bound by an import rather than a same-file declaration), `over-cap` (a literal dispatch table
whose distinct targets exceed the synthesis fan-out cap), `unresolved-in-type` (a literal member
that names no method of the statically recovered receiver type, whatever other symbols carry the
name), and `unattributed-caller` (a construct whose targets resolve but that no indexed symbol
contains, so no edge has a caller).

A construct whose target the literal-reflection resolver binds yields an edge and no site; the
retained-construct bound and the exact per-file total SHALL count each construct at most once, as
an edge or as a site.

#### Scenario: An ordinary map lookup is not a container resolution

- **GIVEN** `this.cache.get(key)` and `Promise.resolve(x)` in a file with no DI framework import
- **WHEN** the repository is analyzed
- **THEN** no `container-resolution` site is recorded for either

#### Scenario: A literal that resolves to nothing is still a boundary

- **GIVEN** `getattr(handler, "process")()` where no internal symbol named `process` resolves
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted and a site of kind `reflective-invoke` IS recorded with refusal
  reason `unresolved-external`

#### Scenario: A refusal never states something that is not so

- **GIVEN** `getattr(handler, "process")()` where an internal symbol named `process` DOES exist
- **WHEN** the repository is analyzed
- **THEN** the refusal is `resolvable-but-unbound`, never `unresolved-external`

#### Scenario: Density stays within budget

- **GIVEN** the substrate's own repository and each language fixture
- **WHEN** sites are recorded
- **THEN** the site density is at or below the declared per-thousand-lines ceiling

#### Scenario: The vocabulary cannot drift

- **GIVEN** a matcher that emits a `kind` outside the declared vocabulary
- **WHEN** the test suite runs
- **THEN** the vocabulary-completeness test fails

#### Scenario: A refusal never names a reason the resolver did not establish

- **GIVEN** `this["run"]()` in a class whose type defines no `run`, while another class defines one
- **WHEN** the repository is analyzed
- **THEN** the site's refusal reason is `unresolved-in-type`, not `resolvable-but-unbound`

#### Scenario: A bound construct does not consume the disclosure of another

- **GIVEN** a file with more bindable self-receiver constructs than the per-file retained-site bound,
  followed by one `eval(code)`
- **WHEN** the repository is analyzed
- **THEN** the `eval` is recorded as a site, and the file's total counts only unbound constructs
