# Tasks — shrink-receiver-resolution-boundary

> Scoped after measurement on this repository's own graph. The direct `this.m()` / `self.m()`
> shape already resolves (521 `self_cls` edges). The shape that resolved to NOTHING — no edge, no
> `external::` leaf, and therefore nothing any conclusion could disclose — is the CHAINED receiver
> `this.<field>.m()` / `self.<field>.m()`: 261 sites in this repository alone, because the call
> queries only ever captured an `(identifier)`, `(this)` or `(super)` receiver. That is the
> boundary this change shrinks and then discloses.

## Implementation
- [x] Per-file receiver registry built during the Pass-1 walk (`receiver-registry.ts`): class field
      types from annotations, `new T()` initializers, constructor parameter properties, Python
      `__init__` annotations forwarded to a field, plus locally-declared function return types for
      a field initialized from a factory. Local variable types stay with the existing
      `type-inference-engine.ts`. No second parse — the same fail-soft query runner
      `collectClassRelationshipFacts` uses
- [x] Capture the chained receiver in the TS/JS and Python call queries, carried as
      `RawEdge.receiverField` (NOT a dotted `calleeObject`, which the import strategy would bind
      to a same-named import)
- [x] Bottom-up receiver resolution as its own strategy: type the field walking the class chain,
      then resolve the method within that one type via the existing affinity ladder; emit a
      `receiver_inferred` edge only on a unique candidate
- [x] Only emit on an unambiguous type. A field observed with two types is refused; an ambiguous
      candidate set is recorded as an ambiguous call site; a typed receiver with no such member
      emits nothing
- [x] Emit NO `external::` leaf for the residue — that would assert the callee leaves the project
- [x] Exclude chained raw edges from the CHA feed: their `calleeObject` is the bare `this`/`self`
      token, so CHA would name-bind `this.repo.save()` inside the caller's own hierarchy
- [x] `exception-flow.ts`: classify a self-rooted chained receiver as `self-field` (scoped to the
      registry languages), and disclose the unresolved residue in `analyze_error_propagation`
      under its own boundary — the callee's provenance is unknown, not merely unreached
- [x] Plumb the facts across the worker structured-clone and Pass-1 fact-cache boundaries, with a
      `FACT_FORMAT_VERSION` bump so a pre-change cached row cannot silently un-resolve a file
- [x] `language-support.ts`: `receiverResolution` capability sourced from the live
      `RECEIVER_REGISTRY_LANGUAGES`, plus `docs/language-support.md` and the standing-context table

## Verification
- [x] Resolution tests, one per declared-type source (annotation, `new T()`, parameter property,
      local factory return type, inherited field, Python `__init__`, Python in-place construction)
- [x] Boundary tests: untyped field, conflicting declarations, typed receiver without the member,
      receiver outside any class — each asserts ZERO edges, not merely no internal edge
- [x] No-false-edge test: a receiver whose name collides with an import is never bound to it
- [x] Ambiguity test: two same-named candidate types record an ambiguous site, not an edge
- [x] Capability test: every `RECEIVER_REGISTRY_LANGUAGES` member resolves a fixture; a non-member
      resolves none
- [x] Additivity: direct `self_cls` resolution unchanged; determinism across repeated builds
- [x] Full suite green

## Hardening (four adversarial review rounds)
- [x] Round 1 — soundness: an import binding for the type name is DECISIVE where present (a
      namesake elsewhere was binding); a write inside a `this`-rebinding construct, a field of an
      anonymous class expression, a `static` declaration, a plain constructor parameter, and a
      capitalized Python LOCAL FUNCTION no longer type a receiver
- [x] Round 1 — disclosure: `isSelfRootedMember` now peels `!`/parens and accepts index and call
      hops, so `this.dep!.m()`, `(this.dep).m()`, `this.map['k'].m()` and `self.get_dep().m()` are
      disclosed instead of silently absent; the boundary sentence names every refusal cause, not
      just an untypeable receiver; an ambiguous site is disclosed ONCE and renders `this.repo.save`
      rather than the non-existent `this.save`
- [x] Round 1 — scope: `#private` field receivers and Python class-body annotations now resolve;
      the capability description no longer claims other languages disclose this shape (Go records
      nothing for it — named as an open gap)
- [x] Round 1 — tests: every finding above pinned; the disclosure half (`self-field` classification
      and `untypedReceiverCalls`) pinned in `exception-flow.test.ts` and
      `error-propagation.test.ts`; `receiverFields` added to the fact-cache round-trip

## Spec
- [x] `analyzer` delta: ADD IntraObjectReceiverResolutionViaTypeRegistries,
      ResidualReceiverBoundaryStaysDisclosed, ChainedReceiverResidueIsScopedAndDeclared
