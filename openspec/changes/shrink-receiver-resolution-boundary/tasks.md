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

- [x] Round 2 — integration: the same "renders a call site the source does not contain" defect in
      `blast_radius` / `analyze_impact` (`this.save` for `this.repo.save`), which reaches
      `structural_diff`, the chat tools and `openlore review`; `SCHEMA_VERSION` 11→12 so an OLDER
      OpenLore fails honestly instead of dropping the new rows and rejecting a valid `.olbundle` as
      tampered; stale capability lists in `docs/mcp-tools.md` and `CLAUDE.md`; the CLI view type
- [x] Round 2 — soundness: an import binding is now DECISIVE (a package-imported `Client` was
      binding to an in-project namesake); a STATIC-context write no longer types the instance
      field; `super.<field>` reads the PARENT's slot; the wrapper peel reaches `as` / `satisfies` /
      `<T>` / `await`
- [x] Round 2 — dogfood: 4 external repositories (poetry, nest, typeorm, mikro-orm), 1,508 new
      edges, **0 false positives** across a 55-edge hand audit, a whole-population automated check
      and a 126/126 same-name-class disambiguation check; **0 pre-existing edges removed or
      changed**; disclosure verified on real code
- [x] Round 3 — the round-2 fixes themselves: `private static` hid the `static` keyword behind the
      accessibility modifier (a false edge); the parent walk was breadth-first, contradicting
      Python's MRO (a wrong callee); the wrapper peel was INERT because each wrapper arrives inside
      parentheses, and `type_assertion` puts its type first; the external-import marker refused
      `src/`-layout Python packages and every TS path alias (recall regressions I introduced); an
      external marker shadowed a concrete binding for the same name
- [x] Round 3 — claims: re-measured every figure with the extractor itself. The chained-site count
      was wrong (261 → **327**, against 544 direct — 38%, which is what the "roughly a third" claim
      had right); `self_cls` 521 → 522. Corrected in the proposal, the tasks and the PR body
- [x] Round 3 — declared what was refused but undeclared: generic/union/namespace-qualified
      annotations, interface-typed fields, the per-file fact cap, cross-file inherited fields, and
      the external-import refusal itself; fixed the false Ruby claim in the capability text and
      completed the five-step "add a language" checklist (two of its steps fail SILENTLY if missed)

## Spec
- [x] `analyzer` delta: ADD IntraObjectReceiverResolutionViaTypeRegistries,
      ResidualReceiverBoundaryStaysDisclosed, ChainedReceiverResidueIsScopedAndDeclared
