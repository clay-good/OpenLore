# Resolve `this.method()` / `super.method()` calls in the call graph

> Status: IMPLEMENTED (2026-06-26, branch `feat/error-propagation-graph`, folded into PR #213).
> `npm run build` clean; `vitest run src examples` green (273 files / 5369 tests). Dogfooded e2e on
> the OpenLore repo + crafted corpora.

## Why

The call graph is the substrate every edge-traversing tool stands on — `analyze_impact`,
`select_tests`, `find_dead_code`, `find_path`, `blast_radius`, and (the motivating case here)
`analyze_error_propagation`. It had a silent, pervasive hole: a `this.method()` call produced **no
edge at all** — not a resolved edge, not even an `external::` leaf.

Root cause: the TypeScript/JavaScript call query matched only `member_expression object: (identifier)`.
A `this`/`super` receiver is its own grammar node (`this` / `super`), not an `identifier`, so the
call was never captured. Every tool that walks edges was therefore blind to intra-object dispatch —
a class method calling a sibling via `this.sibling()` looked like it called nothing. On a class-heavy
repo this is a large fraction of the real call structure (e.g. every `Logger.warning()` →
`this.log()` edge was missing).

This surfaced concretely while hardening `analyze_error_propagation`: an exception thrown by
`this.sibling()` was reported as `escapes: 0` — a silent claim of exception-freedom. That tool was
given a disclosure (`unresolvedSelfCalls`) as a stopgap; this change fixes the gap at the source, so
the disclosure now fires only for the genuinely-unresolvable residue.

## What

Resolve `this.method()` and `super.method()` to indexed methods in the call graph (TypeScript /
JavaScript; Python `self.`/`cls.` already resolved). Deterministic, no LLM, no new artifact.

1. **Capture** — extend `TS_CALL_QUERY` with `member_expression` arms for `object: (this)` and
   `object: (super)`. The receiver text (`"this"` / `"super"`) flows through the existing
   `calleeObject` field.
2. **Resolve (Strategy 1a)** — `this.m()` binds to method `m` on the caller's enclosing class, then
   walks `extends` ancestors transitively (cycle-guarded) for inherited methods; `super.m()` skips
   the caller's own class and resolves against its parents (a super call never targets the caller's
   own class). Confidence `self_cls`. Class relationships are computed once before the resolution loop
   and reused by the later hierarchy pass.
3. **File affinity (soundness)** — `findByQualifiedName(Class, method)` keys on `Class.method` with no
   file dimension. When two files declare a same-named class, prefer a candidate in the caller's OWN
   file (the same-class / same-file family), then the file the caller imports the class from
   (cross-file parent). A single candidate is unambiguous; an ambiguous match with no affinity is
   SKIPPED, never guessed — so the change never mints a false cross-file edge.
4. **Receiver-aware noise filter** — the name-only ignore-list (which suppresses `arr.map()` /
   `JSON.parse()` noise) is bypassed for `this`/`super`/`self`/`cls` receivers, so a class method
   named like a builtin (`parse`, `map`, `filter`, `resolve`, …) still resolves instead of being
   dropped before resolution.
5. **No junk leaves** — an unresolved `this`/`super` call is dropped, not turned into a meaningless
   `external::this.m` node (which would also mask `analyze_error_propagation`'s targeted disclosure).

## Soundness / non-goals

- Additive and provenance-labeled (`self_cls`); the committed TS regression snapshot changes only by
  ADDING the two previously-missing `this.` edges — nothing removed or re-pointed.
- Scope is TS/JS (plus the already-working Python `self.`/`cls.`). Other languages are unaffected.
- Nested-scope guard (adversarial round): a function nested inside a class method — an object-literal
  method shorthand, a nested `function`, a callback — used to inherit the enclosing class name (a
  pre-existing extraction quirk), so its `this.x()` would resolve to a FALSE `self_cls` edge. The
  className walk now STOPS at an object-literal / function / method boundary before the class, so such
  a node carries no class name and produces no false edge. A direct method/field has only `class_body`
  between it and `class_declaration`, so it is unaffected. On the OpenLore repo this removed 18 false
  edges (self_cls 433 → 415) with every genuine intra-object edge preserved and the full suite green.
- Class EXPRESSION support (enhancement round): the className walk now also handles a `class`
  expression — `const K = class { … }` takes the binding name `K`, `X = class { … }` takes the LHS,
  and a named expression `class Named { … }` keeps its own name — so methods of a class expression
  resolve their `this.m()` calls like any class method. Previously this was a safe miss; now it is
  resolved.

## Deliberately deferred: unique identity for nested functions

A sibling idea — give same-named NESTED functions (a `function helper(){}` inside one method and
another inside a second method, or a nested one colliding with a top-level same-named function)
distinct node ids instead of collapsing them at id-keyed aggregation — was implemented and then
**reverted** after testing. It is NOT a small change: it conflicts with the analyzer's deliberate,
documented collapse-on-collision behavior and its stable-identity model.

- Several collapses are INTENTIONAL and pinned by tests: a re-assigned member (`obj.fn = …; obj.fn =
  …`) is meant to be one node; a same-file container homonym (`namespace A { class C { m } }` vs
  `namespace B { class C { m } }`) is a documented completeness limit ("not a wrong resolution").
  Narrowing the dedup to only byte-contained (genuinely nested) functions preserved those, but still
  broke ~30 tests across `structural-diff`, `impact-certificate`, `stable-id`, `scip-export`,
  `cross-service-topology`, and anchoring.
- The breakage is fundamental, not cosmetic: those subsystems require identity to be STABLE across
  edits, and a positional discriminator (`name@byteOffset`) shifts whenever code above changes — a
  nested function would read as removed+added on every diff. A stable discriminator (e.g.
  `enclosingFn.nested`) is a much larger per-extractor change that ripples through stable-id / scip /
  structural-diff / anchoring.

Conclusion: the nested-function collision is rare and pre-existing, and resolving it correctly is its
own dedicated change with a stable-identity design — out of scope here. It is recorded as a known
limitation rather than folded into this PR.
