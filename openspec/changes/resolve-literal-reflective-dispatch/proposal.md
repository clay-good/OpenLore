# Literal reflective dispatch: recover the structurally provable subset, and refuse the rest loudly

> Status: BUILT (2026-09-12). Scope as shipped: **literal dispatch tables in JavaScript/TypeScript**.
> Everything else this proposal once considered is re-scoped out on evidence, below.

## The gap

Plugin systems, job runners, and command dispatchers reach their targets through a literal table —
`const HANDLERS = { create: createUser, remove: deleteUser }` indexed at `HANDLERS[k]()`. The callee
is a bound reference, not a guessed name, yet the call graph drew no edge, so every target read as a
dead-code candidate, an `also-dead` coverage gap, and a symbol with an empty blast radius. The sibling
change `disclose-dynamic-boundary-regions` already records the construct as a dynamic-boundary site;
this change recovers the part that is provable and keeps the rest disclosed.

## What changes

1. **One recovered family: a stable literal dispatch table** (JS/TS). The table is a module-private
   `const` object whose name is used only in its declaration, a type query, or as the receiver of an
   immediately invoked subscript, in a file that evaluates no code. Each entry binds by the span of
   its same-file module-level declaration (never by name). A variable key binds every entry or none
   and none over the existing synthesis fan-out cap; a literal key binds its own entry.
2. **Partition by resolution outcome, keyed on the construct.** Bound candidates stop being sites;
   everything else stays a site with its refusal reason. New reasons: `over-cap`,
   `unattributed-caller`, and `synthesized-binding` (strict-mode only).
3. **Strict mode and incremental builds never lose the disclosure.** Bound constructs are persisted
   in a separate list that directly-resolved-only conclusions fold back in as sites; a subset rebuild
   binds nothing; the watcher re-derives the boundary record of every caller file it rebuilds.
4. **Provenance.** Edges are `synthesized` / `literal-reflective`, deduped against every existing
   pair and excluded from CHA; a `literalReflection` capability is derived from the matcher table.

## Deliberately NOT built

| Family | Why |
|---|---|
| Bare-name reflection (`getattr(o, "m")()`, `send(:m)`, `call_user_func`) | 20% of this repo's symbols share a simple name; strict uniqueness refuses nearly every case and a relaxed rule emits false edges |
| Literal member on a self-typed receiver (`this["m"]()`, `getattr(self, "m")()`) | Built, then removed after two adversarial review rounds: the class graph omits members added by assignment, mixins, `attr_*`, `alias`, and subclasses whose parent never resolved, so no uniqueness check over it is sound |
| DI container registration ↔ resolution | A resolution call returns an instance; the call-form rule leaves it no call edge |
| Python module dicts | Any importer can rebind or mutate a module attribute |
| String solving, constant propagation, `eval`-built code, literal dynamic imports | Out of the structural subset; dynamic imports belong to the import resolver |

## Evidence

Dogfood on four repositories (this one, pallets/click, rack/rack, rails/thor): zero change to any
non-synthesized edge, byte-identical artifacts across two runs, no measurable analyze-time cost, and
the budgets and equivalence lanes green. Real code there contained no qualifying table, so recovery
is exercised by the unit fixtures in `literal-reflection.test.ts`.

## Impact

- **Files:** `literal-reflection.ts` (new, Pass 7a), `dynamic-boundary.ts` (table facts, bound list,
  vocabulary), `call-graph.ts`, `dynamic-boundary-disclosure.ts` (strict fold, tolerant reader),
  strict-mode consumers, `mcp-watcher.ts`, `language-support.ts`, docs.
- **Specs:** `analyzer` — 2 ADDED, 1 MODIFIED (`DynamicBoundaryVocabularyIsClosedAndGroundedInSyntax`).
- **Tool surface:** unchanged.
