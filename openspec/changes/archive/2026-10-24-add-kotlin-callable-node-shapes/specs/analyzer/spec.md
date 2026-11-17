# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinExecutableBodiesAreGraphNodes

The analyzer SHALL create a function node for every Kotlin body that executes: each named function,
the primary constructor of a class together with its `init` blocks and property initializers, each
secondary constructor, each property getter and setter that has a body, the top-level property
initializers of a file, the top-level statements of a `.kts` script, and each function-typed
property initialized by a lambda or anonymous function. Nodes that have no source identifier SHALL
use a reserved angle-bracket name and a `synthetic` kind. A call site inside any of these bodies
SHALL be attributed to that node and SHALL NOT be dropped. A backtick-quoted name SHALL be stored
without backticks, a `suspend` function SHALL be marked asynchronous, and overloaded functions SHALL
have distinct nodes. Adding these nodes SHALL NOT change the identifier of any node that existed
before.

#### Scenario: A call in an init block is attributed

- **GIVEN** `class UserService(private val repo: Repo) { init { warmUp() } private fun warmUp() {} }`
- **WHEN** the call graph is built
- **THEN** the class has a constructor node that calls `warmUp`
- **AND** `warmUp` is not reported as an entry point

#### Scenario: A property accessor has a node

- **GIVEN** `var label: String = "" set(v) { field = normalize(v) }`
- **WHEN** the call graph is built
- **THEN** a setter node for `label` exists and calls `normalize`

#### Scenario: A script body is a node

- **GIVEN** a `.kts` file whose top-level statements call a function declared in the same script
- **WHEN** the call graph is built
- **THEN** a script-body node for that file holds the call edge

#### Scenario: Existing node identifiers are stable

- **GIVEN** a Kotlin repository analyzed before and after this change
- **WHEN** the node identifiers of named functions are compared
- **THEN** they are identical, and only new nodes are added

### Requirement: KotlinStaticCallShapesProduceEdges

The analyzer SHALL emit a call edge for each Kotlin call shape whose target is fixed by syntax and
name resolution: a constructor call on a project class, a constructor delegation (`this(...)`,
`super(...)`, or a supertype constructor invocation), a callable reference (`::f`, `Type::m`,
`obj::m`, `::Type`), an infix call whose name resolves to an `infix` function, and a call on a
function-typed property that has a node. A callable-reference edge SHALL be marked as a reference.
The analyzer SHALL NOT emit an edge for an operator-convention call or a property access, because
the target depends on a static type the analyzer does not compute; each operator-convention site
SHALL be counted as a disclosed boundary, and an `operator` function or accessor node SHALL NOT
receive a confident unreachable verdict.

#### Scenario: A constructor call resolves to the class

- **GIVEN** `val svc = UserService(repo)` where `UserService` is a project class
- **WHEN** the call graph is built
- **THEN** the edge targets the constructor node of `UserService`, not an external leaf

#### Scenario: A callable reference keeps its target alive

- **GIVEN** `listOf(1, 2).forEach(::report)` and a project function `report`
- **WHEN** the call graph is built
- **THEN** an edge marked as a reference joins the enclosing function to `report`
- **AND** `report` is not a dead-code candidate

#### Scenario: An infix call resolves

- **GIVEN** `infix fun Int.times2(o: Int)` and the expression `5 times2 2`
- **WHEN** the call graph is built
- **THEN** an edge targets `times2`

#### Scenario: An operator call is a boundary, not an edge

- **GIVEN** `operator fun plus(o: Box): Box` and the expression `a + b`
- **WHEN** the call graph is built
- **THEN** no edge targets `plus` from that expression
- **AND** the file's operator-dispatch boundary count is one
- **AND** a dead-code query does not report `plus` as confidently unreachable
