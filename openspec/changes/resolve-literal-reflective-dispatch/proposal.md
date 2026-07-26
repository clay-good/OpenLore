# Literal reflective dispatch: recover the *structurally* decidable subset, and refuse the rest loudly

> Status: PROPOSED (2026-07-25, known-limitations closure #2 of 6; **re-scoped 2026-07-25 after
> adversarial review** — the original draft proposed recovering reflective calls by literal
> *method name*, which measurement showed is unsafe on this codebase and recovers almost
> nothing once the refusal rule is honest). A reflective dispatch is recoverable when its
> target is a **symbol reference the resolver can bind structurally** — a dispatch-table value,
> a container registration, or a literal member on a typed receiver. It is *not* safely
> recoverable from a bare method-name string. This change recovers the first set as real
> provenance-labeled edges, and routes every refusal into the sibling change's disclosure so
> the residue is named rather than silently absent.

## The gap

- **Reflective dispatch through a symbol the resolver can see is dropped anyway.** A literal
  dispatch table (`const HANDLERS = { create: createUser, delete: deleteUser }` indexed at
  `HANDLERS[k]()`), a container registration paired with its resolution on the same literal
  token, and a literal member access on a receiver whose type is known are all cases where the
  callee is a *bound reference*, not a guessed name. None of them produce an edge today.
- **The cost is concentrated in the code most likely to look orphaned.** Plugin systems, job
  runners, and command dispatchers reach their targets exactly this way, so their targets are
  reported as dead-code candidates, as `also-dead` coverage gaps, and with empty blast radii.
- **The machinery is in-tree.** The dynamic-dispatch synthesis pass (`call-graph.ts:2819+`)
  already reads static literals (`staticChannelKey`, `:2893`), pairs registration sites with
  dispatch sites, caps per-site fan-out, and stamps every emitted edge `confidence:
  'synthesized'` with a `synthesizedBy` rule name. This is the same shape of work on a different
  construct.

## Why the by-name families are re-scoped out

The original draft proposed resolving `getattr(o, "run")()`, `send(:process)`, and
`call_user_func('handle')` by literal method name. Adversarial review killed it on evidence:

- **The resolver it planned to reuse does not refuse ambiguity.** `HandlerResolver`
  (`call-graph.ts:4581-4592`) returns a **same-file candidate regardless of repo-wide
  ambiguity** (`if (inFile) return inFile;`). That heuristic is defensible for event handlers,
  which are usually referenced lexically nearby; for reflection the target is typically in
  another file, so `preferFile` is pure false-positive surface.
- **Honest refusal recovers almost nothing.** Measured on this repository's own graph: **606 of
  3,073 internal symbols (20%) live under a simple name shared by ≥2 definitions**, and the
  canonical reflective verbs are the worst cases — `run` ×15, `main` ×11, `build` ×10,
  `apply` ×6, `load` ×4, `render` ×4, `execute` ×3, `start` ×3. Under a strict-uniqueness rule
  nearly every motivating call site is refused; under a relaxed rule it emits false edges into
  precisely the code the dead-code caveat exists for. Neither branch is worth shipping.
- **The narrowing that would fix it is not available where the pass runs.** Receiver-type
  narrowing needs the class hierarchy, built at Pass 7 (`call-graph.ts:4814-4820`); synthesis
  runs at Pass 2d (`:4577`). `HandlerResolver` is `(name, preferFile) => FunctionNode | undefined`
  — it carries no receiver, no type, and no class model.
- **Arity cannot rescue it.** `cha.ts:14-19` already records that a call site's argument count is
  not recoverable at these sites, which is why CHA applies no arity narrowing either.

Bare-name reflective invocation therefore stays **unrecovered and disclosed**, and this change
says so in its spec rather than leaving a future implementer to discover it. Recovering it is
gated on receiver typing — see `shrink-receiver-resolution-boundary`, which builds the per-file
type registries that would make it decidable; a follow-up proposal may revisit it *after* that
lands, with the strict-uniqueness rule below as its floor.

## What changes

**1. Three structurally-resolvable families.** Each binds a *reference*, never a name guess:

| Family | Recovered form | Why it is safe |
|---|---|---|
| Literal dispatch table | a module- or class-level literal map of literal keys → **name-bound function references**, indexed at a call site | the values are resolved in the table's own lexical scope, exactly as a direct call would be |
| Container registration ↔ resolution | `container.register('userService', UserService)` paired with `container.get('userService')`, the same literal token on both sides in one repository | the registered value is a symbol reference resolvable at the registration site |
| Literal member on a typed receiver | `obj["method"]()` where the receiver's type is statically recovered | resolution is within one type's subtree, not across a global name space |

**2. A strict-uniqueness resolver, distinct from the handler resolver.** Literal reflection gets
its own entry point: a target resolves only when the internal candidate set has **exactly one**
member after any type narrowing. The same-file preference is **not** applied — a same-file
candidate coexisting with other internal homonyms is ambiguous and refused. Reusing
`HandlerResolver` as-is is explicitly non-conforming.

**3. The partition is decided by resolution outcome, not by syntax.** This is the correction that
makes the sibling disclosure sound. The shared matcher records every recognized construct as a
**candidate** during extraction; after resolution, a candidate that produced exactly one edge is
discharged, and every candidate that did not becomes a dynamic-boundary site carrying its
refusal reason — `non-literal`, `unresolved-external`, `ambiguous`, or `over-cap`. This closes
the hole the syntactic partition left: a literal naming an **external** target
(`getattr(requests, "get")()`) previously produced neither an edge nor a site, which is the worst
possible outcome — it reads as "no dynamic dispatch here."

**4. A call must actually be a call.** An edge is emitted only when the construct is
**immediately invoked**. Obtaining a callable — bare `getattr`/`hasattr`, Ruby `method(:m)`, an
un-invoked PHP array callable, `setattr` — is a reference, not a call, and is left to disclosure.

**5. Dedup across provenance.** Edges are deduped on `(callerId, calleeId)` against the full
accumulated edge set, and the class-hierarchy pass's exclusion set is extended to cover
literal-reflection callees — because CHA's dedup map currently skips synthesized edges
(`call-graph.ts:4836`) and runs *after* synthesis, so the same dispatch would otherwise persist
twice under two labels.

**6. Determinism under incremental rebuild.** Container pairing is cross-file, and synthesis
iterates only the files it was handed — on a subset rebuild the registration site may be absent.
The rule therefore computes over the full file set or is **omitted with its sites disclosed**; a
synthesized edge set that depends on which files were in the rebuild subset is non-conforming.

**Explicitly NOT built / NOT borrowed:** reflective invocation by bare method name (re-scoped out
above, gated on receiver typing); string solving, constant propagation, or concatenated-name
reconstruction; `eval`-constructed code; framework convention magic; and **dynamic import with a
literal specifier** — import resolution completes before synthesis runs and cannot be augmented
from it, so literal specifiers belong to the import resolver and are coordinated with
`widen-import-resolution`, not claimed here. `call-graph-builtins.ts` and
`call-graph-external.ts` are **not modified**: the synthesis pass re-parses each candidate file
(`call-graph.ts:3540`) and is not subject to the Pass-1 ignore tables, so touching them would buy
nothing and would regress the shipped per-language builtins fix and the additivity guarantee.

## Why this is in scope

Call-graph recall is the substrate every conclusion inherits, and this recovers the part of
reflective dispatch that is decidable *structurally* — with no name guessing, no new confidence
tier, and no new algorithm. Equally important, it makes the sibling disclosure **total**: after
this change every recognized reflective construct is either an edge or a named refusal, so
"quietly absent" stops being a possible state.

## Impact

- **Files:** a `literal-reflection` rule module added to the synthesis rule array
  (`call-graph.ts:3951-3956` — a hardcoded list, not a plug-in registry; adding a rule means
  editing it), a per-language literal reader (`staticChannelKey`, `:2893`, is **JS/TS
  node-types only** — Ruby symbols, Python and PHP string nodes are a per-language addition, not
  an extraction), a strict-uniqueness resolver, the candidate→site discharge path shared with
  `disclose-dynamic-boundary-regions`, the CHA exclusion-set extension (`:4832-4841`),
  `language-support.ts` (closed `CAPABILITIES` union + `deriveCapabilities` + the drift and
  behavioral-faithfulness tests), `docs/reachability-dead-code.md`,
  `docs/language-support.md`, `.openlore/analysis/CODEBASE.md`'s matrix, `docs/ALGORITHMS.md`.
- **Specs:** `analyzer` — 2 ADDED (StructurallyResolvableReflectiveTargetsBecomeEdges,
  ReflectionRefusalsArePartitionedByResolutionOutcome) + 1 MODIFIED
  (SynthesizedDynamicDispatchEdges — the enumerated family list gains literal reflection, and the
  existing additivity scenario covers this change rather than being restated).
- **Tool surface:** unchanged.
- **Risk:** (a) *false edges* — mitigated by strict uniqueness, by recovering only bound
  references, and by the re-scope that removes the by-name family entirely. (b) *second-parse
  cost* — mitigated by construct-anchored pre-filters (a bare `require(` / `.send(` / `get(`
  filter would select nearly every file); a family whose filter selects more than a declared
  fraction of files is rejected rather than shipped. (c) *fan-out cap mismatch* — the inherited
  cap of 8 (`call-graph.ts:2831`) is small for real dispatch tables (20–100 entries); over-cap
  tables emit nothing **and are disclosed**, and the limitation is stated rather than hidden.
