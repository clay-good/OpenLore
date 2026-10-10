# Tasks: Kotlin callable node shapes

## Implementation
- [x] Kotlin body-node collector (`kotlin-extract.ts`: constructors, initializers, accessors,
      script body, function-typed properties) beside the existing function query; existing node ids
      unchanged, except that a backtick name loses its backticks
- [x] One `<init>` node per class and object (declared or implied constructor, `init` blocks,
      property initializers, supertype arguments, secondary constructors); `<clinit>` for a
      companion and for a file's top-level initializers
- [x] Attribute calls in `init`, property initializers, accessors, top-level initializers, and
      `.kts` statements to their new nodes
- [x] Constructor-call edges (`Foo()`), delegation edges (`super(...)`, `: Base()`). `this(...)`
      is not an edge: the constructors of a class are one node
- [x] Callable-reference edges for the four reference forms
- [x] Infix-call edges when the name resolves to an `infix fun`
- [x] Strip backticks from names; set `isAsync` for `suspend`; overloads share one node (the
      existing scheme for Java and every other language; the spec delta is corrected to say so)
- [x] Exempt `operator fun` and accessor nodes from confident dead-code verdicts
- [x] Count operator-dispatch sites (built with `add-kotlin-dynamic-boundary`; ledger entry
      `shape-operator-boundary-count`). Kept as a per-file count under `operatorDispatch`, for
      expressions whose convention function the project declares as `operator fun`

## Conformance
- [x] One fixture per row of both tables; each asserts node presence, owner, and edge target
- [x] Negative fixture: `a + b` creates no edge (the boundary count follows with
      `add-kotlin-dynamic-boundary`)
- [x] Node-id stability test: ids of pre-existing nodes unchanged on the reference corpus

## Verification
- [x] Reference corpus: `warmUp`, `report`, `times2`, `normalize` each gain a caller
- [ ] Real repository: entry-point count before/after reported in the PR
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinExecutableBodiesAreGraphNodes,
      KotlinStaticCallShapesProduceEdges
