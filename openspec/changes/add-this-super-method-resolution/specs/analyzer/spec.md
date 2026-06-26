# analyzer spec delta

## ADDED Requirements

### Requirement: IntraObjectMethodCallResolution

The call-graph builder SHALL resolve intra-object method calls — `this.method()` and `super.method()`
in TypeScript/JavaScript (and the already-supported Python `self.`/`cls.`) — to the indexed method
they target, deterministically and without an LLM, so that tools traversing call edges
(`analyze_impact`, `select_tests`, `find_dead_code`, `find_path`, `analyze_error_propagation`) see
intra-object dispatch rather than a silent absence of edges.

- `this.m()` SHALL resolve to method `m` on the caller's enclosing class; when the enclosing class
  does not define `m`, resolution SHALL walk the `extends` ancestor chain transitively (cycle-guarded)
  so an inherited method resolves.
- `super.m()` SHALL resolve to `m` on a parent class of the caller's enclosing class, and SHALL NOT
  resolve to the caller's own class (a super call targets the parent, never a self-loop to an
  overriding child).
- Resolution SHALL disambiguate same-named classes across files by FILE AFFINITY: a candidate in the
  caller's own file is preferred, then the file the caller imports the class from; a single candidate
  is unambiguous; an ambiguous match with no affinity SHALL be skipped rather than bound to an
  arbitrary file (no false cross-file edge).
- A resolved intra-object edge SHALL carry confidence `self_cls`.
- The name-only call-noise ignore filter SHALL be bypassed for `this`/`super`/`self`/`cls` receivers,
  so a class method whose name collides with a common builtin (`parse`, `map`, `filter`, …) still
  resolves.
- An unresolved `this`/`super` call SHALL be dropped, NOT recorded as a synthetic `external::this.m`
  node.

#### Scenario: this.method() resolves to a sibling method of the same class

- **GIVEN** a TypeScript class whose method `caller` contains `this.callee()` and that defines
  `callee`
- **WHEN** the call graph is built
- **THEN** there is an edge `caller → callee` with confidence `self_cls`

#### Scenario: super.method() resolves to the parent, not the overriding child

- **GIVEN** a class `Child extends Base` where both define `greet`, and `Child.greet` calls
  `super.greet()`
- **WHEN** the call graph is built
- **THEN** the edge targets `Base.greet`, never `Child.greet`

#### Scenario: a same-named class in another file does not capture the edge

- **GIVEN** two files each declaring `class Dup` with a `method`, and a `this.method()` call in one of
  them
- **WHEN** the call graph is built
- **THEN** the edge binds to the `Dup.method` in the CALLER's own file

#### Scenario: a this-call whose name is on the noise ignore-list still resolves

- **GIVEN** a class method `handle` that calls `this.parse()` and the class defines `parse` (a name on
  the call-noise ignore-list)
- **WHEN** the call graph is built
- **THEN** the edge `handle → parse` exists (the ignore-list does not suppress a `this.` receiver)
