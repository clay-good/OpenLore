# Shrink the intra-object receiver boundary with deterministic per-file type registries

> Status: PROPOSED (2026-07-03, e2e audit pass 4) — **re-scoped 2026-09-06 after measuring this
> repository's own graph.** The original draft aimed at `this.helper()`, assuming it was the
> unresolved shape. It is not: direct intra-object calls already resolve through the class chain
> (522 `self_cls` edges here). The shape that resolves to *nothing* is the CHAINED receiver.

## The gap

`this.<field>.<method>()` / `self.<field>.<method>()` produces **no edge of any kind**. The call
queries only ever captured an `(identifier)`, `(this)` or `(super)` receiver, and a chained
receiver is a nested member expression, so it matched no alternative: no resolved edge, no
`external::` leaf, and — because `exception-flow.ts` classified it `other`, a kind documented as
"resolves to an internal edge or an `external::obj.x` edge" — nothing any conclusion could
disclose either. It is the last call shape that was silently absent rather than honestly unknown.

It is not rare. Counted with the extractor itself over this repository's `src/`: **327 chained
intra-object call sites against 544 direct ones — 38% of all intra-object calls**, concentrated
exactly where dependencies are held as fields (`this.store.…`, `this.logger.…`, `this.spinner.…`).
Every one of them widened `analyze_error_propagation`'s escape set silently, and left the field's
type looking uncalled.

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
usage; reassignment analysis; imported-factory return types (unreadable from this tree); deeper
chains (`this.a.b.m()`), computed receivers (`this.map['k'].m()`) and receivers obtained from a
call (`self.get_dep().m()`), all of which stay disclosed rather than bound; callees dropped by the
language's builtin-noise filter; and non-registry languages, which keep today's behaviour. Go is
named as an open gap: its call query captures no chained receiver at all, so it records nothing for
the shape — the capability matrix says so rather than implying every other language discloses it.

## Measured on real code

Four external repositories, `analyze --force` with both builds, full edge-row diff:

| repo | files | new `receiver_inferred` | pre-existing edges removed or changed |
|---|---:|---:|---:|
| python-poetry/poetry (Python) | 447 | 29 | 0 |
| nestjs/nest (TS) | 1,835 | 530 | 0 |
| typeorm/typeorm (TS) | 3,596 | 530 | 0 |
| mikro-orm/mikro-orm (TS) | ~3,900 | 419 | 0 |

**Zero false positives.** 55 edges hand-verified against source; a whole-population automated
check over all 1,508 new edges; and for every edge whose callee class name is duplicated in the
repository, the binding was checked against the caller's own import — 126 of 126 correct in
`nest` alone. No new edge points at an external, synthetic or dangling node.

The disclosure side works on real code too: `insert::ClosureSubjectExecutor.ts` in typeorm reports
16 chained-receiver boundary sites where `main` reports none, including
`this.queryRunner.dataSource.driver.escape(...)` — a three-level chain the resolver deliberately
does not read, disclosed rather than guessed.

**A second-order effect worth naming:** in `mikro-orm`, one call site gained 6 imprecise
`cha-name-only` edges the branch did not create. `EntityLoader.findChildren`'s `children.find(…)`
is an `Array.prototype.find` that CHA fans out over every `find` in the repository; `main` drops
that fan-out whole because it exceeds `CHA_FANOUT_CAP`. Two of those candidates are now directly
resolved elsewhere and filtered out, pushing the site *under* the cap so the remainder are emitted.
The imprecision is pre-existing and honestly labelled `synthesized` — this change only alters which
sites the cap happens to hide. Left alone deliberately: suppressing it would mean re-tuning CHA's
cap semantics, which is a different change.

## Decisions to record

Two choices here set precedent beyond this change and should be captured as ADRs through
`openlore decisions --consolidate` when a provider key is available (the consolidation path
requires an LLM, so this change could not record them itself — they are written out here so the
reasoning is not lost):

1. **A new `EdgeConfidence` tier, `receiver_inferred`, at cost 2.** It sits with `type_inference`
   and `type_name`: a DECLARED field type is strong evidence, but still one inference removed from
   resolving the callee's own qualified name. Everything that enumerates confidences now derives
   the set from `CALL_DISTANCE_COSTS`, so adding a tier can no longer silently bypass a validator.
2. **An import binding is decisive, and a name from an unresolvable specifier is refused.** This
   contradicts the last rung of the pre-existing affinity ladder (bind a single repository-wide
   definition) wherever the source has said where the name comes from. It will govern future
   resolution strategies, and it is why `SCHEMA_VERSION` moved.

## Why this is in scope

Call-graph recall is the substrate every conclusion inherits, and this is the one remaining call
shape that was *silent* rather than disclosed. The technique is deterministic, local, and needs no
LSP or type checker — the same posture as the rest of the analyzer.

## Impact

- **Files:** `receiver-registry.ts` (new), the TS/JS and Python call queries and their extractors,
  the Pass-2 resolution ladder and the CHA feed (`call-graph.ts`), `RawEdge`/`EdgeConfidence`/
  `AmbiguousStrategy`/`EDGE_CONFIDENCE_VALUES` and the call-distance costs (`call-graph-types.ts`),
  the Pass-1 fact cache (`FACT_FORMAT_VERSION` 6→7, so a pre-change cached row cannot silently
  un-resolve a file), `import-resolver-bridge.ts` (the unresolvable-specifier marker),
  `exception-flow.ts`, `error-propagation.ts`, `language-support.ts`, and the three runtime
  validators whose hand-written confidence sets are now derived (`edge-store.ts`, `graph.ts`,
  `analysis.ts`), plus `edit-verdict.ts` (a comment), `cli/commands/error-propagation.ts` (a view
  type), `docs/language-support.md`, `docs/mcp-tools.md`, `CLAUDE.md`.
- **`SCHEMA_VERSION` 11 → 12 — a one-time rebuild for every existing database.** `edges.confidence`
  is unconstrained TEXT, so without the bump a NEWER database opened by an OLDER OpenLore would
  pass the version gate and then have every `receiver_inferred` row dropped by that build's own
  validator, and an `.olbundle` import would recompute its digest through that same dropping reader
  and reject a valid bundle as *tampered*. The bump turns both into the honest `schema-mismatch`
  rebuild path. This is the highest-impact consequence of the change and is recorded in an ADR.
- **Specs:** `analyzer` — 3 ADDED (IntraObjectReceiverResolutionViaTypeRegistries,
  ResidualReceiverBoundaryStaysDisclosed, ChainedReceiverResidueIsScopedAndDeclared).
- **Tool surface:** no tool added or removed. `analyze_error_propagation`'s RESPONSE shape gains
  `summary.untypedReceiverCalls` and an optional top-level `untypedReceiverCalls` block — additive,
  but consumers read that shape.
- **Risk:** a wrong receiver type produces a wrong edge. Mitigated by binding only DECLARED types,
  by treating an import binding for the type name as DECISIVE where one exists, by attributing a
  field only to the class that provably owns it (no `this`-rebinding construct, no unnameable class
  expression, no `static` slot, no plain constructor parameter, no capitalized local function), by
  refusing a field with conflicting declarations, by searching within one type rather than the
  global name space, by requiring a unique candidate, and by keeping the chained shape out of every
  strategy that keys off the bare receiver token — including CHA, which would otherwise name-bind
  `this.repo.save()` inside the caller's own hierarchy. The one inference that remains is binding a
  single repository-wide definition when no import binding exists — the same unique-name step the
  rest of the ladder already makes, and unavoidable because Python's absolute intra-project imports
  resolve to nothing.
