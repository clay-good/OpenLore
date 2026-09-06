# Shrink the intra-object receiver boundary with deterministic per-file type registries

> Status: PROPOSED (2026-07-03, e2e audit pass 4) — **re-scoped 2026-09-06 after measuring this
> repository's own graph.** The original draft aimed at `this.helper()`, assuming it was the
> unresolved shape. It is not: direct intra-object calls already resolve through the class chain
> (521 `self_cls` edges here). The shape that resolves to *nothing* is the CHAINED receiver.

## The gap

`this.<field>.<method>()` / `self.<field>.<method>()` produces **no edge of any kind**. The call
queries only ever captured an `(identifier)`, `(this)` or `(super)` receiver, and a chained
receiver is a nested member expression, so it matched no alternative: no resolved edge, no
`external::` leaf, and — because `exception-flow.ts` classified it `other`, a kind documented as
"resolves to an internal edge or an `external::obj.x` edge" — nothing any conclusion could
disclose either. It is the last call shape that was silently absent rather than honestly unknown.

It is not rare. On this repository: **261 chained intra-object call sites**, roughly a third of all
intra-object calls, concentrated exactly where dependencies are held as fields (`this.store.…`,
`this.logger.…`, `this.spinner.…`). Every one of them widened `analyze_error_propagation`'s escape
set silently, and left the field's type looking uncalled.

## What changes

1. **A per-file receiver registry, built during the Pass-1 walk.** `Class.field → Type` from
   DECLARED types only: a field's type annotation, a `new T()` initializer, a constructor parameter
   property, a Python `__init__` annotation forwarded to the field, and the declared return type of
   a function declared in the same file (for `this.repo = makeRepo()`). No second parse — the same
   fail-soft query runner the inheritance collector already uses. Local *variable* types stay where
   they are, in `type-inference-engine.ts`; this adds the field and return-type dimension it lacked.
2. **Bottom-up receiver resolution as its own strategy.** Type the field (walking the class chain,
   so an inherited field still types), then resolve the method **within that one type** through the
   existing affinity ladder. A unique candidate becomes a `receiver_inferred` edge — a distinct
   provenance tier, below a directly-resolved binding and above name-only, so downstream tools can
   weigh it.
3. **The residue is disclosed, never papered over.** An untypeable field, a field observed with two
   conflicting types, an ambiguous candidate set, or a typed receiver with no such member emits
   **nothing** — not a guessed edge, and deliberately not an `external::` leaf, which would assert
   the callee leaves the project. `exception-flow.ts` gains a `self-field` receiver kind and
   `analyze_error_propagation` discloses those sites under their own boundary, distinct from the
   unresolved-intra-object one: here the callee's *provenance* is unknown, not merely unreached.

**Explicitly NOT built:** flow-sensitive or cross-file type inference; typing a field from its
usage; reassignment analysis; imported-factory return types (unreadable from this tree); and
non-registry languages, which keep today's behaviour and are reported unsupported in the matrix
rather than quietly unresolved.

## Why this is in scope

Call-graph recall is the substrate every conclusion inherits, and this is the one remaining call
shape that was *silent* rather than disclosed. The technique is deterministic, local, and needs no
LSP or type checker — the same posture as the rest of the analyzer.

## Impact

- **Files:** `receiver-registry.ts` (new), the TS/JS and Python call queries and their extractors,
  the Pass-2 resolution ladder and the CHA feed (`call-graph.ts`), `RawEdge`/`EdgeConfidence`/
  `AmbiguousStrategy` and the call-distance costs (`call-graph-types.ts`), the Pass-1 fact cache
  (`FACT_FORMAT_VERSION` bump, so a pre-change cached row cannot silently un-resolve a file),
  `exception-flow.ts`, `error-propagation.ts`, `language-support.ts`, `docs/language-support.md`,
  `docs/mcp-tools.md`.
- **Specs:** `analyzer` — 2 ADDED (IntraObjectReceiverResolutionViaTypeRegistries,
  ResidualReceiverBoundaryStaysDisclosed).
- **Tool surface:** unchanged.
- **Risk:** a wrong receiver type produces a wrong edge. Mitigated by binding only DECLARED types,
  by refusing a field with conflicting declarations, by searching within one type rather than the
  global name space, by requiring a unique candidate, and by keeping the chained shape out of every
  strategy that keys off the bare receiver token — including CHA, which would otherwise name-bind
  `this.repo.save()` inside the caller's own hierarchy.
