# Give every Kotlin executable body a node, and every static call shape an edge

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

Kotlin code that runs is in the graph. Constructors, initializers, property accessors, and script
bodies stop being invisible, and calls made by reference or by infix stop looking like dead code.

## What is missing today

Kotlin is a generic query spec with one node query, `function_declaration`
(`call-graph.ts:2993-3022`). A call site with no enclosing function node is dropped (`:2947`).
On the reference fixture:

| Kotlin source | Today |
|---|---|
| `UserService(repo)`, `NotFoundException(id)` | `external::UserService`: no constructor node exists |
| `init { warmUp() }` | no edge; `warmUp` is reported as an entry point |
| `val count: Int get() = repo.size()`; `set(v) { field = normalize(v) }` | no node, no edge |
| `val cache = buildCache()` (property initializer, top-level or member) | no edge |
| `constructor() : this(InMemoryUserRepository())` | no node, no edge |
| `listOf(1, 2).forEach(::report)`, `Foo::bar` | no edge; `report` looks unused |
| `5 times2 2` (infix function) | no edge |
| `val f = fun(z: Int) = z * 2`, `val g = { a: Int -> helper(a) }` | no node; `f(x)` is external |
| `fun \`creates a slug\`()` | node name keeps the backticks |
| `suspend fun` | `isAsync` is always false (`:2928`) |
| top-level statements in a `.kts` script | calls dropped |
| `fun load(a: Int)` and `fun load(a: String)` | collapse to one node |

Java already has constructor nodes, `new` edges, method-reference edges, and synthesized
`super(...)` edges (`call-graph.ts:1977-2105`).

## What changes

**Nodes**

| Body | Node name | Owner |
|---|---|---|
| Primary constructor (declared or implied) with `init` blocks and property initializers | `<init>` | the class |
| Secondary constructor | `<init>` (overload-distinguished) | the class |
| Property getter / setter with a body | `<get-name>` / `<set-name>` | the class or file |
| Top-level property initializers of a file | `<clinit>` | the file |
| `.kts` script top-level statements | `<script>` | the file |
| Function-typed `val` initialized by a lambda or anonymous function | the property name | the class or file |

- Synthetic names use the existing angle-bracket convention so they never collide with a source
  identifier, and they carry a `synthetic` kind so a tool can hide them from name search.
- Backtick names are stored without backticks.
- `suspend` sets `isAsync`.
- Overloads get distinct nodes, keyed as the existing overload-identity scheme does for Java.

**Edges**

| Call shape | Edge |
|---|---|
| `Foo(args)` where `Foo` is a project class | to the matching `<init>`; `calls`, existing confidence ladder |
| `this(...)` / `super(...)` delegation, and `: Base(args)` | to the delegated `<init>` |
| `::f`, `Type::m`, `obj::m`, `::Type` (constructor reference) | to the referenced callable, with `call_type: reference` |
| `a f b` where `f` resolves to an `infix fun` | ordinary call edge |
| A call on a function-typed `val` node (`g(x)`, `g.invoke(x)`) | to that node |
| A property read that has a getter node | no edge (see below) |

**Deliberately not edges**

- **Operator calls** (`a + b`, `a[i]`, `a()`, `for (x in a)`, destructuring, `by` delegates). The
  operator is chosen by the static type of the operand, which this analyzer does not have. Each is
  counted as an `operator-dispatch` boundary so an `operator fun` is never reported dead with
  confidence.
- **Property accesses.** A read or write of a property with a custom accessor is not a call site in
  the syntax tree. Accessor nodes are reached from their owner class; they are marked so
  `find_dead_code` does not list them as unreachable.

## Not in scope

- Receiver typing (`add-kotlin-declared-type-receivers`).
- Kotest and other DSL test bodies (`add-kotlin-test-detection-and-generation`).

## Impact

- `call-graph.ts` (Kotlin moves from the generic query spec to a dedicated extractor, as Java has),
  `call-graph-types.ts` (node kind), `reachability.ts` (accessor and operator handling).
- Specs: `analyzer`, 2 ADDED requirements.
- Risk: node count grows. Node ids for existing functions must not change; the PR proves it with a
  before/after id diff, so anchored memories and decisions carry forward.
