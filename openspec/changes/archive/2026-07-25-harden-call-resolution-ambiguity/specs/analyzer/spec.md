# analyzer spec delta

## ADDED Requirements

### Requirement: NoFirstMatchBindingOnAmbiguity

The call-resolution ladder SHALL never bind a call edge by arbitrary first-match when more than one
candidate definition is viable. Every resolution strategy that resolves against a multi-candidate
symbol set — bare-name (`name_only`), Python `self.`/`cls.` method dispatch, and capitalized-receiver
(`type_name`) — SHALL either single out a unique candidate via a defined affinity ladder (own-file
containment → the file the caller imports the qualifier from → a single remaining candidate) or
record the call site as **unresolved-ambiguous**, carrying a bounded candidate list, instead of
emitting an edge. A unique candidate MAY still bind at the strategy's declared confidence.
Conclusion tools whose soundness depends on edge precision (`find_dead_code`,
`analyze_error_propagation`, `analyze_impact`, `select_tests`) SHALL disclose relevant
unresolved-ambiguous sites as boundaries rather than silently treating them as resolved or absent.

> **Overloaded names are out of scope for this requirement and tracked separately.** Same-name,
> different-arity overloads (Java/C#/Scala/C++) do not reach the resolution ladder as a multi-candidate
> set: they collapse earlier, at *node identity* — two overloads share the id `file::Class.method`, so
> only one survives in the graph and the resolution ladder sees a single candidate. Making overloads
> distinct nodes (arity-qualified identity) and resolving them by call-site argument count is a
> node-identity change with a different, larger blast radius (stable ids, the CFG side-table, symbol
> continuity, every node-count consumer) and is deferred to a dedicated follow-up. This requirement
> therefore governs the three resolution-ladder strategies that genuinely bound by first-match; the
> overload collapse is a disclosed known limitation, not a first-match guess this change introduces.

#### Scenario: An ambiguous bare cross-file call is not bound arbitrarily

- **GIVEN** a bare call `run()` whose name matches two or more function definitions in different
  files, none reachable via an import binding or same-file affinity
- **WHEN** the call graph is built
- **THEN** no `name_only` edge is emitted for that call
- **AND** the call site is recorded as unresolved-ambiguous with its candidate list (bounded, with
  the truncated count disclosed if capped)

#### Scenario: A unique cross-file candidate still binds

- **GIVEN** a bare call whose name matches exactly one cross-file definition
- **WHEN** the call graph is built
- **THEN** the edge is emitted at `name_only` confidence, as today

#### Scenario: Python self-dispatch uses the same affinity ladder as this/super

- **GIVEN** two classes with the same name in different files, each defining `process()`
- **WHEN** `self.process()` is resolved inside one of them
- **THEN** the edge binds to the method in the caller's own file, not to whichever candidate sorts
  first

#### Scenario: Dead-code confidence respects ambiguity

- **GIVEN** a function whose only potential caller is an unresolved-ambiguous site listing it as a
  candidate
- **WHEN** `find_dead_code` runs
- **THEN** the function is not reported in the highest-confidence dead tier, and the ambiguous-site
  reason is disclosed

## MODIFIED Requirements

### Requirement: CapabilityMatrixIsConformanceVerified

The per-language capability matrix surfaced by `get_language_support` (derived from the per-capability
`*_LANGUAGES` constants) SHALL be verified against the real extractors, not merely asserted. For every
language the registry claims supports `callGraph`, a committed conformance fixture SHALL drive the
actual call-graph builder and demonstrate that a realistic `caller→callee` fixture yields both
functions and the resolved edge. The conformance suite SHALL also fail if the registry adds a
`callGraph` language for which no fixture exists, so the matrix can never silently grow to over-claim.

The conformance suite SHALL additionally verify intra-class method dispatch for class-bearing
languages, the richer overlays (CFG, type inference, style fingerprint, cross-service HTTP) for each
of their claimed languages, the IaC projection for every ecosystem in `IAC_LANGUAGES`, and the
error-propagation overlay's claimed languages, and SHALL assert known cross-language *precision*
differences explicitly (e.g. import-precise versus name-only cross-file resolution) rather than
leaving them implicit. For every capability with a closed claimed-language set, the suite SHALL fail
if that set grows without a corresponding fixture, so no capability can silently over-claim.

The suite SHALL further verify **cross-file resolution for every claimed callGraph language** (not a
sample), and SHALL include **adversarial name-collision fixtures** for each first-match-prone
resolution strategy (bare cross-file call, `self`/`cls` dispatch, capitalized-receiver) asserting
that an ambiguous candidate set yields the unresolved-ambiguous disposition, never an arbitrary
first-match edge. (Overload-arity disambiguation is a node-identity concern tracked by a separate
change and is not required here.)

#### Scenario: A claimed callGraph language is proven on real code

- **GIVEN** a language the registry lists in `CALLGRAPH_LANGUAGES`
- **WHEN** the conformance suite builds the call graph from a `caller→callee` fixture in that language
- **THEN** both functions are extracted and the `caller→callee` edge is resolved
- **AND** if any claimed callGraph language has no conformance fixture, the suite fails

#### Scenario: A richer overlay is proven on each claimed language and honestly absent otherwise

- **GIVEN** one of the richer capabilities (CFG, type inference, style fingerprint, cross-service HTTP) and a language the registry claims supports it
- **WHEN** the conformance suite drives that capability's real extractor against a representative fixture
- **THEN** the capability produces a non-empty result for the claimed language
- **AND** a non-claimed language yields an empty/absent result (never a guessed signal), and any claimed language without a fixture fails the suite

#### Scenario: Every claimed IaC ecosystem projects onto graph primitives

- **GIVEN** an ecosystem in `IAC_LANGUAGES` and a minimal realistic fixture for it
- **WHEN** the conformance suite runs the real projector over the fixture
- **THEN** the fixture's resources/jobs/tasks become graph nodes, and where the ecosystem models a cross-reference a `references`/`depends_on` edge is produced
- **AND** if `IAC_LANGUAGES` grows without a fixture, the suite fails

#### Scenario: A cross-language precision difference is asserted, not hidden

- **GIVEN** a cross-file call in TypeScript versus in a name-only-resolved language (e.g. Python, Go)
- **WHEN** the conformance suite resolves each
- **THEN** the edge is found in every case
- **AND** TypeScript's provenance is asserted as import-precise while the name-only languages' lower-confidence provenance is documented explicitly

#### Scenario: Cross-file resolution is proven for every claimed language

- **GIVEN** any language in `CALLGRAPH_LANGUAGES`
- **WHEN** the conformance suite resolves a call whose callee lives in another file
- **THEN** the edge is found with the strategy and confidence expected for that language
- **AND** a claimed language without a cross-file fixture fails the suite

#### Scenario: A name-collision fixture proves the resolver refuses to guess

- **GIVEN** a fixture with two same-named cross-file definitions and a bare call to that name
- **WHEN** the conformance suite builds the call graph
- **THEN** the call yields the unresolved-ambiguous disposition with both candidates listed, and no
  arbitrary edge is emitted
