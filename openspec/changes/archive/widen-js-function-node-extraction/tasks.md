# Tasks — Widen JS/TS function-node extraction

> Status: IMPLEMENTED (2026-06-18). Decision `d8b81a9b` recorded before code. Deterministic,
> no LLM, no new deps. Additive: the new shapes only add nodes; existing shapes are unchanged.

## 1. Extraction query
- [x] Add a `variable_declaration` arm to `TS_FN_QUERY` mirroring the existing `lexical_declaration`
      arm (binds `var f = function|arrow`).
- [x] Add an `assignment_expression` arm with `left: [(identifier) (member_expression)]` and
      `right: [(arrow_function) (function_expression)]` so `obj.prop = fn`, `exports.x = fn`,
      `X.prototype.y = fn`, and `f = fn` are captured. RHS constrained to function/arrow so
      `exports.x = require(...)`, `obj.prop = 42`, and object literals never match.
- [x] Add a `public_field_definition` arm with `name: (property_identifier)` and
      `value: [(arrow_function) (function_expression)]` so class-field arrows/functions
      (`class C { handler = () => {} }`, the dominant modern handler idiom) are captured. Decision
      `efcd981c` (extends `d8b81a9b`).

## 2. Naming & identity
- [x] Name member-assigned nodes by the full dotted LHS text (`app.use`, `Foo.prototype.bar`),
      collapsing incidental whitespace (LHS split across lines) so name/id/stableId stay stable.
- [x] Name class-field functions by their bare property identifier (`handler`) and associate them with
      the enclosing class via the existing className walk (id `File::Class.handler`) — identical to
      `method_definition`. Private (`#`) fields stay unindexed, mirroring `method_definition`.
- [x] Verify dotted names are backtick-escaped by `stableSymbolId` (the `.` is outside the SCIP
      simple-identifier set) and that re-assignment collapses via the existing id-keyed last-wins
      `allNodes.set(id, …)` (no duplicate explosion).

## 3. Tests (unit)
- [x] One node per new shape with the right name: `exports.handler`, `app.use`/`app.lazyrouter`,
      `View.prototype.render`, bare `f = function`, `var parse`/`var format`, member arrow.
- [x] Edge resolves through a member-assigned function (`exports.handler → helper`,
      `app.use → app.lazyrouter`).
- [x] Negatives: `require(...)`, number, object-literal RHS extract nothing; re-assignment → 1 node;
      member node carries an escaped `stableId`.
- [x] Class-field arms: `class C { handler = () => {} }` → `C.handler` with the enclosing className;
      edge resolves out of a class-field arrow; class-field function expression + type-annotated field
      arrow both indexed; non-function fields (number/object/string) extract nothing.

## 4. Regression & adversarial review
- [x] Full `vitest run src` green (185 files, 3872 passed / 2 skipped), `typecheck` + `eslint` clean.
- [x] Adversarial fixture: computed-member `obj[key] = fn` and augmented `obj.x ||= fn` are NOT
      indexed; a chained `exports.a = exports.b = fn` indexes only the inner `exports.b`.
- [x] Node-explosion check: re-analyzed this repo's `src/` (1979 internal nodes) — no explosion, no
      malformed member names introduced (the only space-bearing names are pre-existing Ansible
      fixtures).

## 5. Real-input dogfood (see DOGFOOD-widen-js.md)
- [x] Express 5.2.1 `lib/` (real npm tarball): `application.js` 18 nodes (was ~2), `response.js` 29 —
      `app.*`/`res.*` members indexed; `app.render → tryRender`, `res.sendFile → sendfile` resolve;
      `express.js` `exports.x = require(...)` re-exports correctly excluded.
- [x] Django-admin jQuery-plugin idiom: `$.fn.djangoAdminSelect2 = function(){}` now indexed (the
      handler `formset:added` event synthesis was previously starved of).

## 6. Docs & spec
- [x] Spec delta `specs/analyzer/spec.md` (this change) + new requirement merged into
      `openspec/specs/analyzer/spec.md` (`TypeScriptFunctionNodeExtractionShapes`).
- [x] Proposal status flipped DRAFT → IMPLEMENTED with dogfood evidence.

## Known limitations (out of scope, documented)
- Arity/`signatureShape` may be empty for named/anonymous function-expression assignments whose inner
  name differs from the assigned member (`app.use = function use(...)`); the `stableId` stays valid,
  just less precise. Member-assigned **arrows** get full arity.
- `async` is now read from the captured arrow/function-expression RHS (`@fn.value`), not from the
  enclosing assignment/declaration/field text. `exports.h = async function(){}`, `x = async () => {}`,
  `var load = async () => {}`, and the pre-existing `const f = async () => {}` arm all set `isAsync`
  correctly. Plain `async function`/`async` method declarations (no value capture) still read `fnNode`.
- `this.x = fn` inside a class body associates with the enclosing class name.
- Object-literal `pair` values (`{ prop: function(){} }`) remain out of scope; only assignment,
  `var`/`const`/`let` bindings, and class-field arrow/function members are added.
- Distinct functions in one file that derive the same `filePath::name` id (e.g. a reassigned bare
  `f = function(){}` in two scopes) collapse to one node under the existing id-keyed last-wins de-dup,
  and their out-edges merge onto the survivor. This is a pre-existing property of the id scheme (two
  nested `function helper(){}` collapse the same way) — not introduced here, not widened in severity.

## Inbound reachability of the new nodes
Indexing a member node is only half of reachability — calls must also resolve *into* it.
- **Resolved (added here):** a same-file call with a literal receiver matching the node's dotted name,
  `app.render()` → `app.render`, now resolves to the internal node (confidence `same_file`) via exact
  id lookup, instead of falling through to a synthetic `external::app.render` leaf. This makes the
  feature's reachability/dead-code claim true for the literal-receiver idiom and is what the change's
  own `app.use → app.lazyrouter` test actually exercises.
- **NOT resolved (pre-existing, out of scope — call-extraction layer, not this change):** intra-object
  `this.method()` calls — the dominant sibling-call idiom in real CommonJS/prototype code (Express
  calls `this.set()`, `this.enabled()`). The TS/JS call query captures `member_expression` with an
  `(identifier)` object; `this` is a `this` node, so `this.x()` is not captured as an edge **for any
  TS/JS code, including ordinary ES6 classes** (`class C { a(){ this.b() } }` yields no `a → b` edge).
  Widening the call query to capture `this`-receiver calls is a separate change with repo-wide edge-set
  blast radius and should be proposed, dogfooded, and decided on its own.
- **NOT resolved (out of scope):** cross-file member calls and instance-receiver prototype dispatch
  (`view.render()` → `View.prototype.render`).
