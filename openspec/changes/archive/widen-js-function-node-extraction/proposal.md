# Widen JS/TS function-node extraction to member-assigned and `var`-bound functions

> Status: IMPLEMENTED (2026-06-18). Decisions `d8b81a9b` + `efcd981c`. Three `TS_FN_QUERY` clauses
> (`assignment_expression`, `variable_declaration`, `public_field_definition`) + whitespace-safe
> member naming in `src/core/analyzer/call-graph.ts`; tests in `call-graph.test.ts`; spec delta in
> `specs/analyzer/spec.md`. Real-corpus dogfood in `../DOGFOOD-widen-js.md`. See `tasks.md`.
> Originally filed from the `add-synthesized-dynamic-dispatch-edges` real-corpus dogfood (PR #155,
> 2026-06-17).
> One sentence: **index `obj.prop = function(){}`, `exports.x = function(){}`,
> `X.prototype.y = function(){}`, `var f = function(){}`, and `class C { handler = () => {} }` as
> function nodes so the call graph stops going blind on idiomatic pre-class / CommonJS JavaScript and
> modern class-field handlers.**
>
> **Outcome (measured):** Express 5.2.1 `lib/application.js` went from ~2 to **18** indexed nodes
> (`app.use`, `app.handle`, `app.set`, `app.listen`, …); `lib/response.js` to **29** (`res.send`,
> `res.json`, `res.cookie`, …). Calls out of those methods (e.g. `app.render → tryRender`,
> `res.sendFile → sendfile`) now resolve. `exports.x = require(...)` re-exports stay correctly
> excluded. The Django-admin `$.fn.djangoAdminSelect2 = function(){}` plugin handler is now indexed.
> Class-field arrow handlers resolve too: a React `Counter` component's `increment`/`decrement`/
> `persist`/`reset` fields are indexed under `Counter` with their outward edges resolving (real mobx
> `src/`: 144 clean class-member nodes, no explosion).

## Why

The TypeScript/JavaScript function extractor (`TS_FN_QUERY`, `src/core/analyzer/call-graph.ts:984`)
matches only four node shapes: `function_declaration`, exported `function_declaration`, ES6
`method_definition`, and `lexical_declaration` (`const`/`let`) bound to an arrow/function expression.
It has **no** clause for:

- `assignment_expression` with a member or identifier LHS and a function RHS —
  `app.use = function use(){}`, `exports.handler = function(){}`, `Foo.prototype.bar = function(){}`.
- `variable_declaration` (`var`) bound to a function — `var f = function f(){}`.
- `public_field_definition` bound to a function — `class C { handler = () => {} }`, the dominant
  modern class-field handler idiom (added as follow-up `efcd981c`).

These are the dominant method idioms in pre-class / CommonJS / ES5 JavaScript. Dogfooding the
synthesized-dynamic-dispatch feature surfaced the cost on real code:

- **Express 5 `lib/`** — every method is `app.X = function X(){}` / `res.Y = function Y(){}`; only the
  two plain `function` declarations in the package were extracted (≈2 of 117 candidate nodes in
  `application.js`). The call graph — and therefore reachability, impact, dead-code, and the event /
  callback synthesis rules — has almost no nodes to work with on such files.
- **Django admin JS** — an event handler defined as a jQuery plugin
  `$.fn.djangoAdminSelect2 = function(){}` is not indexed, so the `formset:added` event channel
  resolved only 1 of its 2 real handlers (asymmetric fan-out).

This is upstream of the dispatch-synthesis rules; they are correct on the nodes they are given but are
starved of input here. It is a general call-graph completeness gap, not a synthesis bug, which is why
it was deliberately **not** bundled into the synthesis close-out.

## What would change

1. Add three clauses to `TS_FN_QUERY`: an `assignment_expression` whose left is a `member_expression`
   (or identifier) and whose right is a `function_expression`/`arrow_function`, capturing the
   member/identifier as the name; a `variable_declaration` arm alongside the existing
   `lexical_declaration` one; and a `public_field_definition` arm whose value is a function/arrow,
   capturing the property identifier as the name (follow-up `efcd981c`).
2. Derive a stable, readable node name for member assignments (`app.use`, `Foo.prototype.bar`,
   `exports.handler`) consistent with how existing nodes are named and identified. Class-field
   functions are named by their bare property and associated with the enclosing class
   (`Counter.increment`), exactly as `method_definition` members are.

## What does NOT change / scope & risk

- **Blast radius is the whole analyzer, not just synthesis.** Widening the node set changes
  `fanIn`/`fanOut`, hub/god/entry-point classification, dead-code candidates, duplicate detection, and
  every traversal tool. It must reuse the same structural-metric isolation discipline the synthesis
  set already established, and be adversarially reviewed for: duplicate/oversized node counts,
  `exports.x = require(...)` (not a function — must not match), re-assignments of the same member, and
  identity/stableId collisions for member-named nodes.
- No LLM; purely tree-sitter query + naming. Deterministic, on-mission.

## Verification sketch

- Unit: each new shape extracts exactly one node with the right name; `exports.x = require('y')` and
  `obj.prop = 42` extract nothing.
- E2e: re-analyze Express 5 `lib/` and confirm `app.*`/`res.*` methods appear as nodes and the
  event-channel `mount` edge (`app.use → defaultConfiguration`'s `onmount`) synthesizes; re-analyze
  Django admin JS and confirm the `formset:added` fan-out reaches both handlers.
- Guard: structural-metric isolation invariant (synthesized edges already excluded) still holds, and
  hub/dead-code outputs are reviewed for the new nodes rather than silently shifted.
