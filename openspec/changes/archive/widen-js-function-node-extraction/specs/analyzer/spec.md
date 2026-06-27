# analyzer spec delta

## ADDED Requirements

### Requirement: TypeScriptFunctionNodeExtractionShapes

The TypeScript/JavaScript extractor SHALL index a function node for each of the following source
shapes, in addition to `function_declaration`, exported `function_declaration`, and ES6
`method_definition`: a `const`/`let` binding (`lexical_declaration`) to an arrow or function
expression; a `var` binding (`variable_declaration`) to an arrow or function expression; and an
`assignment_expression` whose left-hand side is an identifier or a member expression and whose
right-hand side is an arrow or function expression (`app.use = function(){}`,
`exports.handler = function(){}`, `Foo.prototype.bar = function(){}`, `f = function(){}`); and a
class-field definition (`public_field_definition`) whose value is an arrow or function expression
(`class C { handler = () => {} }`). A member-assigned node SHALL be named by the full dotted member
path (`app.use`, `Foo.prototype.bar`), with incidental whitespace collapsed so the derived name, node
id, and `stableId` are stable. A class-field function node SHALL be named by its bare property
identifier (`handler`) and associated with its enclosing class (id `File::Class.handler`), exactly as
a `method_definition` is. The extractor SHALL NOT index an assignment whose right-hand side is not a
function/arrow (a `require(...)` call, a member access, an identifier, a number, or an object literal),
a non-function class-field value (a number, object, or string), a computed-member assignment
(`obj[key] = function(){}`), or an augmented assignment (`obj.x ||= function(){}`). When the same
member is assigned more than once in a file, the analyzer SHALL collapse it to a single node (the
existing id-keyed last-wins de-duplication), never emitting duplicate nodes.

#### Scenario: Member-assigned method is indexed

- **GIVEN** a JavaScript file containing `app.use = function use(fn) { app.lazyrouter(); }` and
  `app.lazyrouter = function lazyrouter() {}`
- **WHEN** the call graph is built
- **THEN** both `app.use` and `app.lazyrouter` are function nodes and the edge `app.use → app.lazyrouter`
  is resolved internally

#### Scenario: Prototype and var idioms are indexed

- **GIVEN** a JavaScript file containing `View.prototype.render = function render(){}` and
  `var parse = function parse(){}`
- **WHEN** the call graph is built
- **THEN** `View.prototype.render` and `parse` are function nodes

#### Scenario: Class-field arrow/function members are indexed

- **GIVEN** a TypeScript/JavaScript file containing `class Comp { onClick = () => { recompute(); } }`
- **WHEN** the call graph is built
- **THEN** `onClick` is a function node with className `Comp` (id `…::Comp.onClick`) and the edge
  `onClick → recompute` is resolved

#### Scenario: Non-function class field is not indexed

- **GIVEN** a class with fields `count = 0`, `data = {}`, `label = 'x'`, and `real = () => {}`
- **WHEN** the call graph is built
- **THEN** only `real` produces a function node

#### Scenario: Non-function assignment is not indexed

- **GIVEN** a JavaScript file containing `exports.router = require('./router')`, `exports.VERSION = 42`,
  and `exports.config = { a: 1 }`
- **WHEN** the call graph is built
- **THEN** none of those assignments produce a function node

#### Scenario: Computed-member and augmented assignment are not indexed

- **GIVEN** a JavaScript file containing `obj[key] = function(){}` and `obj.maybe ||= function(){}`
- **WHEN** the call graph is built
- **THEN** neither produces a function node

#### Scenario: Re-assigned member collapses to one node

- **GIVEN** a file that assigns `obj.fn = function(){}` twice
- **WHEN** the call graph is built
- **THEN** exactly one node named `obj.fn` exists

#### Scenario: Member-named node receives an escaped stable id

- **GIVEN** a node named `app.use` produced from `app.use = function use(fn){}`
- **WHEN** its `stableId` is computed
- **THEN** the dotted name is backtick-escaped and the node carries a `stableId`
