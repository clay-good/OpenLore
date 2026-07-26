# analyzer spec delta

## ADDED Requirements

### Requirement: LiteralReflectiveTargetsResolveToProvenanceLabeledEdges

The call-graph builder SHALL recover a call edge for a reflective dispatch construct whose target
is named by a **static literal** — a string literal, a substitution-free template literal, a
symbol literal, or a constant reference the builder already reads as a static key — when that
literal resolves to exactly one internal symbol.

Recovered families SHALL include: reflective invocation by literal method name, member access
with a literal key, dynamic import with a literal module specifier, indexed dispatch through a
literal-keyed table of named internal functions, and container registration/resolution where the
same literal token appears on both the registration and the resolution site within the analyzed
repository.

Every recovered edge SHALL carry `confidence: 'synthesized'` and a `synthesizedBy` rule name
identifying literal reflection, SHALL be excluded wherever synthesized edges are already
excluded, and SHALL be removable through the existing directly-resolved-only mode. Recovery
SHALL NOT introduce a new confidence tier, a new tuning constant, or a second resolution
algorithm: it SHALL reuse the existing static-literal reading, name/import resolution, class
hierarchy narrowing, and per-site fan-out cap.

Where the receiver's type is statically recoverable, the target SHALL be narrowed to that type's
subtree before falling back to name-and-arity resolution.

Language coverage SHALL be declared in the language-capability registry so that a language with
no rules is reported as unsupported for this capability rather than as containing no reflection.

#### Scenario: A literal reflective invocation becomes an edge

- **GIVEN** a Python module containing `getattr(handler, "process")()` where `handler` is an
  instance of an internal class declaring `process`
- **WHEN** the repository is analyzed
- **THEN** a call edge from the enclosing function to that `process` method exists with
  `confidence: 'synthesized'` and a literal-reflection `synthesizedBy` label

#### Scenario: A literal dispatch table wires every named handler

- **GIVEN** a module-level object literal mapping literal keys to named internal functions, and a
  call site indexing that table with a variable key
- **WHEN** the repository is analyzed
- **THEN** an edge is emitted to each named function in the table, subject to the per-site
  fan-out cap; an over-cap table emits no edges at all rather than a partial set

#### Scenario: Synthesized provenance is respected downstream

- **GIVEN** a symbol reachable only through a literal-reflection edge
- **WHEN** reachability is computed in directly-resolved-only mode
- **THEN** the symbol is unreachable, exactly as before this change; in the default mode it is
  reachable and its path names the synthesized edge

#### Scenario: Disabling the rules restores today's graph

- **GIVEN** the fixture corpus analyzed with the literal-reflection rules disabled
- **WHEN** the graph is compared with the pre-change graph
- **THEN** it is byte-identical — the change is strictly additive

### Requirement: ReflectionRulesRefuseToGuessAndPartitionWithDisclosure

A reflective construct whose target is not a static literal, does not resolve to exactly one
internal symbol, or is ambiguous across files SHALL emit **no** edge. The builder SHALL NOT
perform string solving, constant propagation across variables or call boundaries, concatenated or
formatted name reconstruction, or evaluation of generated code.

Every construct recognized by the shared reflective matcher SHALL yield exactly one outcome: a
resolved edge, or a recorded dynamic-boundary site. It SHALL NOT yield both, and it SHALL NOT
yield neither. Increasing resolution coverage SHALL therefore shrink the disclosed boundary
rather than silently removing the disclosure.

#### Scenario: A computed target resolves to nothing and stays disclosed

- **GIVEN** `getattr(handler, action)()` where `action` is a parameter
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted and a dynamic-boundary site of kind `reflective-invoke` is recorded
  for that call site

#### Scenario: An ambiguous literal is refused

- **GIVEN** `obj.send(:process)` where two internal classes declare a compatible `process` and the
  receiver's type is not statically recoverable
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted for that site and the construct is disclosed as a boundary

#### Scenario: A concatenated target is never reconstructed

- **GIVEN** `getattr(o, "get_" + name)()`
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted, no partial name is inferred, and the construct is disclosed as a
  boundary

#### Scenario: The partition is total

- **GIVEN** a fixture containing a literal and a non-literal instance of every recovered family
- **WHEN** the repository is analyzed
- **THEN** each literal instance produced an edge and no site, and each non-literal instance
  produced a site and no edge
