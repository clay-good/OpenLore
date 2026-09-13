# analyzer spec delta

## ADDED Requirements

### Requirement: StructurallyResolvableReflectiveTargetsBecomeEdges

The call-graph builder SHALL recover a call edge for a **literal dispatch table**: a module-private
(not exported) JavaScript/TypeScript `const` object of literal keys to names, whose name is used
nowhere in its file except its declaration, a type query, and as the receiver of an immediately
invoked subscript (`NAME[k]()`), in a file that neither evaluates code nor opens a dynamic scope
(any reference to `eval` as an identifier or a property, `Function(…)` with or without `new`, or a
`with` statement).

Each entry SHALL bind by the span of its same-file module-level declaration — a function declaration
or a `const` arrow or function expression, bound once (counting a `var` nested in a top-level block),
never written (including through a destructuring or `for` target), and not referring to `this` —
and never by name. An entry bound any other way, including by an import, SHALL keep the construct a
site with refusal reason `unresolved-in-file-scope`. A literal key SHALL bind only its own entry; a
non-literal key SHALL bind every entry or none, and SHALL bind none when the table's distinct
targets exceed the existing synthesis fan-out cap. Keys SHALL compare as JavaScript property keys
(`1` and `1.0` are one key); a key carrying an escape, a legacy octal or separator number, or a
`__proto__` key (which sets the prototype rather than an entry) SHALL NOT be accepted. A variable
key's target set covers the table's own entries only; a prototype polluted elsewhere is outside what
a single file can establish.

The following SHALL NOT be recovered. Each reflective call among them SHALL remain a disclosed site,
and a static-index member access (`this["m"]()`) SHALL remain unrecorded, as it was before:

- a literal member on a self-like receiver (`this["m"]()`, `getattr(self, "m")()`, Ruby
  `send(:m)`): the class graph does not bound the receiver's type, because members added by
  assignment or mixins and subclasses whose parent never resolved are invisible to it;
- reflective invocation by bare method name (`getattr(o, "m")()`, `send(:m)`,
  `call_user_func('f')`, `getMethod("m")`), with no name-and-arity fallback;
- DI-container resolution, whose resolution call returns an instance rather than invoking a
  registered callable;
- a Python module-level dict, whose attributes any importer can rebind or mutate.

A `calls`-kind edge SHALL be emitted only when the construct is **immediately invoked** at the
matched site. Obtaining a callable (`NAME[k]` without a call, bare `getattr`, Ruby `method(:m)`)
SHALL NOT produce a call edge.

Every recovered edge SHALL carry `confidence: 'synthesized'` and `synthesizedBy: 'literal-reflective'`,
SHALL be excluded wherever synthesized edges are already excluded, and SHALL be removable through
the existing directly-resolved-only mode. Recovery SHALL NOT introduce a new confidence tier or a new
tuning constant. An emitted edge SHALL NOT duplicate an edge already present for the same
caller→callee pair, and the class-hierarchy pass's exclusion set SHALL cover literal-reflection
edges.

A file whose recorded constructs exceed the per-file retention bound SHALL bind nothing, so every
retained construct stays a listed site and the unretained ones stay counted. A full analysis SHALL
produce the same synthesized edge set regardless of file order. A rebuild that
supplies only part of the repository's nodes SHALL bind nothing and SHALL disclose every candidate,
and an incremental update SHALL re-derive the boundary record of every caller file it rebuilds, so
no construct is left with neither an edge nor a site.

This family extends the dynamic-dispatch synthesis pass (`SynthesizedDynamicDispatchEdges`) under its
existing additivity guarantee: it SHALL only add edges and SHALL NOT modify or remove a
directly-resolved edge. The Pass-1 ignore tables and the external-module set SHALL NOT be modified.

Language coverage SHALL be registered in the language-capability registry, derived from the live
matcher table, so a language with no rule is reported as unsupported.

#### Scenario: A dispatch table wires its bound references

- **GIVEN** a module-private `const` table of literal keys to functions declared in the same file,
  indexed at a call site with a variable key
- **WHEN** the repository is analyzed
- **THEN** an edge is emitted to each bound function and no site is recorded for the construct

#### Scenario: A table value bound by an import is not guessed

- **GIVEN** `import { createUser } from 'lib'` and a table `{ create: createUser }`, while another file
  declares its own `createUser`
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted and the site's refusal reason is `unresolved-in-file-scope`

#### Scenario: A table that can change at runtime is not a table

- **GIVEN** a dispatch table declared with `let`, exported, aliased, passed as an argument, assigned
  into, shadowed by a parameter, or in a file that calls `eval`
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted and the dispatch site is disclosed with refusal reason `no-static-target`

#### Scenario: A self-typed receiver stays disclosed

- **GIVEN** `getattr(self, "go")()` in a method of a class that defines `go`
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted and the construct remains a site

#### Scenario: Obtaining a callable is not a call

- **GIVEN** `return T[k]` over a stable table, with no invocation at that site
- **WHEN** the repository is analyzed
- **THEN** no synthesized edge is emitted for that site

#### Scenario: One dispatch is not counted twice

- **GIVEN** a function that calls `f()` directly and also dispatches `T[k]()` over a table whose only
  entry is `f`
- **WHEN** the repository is analyzed
- **THEN** exactly one edge exists for that caller→callee pair

#### Scenario: A subset rebuild discloses rather than resolves

- **GIVEN** a literal dispatch table and its dispatch site
- **WHEN** the file is rebuilt with only part of the repository's nodes supplied
- **THEN** no literal-reflective edge is emitted and the site is disclosed with refusal reason
  `unresolved-in-file-scope`

#### Scenario: Disabling the rule adds nothing else

- **GIVEN** the fixture corpus analyzed with and without the literal-reflection rule
- **WHEN** the two graphs are compared
- **THEN** their nodes and every edge not labeled `literal-reflective` are identical

#### Scenario: Strict traversal keeps the qualification

- **GIVEN** a symbol reached only through a `literal-reflective` edge
- **WHEN** dead code is computed with directly-resolved edges only
- **THEN** the symbol is not reported as high-confidence dead

### Requirement: ReflectionRefusalsArePartitionedByResolutionOutcome

The partition between a recovered edge and a disclosed dynamic-boundary site SHALL be determined by
the **resolution outcome**, not by the syntactic form of the target.

The shared reflective matcher SHALL record every recognized construct as a **candidate** during
extraction. After resolution, a candidate whose targets bound SHALL be discharged, and every other
candidate SHALL be emitted as a dynamic-boundary site carrying its refusal reason from the closed
dynamic-boundary refusal vocabulary. A resolver refusal SHALL take precedence over a refusal derived
from a repository-wide name count. A candidate SHALL be discharged by its own identity (its file and
byte offset), never by a caller and a target name, so binding one construct cannot retract another.

No recognized construct SHALL yield both an edge and a site, and none SHALL yield neither.
Increasing resolution coverage SHALL shrink the disclosed boundary rather than remove the disclosure.

The builder SHALL NOT perform string solving, constant propagation across variables or call
boundaries, concatenated-name reconstruction, or evaluation of generated code.

#### Scenario: A literal naming a non-internal target is still disclosed

- **GIVEN** `getattr(requests, "get")()` where the literal names no internal symbol
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted **and** a site of kind `reflective-invoke` with refusal reason
  `unresolved-external` is recorded

#### Scenario: An over-cap dispatch table is disclosed, not silently dropped

- **GIVEN** a literal dispatch table with more named functions than the fan-out cap, indexed with a
  variable key
- **WHEN** the repository is analyzed
- **THEN** no edges are emitted **and** a site with refusal reason `over-cap` is recorded

#### Scenario: One bound construct does not retract another

- **GIVEN** `STABLE[k]()` and `LOOSE[k]()` in one function, where only `STABLE` is a stable table
- **WHEN** the repository is analyzed
- **THEN** the first yields edges and no site, and the second yields a site

#### Scenario: A concatenated target is never reconstructed

- **GIVEN** `getattr(o, "get_" + name)()`
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted, no partial name is inferred, and a site with refusal reason
  `no-static-target` is recorded

#### Scenario: The partition is total

- **GIVEN** a file with a stable table dispatched by a variable and a literal key, a `let` table, and
  a table with an imported entry
- **WHEN** the repository is analyzed
- **THEN** each stable-table construct produced edges and no site, and each other construct produced
  exactly one site carrying its refusal reason

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
whose distinct targets exceed the synthesis fan-out cap), `unattributed-caller` (a construct whose targets resolve but that no indexed symbol contains, so no
edge has a caller), and `synthesized-binding` (a construct literal reflection bound, surfaced only to
a directly-resolved-only consumer, which ignores that edge; never persisted as a site).

A construct whose target the literal-reflection resolver binds yields an edge and no site. It SHALL be
persisted in a separate per-file bound list, and a conclusion computed over directly-resolved edges
only SHALL disclose it as a `synthesized-binding` site, so removing the site never makes a strict
answer more confident than it was before the edge existed. A reader SHALL keep a site whose refusal
it does not recognize rather than drop the file. Constructs recorded only because literal
reflection can recover them SHALL be retained and listed after every other site, so they never
crowd a real boundary out of a bounded list, and the exact per-file total SHALL count each construct
at most once.

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

#### Scenario: A strict conclusion still discloses a bound construct

- **GIVEN** a table dispatch that literal reflection bound, so it is not a site
- **WHEN** a conclusion is computed over directly-resolved edges only
- **THEN** the construct is disclosed as a `synthesized-binding` boundary and the reached symbol is
  not reported as high-confidence dead

#### Scenario: A bound construct does not consume the disclosure of another

- **GIVEN** a file with as many literal-key table dispatches as the per-file retained-site bound,
  followed by one computed member call `o[k]()`
- **WHEN** the repository is analyzed
- **THEN** the computed call is recorded as a listed site, and the file's total counts each construct
  at most once, with any construct past the bound counted as a site
