# Tasks: Kotlin callable node shapes

## Implementation
- [ ] Dedicated Kotlin extractor (functions, constructors, initializers, accessors, script body,
      function-typed properties); keep existing node ids byte-identical
- [ ] `<init>` node per class with a primary constructor, `init` block, or property initializer;
      one per secondary constructor
- [ ] Attribute calls in `init`, property initializers, accessors, top-level initializers, and
      `.kts` statements to their new nodes
- [ ] Constructor-call edges (`Foo()`), delegation edges (`this(...)`, `super(...)`, `: Base()`)
- [ ] Callable-reference edges for the four reference forms
- [ ] Infix-call edges when the name resolves to an `infix fun`
- [ ] Strip backticks from names; set `isAsync` for `suspend`; distinct nodes for overloads
- [ ] Count operator-dispatch sites; exempt `operator fun` and accessor nodes from confident
      dead-code verdicts

## Conformance
- [ ] One fixture per row of both tables; each asserts node presence, owner, and edge target
- [ ] Negative fixture: `a + b` creates no edge and one boundary count
- [ ] Node-id stability test: ids of pre-existing nodes unchanged on the reference corpus

## Verification
- [ ] Reference corpus: `warmUp`, `report`, `times2`, `normalize` each gain a caller
- [ ] Real repository: entry-point count before/after reported in the PR
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinExecutableBodiesAreGraphNodes,
      KotlinStaticCallShapesProduceEdges
