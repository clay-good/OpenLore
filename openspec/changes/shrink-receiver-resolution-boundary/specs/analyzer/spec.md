# analyzer spec delta

## ADDED Requirements

### Requirement: IntraObjectReceiverResolutionViaTypeRegistries

The analyzer SHALL resolve a CHAINED intra-object receiver call — `this.<field>.<method>()` /
`self.<field>.<method>()` — when a deterministic per-file type registry types the receiver
unambiguously, emitting a resolved edge with a distinct `receiver_inferred` provenance tier (below
a directly-resolved binding, above name-only).

The registry SHALL be built from DECLARED types recorded during the Pass-1 walk, with no second
parse: a field's type annotation, a `new T()` initializer, a constructor parameter property, a
Python `__init__` parameter annotation forwarded to the field, and the declared return type of a
function declared in the same file. Local variable types remain the existing receiver type
inference; this requirement adds the field and return-type dimension it lacked.

Resolution SHALL search only within the receiver's own type, never across the global name space,
and SHALL bind only a unique candidate. The enclosing class chain SHALL be walked in the language's
own attribute-lookup order (depth-first, left to right, so Python multiple inheritance is not
answered by the wrong base), so a field inherited from an ancestor declared IN THE CALLER'S OWN
FILE still types; an ancestor in another file is a MISS, not a guess, because the registry is keyed
by the caller's path. Where the caller's file carries an import binding for the type name, that binding SHALL
be decisive: only a candidate from the imported target may bind, and no such candidate SHALL be a
refusal rather than a fall-through to a same-named definition elsewhere.

A field SHALL be attributed only to the class that provably owns it. A write inside a construct
that rebinds the receiver — a TS/JS `function` expression or object-literal method, a Python `def`
nested inside another `def` — SHALL NOT be attributed to the enclosing class, a field of an
unnameable class expression SHALL NOT be attributed outward, a `static` declaration SHALL NOT type
an instance receiver, a plain constructor parameter SHALL NOT be treated as a field, and a
capitalized name the file declares as a FUNCTION SHALL NOT be treated as a type.

Supported languages SHALL be reported in the capability matrix as `receiverResolution`;
unsupported languages SHALL be disclosed there, not silently left unresolved.

#### Scenario: A field-typed receiver call resolves

- **GIVEN** a `this.repo.save()` call whose receiver type the per-file registry determines from a
  field annotation, a `new T()`, a parameter property, or a local factory's declared return type
- **WHEN** the call graph is built
- **THEN** a `receiver_inferred` edge to that type's `save` is emitted, raising recall without a
  guessed binding

#### Scenario: An inherited field types the receiver

- **GIVEN** a `this.repo.save()` call in a subclass whose `repo` field is declared on an ancestor
  in the same file
- **WHEN** the call graph is built
- **THEN** the class chain is walked and the edge is emitted, exactly as for an own-class field

### Requirement: ResidualReceiverBoundaryStaysDisclosed

A receiver the type registry cannot type unambiguously SHALL remain a disclosed boundary. The
resolution step SHALL NOT emit a guessed edge, SHALL NOT emit an `external::` leaf (which would
assert the callee leaves the project), and SHALL NOT let a chained receiver reach any resolution
strategy that keys off the bare receiver token or the last dotted qualifier — including
class-hierarchy analysis, which would otherwise name-bind `this.repo.save()` inside the CALLER's
own hierarchy.

A field observed with two conflicting declared types SHALL be refused rather than resolved to
either. An ambiguous candidate set after typing SHALL be recorded as an ambiguous call site, never
bound.

`analyze_error_propagation` SHALL disclose the residual chained intra-object call sites under
their own boundary — distinct from the unresolved-intra-object boundary, because the callee's
provenance is unknown rather than merely unreached — and SHALL NOT treat them as exception-free.

#### Scenario: An untypeable receiver is disclosed, not guessed

- **GIVEN** an intra-object call whose receiver type the registry cannot determine unambiguously
- **WHEN** the call graph is built
- **THEN** no edge of any kind is emitted for it, and `analyze_error_propagation` reports it as a
  chained-receiver boundary whose callee's exceptions are out of scope

#### Scenario: An import binding overrules a same-named definition elsewhere

- **GIVEN** a field typed `Client`, where the caller's file imports `Client` from one module and
  an unrelated `Client` carrying the called method exists elsewhere in the repository
- **WHEN** the call graph is built
- **THEN** no edge is emitted — the import binding decides, and the namesake is never bound

#### Scenario: A conflicting field declaration refuses

- **GIVEN** a field declared with one type and assigned a different type elsewhere in the file
- **WHEN** the call graph is built
- **THEN** the registry refuses that field, and the call site stays unresolved and disclosed

### Requirement: ChainedReceiverResidueIsScopedAndDeclared

Recovery SHALL be confined to a single field hop on a receiver rooted at the enclosing object. A
deeper chain, a computed or indexed receiver, a receiver obtained from a call, and a callee dropped
by the language's builtin-noise filter SHALL NOT be bound — and SHALL still be classified as
chained intra-object call sites so the disclosure covers them. A type name that does not follow the
capitalized-class convention SHALL NOT type a field.

Every remaining refusal SHALL be declared rather than left as a silent recall gap. The registry
reads a PLAIN declared type name only, so a generic (`Map<K, V>`, `Repo<T>`), a union or optional
annotation, and a namespace-qualified type (`pg.Client`) do not type a field. A field typed by an
INTERFACE binds to that interface's member, which has no body — the call reaches the declaration,
not the implementation, and the existing `overrides` edges carry it onward. Per-file facts SHALL be
capped, and the overflow is a recall loss, never an incorrect binding.

A name the caller's file imports from a specifier that resolves to no in-project file SHALL be
REFUSED rather than bound to a repository-wide namesake — the source has stated the type is not
from here. A specifier that is merely unfollowable (a path alias, an absolute intra-project module
that matches a project file) SHALL NOT be treated as external, because the source stated no such
thing. A concrete import binding for the same name SHALL win over an unresolvable one.

The disclosure covers receivers rooted at the enclosing object. A receiver rooted at a CLASS NAME
instead — `Holder.shared.work()`, a static field on another class — is out of scope and remains
both unbound and undisclosed, exactly as before this change; it SHALL NOT be claimed as covered.
The disclosure is served by `analyze_error_propagation` alone: other conclusion tools see the
residue as an absent edge, as they did before.

#### Scenario: A class-name static-field receiver stays out of scope

- **GIVEN** a `Holder.shared.work()` call, whose receiver is a static field on another class
- **WHEN** the call graph is built
- **THEN** no edge is emitted and no chained-receiver boundary is reported — the shape is declared
  out of scope rather than described as covered

#### Scenario: An unread shape is disclosed rather than omitted

- **GIVEN** a `this.a.b.m()`, a `this.map['k'].m()`, a `this.dep!.m()` or a `self.get_dep().m()`
- **WHEN** the call graph is built and `analyze_error_propagation` runs over the caller
- **THEN** no edge is emitted for it, and the site is reported under the chained-receiver boundary
  rather than being absent from the result

#### Scenario: A package-imported type is refused, an alias is not

- **GIVEN** a field typed `Client` where the caller's file writes `import { Client } from 'pg'`,
  and an unrelated in-project `Client` declares the called method
- **WHEN** the call graph is built
- **THEN** no edge is emitted — but the same shape written `from '@/repo'` or, in Python,
  `from myapp.models import Repo` against a matching project file still resolves
